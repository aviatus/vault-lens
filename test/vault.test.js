import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, kvPath, list, listAll, listMounts, read, totp, normalizeUrl, originPattern } from '../extension/vault.js';

const V = { url: 'https://vault.example' };

function mockFetch(body, status = 200) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { status, ok: status < 400, json: async () => body };
  };
  return calls;
}

test('read-only guard rejects write methods before any network call', async () => {
  const calls = mockFetch({});
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    await assert.rejects(request(V, 't', m, 'secret/x'), /Read-only/);
  }
  assert.equal(calls.length, 0);
});

test('LIST is sent as GET ?list=true with the token header', async () => {
  const calls = mockFetch({ data: { keys: ['a/', 'b'] } });
  const keys = await list(V, 'tok', { path: 'secret/', version: 2 }, 'app/');
  assert.deepEqual(keys, ['a/', 'b']);
  assert.equal(calls[0].url, 'https://vault.example/v1/secret/metadata/app/?list=true');
  assert.equal(calls[0].opts.method, 'GET');
  assert.equal(calls[0].opts.headers['X-Vault-Token'], 'tok');
  assert.deepEqual(Object.keys(calls[0].opts.headers), ['X-Vault-Token']);
});

test('listAll walks nested folders, skips unlistable ones, respects max', async () => {
  const tree = {
    'secret/metadata/': ['a/', 'top', 'denied/'],
    'secret/metadata/a/': ['b/', 'one'],
    'secret/metadata/a/b/': ['two'],
  };
  globalThis.fetch = async (url) => {
    const p = new URL(url).pathname.replace('/v1/', '');
    if (p.startsWith('secret/metadata/denied')) return { status: 403, ok: false, json: async () => ({ errors: ['permission denied'] }) };
    return { status: 200, ok: true, json: async () => ({ data: { keys: tree[p] } }) };
  };
  const mount = { path: 'secret/', version: 2 };
  assert.deepEqual((await listAll(V, 't', mount)).sort(), ['a/b/two', 'a/one', 'top']);
  assert.equal((await listAll(V, 't', mount, 2)).length, 2);
});

test('listAll: walks sharing a pace never exceed its limit; raising the limit speeds up a running walk', async () => {
  let active = 0;
  let peak = 0;
  globalThis.fetch = async (url) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    const p = new URL(url).pathname.replace('/v1/', '');
    const depth = p.split('/').length - 3; // secret/metadata/<folders>
    const keys = depth < 2 ? ['x/', 'y/', 'z/', 'leaf'] : ['leaf'];
    return { status: 200, ok: true, json: async () => ({ data: { keys } }) };
  };
  const pace = { limit: 2 };
  const a = listAll(V, 't', { path: 'secret/', version: 2 }, 5000, pace);
  const b = listAll(V, 't', { path: 'other/', version: 2 }, 5000, pace);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(peak, 2, 'two walks together stay at the shared limit');
  pace.limit = 8;
  pace.kick();
  const [ra, rb] = await Promise.all([a, b]);
  assert.ok(peak > 2, 'raising the limit lets more requests run');
  assert.ok(peak <= 8);
  assert.equal(ra.length, 1 + 3 + 9); // leaf at each level: 1 root + 3 + 9
  assert.equal(rb.length, 13);
});

test('kvPath for v1 and v2', () => {
  assert.equal(kvPath({ path: 'kv/', version: 1 }, 'list', 'a/'), 'kv/a/');
  assert.equal(kvPath({ path: 'kv/', version: 1 }, 'read', 'a/b'), 'kv/a/b');
  assert.equal(kvPath({ path: 'secret/', version: 2 }, 'list', 'a/'), 'secret/metadata/a/');
  assert.equal(kvPath({ path: 'secret/', version: 2 }, 'read', 'a/b'), 'secret/data/a/b');
});

test('read returns data + v2 metadata; 404 -> null', async () => {
  mockFetch({ data: { data: { k: 'v' }, metadata: { version: 3 } } });
  assert.deepEqual(await read(V, 't', { path: 'secret/', version: 2 }, 'x'), { data: { k: 'v' }, meta: { version: 3 } });
  mockFetch({ data: { k: 'v1' } });
  assert.deepEqual(await read(V, 't', { path: 'kv/', version: 1 }, 'x'), { data: { k: 'v1' }, meta: null });
  mockFetch({ errors: [] }, 404);
  assert.equal(await read(V, 't', { path: 'kv/', version: 1 }, 'x'), null);
});

test('errors carry status and Vault message', async () => {
  mockFetch({ errors: ['permission denied'] }, 403);
  await assert.rejects(request(V, 't', 'GET', 'secret/x'), (e) => e.status === 403 && e.message === 'Vault: permission denied');
  mockFetch({ errors: ['2 errors occurred:\n\t* permission denied\n\t* invalid token\n\n'] }, 403);
  await assert.rejects(request(V, 't', 'GET', 'secret/x'), (e) => e.message === 'Vault: permission denied; invalid token');
  mockFetch({ errors: ['x'.repeat(500)] }, 500);
  await assert.rejects(request(V, 't', 'GET', 'secret/x'), (e) => e.message.length === 'Vault: '.length + 200);
});

test('never follows redirects with the token and rejects dot path segments', async () => {
  const calls = mockFetch({ data: {} });
  await request(V, 't', 'GET', 'secret/data/a');
  assert.equal(calls[0].opts.redirect, 'error');
  for (const bad of ['secret/metadata/../../sys/x', 'secret/./a', 'kv/..']) {
    await assert.rejects(request(V, 't', 'LIST', bad), /Invalid path/);
  }
  assert.equal(calls.length, 1); // rejected before any network call
  await request(V, 't', 'GET', 'secret/data/a..b/.hidden'); // dots inside names are fine
});

test('normalizeUrl allows https and local http only', () => {
  assert.equal(normalizeUrl(' https://vault.example:8200/ui/ '), 'https://vault.example:8200');
  assert.equal(normalizeUrl('http://127.0.0.1:8200'), 'http://127.0.0.1:8200');
  assert.throws(() => normalizeUrl('http://vault.example'), /https/);
  assert.throws(() => normalizeUrl('not a url'), /Invalid URL/);
  assert.equal(originPattern('https://vault.example:8200'), 'https://vault.example/*');
});

test('listMounts returns KV (with version) and TOTP mounts, skips others', async () => {
  mockFetch({ data: { secret: {
    'secret/': { type: 'kv', options: { version: '2' } },
    'kv/': { type: 'kv', options: { version: '1' } },
    'totp/': { type: 'totp' },
    'pki/': { type: 'pki' },
  } } });
  assert.deepEqual(await listMounts(V, 't'), [
    { path: 'kv/', type: 'kv', version: 1 },
    { path: 'secret/', type: 'kv', version: 2 },
    { path: 'totp/', type: 'totp' },
  ]);
});

test('read sends ?version= for old KV v2 versions', async () => {
  const calls = mockFetch({ data: { data: { k: 'old' }, metadata: { version: 1 } } });
  await read(V, 't', { path: 'secret/', type: 'kv', version: 2 }, 'a/b', 1);
  assert.equal(calls[0].url, 'https://vault.example/v1/secret/data/a/b?version=1');
});

test('totp reads code and period with GET only; period defaults to 30', async () => {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (url.includes('/code/')) return { status: 200, ok: true, json: async () => ({ data: { code: '123456' } }) };
    return { status: 403, ok: false, json: async () => ({ errors: ['permission denied'] }) };
  };
  const mount = { path: 'totp/', type: 'totp' };
  assert.deepEqual(await totp(V, 't', mount, 'app'), { code: '123456', period: 30 });
  assert.ok(calls.every((c) => c.opts.method === 'GET'));
  for (const [period, expected] of [[60, 60], ['abc', 30], [0, 30], [1, 30], [99999, 30], [2.5, 30]]) {
    globalThis.fetch = async (url) => ({ status: 200, ok: true, json: async () => (url.includes('/code/') ? { data: { code: '1' } } : { data: { period } }) });
    assert.equal((await totp(V, 't', mount, 'app')).period, expected, String(period));
  }
  assert.equal(kvPath(mount, 'list', ''), 'totp/keys/');
});

test('explainNetworkError: unreachable vs redirect vs a vault error, without sending the token', async () => {
  const { explainNetworkError } = await import('../extension/vault.js');
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push(opts); throw new TypeError('Failed to fetch'); };
  assert.match(await explainNetworkError(V, new TypeError('Failed to fetch')), /Could not reach https:\/\/vault\.example\. Check/);
  globalThis.fetch = async (url, opts) => { calls.push(opts); return { type: 'opaqueredirect', status: 0 }; };
  assert.match(await explainNetworkError(V, new TypeError('Failed to fetch')), /answers with a redirect/);
  globalThis.fetch = async (url, opts) => { calls.push(opts); return { type: 'basic', status: 503 }; };
  assert.match(await explainNetworkError(V, new TypeError('Failed to fetch')), /is sealed/);
  assert.ok(calls.every((o) => !o.headers), 'the diagnosis request carries no token');
  const denied = Object.assign(new Error('Vault: permission denied'), { status: 403 });
  assert.match(await explainNetworkError(V, denied), /^This token is not valid for https:\/\/vault\.example: it is expired, revoked, or belongs to another vault\.$/);
  const other = Object.assign(new Error('Vault: internal error'), { status: 500 });
  assert.equal(await explainNetworkError(V, other), 'Vault: internal error');
});

test('looksLikePin: digits-only short values are PINs, Vault tokens are not', async () => {
  const { looksLikePin } = await import('../extension/vault.js');
  for (const v of ['1234', '482913', '000000000000']) assert.equal(looksLikePin(v), true, v);
  for (const v of ['hvs.CAESIabc', 's.abcdef', '12', '1234567890123', 'abcd1234']) assert.equal(looksLikePin(v), false, v);
});

test('diagnose: connection status from sys/health, with a timeout', async () => {
  const { diagnose } = await import('../extension/vault.js');
  const answer = (r) => { globalThis.fetch = async (url, opts) => { assert.ok(opts.signal, 'has a timeout'); return r; }; };
  answer({ type: 'basic', status: 200 }); assert.equal(await diagnose(V), 'reachable');
  answer({ type: 'basic', status: 429 }); assert.equal(await diagnose(V), 'reachable'); // standby node
  answer({ type: 'basic', status: 503 }); assert.equal(await diagnose(V), 'sealed');
  answer({ type: 'opaqueredirect', status: 0 }); assert.equal(await diagnose(V), 'redirect');
  globalThis.fetch = async () => { throw new DOMException('timed out', 'TimeoutError'); };
  assert.equal(await diagnose(V), 'unreachable');
});

test('request gives up after the timeout; the message says the vault did not answer', async () => {
  const { request, explainNetworkError, REQUEST_TIMEOUT_S } = await import('../extension/vault.js');
  let signal;
  globalThis.fetch = async (url, opts) => { signal = opts.signal; throw new DOMException('timed out', 'TimeoutError'); };
  const err = await request(V, 't', 'GET', 'auth/token/lookup-self').catch((e) => e);
  assert.ok(signal instanceof AbortSignal, 'every request has a timeout signal');
  assert.equal(err.name, 'TimeoutError');
  assert.equal(await explainNetworkError(V, err), `https://vault.example did not answer within ${REQUEST_TIMEOUT_S} s. Check that the vault is running and reachable from this network (VPN?).`);
});
