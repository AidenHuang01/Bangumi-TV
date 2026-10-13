import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

if (process.platform !== 'darwin') throw new Error('This installer uses macOS launchd');

const root = fileURLToPath(new URL('../', import.meta.url));
const label = 'dev.forgetech.bangumi-server';
const domain = 'gui/' + process.getuid();
const target = domain + '/' + label;
const agents = path.join(homedir(), 'Library/LaunchAgents');
const file = path.join(agents, label + '.plist');
const logs = path.join(root, 'server/data/logs');
const stableNode = '/opt/homebrew/opt/node@18/bin/node';
let node = process.execPath;
try { await access(stableNode, constants.X_OK); node = stableNode; } catch { /* Use the current Node install. */ }

const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tvIP = process.env.TV_IP || '10.0.0.53';
await mkdir(agents, { recursive: true });
await mkdir(logs, { recursive: true });

const existing = spawnSync('launchctl', ['print', target], { stdio: 'ignore' });
if (existing.status === 0) {
  const stopped = spawnSync('launchctl', ['bootout', target], { stdio: 'inherit' });
  if (stopped.status !== 0) throw new Error('Could not stop the existing Bangumi server service');
}

await writeFile(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(path.join(root, 'server/index.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict>
<key>HOST</key><string>0.0.0.0</string>
<key>PORT</key><string>8787</string>
<key>TV_IP</key><string>${xml(tvIP)}</string>
</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(path.join(logs, 'server-service.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(logs, 'server-service-error.log'))}</string>
</dict></plist>\n`, { mode: 0o600 });

const loaded = spawnSync('launchctl', ['bootstrap', domain, file], { stdio: 'inherit' });
if (loaded.status !== 0) throw new Error('Could not register the Bangumi server service');

let healthy = false;
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    const response = await fetch('http://127.0.0.1:8787/api/health', { signal: AbortSignal.timeout(1000) });
    const info = await response.json();
    if (response.ok && info.animeBackend?.engine === 'kazumi') { healthy = true; break; }
  } catch { /* The native Kazumi worker may still be starting. */ }
  await new Promise(resolve => setTimeout(resolve, 500));
}
if (!healthy) throw new Error('Service registered but is not healthy; inspect ' + path.join(logs, 'server-service-error.log'));
console.log('Bangumi server service is running and restarts after exit or macOS login.');
console.log('Phone: http://10.0.0.30:8787/remote/');
console.log('Logs: ' + logs);
