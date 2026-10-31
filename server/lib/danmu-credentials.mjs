import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile } from 'node:fs/promises';

export const danmuKeychainService = 'local.bangumitv.dandanplay';

async function readPrivateCredential() {
  const file = new URL('../data/credentials/dandanplay.json', import.meta.url);
  const info = await lstat(file);
  if (!info.isFile() || (info.mode & 0o077) || info.size > 8192 || info.uid !== process.getuid?.()) throw new Error('Unsafe credential permissions');
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function loadDanmuCredentials({ account, store = 'keychain', platform = process.platform,
  run = promisify(execFile), readPrivate = readPrivateCredential } = {}) {
  if (!account) return undefined;
  if (store === 'file') {
    try {
      const value = await readPrivate();
      if (value.account !== account || typeof value.password !== 'string' || !value.password || value.password.length > 1024) throw new Error('Invalid credential');
      return { account, password: value.password };
    } catch { throw new Error('无法读取弹幕私有凭证；请检查账号、文件所有者与 600 权限。'); }
  }
  if (store !== 'keychain') throw new Error('未知的弹幕凭证存储方式。');
  if (typeof account !== 'string' || account.length > 200 || platform !== 'darwin') {
    throw new Error('弹幕账号需要在 Mac 钥匙串中配置。');
  }
  try {
    const { stdout } = await run('/usr/bin/security', ['find-generic-password', '-s', danmuKeychainService, '-a', account, '-w'],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
    const password = stdout.replace(/\r?\n$/, '');
    if (!password || password.length > 1024) throw new Error('Invalid credential');
    return { account, password };
  } catch {
    throw new Error('无法读取弹幕账号的 Mac 钥匙串凭证；请检查钥匙串是否已解锁。');
  }
}
