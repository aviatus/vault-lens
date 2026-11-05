// Large, realistic-looking but entirely fabricated data set for the dev Vaults.
// Deterministic (seeded PRNG): every run produces the same paths and values.
// Paths deliberately avoid the words the E2E tests search for ("billing", "config", "demo", "team/").

function prng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALNUM = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function maker(seed) {
  const rnd = prng(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const str = (n, chars = ALNUM) => Array.from({ length: n }, () => pick(chars)).join('');
  const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));
  return { rnd, pick, str, int };
}

const TEAMS = ['payments', 'checkout', 'catalog', 'search', 'logistics', 'identity', 'notifications', 'analytics',
  'platform', 'mobile', 'marketing', 'fraud', 'pricing', 'inventory', 'seller', 'support'];
const ENVS = ['prod', 'preprod', 'staging', 'qa', 'dev'];
const SERVICE_SUFFIXES = ['api', 'worker', 'gateway', 'scheduler', 'consumer', 'admin', 'cron'];

// Secret kinds: name -> value factory. Field names follow what real apps store.
function kinds(m, host) {
  return {
    database: () => ({ host: `pg-${host}.db.internal.test`, port: '5432', database: host.replace(/-/g, '_'), username: `${host}_app`, password: `fake-${m.str(24)}` }),
    redis: () => ({ host: `redis-${host}.cache.internal.test`, port: '6379', password: `fake-${m.str(20)}` }),
    kafka: () => ({ endpoint: `kafka-${m.int(1, 6)}.mq.internal.test:9092`, username: `${host}-producer`, password: `fake-${m.str(20)}`, sasl_mechanism: 'SCRAM-SHA-512' }),
    'api-keys': () => ({ api_key: `fk_${m.str(32)}`, api_secret: `fs_${m.str(40)}` }),
    'oauth-client': () => ({ client_id: `${host}-${m.str(8).toLowerCase()}`, client_secret: `fake-${m.str(36)}`, issuer: 'https://sso.internal.test/realms/main' }),
    smtp: () => ({ host: 'smtp.mail.internal.test', port: '587', username: `${host}@mail.internal.test`, password: `fake-${m.str(16)}` }),
    's3-bucket': () => ({ bucket: `${host}-assets`, region: m.pick(['eu-central-1', 'eu-west-1', 'us-east-1']), access_key_id: `AKIAFAKE${m.str(12, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')}`, secret_access_key: `fake/${m.str(36)}` }),
    jwt: () => ({ signing_key: `fake-${m.str(64)}`, ttl: `${m.pick([15, 30, 60])}m` }),
    sentry: () => ({ dsn: `https://${m.str(32).toLowerCase()}@sentry.internal.test/${m.int(10, 999)}` }),
    grafana: () => ({ url: `https://grafana.internal.test/d/${m.str(9)}`, username: 'viewer', password: `fake-${m.str(14)}` }),
    'feature-flags': () => ({ sdk_key: `sdk-${m.str(30)}`, environment: host.split('-').pop() }),
    'tls-cert': () => ({
      cert: `-----BEGIN FAKE CERTIFICATE-----\n${Array.from({ length: 6 }, () => m.str(64, BASE32)).join('\n')}\n-----END FAKE CERTIFICATE-----`,
      key: `-----BEGIN FAKE PRIVATE KEY-----\n${Array.from({ length: 4 }, () => m.str(64, BASE32)).join('\n')}\n-----END FAKE PRIVATE KEY-----`,
    }),
  };
}

// Vault A, KV v2 "secret/": secret/<team>/<env>/<service>/<kind>   (16 x 5 x 7 x 6..9 ≈ 4250; search walks up to 5000 per mount)
export function vaultAKv2() {
  const m = maker(42);
  const out = [];
  for (const team of TEAMS) {
    for (const env of ENVS) {
      for (const suffix of SERVICE_SUFFIXES) {
        const service = `${team}-${suffix}`;
        const k = kinds(m, `${service}-${env}`);
        const names = Object.keys(k).sort(() => m.rnd() - 0.5).slice(0, m.int(6, 9));
        for (const name of names) {
          // ~1 in 8 secrets gets extra versions so the history view has something to show
          const versions = m.rnd() < 0.125 ? m.int(2, 5) : 1;
          out.push({ path: `${team}/${env}/${service}/${name}`, versions: Array.from({ length: versions }, () => k[name]()) });
        }
      }
    }
  }
  return out;
}

// Vault A, KV v1 "kv/": kv/legacy-apps/<app>/<env>/<kind>  (≈ 375)
export function vaultAKv1() {
  const m = maker(7);
  const apps = ['erp', 'crm', 'hr-portal', 'intranet', 'wiki', 'ftp-gateway', 'reporting', 'archive', 'ldap-sync', 'print-server',
    'old-shop', 'b2b-portal', 'edi', 'call-center', 'ivr'];
  const out = [];
  for (const app of apps) {
    for (const env of ENVS) {
      const k = kinds(m, `${app}-${env}`);
      for (const name of Object.keys(k).slice(0, m.int(4, 6))) out.push({ path: `legacy-apps/${app}/${env}/${name}`, data: k[name]() });
    }
  }
  return out;
}

// Vault A, TOTP "totp/": one key per team/env admin account (16 x 5 = 80)
export function vaultATotp() {
  const m = maker(99);
  return TEAMS.flatMap((team) => ENVS.map((env) => ({
    name: `${team}-${env}-admin`,
    url: `otpauth://totp/Fake:${team}-${env}@internal.test?secret=${m.str(32, BASE32)}&issuer=Fake`,
  })));
}

// Vault B, KV v2 "secret/": secret/apps/<app>/<env>/<kind> and secret/shared/<area>/<kind>  (≈ 1850)
export function vaultBKv2() {
  const m = maker(2024);
  const apps = ['storefront', 'courier-app', 'warehouse', 'returns', 'loyalty', 'reviews', 'recommendations', 'cms',
    'media', 'payouts', 'invoices', 'tax', 'kyc', 'chatbot', 'push', 'sms', 'geo', 'routing', 'slots', 'tracking',
    'wallet', 'coupons', 'gift-cards', 'subscriptions', 'auctions', 'marketplace-sync', 'image-resizer', 'translations',
    'sitemap', 'affiliate', 'crm-bridge', 'erp-bridge'];
  const out = [];
  for (const app of apps) {
    for (const env of ENVS) {
      const k = kinds(m, `${app}-${env}`);
      for (const name of Object.keys(k).slice(0, m.int(10, 12))) out.push({ path: `apps/${app}/${env}/${name}`, versions: [k[name]()] });
    }
  }
  for (const area of ['observability', 'ci', 'vpn', 'registry', 'dns', 'cdn', 'waf', 'backup']) {
    const k = kinds(m, area);
    for (const name of Object.keys(k)) out.push({ path: `shared/${area}/${name}`, versions: [k[name]()] });
  }
  return out;
}

// Run fn over items with at most `limit` in flight.
export async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}
