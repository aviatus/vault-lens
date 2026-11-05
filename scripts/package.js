// npm run package -> dist/vault-lens-<version>.zip
// The zip holds one folder (the extension plus INSTALL.txt) that people unzip and load with
// chrome://extensions > Developer mode > Load unpacked. Checks run first so a test-only or broken build
// is never handed out.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { transformSync } from 'esbuild';

const fail = (msg) => {
  console.error(`package: ${msg}`);
  process.exit(1);
};

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const manifest = JSON.parse(readFileSync('extension/manifest.json', 'utf8'));

// ---- checks ----
if (pkg.version !== manifest.version) {
  fail(`version mismatch: package.json ${pkg.version}, manifest ${manifest.version}. Use "npm version <patch|minor|major>".`);
}
// The version becomes part of paths that are deleted recursively below: digits and dots only.
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) fail(`version "${manifest.version}" is not dotted numbers`);
if (manifest.host_permissions) fail('manifest has host_permissions (test build?). Shipped builds ask per vault at runtime.');
if (!manifest.key) fail('manifest has no "key": the extension ID would differ on every machine.');

const ALLOWED = /\.(js|html|css|json|png|svg)$/;
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    // A symlink would ship whatever it points to (zip follows links), e.g. keys/extension.pem.
    if (entry.isSymbolicLink()) fail(`symlink in extension/: ${path}`);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile()) files.push(relative('extension', path));
    else fail(`not a regular file in extension/: ${path}`);
  }
})('extension');
const unexpected = files.filter((f) => !ALLOWED.test(f) || f.split('/').some((p) => p.startsWith('.') || p.startsWith('_')));
if (unexpected.length) fail(`unexpected files in extension/: ${unexpected.join(', ')}`);
const hooked = files.filter((f) => f.endsWith('.js') && /Object\.assign\(self/.test(readFileSync(join('extension', f), 'utf8')));
if (hooked.length) fail(`test hooks found in: ${hooked.join(', ')}`);

// ---- build ----
const name = `vault-lens-${manifest.version}`;
const stage = join('dist', name);
const zip = join('dist', `${name}.zip`);
rmSync(stage, { recursive: true, force: true });
rmSync(zip, { force: true });
mkdirSync('dist', { recursive: true });
cpSync('extension', stage, { recursive: true });

// Minify the extension's own .js and .css in the staged copy (source stays readable in extension/).
// Plain minification, no bundling: module files and import paths stay as they are. Code is still
// visible to anyone who opens the extension; this only makes the package smaller.
// vendor/ is left as shipped so its license notice stays intact.
let before = 0;
let after = 0;
for (const f of files.filter((f) => /\.(js|css)$/.test(f) && !f.startsWith('vendor/'))) {
  const path = join(stage, f);
  const source = readFileSync(path, 'utf8');
  const { code } = transformSync(source, { loader: f.endsWith('.css') ? 'css' : 'js', minify: true, target: 'chrome120', legalComments: 'none' });
  writeFileSync(path, code);
  before += source.length;
  after += code.length;
}

writeFileSync(join(stage, 'INSTALL.txt'), `Vault Lens ${manifest.version}

Kurulum (Chrome)
1. Bu klasörü kalıcı bir yere koyun (ör. Belgeler). Kurulumdan sonra silmeyin ve taşımayın:
   Chrome eklentiyi bu klasörden çalıştırır.
2. Chrome'da chrome://extensions adresini açın.
3. Sağ üstten "Developer mode"u açın.
4. "Load unpacked" deyin ve bu klasörü (içinde manifest.json olan) seçin.
5. Araç çubuğundaki yapboz simgesinden Vault Lens'ı sabitleyin.

Güncelleme
Yeni sürümün klasörüyle bu klasörü değiştirin (içeriğini üzerine kopyalayın), sonra
chrome://extensions sayfasında eklentinin yenile düğmesine basın. Eklenti ID'si
(${extensionId(manifest.key)}) her sürümde aynıdır; kayıtlı Vault'lar ve şifreli token'lar korunur.

Kullanım
- "+ Add vault": ad, adres ve Vault token'ı girin. İlk Vault'ta bir PIN belirlersiniz.
  PIN hiçbir yerde saklanmaz; unutursanız Settings > "Forgot PIN?" ile PIN ve token'lar sıfırlanır.
- Kısayol: Alt+Shift+V.
`);

execFileSync('zip', ['-r', '-X', '-q', `${name}.zip`, name], { cwd: 'dist' });
const sha256 = createHash('sha256').update(readFileSync(zip)).digest('hex');
writeFileSync(`${zip}.sha256`, `${sha256}  ${name}.zip\n`);
rmSync(stage, { recursive: true, force: true });

console.log(`package: ${zip}`);
console.log(`  version   ${manifest.version}`);
console.log(`  extension ${extensionId(manifest.key)}`);
console.log(`  files     ${files.length + 1}`);
console.log(`  minified  ${(before / 1024).toFixed(0)} KB -> ${(after / 1024).toFixed(0)} KB (js/css)`);
console.log(`  sha256    ${sha256}`);

// Chrome's extension ID: first 32 hex chars of sha256(public key DER), mapped 0-f -> a-p.
function extensionId(keyB64) {
  const hex = createHash('sha256').update(Buffer.from(keyB64, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}
