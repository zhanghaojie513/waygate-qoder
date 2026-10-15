/**
 * Qoder CN 凭证：**官方 Qoder CLI 的浏览器设备授权**（`qoc login`）。
 *
 * ## 为什么改走设备授权（不再是解密本机客户端登录态）
 * 旧实现读客户端 `auth.v1.dat` 并用 Windows DPAPI 解出令牌 —— 那要求
 * ① 机器上装着 Qoder 桌面客户端、② 必须是 Windows、③ 每次令牌失效都要重新解一次。
 * 服务器部署与其它平台全都用不了。
 *
 * Qoder 官方 CLI（`@qoder-ai/qodercli`）提供了**浏览器设备授权**，走它就没有上述限制：
 *
 *   GET  {base}/device/selectAccounts?challenge=&challenge_method=S256&nonce=&machine_id=&client_id=
 *        → 浏览器打开该链接、选账号完成授权
 *   GET  {openapi}/api/v1/deviceToken/poll?nonce=&verifier=&challenge_method=S256
 *        → 轮询取票；**未授权时返回 HTTP 404**（这就是"还没好"的信号，不是错误）
 *   POST {openapi}/api/v1/deviceToken/refresh   （form/JSON：refresh_token + machine 字段）
 *
 * 参数与官方 CLI 完全一致（`client_id` 取 CLI 内的 prod 值），因此拿到的令牌与
 * COSY 聊天链路**天然兼容** —— CLI 自己就是靠这套登录后打同一个 COSY 网关的。
 *
 * ## ⚠️ 令牌与「客户端互斥」
 * Qoder 的 refresh token 会轮换、且**同一账号同时只有一个有效会话**：
 * 本工具与桌面客户端共用同一账号会互相顶下线。
 * ⇒ **建议配专用账号**：只用它跑 `qoc login`，此后不再用该账号登桌面客户端。
 * （设备授权改变的是"在哪台机器登录"，**不改变**"能有几个会话"。）
 */
/** 授权页宿主（`zl("base")`）—— 与官方 CLI 的 CN 站点一致。 */
export declare const QODER_BASE_URL = "https://qoder.cn";
/** OpenAPI 宿主：设备令牌的轮询与刷新都在这里（`zl("openapi")`）。 */
export declare const QODER_OPENAPI_BASE_URL = "https://openapi.qoder.com.cn";
/** `login` 原地等待授权的时长；超时后保留 state，提示改用 `login-poll`。 */
export declare const LOGIN_WAIT_MS = 120000;
/** 身份材料（`~/.waygate/qoc/credential.json`，也是 COSY 身份块要的字段）。 */
export interface QoderIdentity {
    /** 访问令牌（`security_oauth_token`）—— COSY 身份块与出站 Bearer 都用它。 */
    token: string;
    /** 刷新令牌。用于 `deviceToken/refresh` 续期（注意轮换）。 */
    refreshToken: string;
    /** 用户 UUID（`cosy-user` 头与身份块都用）。 */
    uid: string;
    /** 显示名（身份块要求非空即可）。 */
    name: string;
    /** 账号档位（user/status 的 userType，如 personal_standard）。 */
    userType: string;
    /** [设备授权新增] 令牌过期时刻（epoch ms）—— 有它才能自动续期。 */
    expiresAt?: number;
    /** [设备授权新增] 刷新令牌过期时刻（epoch ms）。 */
    refreshExpiresAt?: number;
    /** [设备授权新增] 登录时用的机器标识（刷新要回传）。 */
    machineId?: string;
}
/** 一次设备授权会话（`login` 建立、`login-poll` 续用）。 */
export interface LoginState {
    /** PKCE code_verifier —— 取票必须回传，丢了只能重新 login。 */
    codeVerifier: string;
    /** 请求绑定用的 nonce —— 轮询要回传。 */
    nonce: string;
    /** 浏览器授权链接。 */
    authUrl: string;
    /** 本机机器标识（刷新时回传）。 */
    machineId: string;
    /** 会话过期时刻（epoch ms，官方 300s）。 */
    expiresAt: number;
}
/** 凭证落盘位置（`~/.waygate/qoc/credential.json`）。 */
export declare function credentialPath(): string;
/** 未完成登录的暂存，供 `login-poll` 续跑。 */
export declare function loginStatePath(): string;
/** 第 ① 步：生成 PKCE + nonce，组装授权链接并落盘 state。 */
export declare function startDeviceLogin(): Promise<LoginState>;
/** 读回未完成的登录会话（无 / 已过期则 null）。 */
export declare function readLoginState(): LoginState | null;
/**
 * 第 ②③ 步：轮询取票（授权完成后调用）。
 *
 * `timeoutMs` 为原地等待上限：到点仍未授权 → 抛 `PendingLoginError`（**不是失败**），
 * state 保留，用户可跑 `login-poll` 续取（设备码 5 分钟内有效）。
 * `onTick` 每轮 pending 调一次（终端显示进度），否则用户面对最长 2 分钟完全静默。
 * `intervalMs` 仅测试用。
 */
export declare function pollDeviceLogin(timeoutMs?: number, onTick?: (info: {
    waitedMs: number;
    remainingMs: number;
}) => void, intervalMs?: number): Promise<QoderIdentity>;
/** 登录尚未完成（`login` 等待超时的正常待机态，不是错误）。 */
export declare class PendingLoginError extends Error {
    readonly name = "PendingLoginError";
    constructor(message: string);
}
/** 读本工具已落盘的身份材料（无则 null）。 */
export declare function readSavedIdentity(): QoderIdentity | null;
/** 落盘身份材料（0600）。刷新轮换后也要调用本函数写回。 */
export declare function saveIdentity(identity: QoderIdentity): string;
/**
 * 刷新设备令牌（`deviceToken/refresh`）。
 *
 * ⚠️ refresh token **会轮换**（每次刷新都可能换新）—— 必须写回，否则下次刷新用已作废的旧值。
 * 刷新需要登录时的 `machine_id`，故 `machineId` 存在身份里。
 */
export declare function refreshDeviceIdentity(identity: QoderIdentity): Promise<QoderIdentity>;
