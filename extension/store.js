import * as pinCrypto from './crypto.js';

// chrome.storage.local (persists on disk):
//   vaults       [{ id, name, url, env }]
//   vaultTokens  { [vaultId]: { iv, ct } }  token encrypted with the PIN key, bound to the vault URL
//   pin          { salt, iterations, check }  PIN verifier; the PIN itself is never stored
//   pinAttempts  wrong PINs in a row (kept on disk so a browser restart does not reset it)
//   settings     { clipboardClearSec, autoLockMin, pinTtlMin }
//   favorites    { [vaultId]: [{ mount, path }] }  secret paths only, never values
//   clipboardPending  true while a clipboard clear is scheduled (no value)
// chrome.storage.session (memory only, gone when the browser closes):
//   pinKey, unlockedUntil   PIN-derived key while unlocked, and when the unlock ends
//   addDraft (add-form fields without token/PIN), last (location), places { [vaultId]: { mount, path, secret } }, recent { [vaultId]: [{ mount, path }] }
// Plaintext tokens exist only in the memory of the page that is using them.

// autoLockMin: minutes in the background before locking (-1 never, 0 immediately).
// pinTtlMin: minutes an unlock lasts.
export const DEFAULT_SETTINGS = { clipboardClearSec: 90, autoLockMin: 1, pinTtlMin: 15 };
export const MAX_PIN_ATTEMPTS = 5;
export const PIN_TTL_ALARM = 'pin-ttl';

const local = (key) => chrome.storage.local.get(key).then((r) => r[key]);
const session = (key) => chrome.storage.session.get(key).then((r) => r[key]);

// ---- Vaults and tokens ----

export async function getVaults() {
  return (await local('vaults')) ?? [];
}

async function saveVaults(vaults) {
  await chrome.storage.local.set({ vaults });
}

export async function addVault(vault) {
  await saveVaults([...(await getVaults()), vault]);
}

export async function updateVault(vault) {
  await saveVaults((await getVaults()).map((v) => (v.id === vault.id ? vault : v)));
}

export async function removeVault(id) {
  await saveVaults((await getVaults()).filter((v) => v.id !== id));
  for (const key of ['favorites', 'vaultTokens']) {
    const all = (await local(key)) ?? {};
    delete all[id];
    await chrome.storage.local.set({ [key]: all });
  }
  const recent = (await session('recent')) ?? {};
  delete recent[id];
  const places = (await session('places')) ?? {};
  delete places[id];
  await chrome.storage.session.set({ recent, places });
  if ((await getLast())?.vaultId === id) await setLast(null);
}

export async function hasToken(id) {
  return Boolean(((await local('vaultTokens')) ?? {})[id]);
}

// Decrypted with the session key and the vault's *current* URL: a token saved for another address
// does not decrypt. -> token, or undefined when locked / missing / bound to another address.
export async function getToken(vault) {
  const key = await activeKey();
  const blob = ((await local('vaultTokens')) ?? {})[vault.id];
  if (!key || !blob) return undefined;
  return pinCrypto.decrypt(key, blob, vault.url).catch(() => undefined);
}

export async function setToken(vault, token) {
  const key = await activeKey();
  if (!key) throw new Error('Locked: enter the PIN first.');
  const all = (await local('vaultTokens')) ?? {};
  all[vault.id] = await pinCrypto.encrypt(key, token, vault.url);
  await chrome.storage.local.set({ vaultTokens: all });
}

// ---- PIN and unlock session ----

export async function getPinConfig() {
  return (await local('pin')) ?? null;
}

// Key of the current unlock, or null when locked. An unlock past its time is ended here too, so the
// service-worker alarm is not the only guard.
export async function activeKey() {
  const { pinKey, unlockedUntil } = await chrome.storage.session.get(['pinKey', 'unlockedUntil']);
  if (pinKey && unlockedUntil > Date.now()) return pinKey;
  if (pinKey) await lockSession();
  return null;
}

export async function unlockedUntil() {
  return (await session('unlockedUntil')) ?? null;
}

// The PIN only matters while it protects something: a PIN config without any saved token (for example one
// left by an older version, or after the tokens were wiped) is ignored and replaced by the next setup.
export async function pinInUse() {
  return Boolean(await getPinConfig()) && Object.keys((await local('vaultTokens')) ?? {}).length > 0;
}

export async function isLocked() {
  return (await pinInUse()) && !(await activeKey());
}

async function startSession(key) {
  const { pinTtlMin } = await getSettings();
  const until = Date.now() + pinTtlMin * 60_000;
  await chrome.storage.session.set({ pinKey: key, unlockedUntil: until });
  await chrome.storage.local.remove('pinAttempts');
  chrome.alarms.create(PIN_TTL_ALARM, { when: until });
}

export async function lockSession() {
  await chrome.storage.session.remove(['pinKey', 'unlockedUntil']);
  await chrome.alarms.clear(PIN_TTL_ALARM);
}

// First PIN, chosen while adding the first token (replaces an unused config).
export async function setupPin(pin) {
  if (await pinInUse()) throw new Error('A PIN is already set.');
  const { config, key } = await pinCrypto.createPin(pin);
  await chrome.storage.local.set({ pin: config });
  await startSession(key);
}

// -> { ok: true } | { ok: false, attemptsLeft } | { ok: false, wiped: true }: after too many wrong PINs
// the encrypted tokens are deleted, so the PIN cannot be guessed through the UI.
export async function unlockSession(pin) {
  const config = await getPinConfig();
  const key = config && (await pinCrypto.verifyPin(pin, config));
  if (key) {
    await startSession(key);
    return { ok: true };
  }
  return wrongPin();
}

// Counts one wrong PIN (unlock or change-PIN alike) and wipes the saved tokens at MAX_PIN_ATTEMPTS.
// navigator.locks serializes the read and write across extension pages, so parallel guesses all count.
function wrongPin() {
  return navigator.locks.request('pin-attempts', async () => {
    const attempts = ((await local('pinAttempts')) ?? 0) + 1;
    if (attempts >= MAX_PIN_ATTEMPTS) {
      await forgetPinAndTokens(); // nothing is encrypted with this PIN any more; the next token sets a new one
      return { ok: false, wiped: true };
    }
    await chrome.storage.local.set({ pinAttempts: attempts });
    return { ok: false, attemptsLeft: MAX_PIN_ATTEMPTS - attempts };
  });
}

// Wrong-PIN wipe and "Forgot PIN" remove the same things: PIN, saved tokens, and the session's paths.
async function forgetPinAndTokens() {
  await chrome.storage.local.remove(['pin', 'vaultTokens', 'pinAttempts']);
  await chrome.storage.session.remove(['last', 'places', 'recent']);
  await lockSession();
}

// Re-encrypts every saved token with the new PIN's key. Tokens that no longer decrypt are dropped.
// Returns { ok: true } or the wrongPin() result. Only while unlocked: it is not a second way to unlock.
export async function changePin(currentPin, newPin) {
  if (!(await activeKey())) throw new Error('Locked: enter the PIN first.');
  const config = await getPinConfig();
  const oldKey = config && (await pinCrypto.verifyPin(currentPin, config));
  if (!oldKey) return wrongPin();
  const vaults = await getVaults();
  const blobs = (await local('vaultTokens')) ?? {};
  const plain = {};
  for (const v of vaults) {
    if (blobs[v.id]) plain[v.id] = await pinCrypto.decrypt(oldKey, blobs[v.id], v.url).catch(() => null);
  }
  const { config: next, key } = await pinCrypto.createPin(newPin);
  const reencrypted = {};
  for (const v of vaults) if (plain[v.id]) reencrypted[v.id] = await pinCrypto.encrypt(key, plain[v.id], v.url);
  await chrome.storage.local.set({ pin: next, vaultTokens: reencrypted });
  await startSession(key);
  return { ok: true };
}

// Forgotten PIN: nothing can be decrypted any more, so the PIN and all saved tokens go (vaults stay).
export async function resetPin() {
  await forgetPinAndTokens();
}

// ---- Location, settings, favorites, recent ----

export async function getLast() {
  return (await session('last')) ?? null;
}

export async function setLast(last) {
  if (last) {
    // Each vault also remembers its own last location, restored when switching back to it.
    const places = (await session('places')) ?? {};
    places[last.vaultId] = last;
    await chrome.storage.session.set({ last, places });
  } else await chrome.storage.session.remove('last');
}

export async function getPlace(vaultId) {
  return ((await session('places')) ?? {})[vaultId] ?? null;
}

// Add/edit form draft { name, url, env, editingId, askedAt }: only the non-secret fields, never the token or
// PIN, so the form survives the popup closing while Chrome asks for access to the vault's address.
export async function getDraft() {
  return (await session('addDraft')) ?? null;
}

export function setDraft(draft) {
  return draft ? chrome.storage.session.set({ addDraft: draft }) : chrome.storage.session.remove('addDraft');
}

// Only the values the Settings screen offers; anything else in storage falls back to the default.
const ALLOWED_SETTINGS = { clipboardClearSec: [0, 30, 60, 90, 120], autoLockMin: [-1, 0, 1, 5, 15], pinTtlMin: [5, 15, 30, 60] };
export async function getSettings() {
  const saved = (await local('settings')) ?? {};
  return Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([k, d]) => [k, ALLOWED_SETTINGS[k].includes(saved[k]) ? saved[k] : d]));
}

export async function setSettings(patch) {
  await chrome.storage.local.set({ settings: { ...(await getSettings()), ...patch } });
}

const sameEntry = (a, b) => a.mount.path === b.mount.path && a.path === b.path;

export async function getFavorites(vaultId) {
  return ((await local('favorites')) ?? {})[vaultId] ?? [];
}

export async function toggleFavorite(vaultId, entry) {
  const all = (await local('favorites')) ?? {};
  const list = all[vaultId] ?? [];
  const on = !list.some((e) => sameEntry(e, entry));
  all[vaultId] = on ? [...list, entry] : list.filter((e) => !sameEntry(e, entry));
  await chrome.storage.local.set({ favorites: all });
  return on;
}

export async function getRecent(vaultId) {
  return ((await session('recent')) ?? {})[vaultId] ?? [];
}

export async function addRecent(vaultId, entry) {
  const recent = (await session('recent')) ?? {};
  recent[vaultId] = [entry, ...(recent[vaultId] ?? []).filter((e) => !sameEntry(e, entry))].slice(0, 5);
  await chrome.storage.session.set({ recent });
}
