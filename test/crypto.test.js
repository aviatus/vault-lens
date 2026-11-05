import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPin, verifyPin, encrypt, decrypt } from '../extension/crypto.js';

const FAST = 1000; // iterations for tests; production uses PBKDF2_ITERATIONS

test('PIN round trip: right PIN gives the same key, wrong PIN gives null', async () => {
  const { config, key } = await createPin('482913', FAST);
  assert.equal(await verifyPin('482913', config), key);
  assert.equal(await verifyPin('482914', config), null);
  assert.ok(!JSON.stringify(config).includes('482913'), 'PIN must not be stored');
});

test('tokens encrypted with the PIN key decrypt only with that key', async () => {
  const { key } = await createPin('1111', FAST);
  const { key: other } = await createPin('1111', FAST); // same PIN, different salt -> different key
  const blob = await encrypt(key, JSON.stringify({ a: { token: 'hvs.fake' } }));
  assert.ok(!blob.ct.includes('hvs.fake'));
  assert.deepEqual(JSON.parse(await decrypt(key, blob)), { a: { token: 'hvs.fake' } });
  await assert.rejects(decrypt(other, blob));
  const tampered = { ...blob, ct: blob.ct.slice(0, -4) + (blob.ct.endsWith('AAAA') ? 'BBBB' : 'AAAA') };
  await assert.rejects(decrypt(key, tampered));
});

test('each encryption uses a fresh IV', async () => {
  const { key } = await createPin('1234', FAST);
  const [a, b] = [await encrypt(key, 'x'), await encrypt(key, 'x')];
  assert.notEqual(a.iv, b.iv);
});

test('a token bound to one Vault address cannot be decrypted for another', async () => {
  const { key } = await createPin('1234', FAST);
  const blob = await encrypt(key, 'hvs.fake', 'https://vault-a.test');
  assert.equal(await decrypt(key, blob, 'https://vault-a.test'), 'hvs.fake');
  await assert.rejects(decrypt(key, blob, 'https://vault-b.test'));
  await assert.rejects(decrypt(key, blob));
});
