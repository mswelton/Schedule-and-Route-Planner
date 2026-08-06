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

/** Call a handler with whichever verb it accepts, carrying no credentials. */
async function callWithoutAuth(handler) {
  for (const method of ['GET', 'POST']) {
    const { res, sent } = fakeRes();
    await handler({ method, headers: {}, query: {}, body: {} }, res);
    if (sent.status !== 405) return sent;
  }
  throw new Error('handler accepted neither GET nor POST');
}

test('there is at least one endpoint to check', () => {
  assert.ok(handlers.length >= 8, `found ${handlers.length} handlers`);
});

for (const { name, file } of handlers) {
  test(`/api/${name} ${name === 'config' ? 'is deliberately public' : 'rejects an unauthenticated request'}`, async () => {
    const { default: handler } = await import(file);
    const sent = await callWithoutAuth(handler);

    if (name === 'config') {
      // The one endpoint that must answer without a session — it is what the
      // browser needs in order to sign in at all.
      assert.notEqual(sent.status, 401, '/api/config must not require a session');
      return;
    }

    assert.equal(sent.status, 401, `/api/${name} answered ${sent.status} instead of 401`);
    assert.match(sent.body?.error || '', /sign in/i);
  });
}

test('handlers refuse a verb they do not implement', async () => {
  const { default: locations } = await import(path.join(apiDir, 'locations.js'));
  const { res, sent } = fakeRes();
  await locations({ method: 'DELETE', headers: {}, query: {} }, res);

  assert.equal(sent.status, 405);
  assert.equal(sent.headers.Allow, 'GET');
});
