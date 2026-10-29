// Explicit development-only deployment using the CLI's existing local artifact
// support. Keep the production release resolver and main-only tag guards intact.
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../..', import.meta.url));
const cli = new URL('../../cli/src/index.ts', import.meta.url);
const temporary = new URL('../../cli/src/.ios-preview-deploy.ts', import.meta.url);
const version = '0.1.53-ios-preview.1';
const source = await readFile(cli, 'utf8');
const marker = 'async function vaultUpdate(args: string[]) {';
const start = source.indexOf(marker);
if (start < 0) throw new Error('CLI update entry point changed. Review deployment before continuing.');
const prefix = source.slice(0, start), update = source.slice(start);
const target = 'const targetVersion = releaseVersion(release);';
if (!update.includes(target)) throw new Error('CLI version resolver changed. Review deployment before continuing.');
await writeFile(temporary, prefix + update.replace(target, `const targetVersion = ${JSON.stringify(version)};`), { flag: 'wx' });
try {
  const result = spawnSync('bun', [fileURLToPath(temporary), 'vault', 'update', 'default', ...process.argv.slice(2)], {
    cwd: root, stdio: 'inherit', env: { ...process.env, SICKRAT_WEB_DIST: fileURLToPath(new URL('../../web/dist', import.meta.url)) },
  });
  process.exitCode = result.status ?? 1;
} finally { await unlink(temporary); }
