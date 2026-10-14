/**
 * Qoder CN 适配器：把「本机客户端登录态」变成「本地 Anthropic/OpenAI 兼容反代」。
 *
 * 职责：凭证（读客户端登录态）→ 协议（COSY 签名 + 翻译 + 流解码）→ 交给 core 的 HTTP 服务。
 * 上游知识全在本文件与 protocol/ 里，core 不含任何 Qoder 细节。
 */
import { type Adapter } from 'waygate-core';
import { type QoderIdentity } from './credential.js';
import { CredentialError } from './errors.js';
/** 凭证落盘位置（`~/.waygate/qoc/credential.json`）—— 首次 login 后复用，避免每次读客户端文件。 */
export declare function credentialPath(): string;
export declare function resolveIdentity(): QoderIdentity;
/** 落盘身份材料（0600）并更新内存缓存。 */
export declare function saveIdentity(identity: QoderIdentity): string;
export declare function createQoderAdapter(opts?: {
    baseUrl?: string;
    chatPath?: string;
}): Adapter;
export { CredentialError };
