// Vault HTTP API client. Read-only by design: only GET and LIST ever leave this module.
// No chrome.* usage here so it can be unit-tested with plain Node.

const READ_ONLY_METHODS = new Set(['GET', 'LIST']);
// A vault behind a VPN that is not connected never answers; without a limit the browser waits over a minute.
export const REQUEST_TIMEOUT_S = 15;

export async function request(vault, token, method, path, params = {}) {
  if (!READ_ONLY_METHODS.has(method)) throw new Error(`Read-only extension: ${method} requests are not allowed.`);
  const headers = { 'X-Vault-Token': token };
  const segments = path.split('/');
  // Names come from Vault responses (lower-trust secret authors); '.'/'..' would let URL parsing
  // move the request to another API path on the same server.
  if (segments.some((s) => s === '.' || s === '..')) throw new Error(`Invalid path: ${path}`);
  const encoded = segments.map(encodeURIComponent).join('/');
  // LIST is sent as GET ?list=true (Vault supports both); avoids a custom HTTP verb.
  const query = new URLSearchParams({ ...(method === 'LIST' ? { list: 'true' } : {}), ...params }).toString();
  const url = `${vault.url}/v1/${encoded}${query ? `?${query}` : ''}`;
  // redirect:'error': X-Vault-Token is a custom header and would survive a cross-origin redirect.
  const res = await fetch(url, { method: 'GET', headers, credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_S * 1000) });
  if (res.status === 404) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Server text is shown in the UI: label it and cap the length so it cannot pose as extension UI.
    // Vault wraps several errors as "2 errors occurred:\n\t* a\n\t* b": keep just the items.
    const items = (body.errors ?? []).flatMap((e) => String(e).split('\n')).map((l) => l.replace(/^\s*\*\s*/, '').trim())
      .filter((l) => l && !/^\d+ errors? occurred:?$/.test(l));
    const msg = items.length ? items.join('; ') : `HTTP ${res.status}`;
    const err = new Error(`Vault: ${String(msg).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

export async function lookupSelf(vault, token) {
  const body = await request(vault, token, 'GET', 'auth/token/lookup-self');
  if (!body) throw new Error('Could not verify the token.');
  return body.data; // { ttl, display_name, policies, ... }
}

// sys/internal/ui/mounts is readable by Vault's default policy and only returns mounts the token can see.
export async function listMounts(vault, token) {
  const body = await request(vault, token, 'GET', 'sys/internal/ui/mounts');
  const secret = body?.data?.secret ?? {};
  return Object.entries(secret)
    .filter(([, m]) => ['kv', 'generic', 'totp'].includes(m.type))
    .map(([path, m]) => (m.type === 'totp' ? { path, type: 'totp' } : { path, type: 'kv', version: m.options?.version === '2' ? 2 : 1 }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

// mount.path ends with "/" (as returned by Vault); KV v2 splits list/read into metadata/ and data/.
// TOTP mounts are flat: keys are listed under keys/.
export function kvPath(mount, kind, path) {
  if (mount.type === 'totp') return `${mount.path}keys/`;
  if (mount.version === 1) return mount.path + path;
  return mount.path + (kind === 'list' ? 'metadata/' : 'data/') + path;
}

export async function list(vault, token, mount, path) {
  const body = await request(vault, token, 'LIST', kvPath(mount, 'list', path));
  return body?.data?.keys ?? [];
}

// Every secret path under a mount. Folders the token cannot list are skipped.
// pace: { limit } shared by every walk of one index, so all mounts together send at most `limit` LISTs at
// a time; raising pace.limit and calling pace.kick() speeds up walks already running.
// shortcut: stops at `max` paths; upgrade to streaming/paged results if Vaults grow beyond that.
export function listAll(vault, token, mount, max = 5000, pace = { limit: 8 }) {
  pace.active ??= 0;
  pace.pumps ??= new Set();
  pace.kick ??= () => pace.pumps.forEach((pump) => pump());
  const found = [];
  const queue = [''];
  let running = 0;
  return new Promise((resolve) => {
    const finished = () => !running && (!queue.length || found.length >= max);
    const pump = () => {
      while (queue.length && found.length < max && pace.active < pace.limit) {
        const folder = queue.shift();
        pace.active++;
        running++;
        list(vault, token, mount, folder).catch(() => []).then((keys) => {
          for (const k of keys) (k.endsWith('/') ? queue : found).push(folder + k);
        }).finally(() => {
          pace.active--;
          running--;
          pace.kick(); // a free slot: let any walk sharing this pace continue
        });
      }
      if (finished()) {
        pace.pumps.delete(pump);
        resolve(found.slice(0, max));
      }
    };
    pace.pumps.add(pump);
    pump();
  });
}

// -> { data, meta } or null. meta is KV v2's version metadata ({ version, created_time, ... }), null on v1.
// version (KV v2 only) reads an older version; deleted/destroyed versions come back as null.
export async function read(vault, token, mount, path, version) {
  const body = await request(vault, token, 'GET', kvPath(mount, 'read', path), version ? { version } : {});
  if (!body) return null;
  if (mount.version === 1) return { data: body.data, meta: null };
  return body.data?.data ? { data: body.data.data, meta: body.data.metadata ?? null } : null;
}

// TOTP engine: Vault generates the current code (GET, read-only). period comes from the key config
// when the token may read it, otherwise the TOTP default of 30 s.
export async function totp(vault, token, mount, name) {
  const [code, key] = await Promise.all([
    request(vault, token, 'GET', `${mount.path}code/${name}`),
    request(vault, token, 'GET', `${mount.path}keys/${name}`).catch(() => null),
  ]);
  if (!code) return null;
  const period = Number(key?.data?.period);
  // A bogus period (NaN, 0, huge) from the server would drive a tight refresh loop in the UI.
  return { code: String(code.data.code), period: Number.isInteger(period) && period >= 5 && period <= 300 ? period : 30 };
}

// Why a request failed at the network level ("Failed to fetch"), checked without sending any token:
// 'unreachable' (down, wrong address, VPN needed), 'redirect' (requests are never followed through a
// redirect, so the token cannot leak) or 'reachable' (something else went wrong).
// Connection check without a token: 'reachable' | 'sealed' | 'redirect' | 'unreachable' (also after 5 s).
export async function diagnose(vault) {
  try {
    const res = await fetch(`${vault.url}/v1/sys/health`, { redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (res.type === 'opaqueredirect') return 'redirect';
    return res.status === 503 ? 'sealed' : 'reachable'; // sys/health answers 503 while sealed
  } catch {
    return 'unreachable';
  }
}

// Vault tokens look like hvs.…, hvb.…, s.… or b.…; a short all-digit value is almost certainly a PIN typed
// into the token field, and must not be sent to the server.
export const looksLikePin = (value) => /^\d{4,12}$/.test(value);

export async function explainNetworkError(vault, err) {
  if (err.status === 403) return `This token is not valid for ${vault.url}: it is expired, revoked, or belongs to another vault.`;
  if (err.status) return err.message; // the vault answered: its own message
  if (err.name === 'TimeoutError') return `${vault.url} did not answer within ${REQUEST_TIMEOUT_S} s. Check that the vault is running and reachable from this network (VPN?).`;
  const why = await diagnose(vault);
  if (why === 'unreachable') return `Could not reach ${vault.url}. Check that the vault is running and reachable from this network (VPN?).`;
  if (why === 'sealed') return `${vault.url} is sealed. Ask a Vault operator to unseal it.`;
  if (why === 'redirect') return `${vault.url} answers with a redirect. Edit the vault and use the final address: tokens are never sent through redirects.`;
  return `Could not reach the vault: ${err.message}`;
}

export function normalizeUrl(raw) {
  let u;
  try { u = new URL(raw.trim()); } catch { throw new Error('Invalid URL.'); }
  const local = u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !local) {
    throw new Error('Only https:// addresses are accepted (http://localhost is allowed for local development).');
  }
  return u.origin;
}

// Chrome match patterns ignore ports, so the pattern is protocol + hostname.
export function originPattern(origin) {
  const u = new URL(origin);
  return `${u.protocol}//${u.hostname}/*`;
}
