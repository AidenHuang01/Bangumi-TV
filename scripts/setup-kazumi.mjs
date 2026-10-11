// Build tools and upstream source stay project-local; no global Flutter/pod setup.
import { spawn } from 'node:child_process';
import { access, mkdir, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kazumiCommit } from '../server/lib/kazumi-client.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const toolsDir = path.join(root, '.tools');
const source = path.join(toolsDir, 'Kazumi-reference');
const sdk = path.join(toolsDir, 'flutter/bin/flutter');
const flutterVersion = '3.47.6';
const sdkHash = 'a1946d3b6b3de15ce247dc89649df9035ce29e6b4e7ebe91919a25890ea2e79a';
const exists = async filename => { try { await access(filename); return true; } catch { return false; } };
function run(command, args, { cwd = root, env = process.env, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
    let output = '';
    if (capture) child.stdout.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(output.trim()) : reject(new Error(`${command} failed (${code})`)));
  });
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('This bootstrap targets Apple Silicon macOS. A separate Flutter SDK setup is needed on other platforms.');
}
await mkdir(path.join(toolsDir, 'installers'), { recursive: true });
if (!(await exists(source))) {
  await run('git', ['clone', '--no-checkout', 'https://github.com/Predidit/Kazumi.git', source]);
  await run('git', ['checkout', '--detach', kazumiCommit], { cwd: source });
}
const commit = await run('git', ['rev-parse', 'HEAD'], { cwd: source, capture: true });
const dirty = await run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: source, capture: true });
if (commit !== kazumiCommit || dirty) throw new Error('Kazumi source differs from the pinned, unmodified revision. No files were reset.');
if (!(await exists(sdk))) {
  const archive = path.join(toolsDir, `installers/flutter-${flutterVersion}.zip`);
  if (!(await exists(archive))) {
    await run('curl', ['--fail', '--location', '--output', archive + '.partial',
      `https://storage.googleapis.com/flutter_infra_release/releases/stable/macos/flutter_macos_arm64_${flutterVersion}-stable.zip`]);
    await rename(archive + '.partial', archive);
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest('hex') !== sdkHash) throw new Error('Flutter SDK checksum did not match. Archive was not extracted.');
  await run('unzip', ['-q', archive, '-d', toolsDir]);
}
const version = JSON.parse(await run(sdk, ['--suppress-analytics', '--version', '--machine'], { capture: true }));
if (version.frameworkVersion !== flutterVersion) throw new Error(`Expected Flutter ${flutterVersion}; found ${version.frameworkVersion}`);
const rubyDir = '/opt/homebrew/opt/ruby/bin';
if (!(await exists(path.join(rubyDir, 'ruby')))) throw new Error('A Ruby 3+ installation is required for local CocoaPods. Nothing was installed globally.');
const gemDir = path.join(toolsDir, 'ruby-gems'), gemBin = path.join(toolsDir, 'ruby-bin');
const env = { ...process.env, PATH: `${gemBin}:${rubyDir}:${path.dirname(sdk)}:${process.env.PATH}`,
  GEM_HOME: gemDir, GEM_PATH: gemDir, COCOAPODS_DISABLE_STATS: 'true' };
try { await run(path.join(gemBin, 'pod'), ['--version'], { env, capture: true }); }
catch {
  await run(path.join(rubyDir, 'gem'), ['install', 'cocoapods', '--version', '1.16.2',
    '--install-dir', gemDir, '--bindir', gemBin, '--no-document'], { env });
  // Repairs an earlier local gem cache built with system Ruby, if present.
  await run(path.join(rubyDir, 'gem'), ['install', 'nkf', '--force', '--install-dir', gemDir,
    '--bindir', gemBin, '--no-document'], { env });
}
const cwd = path.join(root, 'kazumi-core');
await run(sdk, ['--suppress-analytics', 'pub', 'get'], { cwd, env });
await run(sdk, ['--suppress-analytics', 'analyze'], { cwd, env });
await run(sdk, ['--suppress-analytics', 'test'], { cwd, env });
await run(sdk, ['--suppress-analytics', 'build', 'macos', '--release'], { cwd, env });
console.log(`Built real Kazumi core ${kazumiCommit}. Start with TV_IP=10.0.0.53 npm start.`);
