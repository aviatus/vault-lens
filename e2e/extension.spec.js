import { test as base, expect, chromium } from '@playwright/test';
import path from 'node:path';
import { VAULT_A, VAULT_B } from './seed.js';
import { BUILD } from './global-setup.js';

const MASK = '••••••••';

const test = base.extend({
  // Fresh browser profile per test: empty storage, no tokens.
  context: async ({}, use) => {
    const ext = path.resolve(BUILD);
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium', // bundled Chromium: supports extensions, also headless
      args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    });
    await use(context);
    await context.close();
  },
  sw: async ({ context }, use) => use(context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))),
  origin: async ({ sw }, use) => use(`chrome-extension://${new URL(sw.url()).host}`),
  // Every request the popup sends to a test Vault, to assert the extension stays read-only.
  vaultRequests: async ({}, use) => use([]),
  popup: async ({ context, origin, vaultRequests }, use) => {
    const page = await context.newPage();
    // Capture clipboard writes instead of touching the real OS clipboard
    // (Chrome refuses grantPermissions for chrome-extension:// origins).
    await page.addInitScript(() => {
      window.__copied = [];
      navigator.clipboard.writeText = async (t) => { window.__copied.push(t); };
    });
    page.on('request', (r) => r.url().startsWith('http://127.0.0.1:182') && vaultRequests.push(r));
    await page.goto(`${origin}/popup.html`);
    await use(page);
    expect(vaultRequests.every((r) => r.method() === 'GET'), 'extension must only send GET to Vault').toBe(true);
  },
});

const vaultRow = (page, name) => page.locator('#vaults .row', { hasText: name });
// List row whose name is exactly `name` (favorites/recent rows show the folder on a second line).
const item = (page, name) => page.locator('#items .row').filter({ has: page.locator('.name').getByText(name, { exact: true }) });
const secretRow = (page, key) => page.locator('#secret tbody tr').filter({ has: page.locator('th').getByText(key, { exact: true }) });
const copied = (page) => page.evaluate(() => window.__copied);
const storage = (page, area) => page.evaluate((a) => chrome.storage[a].get(null), area);

const PIN = '482913';
const tokenFor = (url) => (url === VAULT_A ? process.env.TOKEN_A : process.env.TOKEN_B);

// Adds a vault with its token; on the first vault the PIN is chosen in the same form.
async function addVault(page, name, url, { env = '', token = tokenFor(url), pin = PIN } = {}) {
  if (!(await page.locator('#add').evaluate((d) => d.open))) await page.click('#add summary');
  await page.fill('#add-name', name);
  await page.fill('#add-url', url);
  await page.selectOption('#add-env', env);
  await page.fill('#add-token', token);
  if (await page.locator('#add-pin-setup').isVisible()) {
    await page.fill('#add-pin', pin);
    await page.fill('#add-pin2', pin);
  }
  await page.click('#add-submit');
  await expect(vaultRow(page, name)).toBeVisible();
}

// Opens a vault from the list (its token is already saved).
async function unlock(page, name) {
  await vaultRow(page, name).click();
  await expect(page.locator('#browse')).toBeVisible();
}

async function enterPin(page, pin) {
  await page.fill('#pin-input', pin);
  await page.click('#pin-form button[type=submit]');
  // the button shows "Unlocking…" while the key is derived; one attempt at a time
  await expect(page.locator('#pin-form button[type=submit]')).toHaveText('Unlock');
}

// Calls a test Vault directly with its dev root token (test setup only, not the extension).
async function rootApi(addr, method, path, body) {
  const res = await fetch(`${addr}/v1/${path}`, { method, headers: { 'X-Vault-Token': 'root', 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return res.status === 204 ? null : res.json();
}

async function openPath(page, ...segments) {
  for (const s of segments) await item(page, s).first().click();
}

async function setupA(page, ...segments) {
  await addVault(page, 'Vault A', VAULT_A);
  await unlock(page, 'Vault A');
  await openPath(page, ...segments);
}

// ---- Browsing and secrets ----

test('KV v2: gezinme, maskeli değer, göster/gizle, kopyala, versiyon bilgisi', async ({ popup: page }) => {
  await setupA(page);
  await expect(page.locator('#token-info')).toContainText('Policy: readonly');
  await expect(item(page, 'secret/')).toContainText('KV v2');
  await expect(item(page, 'kv/')).toContainText('KV v1');
  await expect(item(page, 'totp/')).toContainText('TOTP');

  await openPath(page, 'secret/', 'demo/', 'app');
  await expect(page.locator('#version option:checked')).toHaveText(/^v\d+ \(current\)$/);
  await expect(page.locator('#secret-meta')).toHaveText(/^\d{2}\/\d{2}\/\d{4}$/);
  await expect(page.locator('#secret-meta')).toHaveAttribute('title', /^Version \d+, updated/);

  const pw = secretRow(page, 'password');
  await expect(pw.locator('.value')).toHaveText(MASK);
  await pw.getByTitle('Show/hide').click();
  await expect(pw.locator('.value')).toHaveText('uydurma-parola-123');
  await pw.getByTitle('Show/hide').click();
  await expect(pw.locator('.value')).toHaveText(MASK);

  await secretRow(page, 'api_key').getByTitle('Copy').click();
  await expect(page.locator('#toast')).toContainText('Copied');
  expect(await copied(page)).toEqual(['fake-api-key-abc']);

  await page.locator('#crumbs a', { hasText: 'secret/' }).click();
  await expect(item(page, 'demo/')).toBeVisible();
});

test('alan tipleri: kullanıcı adı/URL açık, parola/anahtar maskeli, URL aç butonu', async ({ popup: page }) => {
  await setupA(page, 'secret/', 'demo/', 'app');
  await expect(secretRow(page, 'username').locator('.value')).toHaveText('demo-user');
  await expect(secretRow(page, 'username').getByTitle('Show/hide')).toHaveCount(0);
  await expect(secretRow(page, 'password').locator('.value')).toHaveText(MASK);
  await expect(secretRow(page, 'api_key').locator('.value')).toHaveText(MASK);

  await page.locator('#crumbs a[title="Mounts"]').click();
  await openPath(page, 'kv/', 'legacy/', 'config');
  await expect(page.locator('#secret-meta')).toHaveText('KV v1');
  await expect(secretRow(page, 'endpoint').locator('.value')).toHaveText('https://legacy.example.test');
  await expect(secretRow(page, 'endpoint').getByTitle('Open in a new tab')).toBeVisible();
});

test('secret araçları: JSON/.env/path kopyala', async ({ popup: page }) => {
  await setupA(page, 'secret/', 'demo/', 'app');
  await page.click('#copy-json');
  await page.click('#copy-env');
  await page.click('#copy-path');
  const [json, env, p] = await copied(page);
  expect(JSON.parse(json)).toEqual({ api_key: 'fake-api-key-abc', password: 'uydurma-parola-123', username: 'demo-user' });
  expect(env).toBe('api_key=fake-api-key-abc\npassword=uydurma-parola-123\nusername=demo-user');
  expect(p).toBe('secret/demo/app');
});

test('versiyon geçmişi: eski versiyon okunur, uyarı gösterilir', async ({ popup: page }) => {
  await setupA(page, 'secret/', 'demo/', 'db');
  await expect(secretRow(page, 'host').locator('.value')).toHaveText('db.example.test');
  await expect(page.locator('#old-version')).toBeHidden();

  await page.selectOption('#version', { index: 1 }); // previous version (seed writes old, then new)
  await expect(secretRow(page, 'host').locator('.value')).toHaveText('db-old.example.test');
  await expect(page.locator('#old-version')).toBeVisible();

  await page.selectOption('#version', { index: 0 });
  await expect(secretRow(page, 'host').locator('.value')).toHaveText('db.example.test');
  await expect(page.locator('#old-version')).toBeHidden();
});

test('çok satırlı değer satır yapısı korunarak gösterilir', async ({ popup: page }) => {
  await setupA(page, 'secret/', 'demo/', 'tls');
  await secretRow(page, 'cert').getByTitle('Show/hide').click();
  const value = secretRow(page, 'cert').locator('.value.multi');
  await expect(value).toHaveText('-----BEGIN FAKE CERT-----\nAAAA\nBBBB\n-----END FAKE CERT-----');
  expect(await value.evaluate((n) => getComputedStyle(n).whiteSpace)).toBe('pre');
});

test('TOTP: kod, geri sayım ve kopyalama', async ({ popup: page }) => {
  await setupA(page, 'totp/', 'demo-app');
  await expect(page.locator('#totp-view')).toBeVisible();
  await expect(page.locator('#totp-code')).toHaveText(/^\d{3} \d{3}$/);
  await expect(page.locator('#totp-left')).toHaveText(/^\d{1,2} s$/);
  await page.click('#totp-copy');
  expect((await copied(page))[0]).toMatch(/^\d{6}$/);
});

test('yetkisiz secret okununca hata gösterilir', async ({ popup: page }) => {
  await setupA(page, 'secret/', 'restricted/', 'root-creds');
  await expect(page.locator('#error')).toHaveText('You do not have read access to this secret.');
  await expect(page.locator('#secret')).toBeHidden();
});

// ---- Root view: favorites, recent, site suggestions ----

test('favoriler ve son açılanlar ana ekranda; favoride sadece path saklanır', async ({ popup: page }) => {
  await setupA(page, 'secret/', 'demo/', 'app');
  await page.locator('#secret-view .fav').click();
  await expect(page.locator('#toast')).toHaveText('Added to favorites');
  await expect(page.locator('#secret-view .fav')).toHaveClass(/on/);

  const local = JSON.stringify(await storage(page, 'local'));
  expect(local).toContain('demo/app');
  expect(local).not.toContain('uydurma-parola-123');

  await page.locator('#crumbs a[title="Mounts"]').click();
  await expect(page.locator('#items .section')).toHaveText(['Favorites', 'Recently opened', 'Mounts']);
  await expect(item(page, 'app')).toHaveCount(2); // once in each section
  await item(page, 'app').first().click();
  await expect(secretRow(page, 'username')).toBeVisible();

  await page.locator('#secret-view .fav').click(); // unfavorite
  await page.locator('#crumbs a[title="Mounts"]').click();
  await expect(page.locator('#items .section')).toHaveText(['Recently opened', 'Mounts']);
});

// ---- Adding and editing vaults ----

test('add: the token is checked against the vault before saving; a bad token is not saved', async ({ popup: page }) => {
  await page.fill('#add-name', 'Vault A');
  await page.fill('#add-url', VAULT_A);
  await expect(page.locator('#add-http')).toBeVisible(); // test Vaults are plain http on loopback
  await page.fill('#add-token', 'not-a-real-token');
  await page.fill('#add-pin', PIN);
  await page.fill('#add-pin2', PIN);
  await page.click('#add-submit');
  await expect(page.locator('#error')).toHaveText(`This token is not valid for ${VAULT_A}: it is expired, revoked, or belongs to another vault.`);
  await expect(page.locator('#vaults .row')).toHaveCount(0);
  const local = await storage(page, 'local');
  expect(local.vaults ?? []).toEqual([]);
  expect(local.pin).toBeUndefined(); // the PIN is only set once a vault is really added

  await page.fill('#add-token', process.env.TOKEN_A);
  await page.fill('#add-pin2', 'different');
  await page.click('#add-submit');
  await expect(page.locator('#error')).toHaveText('The PINs do not match.');
});

test('add: token toggle, first vault sets the PIN, later vaults do not ask for it', async ({ popup: page }) => {
  await page.fill('#add-url', VAULT_A); // token and PIN fields appear once the address is usable
  await expect(page.locator('#add-pin-setup')).toBeVisible();
  await expect(page.locator('#add-token')).toHaveAttribute('type', 'password');
  await page.click('#token-toggle');
  await expect(page.locator('#add-token')).toHaveAttribute('type', 'text');
  await addVault(page, 'Vault A', VAULT_A);
  await page.click('#add summary');
  await expect(page.locator('#add-pin-setup')).toBeHidden();
  await addVault(page, 'Vault B', VAULT_B);
  await expect(vaultRow(page, 'Vault B')).not.toContainText('Token needed');
});

test('tokens are stored only encrypted (bound to the address); the PIN is never stored', async ({ popup: page }) => {
  await setupA(page, 'secret/', 'demo/', 'db');
  const local = await storage(page, 'local');
  const session = await storage(page, 'session');
  const all = JSON.stringify(local) + JSON.stringify(session);
  expect(all).not.toContain(process.env.TOKEN_A);
  expect(all).not.toContain(PIN);
  expect(Object.keys(local.vaultTokens)).toHaveLength(1);
  expect(Object.keys(Object.values(local.vaultTokens)[0]).sort()).toEqual(['ct', 'iv']);

  await page.reload(); // same as closing and reopening the popup: resumes where it was
  await expect(page.locator('#crumbs > *')).toHaveText(['', 'secret/', 'demo/', 'db']);
  await expect(secretRow(page, 'host')).toBeVisible();
});

test('restart: the saved token survives a browser restart and only the PIN is asked', async ({}, testInfo) => {
  const ext = path.resolve(BUILD);
  const launch = () => chromium.launchPersistentContext(testInfo.outputPath('profile'), {
    channel: 'chromium', args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  const open = async (ctx) => {
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
    return page;
  };
  let ctx = await launch();
  await addVault(await open(ctx), 'Vault A', VAULT_A);
  await ctx.close();

  ctx = await launch();
  const page = await open(ctx);
  await expect(page.locator('#pin')).toBeVisible();
  await enterPin(page, PIN);
  await expect(vaultRow(page, 'Vault A')).not.toContainText('Token needed');
  await unlock(page, 'Vault A');
  await expect(item(page, 'secret/')).toBeVisible();
  await ctx.close();
});

test('edit: name/env change keeps the token; an address change needs the new token', async ({ popup: page }) => {
  await addVault(page, 'Vault A', VAULT_A);
  await vaultRow(page, 'Vault A').getByTitle('Edit').click();
  await expect(page.locator('#add-url')).toHaveValue(VAULT_A);
  await expect(page.locator('#add-pin-setup')).toBeHidden();
  await page.fill('#add-name', 'Main Vault');
  await page.selectOption('#add-env', 'test');
  await page.click('#add-submit');
  await expect(vaultRow(page, 'Main Vault')).not.toContainText('Token needed');
  await expect(vaultRow(page, 'Main Vault').locator('.chip.env-test')).toBeVisible();
  await expect(page.locator('#vaults .row')).toHaveCount(1);

  await vaultRow(page, 'Main Vault').getByTitle('Edit').click();
  await page.fill('#add-url', VAULT_B);
  await page.click('#add-submit');
  await expect(page.locator('#error')).toHaveText('The address changed: enter the token for the new address.');
  await page.fill('#add-token', process.env.TOKEN_B);
  await page.click('#add-submit');
  await unlock(page, 'Main Vault');
  await openPath(page, 'secret/');
  await expect(item(page, 'team/')).toBeVisible(); // Vault B content
});

test('a token the vault rejects (revoked/expired): the message offers a button that opens the edit form', async ({ popup: page }) => {
  const { auth } = await rootApi(VAULT_A, 'POST', 'auth/token/create', { policies: ['readonly'], ttl: '1h' });
  await addVault(page, 'Vault A', VAULT_A, { token: auth.client_token });
  await rootApi(VAULT_A, 'POST', 'auth/token/revoke', { token: auth.client_token });
  await vaultRow(page, 'Vault A').click();
  await expect(page.locator('#error')).toHaveText('The vault rejected the saved token (expired or revoked). Your PIN stays the same.');
  // nothing opens or scrolls by itself: the list stays at the top with the message and one button
  await expect(page.locator('#add-token')).toBeHidden();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.click('#error-action');
  await expect(page.locator('#add-title')).toHaveText('Edit: Vault A');
  await expect(page.locator('#add-token')).toBeFocused();
  await expect(page.locator('#add-token')).toHaveAttribute('placeholder', 'Paste a new Vault token (hvs.…)');
  // typing the PIN into the token field is caught before anything is sent to the vault
  const sent = [];
  page.on('request', (r) => r.url().startsWith(VAULT_A) && sent.push(r.headers()['x-vault-token']));
  await page.fill('#add-token', PIN);
  await page.click('#add-submit');
  await expect(page.locator('#error')).toHaveText('That looks like your PIN. Paste the Vault token here: it is the long value that starts with hvs.');
  expect(sent).not.toContain(PIN);
  await page.fill('#add-token', process.env.TOKEN_A);
  await page.click('#add-submit');
  await unlock(page, 'Vault A');
});

test('multiple vaults: separate tokens and quick switch', async ({ popup: page }) => {
  await addVault(page, 'Vault A', VAULT_A);
  await addVault(page, 'Vault B', VAULT_B);
  await unlock(page, 'Vault B');
  await openPath(page, 'secret/', 'team/', 'service');
  await expect(secretRow(page, 'client_id')).toBeVisible();
  await page.selectOption('#switch', { label: 'Vault A' });
  await expect(item(page, 'kv/')).toBeVisible();
  await expect(page.locator('#switch option:checked')).toHaveText('Vault A');
  expect(Object.keys((await storage(page, 'local')).vaultTokens)).toHaveLength(2);
});

test('switching vaults keeps the last location of each vault', async ({ popup: page }) => {
  await addVault(page, 'Vault A', VAULT_A);
  await addVault(page, 'Vault B', VAULT_B);
  await unlock(page, 'Vault A');
  await openPath(page, 'secret/', 'demo/', 'app');
  await expect(secretRow(page, 'api_key')).toBeVisible();
  await page.selectOption('#switch', { label: 'Vault B' });
  await openPath(page, 'secret/', 'team/');
  await expect(item(page, 'service')).toBeVisible();
  await page.selectOption('#switch', { label: 'Vault A' });
  await expect(secretRow(page, 'api_key')).toBeVisible();
  await expect(page.locator('#crumbs')).toContainText('demo/');
  await page.selectOption('#switch', { label: 'Vault B' });
  await expect(item(page, 'service')).toBeVisible();
  await expect(page.locator('#crumbs')).toContainText('team/');
});

// ---- Dead ends: an unreachable vault or a vanished location must never trap the user ----

const unreachable = (page, url) => page.route(`${url}/**`, (r) => r.abort());
const UNREACHABLE_A = `Could not reach ${VAULT_A}. Check that the vault is running and reachable from this network (VPN?).`;

test('unlocking while the last vault is unreachable lands on the vault list, not back on the PIN screen', async ({ popup: page }) => {
  await addVault(page, 'Vault A', VAULT_A);
  await addVault(page, 'Vault B', VAULT_B);
  await unlock(page, 'Vault A');
  await page.click('#lock-now');
  await unreachable(page, VAULT_A);
  await enterPin(page, PIN);
  await expect(page.locator('#list')).toBeVisible();
  await expect(page.locator('#pin')).toBeHidden();
  await expect(page.locator('#error')).toHaveText(UNREACHABLE_A);
  await expect(page.locator('#vaults .row')).toHaveCount(2);
  await unlock(page, 'Vault B'); // the other vault still works
});

test('reopening while the last vault is down or sealed shows the vault list', async ({ popup: page }) => {
  await addVault(page, 'Vault A', VAULT_A);
  await unlock(page, 'Vault A');
  await page.route('**/v1/auth/token/lookup-self', (r) => r.fulfill({ status: 503, body: '{"errors":["Vault is sealed"]}' }));
  await page.reload();
  await expect(page.locator('#error')).toHaveText('Vault: Vault is sealed');
  await expect(vaultRow(page, 'Vault A')).toBeVisible();
  await page.unroute('**/v1/auth/token/lookup-self');
  await page.reload(); // the failed vault is not retried on every open
  await expect(vaultRow(page, 'Vault A')).toBeVisible();
  await expect(page.locator('#browse')).toBeHidden();
});

test('switching to an unreachable vault does not leave the previous vault on screen', async ({ popup: page }) => {
  await addVault(page, 'Vault A', VAULT_A);
  await addVault(page, 'Vault B', VAULT_B);
  await unlock(page, 'Vault B');
  await unreachable(page, VAULT_A);
  await page.selectOption('#switch', { label: 'Vault A' });
  await expect(page.locator('#error')).toHaveText(UNREACHABLE_A);
  await expect(page.locator('#list')).toBeVisible();
  await expect(page.locator('#browse')).toBeHidden();
});

test('a restored secret that was deleted opens its folder instead of an empty view', async ({ popup: page }) => {
  await addVault(page, 'Vault A', VAULT_A);
  await unlock(page, 'Vault A');
  await openPath(page, 'secret/', 'demo/', 'app');
  await page.route('**/v1/secret/data/demo/app*', (r) => r.fulfill({ status: 404, body: '{"errors":[]}' }));
  await page.reload();
  await expect(page.locator('#error')).toHaveText('Secret not found (it may have been deleted).');
  await expect(item(page, 'app')).toBeVisible();
  await expect(page.locator('#crumbs')).toHaveText(/demo\/$/);
});

test('a restored folder that is no longer readable steps up a level', async ({ popup: page }) => {
  await addVault(page, 'Vault A', VAULT_A);
  await unlock(page, 'Vault A');
  await openPath(page, 'secret/', 'demo/');
  await page.route('**/v1/secret/metadata/demo/*', (r) => r.fulfill({ status: 403, body: '{"errors":["permission denied"]}' }));
  await page.reload();
  await expect(page.locator('#error')).toHaveText('Permission denied.');
  await expect(item(page, 'demo/')).toBeVisible();
});

test('vault list dot shows the connection status of each vault', async ({ popup: page }) => {
  await addVault(page, 'Vault A', VAULT_A);
  await addVault(page, 'Vault B', VAULT_B);
  await expect(vaultRow(page, 'Vault A').locator('.dot')).toHaveAttribute('title', 'Connected, token valid');
  await expect(vaultRow(page, 'Vault A').locator('.dot')).toHaveClass(/\bok\b/);
  await unreachable(page, VAULT_A);
  await page.route(`${VAULT_B}/v1/sys/health`, (r) => r.fulfill({ status: 503, body: '{"sealed":true}' }));
  await page.reload();
  await expect(vaultRow(page, 'Vault A').locator('.dot')).toHaveAttribute('title', 'Unreachable (VPN?)');
  await expect(vaultRow(page, 'Vault A').locator('.dot')).toHaveClass(/\bdown\b/);
  await expect(vaultRow(page, 'Vault B').locator('.dot')).toHaveAttribute('title', 'Sealed');
  await expect(vaultRow(page, 'Vault B').locator('.dot')).toHaveClass(/\bwarn\b/);
});

test('vault list dot turns red for a rejected token and stays red after another vault is edited', async ({ popup: page }) => {
  await addVault(page, 'Vault A', VAULT_A);
  await addVault(page, 'Vault B', VAULT_B);
  await page.route(`${VAULT_B}/v1/auth/token/lookup-self`, (r) => r.fulfill({ status: 403, body: '{"errors":["permission denied"]}' }));
  await page.reload();
  const dotB = vaultRow(page, 'Vault B').locator('.dot');
  await expect(dotB).toHaveAttribute('title', 'Token rejected (expired or revoked): edit the vault');
  await expect(dotB).toHaveClass(/\bdown\b/);
  await vaultRow(page, 'Vault A').getByTitle('Edit').click();
  await page.fill('#add-name', 'Vault A2');
  await page.click('#add-submit');
  await expect(vaultRow(page, 'Vault A2').locator('.dot')).toHaveAttribute('title', 'Connected, token valid');
  await expect(dotB).toHaveAttribute('title', 'Token rejected (expired or revoked): edit the vault');
  await vaultRow(page, 'Vault B').click(); // opening it agrees with the dot
  await expect(page.locator('#error')).toContainText('rejected the saved token');
});

test('each vault keeps its own status: editing or opening one does not touch the other', async ({ popup: page }) => {
  await addVault(page, 'Vault A', VAULT_A);
  await addVault(page, 'Vault B', VAULT_B);
  const dotA = vaultRow(page, 'Vault A').locator('.dot');
  const dotB = vaultRow(page, 'Vault B').locator('.dot');
  await expect(dotA).toHaveAttribute('title', 'Connected, token valid');
  await expect(dotB).toHaveAttribute('title', 'Connected, token valid');
  // B goes down after the list was checked: opening it fails and marks only B.
  await unreachable(page, VAULT_B);
  await vaultRow(page, 'Vault B').click();
  await expect(page.locator('#error')).toContainText(`Could not reach ${VAULT_B}`);
  await expect(dotB).toHaveClass(/\bdown\b/);
  await expect(dotA).toHaveAttribute('title', 'Connected, token valid');
  // Editing A re-checks A only; B keeps its red status.
  await page.unroute(`${VAULT_B}/**`);
  await vaultRow(page, 'Vault A').getByTitle('Edit').click();
  await page.fill('#add-name', 'Vault A2');
  await page.click('#add-submit');
  await expect(vaultRow(page, 'Vault A2').locator('.dot')).toHaveAttribute('title', 'Connected, token valid');
  await expect(dotB).toHaveClass(/\bdown\b/);
  // Opening B again succeeds and turns B green.
  await unlock(page, 'Vault B');
  await page.click('#back');
  await expect(dotB).toHaveAttribute('title', 'Connected, token valid');
});

test('a late secret response is dropped after switching vaults or locking', async ({ popup: page }) => {
  await addVault(page, 'Vault A', VAULT_A);
  await addVault(page, 'Vault B', VAULT_B);
  await unlock(page, 'Vault A');
  await openPath(page, 'secret/', 'demo/');
  const slow = (route) => setTimeout(() => route.continue().catch(() => {}), 1500);
  await page.route(`${VAULT_A}/v1/secret/data/demo/app*`, slow);
  await item(page, 'app').click();
  await page.selectOption('#switch', { label: 'Vault B' });
  await expect(page.locator('#switch option:checked')).toHaveText('Vault B');
  await page.waitForTimeout(2000); // A's answer has arrived by now
  await expect(page.locator('#secret-view')).toBeHidden();
  await expect(page.locator('#crumbs')).not.toContainText('demo/');

  await page.selectOption('#switch', { label: 'Vault A' }); // resumes at demo/app: the slow read starts again
  await page.click('#lock-now');
  await expect(page.locator('#pin')).toBeVisible();
  await page.waitForTimeout(2000);
  expect(await page.locator('#secret tbody tr').count()).toBe(0); // nothing written behind the PIN screen
});

test('opening a vault that does not answer shows that it is connecting; another vault can be opened meanwhile', async ({ popup: page }) => {
  await addVault(page, 'Vault A', VAULT_A);
  await addVault(page, 'Vault B', VAULT_B);
  const held = [];
  await page.route(`${VAULT_A}/v1/auth/token/lookup-self`, (r) => held.push(r)); // never answers, like a VPN-only vault
  await vaultRow(page, 'Vault A').click();
  await expect(vaultRow(page, 'Vault A')).toContainText('Connecting…');
  await expect(vaultRow(page, 'Vault A')).toHaveClass(/connecting/);
  await expect(page.locator('#busy')).toBeVisible();
  // the user gives up and opens B; A answering late must not pull the screen back
  await vaultRow(page, 'Vault B').click();
  await expect(page.locator('#switch option:checked')).toHaveText('Vault B');
  await expect(page.locator('#busy')).toBeVisible(); // A is still being waited for
  for (const r of held) await r.abort('timedout');
  await expect(page.locator('#busy')).toBeHidden();
  await expect(page.locator('#browse')).toBeVisible();
  await expect(page.locator('#switch option:checked')).toHaveText('Vault B');
  await expect(page.locator('#error')).toBeHidden();
});

test('add form: access is asked before the token; name, address and environment survive the popup closing', async ({ popup: page }) => {
  await page.fill('#add-name', 'Remote Vault');
  await page.fill('#add-url', 'https://vault.example.test');
  await page.selectOption('#add-env', 'prod');
  await expect(page.locator('#add-access')).toBeVisible(); // no access to that address yet
  await expect(page.locator('#add-access')).toContainText('vault.example.test');
  await expect(page.locator('#add-secret')).toBeHidden();
  const draft = (await storage(page, 'session')).addDraft;
  expect(draft).toMatchObject({ name: 'Remote Vault', url: 'https://vault.example.test', env: 'prod' });
  expect(JSON.stringify(draft)).not.toMatch(/token|pin/i); // never the secrets

  await page.reload(); // same as the popup closing for Chrome's permission prompt
  await expect(page.locator('#add-name')).toHaveValue('Remote Vault');
  await expect(page.locator('#add-url')).toHaveValue('https://vault.example.test');
  await expect(page.locator('#add-env')).toHaveValue('prod');
  await expect(page.locator('#add-access')).toBeVisible();

  // an address the extension can already reach shows the token field straight away
  await page.fill('#add-url', VAULT_A);
  await expect(page.locator('#add-access')).toBeHidden();
  await expect(page.locator('#add-secret')).toBeVisible();
});

test('back from the permission prompt: the popup opens on the add form, not on the last vault', async ({ popup: page }) => {
  await addVault(page, 'Vault A', VAULT_A);
  await unlock(page, 'Vault A');
  await page.evaluate(() => chrome.storage.session.set({ addDraft: { name: 'Vault B', url: 'http://127.0.0.1:18201', env: '', editingId: null, askedAt: Date.now() } }));
  await page.reload();
  await expect(page.locator('#list')).toBeVisible();
  await expect(page.locator('#add-name')).toHaveValue('Vault B');
  await expect(page.locator('#add-secret')).toBeVisible(); // access to that address is there now
  await expect(page.locator('#add-token')).toBeFocused();
  await page.fill('#add-token', process.env.TOKEN_B);
  await page.click('#add-submit');
  await expect(vaultRow(page, 'Vault B')).toBeVisible();
  expect((await storage(page, 'session')).addDraft).toBeUndefined(); // done: the draft is gone
});

test('a lock while a vault is still opening wins: the PIN screen stays, Settings stays out of reach', async ({ popup: page }) => {
  await addVault(page, 'Vault A', VAULT_A);
  await page.route(`${VAULT_A}/v1/auth/token/lookup-self`, (r) => setTimeout(() => r.fulfill({ status: 500, body: '{"errors":["slow and broken"]}' }).catch(() => {}), 1500));
  await vaultRow(page, 'Vault A').click();
  await page.click('#lock-now'); // the open is still waiting for the vault
  await expect(page.locator('#pin')).toBeVisible();
  await page.waitForTimeout(2500); // the open fails after the lock
  await expect(page.locator('#pin')).toBeVisible();
  await expect(page.locator('#open-settings')).toBeHidden();
  await expect(page.locator('#list')).toBeHidden();
});

test('Change PIN counts wrong current PINs like the unlock does', async ({ popup: page }) => {
  await addVault(page, 'Vault A', VAULT_A);
  await page.click('#open-settings');
  await page.click('#pin-change summary');
  for (let i = 1; i <= 4; i++) {
    await page.fill('#pin-current', '000000');
    await page.fill('#pin-new', '24680');
    await page.fill('#pin-new2', '24680');
    await page.click('#pin-save');
    await expect(page.locator('#error')).toContainText(`${5 - i} attempt(s) left`);
  }
  await page.fill('#pin-current', '000000');
  await page.fill('#pin-new', '24680');
  await page.fill('#pin-new2', '24680');
  await page.click('#pin-save');
  await expect(page.locator('#error')).toContainText('Too many wrong PINs');
  const local = await storage(page, 'local');
  expect(local.vaultTokens).toBeUndefined();
  expect(local.pin).toBeUndefined();
});

test('wrong PINs entered at the same moment in several pages are all counted', async ({ popup: page, context, origin }) => {
  await addVault(page, 'Vault A', VAULT_A);
  await page.click('#lock-now');
  const pages = [page, await context.newPage(), await context.newPage()];
  for (const p of pages.slice(1)) await p.goto(`${origin}/popup.html`);
  for (const p of pages) { await expect(p.locator('#pin')).toBeVisible(); await p.fill('#pin-input', '000000'); }
  await Promise.all(pages.map((p) => p.click('#pin-form button[type=submit]')));
  for (const p of pages) await expect(p.locator('#pin-form button[type=submit]')).toHaveText('Unlock');
  expect((await storage(page, 'local')).pinAttempts).toBe(3);
});

test('settings outside the offered values fall back to the defaults', async ({ popup: page }) => {
  await page.evaluate(() => chrome.storage.local.set({ settings: { autoLockMin: 999, pinTtlMin: 'x', clipboardClearSec: 30 } }));
  await page.click('#open-settings');
  await expect(page.locator('#set-autolock')).toHaveValue('1');
  await expect(page.locator('#set-pinttl')).toHaveValue('15');
  await expect(page.locator('#set-clip')).toHaveValue('30');
});

test('the vault web UI opens at the current page in a new tab, without the token', async ({ popup: page, context }) => {
  const openUi = async () => {
    const [tab] = await Promise.all([context.waitForEvent('page'), page.click('#open-ui')]);
    await expect.poll(() => tab.url()).not.toBe('about:blank');
    const url = tab.url();
    await tab.close();
    return url;
  };
  await setupA(page);
  expect(await openUi()).toContain(`${VAULT_A}/ui/vault/`); // root: the secrets engines (Vault may send to sign-in first)
  await openPath(page, 'secret/', 'demo/');
  expect(decodeURIComponent(await openUi())).toContain('/vault/secrets/secret/kv/list/demo/');
  await openPath(page, 'app');
  const url = await openUi();
  expect(decodeURIComponent(decodeURIComponent(url))).toContain('/vault/secrets/secret/kv/demo/app/details');
  expect(url).not.toContain('hvs.');
});

test('environment label: list, add form and while browsing', async ({ popup: page }) => {
  await addVault(page, 'Vault A', VAULT_A, { env: 'prod' });
  await expect(vaultRow(page, 'Vault A').locator('.chip.env-prod')).toHaveText('Prod');
  await unlock(page, 'Vault A');
  await expect(page.locator('#env-chip .chip')).toHaveText('Prod');
  await expect(page.locator('body')).toHaveAttribute('data-env', 'prod');
  await page.click('#back');
  await expect(page.locator('body')).toHaveAttribute('data-env', '');
});

test('delete takes two clicks and removes the encrypted token and favorites', async ({ popup: page }) => {
  await setupA(page, 'secret/', 'demo/', 'app');
  await page.locator('#secret-view .fav').click();
  await page.click('#back');
  const del = vaultRow(page, 'Vault A').getByTitle('Delete');
  await del.click();
  await expect(del).toHaveText('Delete?');
  await expect(vaultRow(page, 'Vault A')).toHaveCount(1);
  await del.click();
  await expect(vaultRow(page, 'Vault A')).toHaveCount(0);
  const local = await storage(page, 'local');
  expect(local.vaultTokens).toEqual({});
  expect(local.favorites).toEqual({});
});

test('non-https remote addresses are rejected', async ({ popup: page }) => {
  await page.fill('#add-url', 'http://vault.example.com');
  await expect(page.locator('#add-secret')).toBeHidden(); // no token field for an address that cannot be used
  await page.click('#add-submit');
  await expect(page.locator('#error')).toContainText('https://');
  await expect(page.locator('#vaults .row')).toHaveCount(0);
});

// ---- PIN ----

test('PIN: lock now wipes the view; wrong PIN counts down; right PIN resumes', async ({ popup: page }) => {
  await setupA(page, 'secret/', 'demo/', 'app');
  await expect(page.locator('#lock-now')).toBeVisible();
  await page.click('#lock-now');
  await expect(page.locator('#pin')).toBeVisible();
  await expect(page.locator('#secret tbody tr')).toHaveCount(0); // nothing secret left in the DOM
  expect((await storage(page, 'session')).pinKey).toBeUndefined();

  await enterPin(page, '000000');
  await expect(page.locator('#error')).toContainText('Wrong PIN. 4 attempt(s) left');
  await enterPin(page, PIN);
  await expect(secretRow(page, 'username')).toBeVisible(); // back where we were, no token prompt
});

test('PIN: the unlock lasts 15 minutes, then the PIN is asked again (not the token)', async ({ popup: page }) => {
  await page.clock.install();
  await page.reload();
  await setupA(page);
  await expect(page.locator('#token-info')).toContainText('locks in 15 min');
  await expect(page.locator('#token-info')).not.toHaveClass(/warn/);
  await page.clock.fastForward('14:30');
  await expect(page.locator('#token-info')).toHaveClass(/warn/);
  await page.clock.fastForward('01:00');
  await expect(page.locator('#pin')).toBeVisible();
  await enterPin(page, PIN);
  await expect(item(page, 'secret/')).toBeVisible();
});

test('PIN: 5 wrong PINs delete the saved tokens and the PIN; the next token sets a new PIN', async ({ popup: page }) => {
  await addVault(page, 'Vault A', VAULT_A);
  await page.click('#lock-now');
  for (let i = 0; i < 4; i++) await enterPin(page, '1111');
  await expect(page.locator('#error')).toContainText('1 attempt(s) left');
  await enterPin(page, '1111');
  await expect(page.locator('#list')).toBeVisible();
  await expect(page.locator('#error')).toContainText('Too many wrong PINs');
  const local = await storage(page, 'local');
  expect(local.vaultTokens).toBeUndefined();
  expect(local.pin).toBeUndefined();
  await expect(vaultRow(page, 'Vault A')).toContainText('Token needed');

  await vaultRow(page, 'Vault A').click(); // says the token is missing, with a button to add it
  await expect(page.locator('#error')).toHaveText('No token is saved for this vault.');
  await page.click('#error-action');
  await expect(page.locator('#add-title')).toHaveText('Edit: Vault A');
  await expect(page.locator('#add-pin-setup')).toBeVisible();
  await page.fill('#add-token', process.env.TOKEN_A);
  await page.fill('#add-pin', '777777');
  await page.fill('#add-pin2', '777777');
  await page.click('#add-submit');
  await page.click('#lock-now');
  await enterPin(page, '777777');
  await unlock(page, 'Vault A');
});

test('PIN: a forgotten PIN can be reset (PIN and tokens go, vaults stay)', async ({ popup: page }) => {
  await addVault(page, 'Vault A', VAULT_A);
  await page.click('#lock-now');
  await page.click('#pin-forgot');
  await expect(page.locator('#pin-forgot')).toContainText('Click again');
  await page.click('#pin-forgot');
  await expect(page.locator('#list')).toBeVisible();
  await expect(page.locator('#lock-now')).toBeHidden();
  await expect(vaultRow(page, 'Vault A')).toContainText('Token needed');
  const local = await storage(page, 'local');
  expect(local.pin).toBeUndefined();
  expect(local.vaultTokens).toBeUndefined();
});

test('PIN: Settings also offers the reset, with the same two-step confirmation', async ({ popup: page }) => {
  await page.click('#open-settings');
  await expect(page.locator('#settings-reset')).toBeHidden(); // no PIN yet
  await page.click('#back');
  await addVault(page, 'Vault A', VAULT_A);
  await page.click('#open-settings');
  const reset = page.locator('#settings-reset');
  await expect(reset).toHaveText('Forgot PIN? Reset the PIN and saved tokens');
  await reset.click();
  await expect(reset).toContainText('Click again');
  expect((await storage(page, 'local')).pin).toBeTruthy(); // nothing removed after the first click
  await reset.click();
  await expect(page.locator('#list')).toBeVisible();
  await expect(page.locator('#toast')).toHaveText('PIN and saved tokens removed');
  await expect(vaultRow(page, 'Vault A')).toContainText('Token needed');
  await expect(page.locator('#lock-now')).toBeHidden();
  const local = await storage(page, 'local');
  expect(local.pin).toBeUndefined();
  expect(local.vaultTokens).toBeUndefined();
});

test('regression: a PIN left by an older version (no saved tokens) does not lock the reader', async ({ popup: page }) => {
  // what the previous version left behind: an optional PIN with a forgotten value, plaintext session tokens
  await page.evaluate(async () => {
    const { createPin } = await import('./crypto.js');
    const { config, key } = await createPin('old-pin-nobody-remembers', 1000);
    await chrome.storage.local.set({ pin: config, vaults: [{ id: 'old', name: 'Old Vault', url: 'http://127.0.0.1:18200', namespace: '', env: '' }] });
    await chrome.storage.session.set({ pinKey: key, tokens: { old: { token: 'x' } }, last: { vaultId: 'old', mount: null, path: '', secret: null } });
  });
  await page.reload();
  await expect(page.locator('#pin')).toBeHidden(); // nothing is encrypted with that PIN, so it is not asked for
  await vaultRow(page, 'Old Vault').click();
  await page.click('#error-action'); // "Add token"
  await expect(page.locator('#add-pin-setup')).toBeVisible(); // a new PIN is chosen with the token
  await page.fill('#add-token', process.env.TOKEN_A);
  await page.fill('#add-pin', PIN);
  await page.fill('#add-pin2', PIN);
  await page.click('#add-submit');
  await expect(vaultRow(page, 'Old Vault')).not.toContainText('Token needed');
  await page.click('#lock-now');
  await enterPin(page, PIN);
  await unlock(page, 'Old Vault');
});

test('PIN: change re-encrypts the saved tokens; the old PIN stops working', async ({ popup: page }) => {
  await addVault(page, 'Vault A', VAULT_A);
  await page.click('#open-settings');
  await expect(page.locator('#set-pinttl')).toHaveValue('15');
  await page.click('#pin-change summary');
  await page.fill('#pin-current', '999999');
  await page.fill('#pin-new', '24680');
  await page.fill('#pin-new2', '24680');
  await page.click('#pin-save');
  await expect(page.locator('#error')).toContainText('The current PIN is wrong. 4 attempt(s) left');
  await page.fill('#pin-current', PIN);
  await page.fill('#pin-new', '24680');
  await page.fill('#pin-new2', '24680');
  await page.click('#pin-save');
  await expect(page.locator('#toast')).toHaveText('PIN changed');

  await page.click('#lock-now');
  await enterPin(page, PIN);
  await expect(page.locator('#error')).toContainText('Wrong PIN');
  await enterPin(page, '24680');
  await unlock(page, 'Vault A');
  await expect(item(page, 'secret/')).toBeVisible();
});

test('PIN: the background auto-lock locks every open window; unlocking one unlocks all', async ({ context, origin, popup: page, sw }) => {
  await addVault(page, 'Vault A', VAULT_A);
  await unlock(page, 'Vault A');
  const other = await context.newPage();
  await other.goto(`${origin}/popup.html`);
  await expect(item(other, 'secret/')).toBeVisible();

  // what the service worker runs once the browser has been in the background for the configured time
  await sw.evaluate(() => chrome.alarms.create('auto-lock', { when: Date.now() }));
  await expect(page.locator('#pin')).toBeVisible();
  await expect(other.locator('#pin')).toBeVisible();

  await enterPin(other, PIN);
  await expect(item(other, 'secret/')).toBeVisible();
  await expect(item(page, 'secret/')).toBeVisible();
});

test('secret rows: copy buttons line up on the right whether or not a row has a reveal button', async ({ popup: page }) => {
  await setupA(page, 'secret/', 'demo/', 'app'); // username has no reveal button, password and api_key do
  await expect(page.locator('#secret tbody tr')).toHaveCount(3);
  const rights = await page.locator('#secret tbody tr').evaluateAll((rows) =>
    rows.map((r) => Math.round(r.querySelector('button[title="Copy"]').getBoundingClientRect().right)));
  expect(new Set(rights).size).toBe(1);
});

test('theme follows the system: Radix dark scales on .dark-theme', async ({ popup: page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark-theme/);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(17, 17, 19)'); // Radix slate-1 (dark)
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass(/dark-theme/);
});

test('layout: popup is as tall as its content; a long view scrolls the page with the header on top', async ({ popup: page }) => {
  await addVault(page, 'Vault A', VAULT_A);
  await page.setViewportSize({ width: 380, height: 600 }); // Chrome's maximum popup height
  // one vault, add form closed: a short list, no empty area below it
  expect(await page.evaluate(() => document.body.getBoundingClientRect().height)).toBeLessThan(300);
  await page.click('#open-settings');
  await page.click('#pin-change summary'); // open the PIN form: longer than the popup
  await page.evaluate(() => window.scrollTo(0, 1000));
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  expect(Math.round((await page.locator('header').boundingBox()).y)).toBe(0);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overscrollBehaviorY)).toBe('none');
  const [htmlBg, bodyBg] = await page.evaluate(() => [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor]);
  expect(htmlBg).toBe(bodyBg);
});

test('selecting and copying a key name keeps the page scrollable', async ({ popup: page }) => {
  await page.setViewportSize({ width: 380, height: 600 });
  const data = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`config_key_${i}`, `fake-value-${i}`]));
  await page.route('**/v1/secret/data/demo/app*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { data, metadata: { version: 1, created_time: '2026-10-01T00:00:00Z' } } }) }));
  await addVault(page, 'Vault A', VAULT_A);
  await unlock(page, 'Vault A');
  await openPath(page, 'secret/', 'demo/', 'app');
  const b = await secretRow(page, 'config_key_3').locator('th').boundingBox();
  await page.mouse.dblclick(b.x + 10, b.y + b.height / 2);
  expect(await page.evaluate(() => getSelection().toString())).toBe('config_key_3');
  await page.keyboard.press('ControlOrMeta+c');
  for (const y of [150, 350, 580]) {
    const before = await page.evaluate(() => window.scrollY);
    await page.mouse.move(150, y);
    await page.mouse.wheel(0, 200);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before);
  }
});

test('an unreachable vault gets a clear error instead of "Failed to fetch"', async ({ popup: page }) => {
  await page.fill('#add-name', 'Nowhere');
  await page.fill('#add-url', 'http://127.0.0.1:18299'); // nothing listens here
  await page.fill('#add-token', 'any');
  await page.fill('#add-pin', PIN);
  await page.fill('#add-pin2', PIN);
  await page.click('#add-submit');
  await expect(page.locator('#error')).toHaveText('Could not reach http://127.0.0.1:18299. Check that the vault is running and reachable from this network (VPN?).');
});

test('privacy curtain: losing focus re-masks revealed values and covers the window', async ({ popup: page }) => {
  await setupA(page, 'secret/', 'demo/', 'app');
  const pw = secretRow(page, 'password');
  await pw.getByTitle('Show/hide').click();
  await expect(pw.locator('.value')).toHaveText('uydurma-parola-123');

  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.locator('#curtain')).toBeVisible();
  await expect(pw.locator('.value')).toHaveText(MASK);
  await page.click('#curtain-show');
  await expect(page.locator('#curtain')).toBeHidden();
  await expect(pw.locator('.value')).toHaveText(MASK);
});

// ---- Windows, clipboard, manifest ----

test('manifest: no idle permission, one shortcut', async ({ sw }) => {
  const manifest = await sw.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.permissions).not.toContain('idle');
  expect(Object.keys(manifest.commands)).toEqual(['_execute_action']);
});

test('windows stay in sync: a vault deleted in another window sends this one back to the list', async ({ context, origin, popup: page }) => {
  await setupA(page, 'secret/', 'demo/');
  const other = await context.newPage();
  await other.goto(`${origin}/popup.html`);
  await expect(item(other, 'app')).toBeVisible();
  await other.click('#back');
  const del = vaultRow(other, 'Vault A').getByTitle('Delete');
  await del.click();
  await del.click();
  await expect(page.locator('#list')).toBeVisible();
  await expect(page.locator('#error')).toHaveText('This vault was deleted in another window.');
});

test('stale record: after an address change in another window, the token never goes to the old address', async ({ context, origin, popup: page }) => {
  await addVault(page, 'Vault X', VAULT_A);
  const other = await context.newPage();
  const toOld = [];
  other.on('request', (r) => r.url().startsWith(VAULT_A) && toOld.push(r.headers()['x-vault-token']));
  await other.goto(`${origin}/popup.html`);
  await expect(vaultRow(other, 'Vault X')).toContainText(VAULT_A);

  await vaultRow(page, 'Vault X').getByTitle('Edit').click();
  await page.fill('#add-url', VAULT_B);
  await page.fill('#add-token', process.env.TOKEN_B);
  await page.click('#add-submit');

  await expect(vaultRow(other, 'Vault X')).toContainText(VAULT_B); // re-rendered from storage
  await vaultRow(other, 'Vault X').click();
  await openPath(other, 'secret/');
  await expect(item(other, 'team/')).toBeVisible();
  expect(toOld).not.toContain(process.env.TOKEN_B);
});

test('clipboard: copy schedules a clear, the alarm clears via offscreen, setting can turn it off', async ({ popup: page, sw }) => {
  const alarmIn = () => sw.evaluate(async () => {
    const a = await chrome.alarms.get('clear-clipboard');
    return a ? Math.round((a.scheduledTime - Date.now()) / 1000) : null;
  });
  const pending = async () => (await storage(page, 'local')).clipboardPending;
  await setupA(page, 'secret/', 'demo/', 'app');
  await secretRow(page, 'password').getByTitle('Copy').click();
  await expect(page.locator('#toast')).toHaveText('Copied · cleared from the clipboard in 90 s');
  await expect.poll(alarmIn).toBeGreaterThan(80);
  expect(await pending()).toBe(true);

  await sw.evaluate(() => chrome.alarms.create('clear-clipboard', { when: Date.now() }));
  await expect.poll(pending).toBeUndefined();
  expect(await sw.evaluate(() => chrome.offscreen.hasDocument())).toBe(false);

  await page.click('#open-settings');
  await page.selectOption('#set-clip', '0');
  await expect(page.locator('#toast')).toHaveText('Saved');
  await page.click('#back');
  await unlock(page, 'Vault A'); // reopens where Vault A was left: secret/demo/app
  await secretRow(page, 'password').getByTitle('Copy').click();
  await expect(page.locator('#toast')).toHaveText('Copied');
  expect(await alarmIn()).toBeNull();
});

// ---- Search ----

test('search: nested paths across mounts, highlighted, opens the secret', async ({ popup: page }) => {
  await setupA(page);
  await page.fill('#search', 'billing');
  await expect(page.locator('#items .row')).toHaveCount(1);
  await expect(item(page, 'config')).toContainText('secret/demo/services/billing/');
  await expect(page.locator('#items mark')).toHaveText('billing');
  await page.fill('#search', 'CONFIG');
  await expect(page.locator('#items .row')).toHaveCount(2);
  await page.locator('#items .row', { hasText: 'kv/legacy/' }).click();
  await expect(secretRow(page, 'endpoint')).toBeVisible();
  await expect(page.locator('#crumbs > *')).toHaveText(['', 'kv/', 'legacy/', 'config']);
  await page.fill('#search', 'demo-app');
  await expect(item(page, 'demo-app')).toContainText('totp/');
  await page.fill('#search', 'no-such-thing');
  await expect(page.locator('#search-info')).toContainText('0 results');
  await page.fill('#search', '');
  await expect(secretRow(page, 'endpoint')).toBeVisible();
});

test('search is per vault: A\'s secrets do not show up in B', async ({ popup: page }) => {
  await addVault(page, 'Vault A', VAULT_A);
  await addVault(page, 'Vault B', VAULT_B);
  await unlock(page, 'Vault A');
  await page.fill('#search', 'demo');
  await expect(item(page, 'app')).toBeVisible();
  await page.click('#back');
  await unlock(page, 'Vault B');
  await expect(page.locator('#search')).toHaveValue('');
  await page.fill('#search', 'team/service');
  await expect(page.locator('#items .row')).toHaveCount(1);
  await page.fill('#search', 'demo');
  await expect(page.locator('#search-info')).toContainText('0 results');
});
