// Seeds the dev Vaults with fabricated data, a read-only policy and a read-only token per Vault.
// Standalone: `node e2e/seed.js` prints the tokens (for manual testing after `npm run vault:up`).
import { fileURLToPath } from 'node:url';
import { pool, vaultAKv1, vaultAKv2, vaultATotp, vaultBKv2 } from './bulk.js';

export const VAULT_A = 'http://127.0.0.1:18200';
export const VAULT_B = 'http://127.0.0.1:18201';
const ROOT = 'root'; // dev-mode root token from docker-compose.yml

async function api(addr, method, path, body) {
  const res = await fetch(`${addr}/v1/${path}`, {
    method,
    headers: { 'X-Vault-Token': ROOT, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function waitReady(addr) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${addr}/v1/sys/health`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Vault ${addr} did not become ready`);
}

const put = (addr, path, data) => api(addr, 'POST', `secret/data/${path}`, { data });

// Bulk data is written once per Vault; a kept-up Vault (KEEP_VAULT=1) is not rewritten on every run.
async function seedBulk(addr, kv2, extra = async () => {}) {
  const last = kv2.at(-1).path;
  const done = await fetch(`${addr}/v1/secret/metadata/${last}`, { headers: { 'X-Vault-Token': ROOT } });
  if (done.ok) return;
  await pool(kv2, 32, async ({ path, versions }) => {
    for (const data of versions) await put(addr, path, data); // versions of one path must stay in order
  });
  await extra();
}

async function readonlyToken(addr, policy) {
  await api(addr, 'PUT', 'sys/policies/acl/readonly', { policy });
  const { auth } = await api(addr, 'POST', 'auth/token/create', { policies: ['readonly'], ttl: '1h' });
  return auth.client_token;
}

export async function seed() {
  await Promise.all([waitReady(VAULT_A), waitReady(VAULT_B)]);

  // Vault A: KV v2 at secret/ (dev default) + KV v1 at kv/
  await put(VAULT_A, 'demo/app', { username: 'demo-user', password: 'uydurma-parola-123', api_key: 'fake-api-key-abc' });
  // two versions: v1 (and every odd version on re-seed) is the old host, the latest is the new one
  await put(VAULT_A, 'demo/db', { host: 'db-old.example.test', port: '5432', password: 'eski-parola' });
  await put(VAULT_A, 'demo/db', { host: 'db.example.test', port: '5432', password: 'yeni-parola' });
  await put(VAULT_A, 'demo/services/billing/config', { webhook_url: 'https://billing.example.test/hook' });
  await put(VAULT_A, 'demo/tls', { cert: '-----BEGIN FAKE CERT-----\nAAAA\nBBBB\n-----END FAKE CERT-----' });
  await put(VAULT_A, 'restricted/root-creds', { password: 'okunmamali' });
  const mounts = await api(VAULT_A, 'GET', 'sys/mounts');
  if (!mounts.data['kv/']) await api(VAULT_A, 'POST', 'sys/mounts/kv', { type: 'kv', options: { version: '1' } });
  await api(VAULT_A, 'POST', 'kv/legacy/config', { endpoint: 'https://legacy.example.test', retries: '3' });
  // TOTP engine with a fabricated key (the well-known RFC example secret)
  if (!mounts.data['totp/']) await api(VAULT_A, 'POST', 'sys/mounts/totp', { type: 'totp' });
  await api(VAULT_A, 'POST', 'totp/keys/demo-app', { url: 'otpauth://totp/Demo:demo@example.test?secret=JBSWY3DPEHPK3PXP&issuer=Demo' });
  await seedBulk(VAULT_A, vaultAKv2(), async () => {
    await pool(vaultAKv1(), 32, ({ path, data }) => api(VAULT_A, 'POST', `kv/${path}`, data));
    await pool(vaultATotp(), 16, ({ name, url }) => api(VAULT_A, 'POST', `totp/keys/${name}`, { url }));
  });
  const tokenA = await readonlyToken(VAULT_A, `
    path "secret/metadata/*" { capabilities = ["list"] }
    path "secret/data/*" { capabilities = ["read"] }
    path "secret/data/restricted/*" { capabilities = ["deny"] }
    path "kv/*" { capabilities = ["list", "read"] }
    path "totp/keys" { capabilities = ["list"] }
    path "totp/keys/*" { capabilities = ["read"] }
    path "totp/code/*" { capabilities = ["read"] }
  `); // restricted/ is listable but not readable -> exercises the 403 path

  // Vault B: separate instance with its own token
  await put(VAULT_B, 'team/service', { client_id: 'svc-demo', client_secret: 'fake-secret-b' });
  await seedBulk(VAULT_B, vaultBKv2());
  const tokenB = await readonlyToken(VAULT_B, `
    path "secret/metadata/*" { capabilities = ["list"] }
    path "secret/data/*" { capabilities = ["read"] }
  `);

  return { tokenA, tokenB };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { tokenA, tokenB } = await seed();
  console.log(`Seed: Vault A ${vaultAKv2().length} KV v2 + ${vaultAKv1().length} KV v1 + ${vaultATotp().length} TOTP, Vault B ${vaultBKv2().length} KV v2 (+ test kayıtları)`);
  console.log(`Vault A  ${VAULT_A}  read-only token: ${tokenA}`);
  console.log(`Vault B  ${VAULT_B}  read-only token: ${tokenB}`);
}
