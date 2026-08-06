import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every endpoint but /api/config is behind a verified session. This walks the
 * api/ directory rather than naming the handlers, so an endpoint added later
 * that forgets `authenticate()` fails here instead of shipping open.
 *
 * No environment variables are needed: an unauthenticated request must be
 * rejected before anything reaches Supabase or Google.
 */

const apiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'api');
const handlers = readdirSync(apiDir)
  .filter((file) => file.endsWith('.js'))
  .map((file) => ({ name: file.replace(/\.js$/, ''), file: path.join(apiDir, file) }));

/** Just enough of Vercel's `res` to see what a handler decided. */
function fakeRes() {
  const sent = { status: null, body: null, headers: {} };
  const res = {
    status(code) {
      sent.status = code;
      return res;
    },
    json(payload) {
      sent.body = payload;
      return res;
    },
    send(payload) {
      sent.body = payload;
      return res;
    },
    setHeader(key, value) {
      sent.headers[key] = value;
    },
  };
  return { res, sent };
}

const VERBS = ['GET', 'POST', 'PUT', 'DELETE'];

/**
 * Every verb a handler accepts, called with no credentials.
 *
 * All four are tried rather than stopping at the first: an endpoint that
 * guards `GET` but not `DELETE` is exactly the mistake worth catching, and
 * checking only the first accepted verb would miss it.
 */
async function callWithoutAuth(handler) {
  const answered = [];
  for (const method of VERBS) {
    const { res, sent } = fakeRes();
    await handler({ method, headers: {}, query: {}, body: {} }, res);
    if (sent.status !== 405) answered.push({ method, sent });
  }
  if (answered.length === 0) throw new Error('handler accepted none of ' + VERBS.join(', '));
  return answered;
}

test('there is at least one endpoint to check', () => {
  assert.ok(handlers.length >= 8, `found ${handlers.length} handlers`);
});

for (const { name, file } of handlers) {
  test(`/api/${name} ${name === 'config' ? 'is deliberately public' : 'rejects an unauthenticated request on every verb it accepts'}`, async () => {
    const { default: handler } = await import(file);
    const answered = await callWithoutAuth(handler);

    if (name === 'config') {
      // The one endpoint that must answer without a session — it is what the
      // browser needs in order to sign in at all.
      for (const { method, sent } of answered) {
        assert.notEqual(sent.status, 401, `/api/config must not require a session (${method})`);
      }
      return;
    }

    for (const { method, sent } of answered) {
      assert.equal(sent.status, 401, `${method} /api/${name} answered ${sent.status}, not 401`);
      assert.match(sent.body?.error || '', /sign in/i);
    }
  });
}

test('handlers refuse a verb they do not implement', async () => {
  const { default: locations } = await import(path.join(apiDir, 'locations.js'));
  const { res, sent } = fakeRes();
  await locations({ method: 'DELETE', headers: {}, query: {} }, res);

  assert.equal(sent.status, 405);
  assert.equal(sent.headers.Allow, 'GET');
});
