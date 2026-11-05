import * as vault from './vault.js';
import * as store from './store.js';
import { icon } from './icons.js';
import { ENVS, STALE_DAYS, ageDays, isEnvKey, isHttpUrl, isPlain, parentPath, toEnv, vaultUiUrl, valueText } from './format.js';

const $ = (id) => document.getElementById(id);
const VIEWS = ['pin', 'list', 'browse', 'settings'];
const MASK = '••••••••';
const MAX_HITS = 100;
const MAX_VERSIONS = 20;
const PIN_RULE = /^.{4,64}$/u;

// Radix Colors keeps its dark scales on .dark-theme; follow the system setting.
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => document.documentElement.classList.toggle('dark-theme', darkQuery.matches);
applyTheme();
darkQuery.addEventListener('change', applyTheme);

// mount: { path, type, version } | null; path: folder inside the mount ("" or "a/b/"); secret: open item name | null
const EMPTY_STATE = { vault: null, token: null, mount: null, path: '', secret: null, currentVersion: null };
let state = { ...EMPTY_STATE };
let settings = store.DEFAULT_SETTINGS;
let hasPin = false;
// Search index per vault: { token, pace, paths: Promise<[{ mount, path }]> }. Kept while the popup is open so
// switching back to a vault does not walk it again; page memory only, never stored, dropped on lock.
const indexes = new Map();
let secretData = null; // currently shown secret, for the JSON/.env copy buttons
let hideRevealed = []; // re-mask functions of the open secret's revealed fields (privacy curtain)
let lockTimer;
let totpTimer;
let searchTimer;
let editingId = null;
// Every navigation takes a number; when its data arrives it renders only if no newer navigation (or a lock)
// started meanwhile. Until then the previous screen stays, so there is no half-built screen in between.
let viewSeq = 0;
// Views wait for this before rendering: the token check of the vault being opened (see openVaultNow).
let ready = Promise.resolve();
let openSeq = 0; // the latest vault open; an older one that answers late must not touch the screen
let opening = 0; // >0 while openVault runs: storage events it causes itself are ignored

// All DOM text goes through append()/textContent, never innerHTML: secret values cannot inject markup.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else node[k] = v;
  }
  node.append(...children);
  return node;
}

// Wraps an event handler so a failure shows up as an error message instead of leaving the view half-done.
const guard = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (err) {
    setError(err.message || String(err));
  }
};

const iconButton = (name, title, onclick) => el('button', { class: 'icon', title, ariaLabel: title, onclick }, icon(name));
const envChip = (env) => (Object.hasOwn(ENVS, env) && ENVS[env] ? el('span', { class: `chip env-${env}` }, ENVS[env]) : '');

// While the first screen loads, keep the popup at the height it had last time instead of flashing small.
try { document.body.style.minHeight = `${Math.min(Number(localStorage.popupHeight) || 0, 600)}px`; } catch {}

function show(view) {
  for (const v of VIEWS) $(v).hidden = v !== view;
  requestAnimationFrame(() => {
    document.body.style.minHeight = '';
    try { localStorage.popupHeight = String(document.body.offsetHeight); } catch {}
  });
  $('back').hidden = view === 'list' || view === 'pin';
  $('lock-now').hidden = !hasPin || view === 'pin';
  $('open-settings').hidden = view === 'pin';
  if (view !== 'browse') {
    clearInterval(lockTimer);
    clearInterval(totpTimer);
  }
  document.body.dataset.env = view === 'browse' ? state.vault?.env ?? '' : '';
  setError('');
}

// action: { label, run } adds one button to the message, for a problem the user can fix right there.
let errorAction = null;
function setError(msg, action = null) {
  errorAction = msg ? action : null;
  $('error').textContent = msg;
  $('error-box').hidden = !msg;
  $('error-action').hidden = !errorAction;
  $('error-action').textContent = errorAction?.label ?? '';
}
$('error-action').addEventListener('click', guard(async () => {
  const action = errorAction;
  setError($('error').textContent); // keep the reason on screen; the button has done its job
  await action?.run();
}));

// Thin bar under the header while the vault is being waited for (connecting, loading a folder or secret).
// CSS shows it only after a short delay, so fast answers do not flicker.
let busyCount = 0;
function track(promise) {
  busyCount++;
  $('busy').hidden = false;
  return promise.finally(() => {
    if (--busyCount === 0) $('busy').hidden = true;
  });
}

let toastTimer;
function toast(msg) {
  $('toast').textContent = msg;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 1800);
}

async function copy(text, button) {
  await navigator.clipboard.writeText(text);
  // The service worker clears the clipboard later, even after the popup has closed.
  chrome.runtime.sendMessage({ type: 'copied' }).catch(() => {});
  toast(settings.clipboardClearSec ? `Copied · cleared from the clipboard in ${settings.clipboardClearSec} s` : 'Copied');
  if (button?.classList.contains('icon')) {
    button.replaceChildren(icon('check'));
    setTimeout(() => button.replaceChildren(icon('copy')), 1200);
  }
}

// ---- Header ----

$('back').append(icon('back'));
$('back').addEventListener('click', renderList);
$('lock-now').append(icon('lock'));
$('lock-now').addEventListener('click', () => store.lockSession()); // the storage listener shows the PIN screen
$('open-settings').append(icon('settings'));
$('open-settings').addEventListener('click', renderSettings);

// ---- Sync between open extension pages and the service worker ----

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (changes.pin || changes.vaultTokens) hasPin = await store.pinInUse();
  if (area === 'session' && changes.pinKey) {
    // Locked anywhere (button, unlock time up, background): wipe this view and ask for the PIN.
    if (!changes.pinKey.newValue && hasPin) return showLocked();
    // Unlocked in another window: continue here too.
    if (changes.pinKey.newValue && !$('pin').hidden) return init();
  }
  if ((!changes.vaultTokens && !changes.vaults) || opening) return;
  if (!$('list').hidden) {
    const shown = [$('error').textContent, errorAction]; // one change arrives as several events: keep the message
    await renderList();
    return setError(...shown);
  }
  if ($('browse').hidden || !state.token) return;
  // A vault deleted, its address changed or its token replaced elsewhere: do not keep using stale data.
  const v = (await store.getVaults()).find((x) => x.id === state.vault?.id);
  if (v && v.url === state.vault.url && (await store.getToken(v)) === state.token) return;
  state.token = null;
  await renderList();
  setError(v ? "This vault's address or token was changed in another window." : 'This vault was deleted in another window.');
});

// ---- PIN screen ----

// Drops everything secret this view holds (token, values, paths) and shows the PIN screen.
function showLocked() {
  viewSeq++;
  openSeq++; // a vault open still waiting (token decrypt, lookup-self) must not continue after the lock
  clearInterval(lockTimer);
  clearInterval(totpTimer);
  state = { ...EMPTY_STATE };
  indexes.clear();
  secretData = null;
  hideRevealed = [];
  for (const id of ['items', 'crumbs', 'switch']) $(id).replaceChildren();
  $('secret').tBodies[0].replaceChildren();
  $('totp-code').textContent = '';
  $('add-token').value = '';
  clearSearch();
  $('curtain').hidden = true;
  show('pin');
  $('pin-input').value = '';
  $('pin-input').focus();
}

$('pin-form').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const pin = $('pin-input').value;
  const button = $('pin-form').querySelector('button[type=submit]');
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = 'Unlocking…'; // deriving the key takes a moment by design
  try {
    const res = await store.unlockSession(pin);
    $('pin-input').value = '';
    if (res.ok) return init();
    if (res.wiped) {
      hasPin = false;
      statuses.clear(); // the tokens are gone
      await renderList();
      return setError('Too many wrong PINs: the saved tokens and the PIN were deleted. Edit each vault to enter its token and choose a new PIN.');
    }
    setError(`Wrong PIN. ${res.attemptsLeft} attempt(s) left before the saved tokens are deleted.`);
    $('pin-input').focus();
  } finally {
    button.disabled = false;
    button.textContent = 'Unlock';
  }
}));

// "Forgot PIN" on the PIN screen and in Settings. Two-step like delete: without the PIN the saved tokens
// can never be read again, so the PIN and the tokens go (vaults stay).
const FORGOT = 'Forgot PIN? Reset the PIN and saved tokens';
function resetPinButton(b, after) {
  b.textContent = FORGOT;
  b.addEventListener('click', guard(async () => {
    if (!b.classList.contains('armed')) {
      b.classList.add('armed');
      b.textContent = 'Click again: remove the PIN and all saved tokens';
      setTimeout(() => { b.classList.remove('armed'); b.textContent = FORGOT; }, 3000);
      return;
    }
    b.classList.remove('armed');
    b.textContent = FORGOT;
    await store.resetPin();
    hasPin = false;
    statuses.clear();
    await after();
  }));
}
resetPinButton($('pin-forgot'), init);
resetPinButton($('settings-reset'), async () => {
  await renderList();
  toast('PIN and saved tokens removed');
});

// ---- Privacy curtain: when this window loses focus, hide what is on screen ----

window.addEventListener('blur', () => {
  if ($('browse').hidden) return;
  for (const hide of hideRevealed) hide();
  $('curtain').hidden = false;
});
$('curtain-show').addEventListener('click', () => { $('curtain').hidden = true; });

// ---- Vault list ----

async function renderList() {
  viewSeq++;
  await store.setLast(null);
  const vaults = await store.getVaults();
  const saved = Object.fromEntries(await Promise.all(vaults.map(async (v) => [v.id, await store.hasToken(v.id)])));
  const ul = $('vaults');
  ul.replaceChildren();
  if (!vaults.length) ul.append(el('li', { class: 'empty' }, 'No vaults yet.'));
  for (const v of vaults) {
    const ok = saved[v.id];
    const row = el('li', { class: 'row', onclick: async () => {
      row.classList.add('connecting');
      row.querySelector('.sub').textContent = `${v.url} · Connecting…`;
      openVault(v, await store.getPlace(v.id));
    } },
      connectionDot(v),
      el('div', { class: 'grow' },
        el('div', { class: 'name' }, v.name, ' ', envChip(v.env)),
        el('div', { class: 'sub' }, v.url, ok ? '' : el('span', { class: 'needs' }, ' · Token needed'))),
      iconButton('edit', 'Edit', (e) => { e.stopPropagation(); startEdit(v); }),
      deleteButton(v));
    ul.append(row);
  }
  $('add').open = !vaults.length || editingId !== null;
  $('add-pin-setup').hidden = hasPin;
  state = { ...EMPTY_STATE };
  show('list');
  restoreDraft();
}

// Status of a vault in the list: can it be used right now? Filled in when the checks answer.
const STATUS = {
  ok: ['ok', 'Connected, token valid'],
  reachable: ['ok', 'Reachable (no saved token to check)'],
  rejected: ['down', 'Token rejected (expired or revoked): edit the vault'],
  sealed: ['warn', 'Sealed'],
  redirect: ['warn', 'Redirects: edit the address'],
  denied: ['warn', 'Access to this address not allowed: edit and save the vault'],
  unreachable: ['down', 'Unreachable (VPN?)'],
};

async function vaultStatus(v) {
  // Without the host permission the request fails like a dead server; say what is really wrong.
  if (!(await chrome.permissions.contains({ origins: [vault.originPattern(v.url)] }))) return ['denied'];
  const why = await vault.diagnose(v);
  if (why !== 'reachable') return [why];
  const token = await store.getToken(v); // undefined: none saved, or locked
  if (!token) return ['reachable'];
  try {
    await vault.lookupSelf(v, token);
    return ['ok'];
  } catch (err) {
    if (err.status === 403) return ['rejected'];
    return err.status ? ['warn', err.message] : ['unreachable'];
  }
}

// Each vault keeps its own last known status (page memory): re-rendering the list for one vault's
// change does not re-check or repaint the others. Opening a vault records what actually happened.
const statuses = new Map(); // vault id -> Promise<[class, label]>
const setStatus = (id, key, message) => statuses.set(id, Promise.resolve(STATUS[key] ?? [key, message]));
const forgetStatus = (id) => statuses.delete(id);

function connectionDot(v) {
  const dot = el('span', { class: 'dot', title: 'Checking…', ariaLabel: 'Checking connection' });
  if (!statuses.has(v.id)) {
    statuses.set(v.id, vaultStatus(v).catch(() => ['unreachable']).then(([key, message]) => STATUS[key] ?? [key, message]));
  }
  statuses.get(v.id).then(([cls, label]) => {
    dot.classList.add(cls);
    dot.title = label;
    dot.ariaLabel = label;
  });
  return dot;
}

// Two-step delete: first click arms the button for 3 s, second click deletes.
function deleteButton(v) {
  const b = iconButton('trash', 'Delete', async (e) => {
    e.stopPropagation();
    if (!b.classList.contains('armed')) {
      b.classList.add('armed');
      b.replaceChildren('Delete?');
      setTimeout(() => { b.classList.remove('armed'); b.replaceChildren(icon('trash')); }, 3000);
      return;
    }
    await store.removeVault(v.id);
    forgetStatus(v.id);
    await releasePermission(v.url);
    renderList();
  });
  return b;
}

// needToken: the saved token is missing or was rejected, so the token field is the one to fill.
function startEdit(v, needToken = false) {
  editingId = v.id;
  $('add-name').value = v.name;
  $('add-url').value = v.url;
  $('add-env').value = v.env ?? '';
  $('add-token').value = '';
  $('add-token').placeholder = needToken ? 'Paste a new Vault token (hvs.…)' : 'Leave empty to keep the saved token';
  $('add-title').textContent = `Edit: ${v.name}`;
  $('add-submit').textContent = 'Save';
  $('add-cancel').hidden = false;
  if ($('list').hidden) renderList();
  $('add').open = true;
  // the token field appears once access to the address is confirmed
  updateHttpNotice().then(() => (needToken ? $('add-token') : $('add-name')).focus());
}

function endEdit() {
  editingId = null;
  store.setDraft(null);
  $('add-form').reset();
  $('add-token').placeholder = '';
  $('add-title').textContent = '+ Add vault';
  $('add-submit').textContent = 'Add';
  $('add-cancel').hidden = true;
  updateHttpNotice();
}

$('add-cancel').addEventListener('click', () => { endEdit(); renderList(); });

const updateHttpNotice = () => {
  $('add-http').hidden = !$('add-url').value.trim().startsWith('http:');
  return updateAccess();
};
$('add-url').addEventListener('input', updateHttpNotice);

// ---- Access to the vault's address comes first ----
// Chrome's permission prompt can close the popup. So access is asked before the token and PIN fields
// appear, and name/address/environment are kept as a draft (never the token or PIN) to survive the close.
let accessSeq = 0;
async function updateAccess() {
  const seq = ++accessSeq;
  let url = null;
  try { url = $('add-url').value.trim() ? vault.normalizeUrl($('add-url').value) : null; } catch { /* shown on submit */ }
  const granted = url ? await chrome.permissions.contains({ origins: [vault.originPattern(url)] }).catch(() => false) : false;
  if (seq !== accessSeq) return;
  $('add-access').hidden = !url || granted;
  if (url) $('add-access-text').textContent = `Chrome will ask to allow access to ${new URL(url).host}. If this window closes meanwhile, open Vault Lens again: the form is kept.`;
  $('add-secret').hidden = !granted;
}

const saveDraft = (extra = {}) => store.setDraft({ name: $('add-name').value, url: $('add-url').value, env: $('add-env').value, editingId, ...extra });
for (const id of ['add-name', 'add-url', 'add-env']) $(id).addEventListener('input', () => saveDraft());

$('add-allow').addEventListener('click', guard(async () => {
  let url;
  try { url = vault.normalizeUrl($('add-url').value); } catch (err) { return setError(err.message); }
  saveDraft({ askedAt: Date.now() }); // not awaited: the request below must start inside the click
  const granted = await chrome.permissions.request({ origins: [vault.originPattern(url)] }).catch(() => false);
  saveDraft();
  if (!granted) return setError('Access to this address is needed to use the vault.');
  await updateAccess();
  $('add-token').focus();
}));

// Puts an unfinished add/edit form back, once per page (the popup may have closed for the permission prompt).
let draftChecked = false;
async function restoreDraft() {
  if (draftChecked) return;
  draftChecked = true;
  const draft = await store.getDraft();
  if (!draft) return;
  const v = draft.editingId && (await store.getVaults()).find((x) => x.id === draft.editingId);
  if (v) startEdit(v);
  $('add-name').value = draft.name;
  $('add-url').value = draft.url;
  $('add-env').value = draft.env;
  $('add').open = true;
  updateHttpNotice();
  if (draft.askedAt) {
    store.setDraft({ ...draft, askedAt: undefined });
    await updateAccess();
    if (!$('add-secret').hidden) {
      toast('Access allowed');
      $('add-token').focus();
    }
  }
}

function setTokenVisible(visible) {
  $('add-token').type = visible ? 'text' : 'password';
  $('token-toggle').replaceChildren(icon(visible ? 'eyeOff' : 'eye'));
}
setTokenVisible(false);
$('token-toggle').addEventListener('click', () => setTokenVisible($('add-token').type === 'password'));

// Add or edit a vault. The token is checked against the vault before it is saved, encrypted with the PIN.
$('add-form').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  let url;
  try { url = vault.normalizeUrl($('add-url').value); } catch (err) { return setError(err.message); }
  // Must start inside the click gesture, before any await.
  const granted = chrome.permissions.request({ origins: [vault.originPattern(url)] }).catch(() => false);
  const token = $('add-token').value.trim();
  const old = editingId && (await store.getVaults()).find((x) => x.id === editingId);
  const v = { id: old?.id ?? crypto.randomUUID(), name: $('add-name').value.trim() || new URL(url).host, url, env: $('add-env').value };
  if (!old && !token) return setError('Enter the token for this vault.');
  if (token && vault.looksLikePin(token)) return setError('That looks like your PIN. Paste the Vault token here: it is the long value that starts with hvs.');
  if (old && old.url !== url && !token) return setError('The address changed: enter the token for the new address.');
  const [pin, pin2] = [$('add-pin').value, $('add-pin2').value];
  if (!hasPin && token) {
    if (!PIN_RULE.test(pin)) return setError('Choose a PIN of 4 to 64 characters.');
    if (pin !== pin2) return setError('The PINs do not match.');
  }
  if (!(await granted)) return setError('Access to this address is needed to use the vault.');
  if (token && (await store.isLocked())) {
    showLocked();
    return setError('Enter your PIN first, then add the token again.');
  }
  if (token) {
    try {
      await vault.lookupSelf(v, token);
    } catch (err) {
      return setError(await vault.explainNetworkError(v, err));
    }
    // The session may have locked while the token was checked: write nothing then (an edited address
    // would otherwise be saved without its token).
    if (await store.isLocked()) {
      showLocked();
      return setError('Enter your PIN first, then add the token again.');
    }
    if (!hasPin) {
      await store.setupPin(pin);
      hasPin = true;
    }
  }
  forgetStatus(v.id);
  if (old) await store.updateVault(v);
  else await store.addVault(v);
  if (token) await store.setToken(v, token);
  if (old && old.url !== url) await releasePermission(old.url);
  setTokenVisible(false);
  endEdit();
  renderList();
}));

// Revoke the host permission of an address no configured vault uses any more.
async function releasePermission(url) {
  const pattern = vault.originPattern(url);
  if ((await store.getVaults()).some((v) => vault.originPattern(v.url) === pattern)) return;
  await chrome.permissions.remove({ origins: [pattern] }).catch(() => {}); // required (manifest) grants cannot be removed
}

// ---- Settings ----

async function renderSettings() {
  viewSeq++;
  if (await store.isLocked()) return showLocked(); // Settings (Change PIN) only while unlocked
  settings = await store.getSettings();
  hasPin = await store.pinInUse();
  $('set-clip').value = String(settings.clipboardClearSec);
  $('set-pinttl').value = String(settings.pinTtlMin);
  $('set-autolock').value = String(settings.autoLockMin);
  $('pin-status').textContent = hasPin
    ? 'Your saved tokens are encrypted with your PIN. The PIN is never stored.'
    : 'You choose a PIN when you add your first vault.';
  $('pin-change').hidden = !hasPin;
  $('pin-change').open = false;
  $('settings-reset').hidden = !hasPin;
  $('pin-set-form').reset();
  state = { ...EMPTY_STATE };
  show('settings');
}

async function saveSettings(patch) {
  await store.setSettings(patch);
  settings = await store.getSettings();
  toast('Saved');
}

$('pin-set-form').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const [current, next, again] = ['pin-current', 'pin-new', 'pin-new2'].map((id) => $(id).value);
  if (!PIN_RULE.test(next)) return setError('The PIN must be 4 to 64 characters.');
  if (next !== again) return setError('The new PINs do not match.');
  const res = await store.changePin(current, next);
  if (res.wiped) {
    hasPin = false;
    statuses.clear();
    await renderList();
    return setError('Too many wrong PINs: the saved tokens and the PIN were deleted. Edit each vault to enter its token and choose a new PIN.');
  }
  if (!res.ok) return setError(`The current PIN is wrong. ${res.attemptsLeft} attempt(s) left before the saved tokens are deleted.`);
  await renderSettings();
  toast('PIN changed');
}));

$('set-clip').addEventListener('change', (e) => saveSettings({ clipboardClearSec: Number(e.target.value) }));
$('set-pinttl').addEventListener('change', (e) => saveSettings({ pinTtlMin: Number(e.target.value) }));
$('set-autolock').addEventListener('change', (e) => saveSettings({ autoLockMin: Number(e.target.value) }));
$('shortcuts-link').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// ---- Opening a vault ----

async function openVault(...args) {
  opening++;
  try {
    return await track(openVaultNow(...args));
  } finally {
    opening--;
  }
}

// resume: { mount, path, secret } to restore the last location.
async function openVaultNow(record, resume = null) {
  viewSeq++;
  const myOpen = ++openSeq;
  // Always use the stored record: the one passed in may be stale (rendered before an edit elsewhere).
  const v = (await store.getVaults()).find((x) => x.id === record.id);
  if (myOpen !== openSeq) return; // locked or another vault opened meanwhile
  if (!v) return renderList();
  if (await store.isLocked()) return showLocked();
  const token = await store.getToken(v);
  // A lock can land while the token is decrypted: then this open must not put the token back on screen.
  if (myOpen !== openSeq || (await store.isLocked())) return;
  if (!token) {
    forgetStatus(v.id);
    return needsFix('No token is saved for this vault.', 'Add token', () => startEdit(v, true));
  }
  state = { ...EMPTY_STATE, vault: v, token };
  clearSearch();
  if (resume) Object.assign(state, { mount: resume.mount, path: resume.path });
  // The first view's data is fetched while the token is checked (one round trip instead of two);
  // it renders only after the check passed and the header shows this vault.
  let release;
  ready = new Promise((r) => { release = r; });
  const view = resume?.secret ? openSecret(resume.secret, null, true) : browse(true);
  try {
    let info;
    try {
      info = await vault.lookupSelf(v, token);
    } catch (err) {
      if (myOpen !== openSeq) return; // the user opened another vault meanwhile
      viewSeq++; // drop the view fetched with this token
      if (err.status === 403) {
        setStatus(v.id, 'rejected');
        return needsFix('The vault rejected the saved token (expired or revoked). Your PIN stays the same.', 'Paste new token', () => startEdit(v, true));
      }
      if (!(await chrome.permissions.contains({ origins: [vault.originPattern(v.url)] }))) {
        setStatus(v.id, 'denied');
        return needsFix('Access to this address is not allowed.', 'Allow access', async () => {
          // Asked inside the click: Chrome only shows the permission prompt for a user gesture.
          if (await chrome.permissions.request({ origins: [vault.originPattern(v.url)] })) openVault(v, await store.getPlace(v.id));
        });
      }
      // Back to the list: staying on the PIN screen or the previous vault's view would trap the user.
      const msg = await vault.explainNetworkError(v, err);
      setStatus(v.id, err.status ? 'warn' : 'down', msg);
      await renderList();
      return setError(msg);
    }
    setStatus(v.id, 'ok');
    if (myOpen !== openSeq) return;
    await startLockCountdown(info);
    await renderSwitcher();
  } finally {
    release();
  }
  return view;
}

// The vault cannot be used as it is: back to the list with the reason and one button to fix it. Nothing
// opens or scrolls by itself, so the message stays where the user is looking.
async function needsFix(message, label, run) {
  await renderList();
  setError(message, { label, run });
}

// Shows the token's policies and when the PIN will be asked for again; locks when that time is up.
async function startLockCountdown(info) {
  clearInterval(lockTimer);
  const policies = info.policies?.filter((p) => p !== 'default').join(', ') || 'default';
  const until = await store.unlockedUntil();
  const tick = () => {
    if (!until) {
      $('token-info').textContent = `Policy: ${policies}`;
      return;
    }
    const left = Math.max(0, Math.round((until - Date.now()) / 1000));
    // Whole minutes keep the line still; seconds only in the last minute, when they matter.
    const when = left < 60 ? `${left} s` : `${Math.ceil(left / 60)} min`;
    $('token-info').textContent = `Policy: ${policies} · locks in ${when}`;
    $('token-info').classList.toggle('warn', left < 60);
    if (left === 0) {
      clearInterval(lockTimer);
      store.lockSession(); // the storage listener shows the PIN screen
    }
  };
  tick();
  lockTimer = setInterval(tick, 1000);
}

// ---- Browse ----

async function renderSwitcher() {
  const vaults = await store.getVaults();
  $('switch').replaceChildren(...vaults.map((v) => el('option', { value: v.id, selected: v.id === state.vault.id }, v.name)));
  $('env-chip').replaceChildren(envChip(state.vault.env));
}

// The vault's own web UI at the current location, for what this read-only reader does not do (writes,
// policies, admin). Built from the stored, validated origin; no token is passed along (Vault asks to sign in
// and then returns to this page).
$('open-ui').append(icon('external'));
$('open-ui').addEventListener('click', () => {
  const olderVersion = !$('secret-view').hidden && !$('old-version').hidden ? Number($('version').value) : null;
  chrome.tabs.create({ url: vaultUiUrl(state.vault.url, state.mount, state.path, state.secret, olderVersion) });
});

$('switch').addEventListener('change', async () => {
  const v = (await store.getVaults()).find((x) => x.id === $('switch').value);
  if (v) openVault(v, await store.getPlace(v.id));
});

const currentPath = () => (state.mount ? state.mount.path + state.path + (state.secret ?? '') : '');

function renderCrumbs() {
  const parts = [{ label: icon('home'), title: 'Mounts', go: () => go(null, '') }];
  if (state.mount) {
    parts.push({ label: state.mount.path, go: () => go(state.mount, '') });
    const segs = state.path.split('/').filter(Boolean);
    segs.forEach((s, i) => parts.push({ label: `${s}/`, go: () => go(state.mount, segs.slice(0, i + 1).join('/') + '/') }));
  }
  if (state.secret) parts.push({ label: state.secret });
  $('crumbs').replaceChildren(...parts.map((p, i) => (i === parts.length - 1
    ? el('span', { class: 'here', title: p.title ?? '' }, p.label)
    : el('a', { href: '#', title: p.title ?? '', ariaLabel: p.title ?? '', onclick: (e) => { e.preventDefault(); p.go(); } }, p.label))));
  $('copy-path').hidden = !state.mount;
}

$('copy-path').append(icon('copy'));
$('copy-path').addEventListener('click', () => copy(currentPath(), $('copy-path')));

function go(mount, path, fallback = false) {
  clearSearch();
  state.mount = mount;
  state.path = path;
  state.secret = null;
  return browse(fallback);
}

// A restored location failed to open: show the parent level, with the reason.
async function stepUp(msg) {
  const { mount, path, secret } = state;
  if (secret) await go(mount, path, true);
  else await go(path ? mount : null, path ? parentPath(path) : '', true);
  if (!$('error').textContent) setError(msg);
}

function saveLocation() {
  const { vault: v, mount, path, secret } = state;
  return store.setLast({ vaultId: v.id, mount, path, secret });
}

// Which detail is visible: null (the list) | 'secret' | 'totp'. The detail replaces the list.
function showDetail(kind) {
  $('secret-view').hidden = kind !== 'secret';
  $('totp-view').hidden = kind !== 'totp';
  $('items').hidden = Boolean(kind);
  if (kind !== 'totp') clearInterval(totpTimer);
}

const itemIcon = (mount, key = '') => (mount.type === 'totp' ? 'clock' : key.endsWith('/') ? 'folder' : 'key');

// fallback: this is a restored location; if it fails, step up a level instead of showing an empty view.
async function browse(fallback = false) {
  const seq = ++viewSeq;
  saveLocation(); // right away: the popup may be closed before the data arrives
  const { vault: v, token, mount, path } = state;
  let rows;
  let error;
  try {
    rows = await track(mount ? folderRows(v, token, mount, path) : rootRows(v, token));
  } catch (err) {
    error = err;
  }
  await ready;
  if (seq !== viewSeq) return;
  if (error) {
    const msg = error.status === 403 ? 'Permission denied.' : error.message;
    if (fallback && mount) return stepUp(msg);
    showBrowse();
    $('items').replaceChildren();
    return setError(msg);
  }
  showBrowse();
  $('items').replaceChildren(...rows);
}

// Shows the browse view for the current location (called once its data is ready).
function showBrowse(detail = null) {
  show('browse');
  renderCrumbs();
  showDetail(detail);
}

async function folderRows(v, token, mount, path) {
  const rows = (await vault.list(v, token, mount, path)).map((k) => itemRow({
    icon: itemIcon(mount, k), label: [k],
    open: () => (k.endsWith('/') ? go(mount, path + k) : openSecret(k)),
  }));
  return rows.length ? rows : [el('li', { class: 'empty' }, 'Empty folder.')];
}

// it: { icon, label: nodes[], folder?: nodes[], sub?, open }
function itemRow(it) {
  return el('li', { class: 'row', onclick: it.open },
    icon(it.icon),
    el('div', { class: 'grow' },
      el('div', { class: 'name' }, ...it.label),
      it.folder ? el('div', { class: 'sub path' }, ...it.folder) : ''),
    el('span', { class: 'sub' }, it.sub ?? ''));
}

// A saved/found item { mount, path } shown with its name and folder.
function entryRow(e, q = '') {
  const cut = e.path.lastIndexOf('/') + 1;
  const mark = (t) => (q ? highlight(t, q) : [t]);
  return itemRow({ icon: itemIcon(e.mount), label: mark(e.path.slice(cut)), folder: mark(e.mount.path + e.path.slice(0, cut)), open: () => openHit(e) });
}

const section = (title, rows) => (rows.length ? [el('li', { class: 'section' }, title), ...rows] : []);

// Root: favorites, recently opened, mounts; "for this site" suggestions are added on top when the index is ready.
async function rootRows(v, token) {
  const [mounts, favorites, recent] = await Promise.all([vault.listMounts(v, token), store.getFavorites(v.id), store.getRecent(v.id)]);
  return [
    ...section('Favorites', favorites.map((e) => entryRow(e))),
    ...section('Recently opened', recent.map((e) => entryRow(e))),
    ...section('Mounts', mounts.map((m) => itemRow({ icon: m.type === 'totp' ? 'clock' : 'database', label: [m.path], sub: m.type === 'totp' ? 'TOTP' : `KV v${m.version}`, open: () => go(m, '') }))),
    ...(mounts.length ? [] : [el('li', { class: 'empty' }, 'This token cannot see any KV/TOTP mounts.')]),
  ];
}

// Back to whatever the search box was covering.
const renderCurrent = () => (state.secret ? openSecret(state.secret) : browse());

// ---- Search (item paths across all mounts of the current vault) ----

// Built on the first search and kept per vault while the popup is open; at most 8 LISTs at a time over all mounts.
function buildIndex() {
  const { vault: v, token } = state;
  let index = indexes.get(v.id);
  if (!index || index.token !== token) {
    const pace = { limit: 8 };
    const paths = vault.listMounts(v, token)
      .then((mounts) => Promise.all(mounts.map((m) => vault.listAll(v, token, m, 5000, pace).then((list) => list.map((path) => ({ mount: m, path }))))))
      .then((perMount) => perMount.flat());
    paths.catch(() => indexes.get(v.id)?.paths === paths && indexes.delete(v.id)); // a failed walk is retried next time
    index = { token, paths };
    indexes.set(v.id, index);
  }
  return index.paths;
}

function highlight(text, q) {
  const lower = text.toLowerCase();
  const i = lower.indexOf(q);
  // Skip highlighting when lowercasing changes the length (e.g. "İ"): offsets would be wrong.
  if (i < 0 || lower.length !== text.length) return [text];
  return [text.slice(0, i), el('mark', {}, text.slice(i, i + q.length)), text.slice(i + q.length)];
}

$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(search, 150);
});

async function search() {
  const query = () => $('search').value.trim().toLowerCase();
  const q = query();
  $('search-info').hidden = !q;
  if (!q) return renderCurrent();
  const seq = ++viewSeq;
  showDetail(null);
  setError('');
  $('search-info').textContent = 'Scanning…';
  let all;
  try {
    all = await buildIndex();
  } catch (err) {
    $('search-info').hidden = true;
    return setError(err.message);
  }
  if (query() !== q || seq !== viewSeq) return; // a newer keystroke or navigation owns the result list
  const hits = all.filter((h) => (h.mount.path + h.path).toLowerCase().includes(q));
  $('search-info').textContent = `${hits.length} result${hits.length === 1 ? '' : 's'} (of ${all.length} items)` + (hits.length > MAX_HITS ? `, showing the first ${MAX_HITS}` : '');
  $('items').replaceChildren(...hits.slice(0, MAX_HITS).map((h) => entryRow(h, q)));
}

function openHit(h) {
  const cut = h.path.lastIndexOf('/') + 1;
  clearSearch();
  state.mount = h.mount;
  state.path = h.path.slice(0, cut);
  openSecret(h.path.slice(cut));
}

function clearSearch() {
  $('search').value = '';
  $('search-info').hidden = true;
}

// ---- Favorites ----

const currentEntry = () => ({ mount: state.mount, path: state.path + state.secret });

async function renderFavorite() {
  const e = currentEntry();
  const on = (await store.getFavorites(state.vault.id)).some((f) => f.mount.path === e.mount.path && f.path === e.path);
  for (const b of document.querySelectorAll('.fav')) {
    b.replaceChildren(icon('star'));
    b.classList.toggle('on', on);
    b.title = on ? 'Remove from favorites' : 'Add to favorites';
    b.ariaLabel = b.title;
  }
}

for (const b of document.querySelectorAll('.fav')) {
  b.append(icon('star')); // present from the start, so the row height does not jump when the state arrives
  b.addEventListener('click', async () => {
    const on = await store.toggleFavorite(state.vault.id, currentEntry());
    toast(on ? 'Added to favorites' : 'Removed from favorites');
    renderFavorite();
  });
}

// ---- Secret view ----

// version: KV v2 version number to show, null for the current one.
async function openSecret(name, version = null, fallback = false) {
  state.secret = name;
  saveLocation();
  if (state.mount.type === 'totp') return openTotp(name, fallback);
  const seq = ++viewSeq;
  const { vault: v, token, mount, path } = state;
  let res;
  let msg;
  try {
    res = await track(vault.read(v, token, mount, path + name, version));
    if (!res) msg = version ? `v${version} was deleted or destroyed.` : 'Secret not found (it may have been deleted).';
  } catch (err) {
    msg = err.status === 403 ? 'You do not have read access to this secret.' : err.message;
  }
  await ready;
  if (seq !== viewSeq) return; // a newer navigation, a vault switch or a lock happened meanwhile
  if (msg) {
    if (fallback) return stepUp(msg);
    showBrowse();
    return setError(msg);
  }
  secretData = res.data;
  hideRevealed = [];
  if (!version) store.addRecent(v.id, currentEntry());
  renderSecretHead(res.meta, version);
  $('secret').tBodies[0].replaceChildren(...Object.entries(res.data).map(([k, raw]) => secretRow(k, raw)));
  showBrowse('secret');
  renderFavorite();
}

function renderSecretHead(meta, version) {
  const select = $('version');
  select.hidden = !meta;
  $('old-version').hidden = !version;
  $('stale').hidden = true;
  if (!meta) {
    $('secret-meta').textContent = 'KV v1';
    $('secret-meta').title = 'KV v1: no version information';
    return;
  }
  if (!version) state.currentVersion = meta.version;
  const current = state.currentVersion;
  // shortcut: lists only the last MAX_VERSIONS versions; add paging if longer histories matter.
  const versions = Array.from({ length: Math.min(current, MAX_VERSIONS) }, (_, i) => current - i);
  select.replaceChildren(...versions.map((n) => el('option', { value: n, selected: n === meta.version }, n === current ? `v${n} (current)` : `v${n}`)));
  const when = new Date(meta.created_time);
  $('secret-meta').textContent = when.toLocaleDateString('en-GB');
  $('secret-meta').title = `Version ${meta.version}, updated ${when.toLocaleString('en-GB')}`;
  const age = ageDays(meta.created_time);
  if (!version && age >= STALE_DAYS) {
    $('stale').textContent = `Not updated for ${age} days; consider rotating it.`;
    $('stale').hidden = false;
  }
}

$('version').addEventListener('change', () => {
  const n = Number($('version').value);
  openSecret(state.secret, n === state.currentVersion ? null : n);
});

function secretRow(key, raw) {
  const value = valueText(raw);
  const display = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
  const plain = isPlain(key, value);
  const out = el('code', { class: 'value' });
  const setVisible = (visible) => {
    out.textContent = visible ? display : MASK;
    // Multi-line values (certs, JSON) keep their line breaks in a scrollable block.
    out.classList.toggle('multi', visible && display.includes('\n'));
  };
  setVisible(plain); // known non-secret fields (username, host, url…) are shown; everything else masked
  const actions = [];
  if (!plain) {
    const reveal = iconButton('eye', 'Show/hide', () => {
      const visible = out.textContent === MASK;
      setVisible(visible);
      reveal.replaceChildren(icon(visible ? 'eyeOff' : 'eye'));
    });
    hideRevealed.push(() => { setVisible(false); reveal.replaceChildren(icon('eye')); });
    actions.push(reveal);
  }
  if (plain && isHttpUrl(value)) actions.push(iconButton('external', 'Open in a new tab', () => chrome.tabs.create({ url: value })));
  actions.push(iconButton('copy', 'Copy', (e) => copy(value, e.currentTarget)));
  return el('tr', {}, el('th', {}, key), el('td', {}, out), el('td', { class: 'actions' }, el('div', { class: 'act' }, ...actions)));
}

$('copy-json').addEventListener('click', () => copy(JSON.stringify(secretData, null, 2)));
$('copy-env').addEventListener('click', async () => {
  await copy(toEnv(secretData));
  const skipped = Object.keys(secretData).filter((k) => !isEnvKey(k)).length;
  if (skipped) toast(`Copied · skipped ${skipped} field(s) whose names are not valid variable names`);
});

// ---- TOTP ----

async function openTotp(name, fallback = false) {
  const seq = ++viewSeq;
  const { vault: v, token, mount } = state;
  let res;
  let msg;
  try {
    res = await track(vault.totp(v, token, mount, name));
    if (!res) msg = 'TOTP key not found.';
  } catch (err) {
    msg = err.status === 403 ? 'You do not have read access to this code.' : err.message;
  }
  await ready;
  if (seq !== viewSeq) return;
  if (msg) {
    if (fallback) return stepUp(msg);
    showBrowse();
    return setError(msg);
  }
  store.addRecent(v.id, currentEntry());
  showBrowse('totp');
  renderFavorite();
  $('totp-code').textContent = res.code.length === 6 ? `${res.code.slice(0, 3)} ${res.code.slice(3)}` : res.code;
  $('totp-copy').onclick = (e) => copy(res.code, e.currentTarget);
  const slot = Math.floor(Date.now() / 1000 / res.period);
  const tick = () => {
    const now = Date.now() / 1000;
    if (Math.floor(now / res.period) !== slot) {
      clearInterval(totpTimer);
      if (state.secret === name && !$('totp-view').hidden) openTotp(name); // next code
      return;
    }
    const left = Math.ceil(res.period - (now % res.period));
    $('totp-left').textContent = `${left} s`;
    $('totp-left').classList.toggle('warn', left <= 5);
    $('totp-ring').style.setProperty('--p', String(left / res.period));
  };
  clearInterval(totpTimer);
  tick();
  totpTimer = setInterval(tick, 500);
}
$('totp-copy').append(icon('copy'));

// ---- Start: PIN first if locked, then reopen where the user left off ----

async function init() {
  settings = await store.getSettings();
  hasPin = await store.pinInUse();
  if (await store.isLocked()) return showLocked();
  const draft = await store.getDraft();
  if (draft?.askedAt && Date.now() - draft.askedAt < 120_000) return renderList(); // back from the permission prompt
  const last = await store.getLast();
  const v = last && (await store.getVaults()).find((x) => x.id === last.vaultId);
  if (v && (await store.hasToken(v.id))) return openVault(v, last);
  renderList();
}

init();
