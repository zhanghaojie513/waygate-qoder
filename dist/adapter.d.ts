/**
 * Qoder CN 适配器：把「官方 Qoder CLI 的浏览器设备授权」变成「本地 Anthropic/OpenAI 兼容反代」。
 *
 * 职责：凭证（设备授权登录取令牌 + 自动续期）→ 协议（COSY 签名 + 翻译 + 流解码）→ 交给 core 的 HTTP 服务。
 * 上游知识全在本文件与 protocol/ 里，core 不含任何 Qoder 细节。
 */
import { type Adapter } from 'waygate-core';
import { type QoderIdentity } from './credential.js';
import { CredentialError } from './errors.js';
/** 凭证落盘位置（`~/.waygate/qoc/credential.json`）—— `qoc login` 后复用。 */
export declare function credentialPath(): string;
/**
 * 读身份材料（同步，只读本地副本）。
 * 走到这里说明**已 `qoc login`** —— 不再回退去解密客户端登录态。
 */
export declare function resolveIdentity(): QoderIdentity;
/**
 * 取**可用**的身份材料：临期则先续期（并发去重），并把轮换后的令牌写回。
 *
 * ⚠️ 与旧的「读客户端」路线不同，这里**必须**自己续期 —— 没有客户端文件可回退，
 * 不刷新就会在令牌到期后彻底不可用（表现为 401）。
 */
export declare function ensureFreshIdentity(): Promise<QoderIdentity>;
/** 落盘身份材料（0600）并更新内存缓存。 */
export declare function saveIdentityCached(identity: QoderIdentity): string;
export declare function createQoderAdapter(opts?: {
    baseUrl?: string;
    chatPath?: string;
}): Adapter;
export { CredentialError };
