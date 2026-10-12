import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const tv = option('--tv', '10.0.0.53'), server = option('--server', 'http://10.0.0.30:8787'), profile = option('--profile', 'BangumiTV');
if (!isIP(tv)) throw new Error('--tv must be the TV IP address');
const studio = path.join(homedir(), 'tizen-studio/tools');
const tizen = path.join(studio, 'ide/bin/tizen'), sdb = path.join(studio, 'sdb');
const env = { ...process.env, PATH: path.dirname(tizen) + path.delimiter + process.env.PATH };
function run(command, input, timeout) {
  const result = spawnSync(command, input, { cwd: root, env, stdio: 'inherit', timeout });
  if (result.error || result.status !== 0) throw new Error('TV update stopped: ' + (result.error?.message || 'command failed') + '. Previous app was not automatically removed.');
}
console.log('Enter certificate passwords privately in Terminal when prompted.');
run(process.execPath, [path.join(root, 'scripts/package-tv.mjs'), '--server', server, '--profile', profile]);
run(sdb, ['connect', tv], 20000);
run(tizen, ['install', '-s', tv + ':26101', '-n', 'BangumiTV.wgt', '--', path.join(root, 'dist')], 120000);
run(tizen, ['run', '-s', tv + ':26101', '-p', 'BgmiTVpoc1.BangumiTV'], 30000);
console.log('TV app installed and launched. Open the phone page to test ±10 seconds.');
