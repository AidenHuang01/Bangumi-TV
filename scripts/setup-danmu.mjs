import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const commit = '4d325e096bbbf0c1ff261a9bfa638f7c58784f60';
const directory = fileURLToPath(new URL('../.tools/danmu-api/', import.meta.url));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });
if (!existsSync(directory)) {
  mkdirSync(fileURLToPath(new URL('../.tools/', import.meta.url)), { recursive: true });
  run('git', ['clone', '--no-checkout', 'https://github.com/huangxd-/danmu_api.git', directory]);
  run('git', ['fetch', '--depth', '1', 'origin', commit], directory);
  run('git', ['checkout', '--detach', commit], directory);
}
const current = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim();
if (current !== commit) throw new Error('danmu_api revision differs; use a separate clean checkout pinned to ' + commit + '. No existing checkout was overwritten.');
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', [existsSync(directory + '/package-lock.json') ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund'], directory);
console.log('Pinned danmu_api ready. npm start launches a private loopback-only worker. No API key or desktop player is used.');
