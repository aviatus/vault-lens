// Service worker: work that must happen while the popup is closed.
// - clears the clipboard N seconds after a copy (workers have no clipboard: an offscreen document does it)
// - locks when the unlock time is up, or when the browser has been in the background for the configured time
import * as store from './store.js';

const CLEAR_ALARM = 'clear-clipboard';
const LOCK_ALARM = 'auto-lock';

// shortcut: clears unconditionally (checking that the clipboard still holds our value would need the
// clipboardRead permission); a newer copy the user made within the window is cleared too.
async function clearClipboard() {
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['CLIPBOARD'],
      justification: 'Clear a copied secret value from the clipboard after a timeout',
    });
  }
  await chrome.runtime.sendMessage({ type: 'offscreen-clear-clipboard' });
  await chrome.offscreen.closeDocument();
  // Flag only (no value): survives a browser restart so a clear interrupted by shutdown still happens.
  await chrome.storage.local.remove('clipboardPending');
}

async function onCopied() {
  const { clipboardClearSec } = await store.getSettings();
  if (clipboardClearSec <= 0) return;
  await chrome.storage.local.set({ clipboardPending: true });
  chrome.alarms.create(CLEAR_ALARM, { when: Date.now() + clipboardClearSec * 1000 });
}

// The toolbar popup is not a browser window: on macOS, focusing it reports "no window focused". While it is
// open the user is in the extension, so the background lock waits instead of firing.
async function popupOpen() {
  return (await chrome.runtime.getContexts({ contextTypes: ['POPUP'] })).length > 0;
}

// WINDOW_ID_NONE = no Chrome window has focus (the user switched to another app, or opened the popup).
async function onFocusChanged(windowId) {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) return chrome.alarms.clear(LOCK_ALARM);
  const { autoLockMin } = await store.getSettings();
  if (autoLockMin < 0 || !(await store.pinInUse())) return;
  if (autoLockMin === 0 && !(await popupOpen())) return store.lockSession();
  chrome.alarms.create(LOCK_ALARM, { delayInMinutes: Math.max(autoLockMin, 0.5) });
}

async function onLockAlarm() {
  if (await popupOpen()) return chrome.alarms.create(LOCK_ALARM, { delayInMinutes: 0.5 }); // check again later
  return store.lockSession();
}

// Data written by earlier versions: plaintext session tokens, the namespace field and an optional PIN that no
// longer protects anything would otherwise block the new PIN flow.
async function migrate() {
  await chrome.storage.session.remove(['tokens', 'locked', 'pinAttempts']);
  const { vaults = [] } = await chrome.storage.local.get('vaults');
  await chrome.storage.local.set({ vaults: vaults.map(({ namespace, ...v }) => v) });
  if (!(await store.pinInUse())) await chrome.storage.local.remove(['pin', 'pinAttempts']);
}

// Chrome's permission prompt can close the popup in the middle of adding a vault. When access is granted
// right after the add form asked for it, reopen the popup; it puts the form back (popup.js restoreDraft).
chrome.permissions.onAdded.addListener(async () => {
  const { addDraft } = await chrome.storage.session.get('addDraft');
  if (addDraft?.askedAt && Date.now() - addDraft.askedAt < 120_000) chrome.action.openPopup?.().catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  // Only this extension's own pages may schedule work (there are no content scripts; defence in depth).
  if (sender.id !== chrome.runtime.id) return;
  if (msg?.type === 'copied') onCopied();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CLEAR_ALARM) clearClipboard();
  if (alarm.name === LOCK_ALARM) onLockAlarm();
  if (alarm.name === store.PIN_TTL_ALARM) store.lockSession();
});
chrome.windows.onFocusChanged.addListener(onFocusChanged);
chrome.runtime.onInstalled.addListener(migrate);
chrome.runtime.onStartup.addListener(async () => {
  if ((await chrome.storage.local.get('clipboardPending')).clipboardPending) await clearClipboard();
});
