import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Configure admin auth BEFORE import.
process.env.ADMIN_PASSWORD = 'correct horse';
process.env.SECRET_KEY = 'admin-signing-key';

const auth = await import('../src/admin/auth.js');

test('checkPassword accepts the right password, rejects wrong ones', () => {
  assert.equal(auth.checkPassword('correct horse'), true);
  assert.equal(auth.checkPassword('wrong'), false);
  assert.equal(auth.checkPassword(''), false);
});

test('issued token verifies; a tampered token does not', () => {
  const token = auth.issueToken();
  assert.equal(auth.verifyToken(token), true);
  assert.equal(auth.verifyToken(token + 'x'), false);
  assert.equal(auth.verifyToken('garbage'), false);
  assert.equal(auth.verifyToken(''), false);
});

// Sign a token exactly the way auth.js does, so we can forge one that is CORRECTLY signed but
// expired. The previous version of this test used `${past}.anything`, which was rejected at the
// signature check and never reached the expiry check at all — deleting the expiry line entirely
// left it green, so the 12h session limit was unverified.
const signToken = (exp) =>
  `${exp}.${crypto.createHmac('sha256', process.env.SECRET_KEY).update(String(exp)).digest('base64url')}`;

test('a correctly-signed but expired token is rejected', () => {
  assert.equal(auth.verifyToken(signToken(Date.now() - 1000)), false, 'expiry must be enforced');

  // Sanity: the same construction with a future expiry IS accepted, proving the forged
  // signature above is genuinely valid and expiry is the only reason it was rejected.
  assert.equal(auth.verifyToken(signToken(Date.now() + 60_000)), true);
});

test('a token signed with the wrong key is rejected', () => {
  const wrong = `${Date.now() + 60_000}.${crypto.createHmac('sha256', 'not-the-key').update('x').digest('base64url')}`;
  assert.equal(auth.verifyToken(wrong), false);
});

test('adminOpen reflects whether a password is set', () => {
  assert.equal(auth.adminOpen(), false); // password is set in this process
});

test('sessionCookie carries HttpOnly + SameSite', () => {
  const c = auth.sessionCookie('t');
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
});
