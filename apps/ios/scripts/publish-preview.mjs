// Publish a private development build; never creates a release or a Git tag.
import { readFile, writeFile, copyFile, rename, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const [directory, baseURL] = process.argv.slice(2);
if (!directory || !baseURL || new URL(baseURL).protocol !== 'https:') throw new Error('Usage: node publish-preview.mjs <existing-source-directory> <https-base-url>');
const ios = fileURLToPath(new URL('..', import.meta.url));
const sourcePath = join(resolve(directory), 'source.json');
const original = await readFile(sourcePath, 'utf8');
const source = JSON.parse(original);
if (!Array.isArray(source.apps)) throw new Error('Invalid existing AltStore source.');
const plist = join(ios, 'build-device/Build/Products/Release-iphoneos/Sickrat.app/Info.plist');
const info = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }));
const version = info.CFBundleShortVersionString, build = info.CFBundleVersion;
const file = `Sickrat-${version}-${build}.ipa`, icon = `SickratIcon-${build}.png`;
const ipa = join(ios, 'build', file), bytes = await readFile(ipa);
const digest = createHash('sha256').update(bytes).digest('hex');
const bundleIdentifier = info.CFBundleIdentifier;
const old = source.apps.find(app => app.bundleIdentifier === bundleIdentifier);
if (old?.versions.some(item => item.version === version && item.buildVersion === build)) throw new Error('This version/build already exists. Increment the build before publishing.');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ios, encoding: 'utf8' }).trim();
const url = name => baseURL.replace(/\/$/, '') + '/' + name;
const app = {
  name: 'Sickrat Preview', bundleIdentifier, developerName: 'Netanel Gilad',
  localizedDescription: 'Native SwiftUI development preview. Approve CLI requests, manage encrypted secrets, connect accounts and transfer your existing vault key. Foreground refresh; background push and some management flows are still being migrated.',
  iconURL: url(icon), tintColor: '5856D6', category: 'utilities',
  versions: [{version, buildVersion: build, date: new Date().toISOString(), localizedDescription: 'Transfer your vault key directly between iPhones with fresh device authentication and an encrypted, recipient-bound file. Existing web-console transfers remain supported. Requires iOS 18 and a device passcode.', downloadURL: url(file), size: (await stat(ipa)).size, sha256: digest, minOSVersion: info.MinimumOSVersion, commit}, ...(old?.versions ?? [])],
  appPermissions: {entitlements: [], privacy: {NSFaceIDUsageDescription: info.NSFaceIDUsageDescription}},
};
await copyFile(ipa, join(directory, file), constants.COPYFILE_EXCL);
await copyFile(join(ios, 'Sickrat/Assets.xcassets/AppIcon.appiconset/AppIcon.png'), join(directory, icon), constants.COPYFILE_EXCL);
await writeFile(join(directory, `source-before-sickrat-${Date.now()}.json`), original, {flag:'wx'});
source.apps = [...source.apps.filter(item => item.bundleIdentifier !== bundleIdentifier), app];
const temporary = sourcePath + '.sickrat-tmp';
await writeFile(temporary, JSON.stringify(source, null, 2) + '\n', {flag:'wx'});
await rename(temporary, sourcePath);
console.log(JSON.stringify({source: url('source.json'), ipa: url(file), sha256: digest, bytes: bytes.length}));
