// Offscreen document: the only extension context that can write the clipboard without a visible page.
// navigator.clipboard needs focus, so the classic copy-event + execCommand route is used.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'offscreen-clear-clipboard') return;
  const onCopy = (e) => {
    e.clipboardData.setData('text/plain', '');
    e.preventDefault();
  };
  document.addEventListener('copy', onCopy);
  const ok = document.execCommand('copy');
  document.removeEventListener('copy', onCopy);
  sendResponse({ ok });
});
