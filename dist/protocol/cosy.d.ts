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
/** 客户端 CLI 版本（2026-10-11 本机实测，来源：.qoder-cn/logs/runs 下的 manifest.json）。 */
export declare const QODER_CLI_VERSION = "1.1.61";
/** COSY 协议版本（客户端写死值，随客户端升级漂移）。 */
export declare const QODER_COSY_VERSION = "0.1.43";
/** 客户端类型标识（5 = CLI 形态，实测值）。 */
export declare const QODER_CLIENT_TYPE = "5";
/** 与官方 CLI 同族形态的出站 UA（node 段动态取运行时，同族即可 —— 见 ua-fingerprint-plan.md）。 */
export declare const QODER_OUT_UA: string;
/** 登录协议版本（写死 v2）。 */
export declare const QODER_LOGIN_VERSION = "v2";
/** [v0.6.0] Qoder 协议的默认网关与聊天端点（chat_path 可按提供商覆写）。 */
export declare const DEFAULT_QODER_BASE_URL = "https://gateway.qoder.com.cn";
export declare const DEFAULT_QODER_CHAT_PATH = "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
/** 标准请求体 → 网关自定义编码（所有 Encode=1 端点的请求体格式）。 */
export declare function qEncode(plain: string): string;
/** 网关自定义编码 → 原文（响应侧解码用；非法字符抛错而不是静默截断）。 */
export declare function qDecode(encoded: string): string;
/** 提供商凭证文件（`providers/<id>.qoder.json`）里的身份材料。
 *  来自官方客户端本地登录态（auth.v1.dat），由 tools/qoder-import-credential.mjs 导入。 */
export interface QoderIdentity {
    /** 访问令牌（dt-…）。过期后需从客户端重新导入（本服务不做刷新 —— 刷新会轮换
     *  refresh token，连带把用户桌面客户端的登录态顶掉，见 translate 注释）。 */
    token: string;
    /** 刷新令牌（drt-…）。当前仅透传进身份块（网关校验其存在），不用于主动刷新。 */
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
export declare function newCosySession(identity: QoderIdentity): CosySession;
/** 请求签名：md5(payload \n cosyKey \n date \n body \n path)。path 剥 /algo 前缀。 */
export declare function signCosyRequest(payloadB64: string, cosyKey: string, date: string, body: string, pathWithoutAlgo: string): string;
/** 剥掉 /algo 前缀的签名用路径（网关双形态路径共用此规则）。 */
export declare function sigPath(urlPath: string): string;
/** 组装完整 COSY bearer：`Bearer COSY.<payloadB64>.<sig>`。date=unix 秒（字符串）。 */
export declare function buildCosyBearer(session: CosySession, unixDate: string, encodedBody: string, urlPath: string): string;
export interface MachineIdentity {
    machineId: string;
    machineToken: string;
    machineType: string;
}
/** 进程级单例：同一进程内所有请求共用一套机器身份（与官方客户端行为一致）。 */
export declare function machineIdentity(): MachineIdentity;
/** 组装 COSY bearer 路径的公共头（出站全部头在此构造 —— 不透传入站头）。 */
export declare function cosyChatHeaders(session: CosySession, identity: QoderIdentity, bearer: string, unixDate: string, accept: string): Record<string, string>;
