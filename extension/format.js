// Pure formatting helpers (no DOM, no chrome.*) so they can be unit-tested in Node.

export const ENVS = { prod: 'Prod', test: 'Test', dev: 'Dev' };

// Remaining token lifetime: "1h 05m" above an hour, "mm:ss" below.
export function formatTtl(sec) {
  if (sec == null) return 'no expiry';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}h ${pad(m)}m` : `${pad(m)}:${pad(s)}`;
}

export const valueText = (raw) => (typeof raw === 'string' ? raw : JSON.stringify(raw));

// Keys and values come from whoever wrote the secret, and the text may end up pasted into a shell.
export const isEnvKey = (k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k);

// KEY=value lines. Keys that are not valid variable names are skipped (see isEnvKey). Values that are not
// plain tokens are single-quoted, which stops $(), ${} and backtick expansion in shells; a ' inside is
// written as '\'' (shell syntax; dotenv parsers keep it literally).
export function toEnv(data) {
  return Object.entries(data)
    .filter(([k]) => isEnvKey(k))
    .map(([k, raw]) => {
      const v = valueText(raw);
      return `${k}=${/^[\w./:@+-]*$/.test(v) ? v : `'${v.replaceAll("'", "'\\''")}'`}`;
    })
    .join('\n');
}

// "a/b/" -> "a/"; "a/" -> ""
export const parentPath = (path) => path.replace(/[^/]+\/$/, '');

// Field keys whose values are not secret and can be shown without masking (deny by default:
// anything not listed here stays masked).
const PLAIN_KEYS = /^(user(_?name)?|login|e?mail|host(_?name)?|port|ur[li]|endpoint|address|region|zone|database|db(_?name)?|schema|account(_?id)?|client_?id|app_?id|tenant(_?id)?|issuer|bucket|env(ironment)?|namespace|retries|timeout|version)$/i;

export function isPlain(key, value) {
  // A URL carrying credentials (scheme://user:pass@host) is still a secret.
  return PLAIN_KEYS.test(key) && !/:\/\/[^/\s]*:[^/\s]*@/.test(value);
}

export const isHttpUrl = (value) => /^https?:\/\/\S+$/.test(value);

// The vault's own web UI page for a location (routes checked against Vault 1.18): KV v2 and v1 folders and
// secrets, an older KV v2 version when one is shown. TOTP has no UI page: the secrets engine list instead.
export function vaultUiUrl(base, mount, path = '', secret = null, version = null) {
  const ui = `${base}/ui/vault/secrets`;
  if (!mount || mount.type === 'totp') return ui;
  const m = encodeURIComponent(mount.path.replace(/\/$/, ''));
  const segments = (p) => p.split('/').map(encodeURIComponent).join('/');
  const folder = path ? `/${segments(path)}` : '';
  if (mount.version === 2) {
    return secret ? `${ui}/${m}/kv/${encodeURIComponent(path + secret)}/details${version ? `?version=${version}` : ''}` : `${ui}/${m}/kv/list${folder}`;
  }
  return secret ? `${ui}/${m}/show/${segments(path + secret)}` : `${ui}/${m}/list${folder}`;
}

export const STALE_DAYS = 180;

export function ageDays(isoTime, now = Date.now()) {
  return Math.floor((now - new Date(isoTime).getTime()) / 86_400_000);
}
