import { execSync } from 'node:child_process';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { seed } from './seed.js';

const COMPOSE = 'docker compose -f e2e/docker-compose.yml';
export const BUILD = 'e2e/.build/extension';

export default async function globalSetup() {
  execSync(`${COMPOSE} up -d`, { stdio: 'inherit' });
  const { tokenA, tokenB } = await seed();
  process.env.TOKEN_A = tokenA;
  process.env.TOKEN_B = tokenB;

  // Test-only copy of the extension with host_permissions pre-granted,
  // because Chrome's permission prompt cannot be clicked by automation.
  // E2E_EXTENSION=<unzipped dist folder> runs the same tests against the packaged (minified) build.
  rmSync(BUILD, { recursive: true, force: true });
  cpSync(process.env.E2E_EXTENSION ?? 'extension', BUILD, { recursive: true });
  const manifest = JSON.parse(readFileSync(`${BUILD}/manifest.json`, 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  writeFileSync(`${BUILD}/manifest.json`, JSON.stringify(manifest, null, 2));

  return () => {
    if (!process.env.KEEP_VAULT) execSync(`${COMPOSE} down -v`, { stdio: 'inherit' });
  };
}
