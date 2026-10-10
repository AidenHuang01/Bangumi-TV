import { cp, mkdir, writeFile, mkdtemp, rename, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'dist');
const output = path.join(dist, 'tv-app');
const args = process.argv.slice(2);
function argument(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(name + ' needs a value');
  return args[index + 1];
}
const server = argument('--server');
const profile = argument('--profile');
const assets = ['config.xml', 'index.html', 'style.css', 'app.js', 'defaults.js', 'icon.svg', 'icon.png'];
await mkdir(output, { recursive: true });
for (const file of assets) await cp(path.join(root, 'tv-app', file), path.join(output, file));
if (server) {
  const url = new URL(server);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) throw new Error('--server must be an HTTP(S) origin');
  await writeFile(path.join(output, 'defaults.js'), `window.BANGUMI_DEFAULT_SERVER = ${JSON.stringify(url.origin)};\n`);
}
if (profile) {
  const result = spawnSync('tizen', ['package', '-t', 'wgt', '-s', profile, '-o', dist, '--', output], { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    console.error('Signing failed. Check Tizen Studio, your Samsung profile and PATH. If a certificate password was requested, rerun this command in Terminal and enter it privately at the prompt.');
    process.exit(1);
  }
  // The 2019 TV installer fails when the archive filename contains spaces.
  // Renaming the archive does not alter the signed files inside it.
  const config = await readFile(path.join(output, 'config.xml'), 'utf8');
  const appName = config.match(/<name>([^<]+)<\/name>/)?.[1];
  if (!appName) throw new Error('Missing widget name in config.xml');
  const installable = path.join(dist, 'BangumiTV.wgt');
  await cp(path.join(dist, appName + '.wgt'), installable);
  console.log('Signed installable package: ' + installable);
} else {
  // ZIP is the widget container, but TV installation also requires Samsung signatures.
  const archive = path.join(dist, 'BangumiTV-unsigned.wgt');
  const temporary = path.join(await mkdtemp(path.join(dist, '.package-')), 'BangumiTV-unsigned.wgt');
  const result = spawnSync('zip', ['-q', temporary, ...assets], { cwd: output, stdio: 'inherit' });
  if (result.error || result.status !== 0) process.exit(1);
  await rename(temporary, archive);
  console.log('Unsigned preview package: ' + archive);
  console.log('Not installable yet. Sign using: npm run package:tv -- --profile YOUR_SAMSUNG_PROFILE');
}
