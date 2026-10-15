/**
 * Qoder CN 网关的 COSY 协议原语（v0.6.0）。
 *
 * 全部算法逆向自官方客户端 + 社区参考实现（EchoPing07/Qoder-2API-Go 的 auth.go），
 * 并于 2026-10-11 对真网关实弹验证通过（model/list / user/status / chat 三发三中，
 * 见记忆 waygate-qoder-integration 与 POC C:\tmp\qoder-poc.mjs）。
 *
 * 出站安全：所有头走本模块构造，绝不透传入站头（与 headers.ts 的 allowlist 纪律一致）；
 * 凭证（dt-/drt- 令牌）只进 AES 加密的 info 块，不落日志。
 */

import { createHash, publicEncrypt, createCipheriv, randomUUID } from 'node:crypto';

/* ─── 指纹常量（版本字典：客户端升级漂移时只改这里，单测钉住） ─── */

/** 客户端 CLI 版本（2026-10-11 本机实测，来源：.qoder-cn/logs/runs 下的 manifest.json）。 */
export const QODER_CLI_VERSION = '1.1.61';
/** COSY 协议版本（客户端写死值，随客户端升级漂移）。 */
export const QODER_COSY_VERSION = '0.1.43';
/** 客户端类型标识（5 = CLI 形态，实测值）。 */
export const QODER_CLIENT_TYPE = '5';
/** 与官方 CLI 同族形态的出站 UA（node 段动态取运行时，同族即可 —— 见 ua-fingerprint-plan.md）。 */
export const QODER_OUT_UA = `qodercli/${QODER_CLI_VERSION} node/${process.versions.node}`;
/** 登录协议版本（写死 v2）。 */
export const QODER_LOGIN_VERSION = 'v2';

/** [v0.6.0] Qoder 协议的默认网关与聊天端点（chat_path 可按提供商覆写）。 */
export const DEFAULT_QODER_BASE_URL = 'https://gateway.qoder.com.cn';
export const DEFAULT_QODER_CHAT_PATH =
  '/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1';

/* ─── 自定义 base64（Qoder 网关变体：字母表替换 + 三段轮转 + '='→'$'） ─── */

const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const S2C = new Map<string, string>();
const C2S = new Map<string, string>();
/* 两表等长（64 项，构造时同源生成）；i<64 时下标必然有效 —— 数组字面量的下标在
   类型层是 string|undefined，这里用非空断言表达该不变量。 */
for (let i = 0; i < 64; i++) {
  S2C.set(STD_ALPHABET[i]!, CUSTOM_ALPHABET[i]!);
  C2S.set(CUSTOM_ALPHABET[i]!, STD_ALPHABET[i]!);
}
S2C.set('=', '$');
C2S.set('$', '=');

/** 标准请求体 → 网关自定义编码（所有 Encode=1 端点的请求体格式）。 */
export function qEncode(plain: string): string {
  const std = Buffer.from(plain, 'utf8').toString('base64');
  const n = std.length;
  const a = Math.floor(n / 3);
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  let out = '';
  for (const ch of rearranged) {
    const mapped = S2C.get(ch);
    if (mapped === undefined) throw new Error(`qEncode 遇到字母表外字符: ${JSON.stringify(ch)}`);
    out += mapped;
  }
  return out;
}

/** 网关自定义编码 → 原文（响应侧解码用；非法字符抛错而不是静默截断）。 */
export function qDecode(encoded: string): string {
  let std = '';
  for (const ch of encoded) {
    const mapped = C2S.get(ch);
    if (mapped === undefined) throw new Error(`qDecode 遇到字母表外字符: ${JSON.stringify(ch)}`);
    std += mapped;
  }
  const n = std.length;
  const a = Math.floor(n / 3);
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  return Buffer.from(rearranged, 'base64').toString('utf8');
}

/* ─── COSY 会话（身份块加密 + 请求签名） ─── */

/** 网关服务端 RSA 公钥（客户端内写死值；加密临时 AES key 用）。 */
const SERVER_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

const md5hex = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex');

/** 身份材料（`~/.waygate/qoc/credential.json`，也用于 relay 的 `providers/<id>.qoder.json`）。
 *  由 `qoc login`（官方 CLI 浏览器设备授权）取得。 */
export interface QoderIdentity {
  /** 访问令牌（dt-…）。到期前自动续期（`deviceToken/refresh`）。 */
  token: string;
  /** 刷新令牌（drt-…）。用于续期。
   *  ⚠️ 刷新会轮换它、必须写回；但**不影响桌面客户端** —— Qoder 多会话并存（实测 2026-10-16）。 */
  refreshToken: string;
  /** 用户 UUID（cosy-user 头与身份块都用）。 */
  uid: string;
  /** 显示名（身份块要求非空即可）。 */
  name: string;
  /** 账号档位（user/status 的 userType，如 personal_standard）。 */
  userType: string;
}

/** 一次会话的加密材料。tempKey 仅本地持有；cosyKey/info 每请求头携带。 */
export interface CosySession {
  cosyKey: string;
  info: string;
}

/** 组装 COSY 会话：tempKey=uuid[:16]（AES-128，IV=key），cosyKey=RSA(tempKey)，
 *  info=AES-CBC(身份 JSON)。会话可复用（与签名无关），按身份缓存即可。 */
export function newCosySession(identity: QoderIdentity): CosySession {
  const tempKey = Buffer.from(randomUUID().slice(0, 16), 'utf8');
  const cosyKey = publicEncrypt(
    { key: SERVER_PUBLIC_KEY, padding: 1 /* RSA_PKCS1_PADDING */ },
    tempKey,
  ).toString('base64');
  /* 身份块字段序照社区实现（Go struct 序）—— 服务端解密后按 JSON 解析，
     序不参与校验，但保持一致便于对照排查。 */
  const plain = Buffer.from(
    JSON.stringify({
      name: identity.name,
      aid: '',
      uid: identity.uid,
      yx_uid: '',
      organization_id: '',
      organization_name: '',
      user_type: identity.userType,
      security_oauth_token: identity.token,
      refresh_token: identity.refreshToken,
    }),
    'utf8',
  );
  const padLen = 16 - (plain.length % 16);
  const padded = Buffer.concat([plain, Buffer.alloc(padLen, padLen)]);
  const cipher = createCipheriv('aes-128-cbc', tempKey, tempKey.slice(0, 16));
  cipher.setAutoPadding(false);
  const info = Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
  return { cosyKey, info };
}

/** bearer 载荷（cosyVersion/ideVersion/info/requestId/version 五字段，base64）。
 *  requestId 每请求新生成。 */
function buildPayloadB64(info: string): string {
  return Buffer.from(
    JSON.stringify({
      cosyVersion: QODER_COSY_VERSION,
      ideVersion: '',
      info,
      requestId: randomUUID(),
      version: 'v1',
    }),
    'utf8',
  ).toString('base64');
}

/** 请求签名：md5(payload \n cosyKey \n date \n body \n path)。path 剥 /algo 前缀。 */
export function signCosyRequest(payloadB64: string, cosyKey: string, date: string, body: string, pathWithoutAlgo: string): string {
  return md5hex([payloadB64, cosyKey, date, body, pathWithoutAlgo].join('\n'));
}

/** 剥掉 /algo 前缀的签名用路径（网关双形态路径共用此规则）。 */
export function sigPath(urlPath: string): string {
  return urlPath.startsWith('/algo') ? urlPath.slice('/algo'.length) : urlPath;
}

/** 组装完整 COSY bearer：`Bearer COSY.<payloadB64>.<sig>`。date=unix 秒（字符串）。 */
export function buildCosyBearer(
  session: CosySession,
  unixDate: string,
  encodedBody: string,
  urlPath: string,
): string {
  const payloadB64 = buildPayloadB64(session.info);
  const sig = signCosyRequest(payloadB64, session.cosyKey, unixDate, encodedBody, sigPath(urlPath));
  return `Bearer COSY.${payloadB64}.${sig}`;
}

/* ─── 机器身份（网关不校验设备注册 —— 随机 UUID 即可，进程内保持稳定） ─── */

export interface MachineIdentity {
  machineId: string;
  machineToken: string;
  machineType: string;
}

let machineSingleton: MachineIdentity | null = null;

/** 进程级单例：同一进程内所有请求共用一套机器身份（与官方客户端行为一致）。 */
export function machineIdentity(): MachineIdentity {
  if (!machineSingleton) {
    machineSingleton = {
      machineId: randomUUID(),
      machineToken: (randomUUID() + randomUUID()).slice(0, 50),
      machineType: randomUUID().slice(0, 18),
    };
  }
  return machineSingleton;
}

/** 组装 COSY bearer 路径的公共头（出站全部头在此构造 —— 不透传入站头）。 */
export function cosyChatHeaders(
  session: CosySession,
  identity: QoderIdentity,
  bearer: string,
  unixDate: string,
  accept: string,
): Record<string, string> {
  const m = machineIdentity();
  return {
    'cosy-data-policy': 'AGREE',
    'content-type': 'application/json',
    'cosy-machinetype': m.machineType,
    'cosy-clienttype': QODER_CLIENT_TYPE,
    'cosy-date': unixDate,
    'cosy-user': identity.uid,
    'cosy-key': session.cosyKey,
    accept,
    authorization: bearer,
    'accept-encoding': 'identity',
    'cosy-version': QODER_COSY_VERSION,
    'cosy-machineid': m.machineId,
    'cosy-machinetoken': m.machineToken,
    'login-version': QODER_LOGIN_VERSION,
    'user-agent': QODER_OUT_UA,
  };
}
