/**
 * Qoder CN 客户端登录态 → 凭证明文。
 *
 * 客户端把登录态放在 Chromium 的 `auth.v1.dat`（os_crypt v10：AES-256-GCM，密钥由
 * Windows DPAPI 保护）。解密链（与社区实现同源、本项目生产验证过）：
 *   Local State 的 `os_crypt.encrypted_key`（base64，去 5 字节前缀 "DPAPI"）
 *     → PowerShell 调 DPAPI Unprotect（CurrentUser）→ 32 字节 AES key
 *     → 解 auth.v1.dat：[3B "v10"][12B nonce][ct…][16B tag]
 *
 * 只读本机文件、只在本机解密；令牌仅写到本机 `~/.waygate/qoc/`，不上传任何地方。
 */

import { execFileSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CredentialError } from './errors.js';

/** Qoder 客户端身份材料（`providers/<id>.key` 的同形 JSON）。 */
export interface QoderIdentity {
  /** 访问令牌（`dt-…`）。 */
  token: string;
  /** 刷新令牌（`drt-…`）。 */
  refreshToken: string;
  uid: string;
  name: string;
  userType: string;
}

/** 客户端数据目录（可用 QODER_APP_DIR 覆盖，便于便携部署/异机取证）。 */
export function qoderAppDir(): string {
  const override = (process.env.QODER_APP_DIR ?? '').trim();
  if (override) return override;
  const roaming = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  return join(roaming, 'com.qodercn.app.stable');
}

/** 平台是否支持（DPAPI 是 Windows 专有）。 */
export function isSupportedPlatform(): boolean {
  return process.platform === 'win32';
}

/** 用 DPAPI 解出 os_crypt 的 AES key（Windows；走 PowerShell 免原生依赖）。 */
function osCryptKey(appDir: string): Buffer {
  const localStatePath = join(appDir, 'Local State');
  if (!existsSync(localStatePath)) {
    throw new CredentialError(`找不到客户端文件：${localStatePath}（客户端未安装或未运行过？可用 QODER_APP_DIR 指定目录）`);
  }
  const ls = JSON.parse(readFileSync(localStatePath, 'utf8')) as { os_crypt?: { encrypted_key?: string } };
  const b64 = ls.os_crypt?.encrypted_key;
  if (!b64) throw new CredentialError('Local State 里没有 os_crypt.encrypted_key —— 客户端版本可能变了');

  const encrypted = Buffer.from(b64, 'base64');
  const hex = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `$enc = [Convert]::FromBase64String('${encrypted.toString('base64')}'); $enc = $enc[5..($enc.Length-1)]; Add-Type -AssemblyName System.Security; ([Security.Cryptography.ProtectedData]::Unprotect($enc, $null, 'CurrentUser') | ForEach-Object { $_.ToString('x2') }) -join ''`,
    ],
    { encoding: 'utf8' },
  ).trim();
  if (!hex) throw new CredentialError('DPAPI 解密返回空（当前用户与写入该文件的用户不一致？）');
  return Buffer.from(hex, 'hex');
}

/** 解 `auth.v1.dat`（v10 形态）。 */
function decryptV10(blob: Buffer, key: Buffer): string {
  if (blob.subarray(0, 3).toString() !== 'v10') {
    throw new CredentialError('auth.v1.dat 不是 v10 格式（客户端加密方案变了？）');
  }
  const nonce = blob.subarray(3, 15);
  const tag = blob.subarray(blob.length - 16);
  const ct = blob.subarray(15, blob.length - 16);
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/**
 * 从本机客户端登录态解出身份材料。
 * 失败一律抛 `CredentialError`（人话描述，CLI 直接展示，不抛栈）。
 */
export function readQoderIdentity(): QoderIdentity {
  if (!isSupportedPlatform()) {
    throw new CredentialError(`当前平台（${process.platform}）暂不支持自动读取 Qoder 登录态（DPAPI 为 Windows 专有）；请手动导出 identity JSON 后放入 ~/.waygate/qoc/credential.json`);
  }
  const appDir = qoderAppDir();
  const authFile = join(appDir, 'auth.v1.dat');
  if (!existsSync(authFile)) {
    throw new CredentialError(`找不到登录态文件 ${authFile} —— 请先在 Qoder 客户端登录；或用 QODER_APP_DIR 指定客户端数据目录`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(decryptV10(readFileSync(authFile), osCryptKey(appDir))) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof CredentialError) throw err;
    throw new CredentialError(`解密登录态失败：${(err as Error).message}（客户端未登录，或文件被其他程序占用？）`);
  }

  const user = (parsed.user ?? {}) as { id?: unknown; name?: unknown };
  const identity: QoderIdentity = {
    token: String(parsed.token ?? ''),
    refreshToken: String(parsed.refreshToken ?? ''),
    uid: String(user.id ?? ''),
    name: String(user.name ?? 'qoder-user'),
    userType: 'personal_standard',
  };
  for (const [k, v] of Object.entries(identity)) {
    if (!v && k !== 'name') throw new CredentialError(`登录态缺字段 ${k} —— 客户端未登录？请在客户端登录后重试`);
  }
  return identity;
}
