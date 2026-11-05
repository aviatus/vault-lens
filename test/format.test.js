import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTtl, toEnv, parentPath } from '../extension/format.js';

test('formatTtl', () => {
  assert.equal(formatTtl(null), 'no expiry');
  assert.equal(formatTtl(0), '00:00');
  assert.equal(formatTtl(65), '01:05');
  assert.equal(formatTtl(3599), '59:59');
  assert.equal(formatTtl(3600 + 5 * 60 + 9), '1h 05m');
});

test('toEnv: invalid keys skipped, values single-quoted so shells do not expand them', () => {
  assert.equal(
    toEnv({ USER: 'demo', URL: 'https://x.test/a?b=1', PASS: "it's $(id) `x`", CERT: 'l1\nl2', N: 3, OBJ: { a: 1 }, 'A;touch x;B': '1', 'bad key': 'v', '1X': 'v' }),
    ['USER=demo', "URL='https://x.test/a?b=1'", "PASS='it'\\''s $(id) `x`'", "CERT='l1\nl2'", 'N=3', `OBJ='{"a":1}'`].join('\n'),
  );
});

test('parentPath', () => {
  assert.equal(parentPath('a/b/'), 'a/');
  assert.equal(parentPath('a/'), '');
});

import { isPlain, isHttpUrl, ageDays, vaultUiUrl } from '../extension/format.js';

test('isPlain: allowlisted keys shown, everything else and credential URLs masked', () => {
  for (const k of ['username', 'user_name', 'host', 'port', 'url', 'endpoint', 'client_id', 'region']) assert.equal(isPlain(k, 'x'), true, k);
  for (const k of ['password', 'api_key', 'client_secret', 'token', 'cert', 'connection_string', 'note']) assert.equal(isPlain(k, 'x'), false, k);
  assert.equal(isPlain('url', 'postgres://admin:s3cret@db:5432/app'), false);
  assert.equal(isHttpUrl('https://a.test/x'), true);
  assert.equal(isHttpUrl('javascript:alert(1)'), false);
});

test('ageDays', () => {
  assert.equal(ageDays('2026-01-01T00:00:00Z', Date.parse('2026-07-01T12:00:00Z')), 181);
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('toEnv output sourced by a real shell runs nothing and round-trips values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'toenv-'));
  try {
    const data = { A: "$(touch pwned1)", B: '`touch pwned2`', C: "it's ${HOME} \"q\"\nline2", 'D;touch pwned3;E': '1' };
    writeFileSync(join(dir, 'f.env'), toEnv(data));
    const out = execFileSync('sh', ['-c', 'set -a; . ./f.env; printf "%s\\0%s\\0%s" "$A" "$B" "$C"'], { cwd: dir, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } }).toString();
    assert.deepEqual(out.split('\0'), [data.A, data.B, data.C]);
    for (const f of ['pwned1', 'pwned2', 'pwned3']) assert.equal(existsSync(join(dir, f)), false, f);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vaultUiUrl: Vault web UI page for the current location', () => {
  const B = 'https://vault.example.test';
  const v2 = { path: 'secret/', type: 'kv', version: 2 };
  const v1 = { path: 'kv/', type: 'kv', version: 1 };
  assert.equal(vaultUiUrl(B, null), `${B}/ui/vault/secrets`);
  assert.equal(vaultUiUrl(B, v2, ''), `${B}/ui/vault/secrets/secret/kv/list`);
  assert.equal(vaultUiUrl(B, v2, 'demo/'), `${B}/ui/vault/secrets/secret/kv/list/demo/`);
  assert.equal(vaultUiUrl(B, v2, 'demo/', 'app'), `${B}/ui/vault/secrets/secret/kv/demo%2Fapp/details`);
  assert.equal(vaultUiUrl(B, v2, 'demo/', 'db', 3), `${B}/ui/vault/secrets/secret/kv/demo%2Fdb/details?version=3`);
  assert.equal(vaultUiUrl(B, v1, 'legacy/'), `${B}/ui/vault/secrets/kv/list/legacy/`);
  assert.equal(vaultUiUrl(B, v1, 'legacy/', 'config'), `${B}/ui/vault/secrets/kv/show/legacy/config`);
  assert.equal(vaultUiUrl(B, { path: 'totp/', type: 'totp' }, '', 'x'), `${B}/ui/vault/secrets`);
  // names from the vault cannot add query, fragment or path tricks
  assert.equal(vaultUiUrl(B, v2, 'a?b/', 'c#d'), `${B}/ui/vault/secrets/secret/kv/a%3Fb%2Fc%23d/details`);
});
