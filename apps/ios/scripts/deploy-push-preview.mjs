// Explicit development-only deployment using the CLI's existing local artifact
// support. Keep the production release resolver and main-only tag guards intact.
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../..', import.meta.url));
const cli = new URL('../../cli/src/index.ts', import.meta.url);
const temporary = new URL('../../cli/src/.ios-preview-deploy.ts', import.meta.url);
const version = '0.1.53-ios-push-preview.1';
const source = await readFile(cli, 'utf8');
const marker = 'async function vaultUpdate(args: string[]) {';
const start = source.indexOf(marker);
if (start < 0) throw new Error('CLI update entry point changed. Review deployment before continuing.');
let prefix = source.slice(0, start); const update = source.slice(start);
const markerBindings = '...existingSecrets.filter(secret => apnsNames.has(secret.name)).map(secret => ({name: secret.name, type: "inherit"})),';
if (!prefix.includes(markerBindings)) throw new Error('APNs binding support changed; review before deploying.');
// Read the private key only in the short-lived CLI process; never log it or
// write it into the repository, the deployment plan, or an environment value.
prefix = prefix.replace(markerBindings, `...(process.env.SICKRAT_APNS_CONFIG ? await (async () => {
  const cfg = JSON.parse(await readFile(process.env.SICKRAT_APNS_CONFIG!, "utf8"));
  const key = await readFile(cfg.privateKeyPath, "utf8");
  if (cfg.environment !== "sandbox" || !cfg.teamId || !cfg.keyId || !cfg.topic || !cfg.enrollmentSecret || !key.includes("BEGIN PRIVATE KEY")) throw new Error("Invalid APNs configuration.");
  return Object.entries({APNS_TEAM_ID:cfg.teamId, APNS_KEY_ID:cfg.keyId, APNS_PRIVATE_KEY:key, APNS_TOPIC:cfg.topic, APNS_ENVIRONMENT:cfg.environment, APNS_ENROLLMENT_SECRET:cfg.enrollmentSecret}).map(([name,text]) => ({name, type:"secret_text", text}));
})() : existingSecrets.filter(secret => apnsNames.has(secret.name)).map(secret => ({name: secret.name, type: "inherit"}))),`);
const target = 'const targetVersion = releaseVersion(release);';
if (!update.includes(target)) throw new Error('CLI version resolver changed. Review deployment before continuing.');
await writeFile(temporary, prefix + update.replace(target, `const targetVersion = ${JSON.stringify(version)};`), { flag: 'wx' });
try {
  const result = spawnSync('bun', [fileURLToPath(temporary), 'vault', 'update', 'default', ...process.argv.slice(2)], {
    cwd: root, stdio: 'inherit', env: { ...process.env, SICKRAT_APNS_CONFIG: process.env.SICKRAT_APNS_CONFIG, SICKRAT_WEB_DIST: fileURLToPath(new URL('../../web/dist', import.meta.url)) },
  });
  process.exitCode = result.status ?? 1;
} finally { await unlink(temporary); }
