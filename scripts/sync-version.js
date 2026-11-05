// Runs from `npm version <patch|minor|major|x.y.z>` (npm's "version" lifecycle script): copies the new
// package.json version into the extension manifest so the two never drift apart.
import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const path = 'extension/manifest.json';
const manifest = JSON.parse(readFileSync(path, 'utf8'));
manifest.version = version;
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`manifest version -> ${version} (add the changes to CHANGELOG.md)`);
