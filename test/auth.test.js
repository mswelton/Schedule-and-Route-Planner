import test from 'node:test';
import assert from 'node:assert/strict';
import { bearerToken, requireUser, AuthError } from '../lib/auth.js';

test('reads the token out of an Authorization header', () => {
  assert.equal(bearerToken({ headers: { authorization: 'Bearer abc.def.ghi' } }), 'abc.def.ghi');
  // Node lower-cases incoming headers, but the dev-server shim may not.
  assert.equal(bearerToken({ headers: { Authorization: 'Bearer abc.def.ghi' } }), 'abc.def.ghi');
  // The scheme is case-insensitive per RFC 6750, and surrounding space is not
  // part of the token.
  assert.equal(bearerToken({ headers: { authorization: '  bearer   abc  ' } }), 'abc');
});

test('treats anything that is not a bearer token as absent', () => {
  assert.equal(bearerToken({ headers: {} }), null);
  assert.equal(bearerToken({}), null);
  assert.equal(bearerToken({ headers: { authorization: '' } }), null);
  assert.equal(bearerToken({ headers: { authorization: 'Bearer' } }), null);
  assert.equal(bearerToken({ headers: { authorization: 'Bearer   ' } }), null);
  assert.equal(bearerToken({ headers: { authorization: 'Basic dXNlcjpwdw==' } }), null);
});

test('a request with no token is rejected before Supabase is contacted', async () => {
  // No SUPABASE_* variables are needed to reach this: an unauthenticated
  // request must never become a network call.
  await assert.rejects(() => requireUser({ headers: {} }), (err) => {
    assert.ok(err instanceof AuthError);
    assert.equal(err.status, 401);
    return true;
  });
});
