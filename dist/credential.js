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
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { commandDir } from 'waygate-core';
import { CredentialError, UpstreamError } from './errors.js';
/** 授权页宿主（`zl("base")`）—— 与官方 CLI 的 CN 站点一致。 */
export const QODER_BASE_URL = 'https://qoder.cn';
/** OpenAPI 宿主：设备令牌的轮询与刷新都在这里（`zl("openapi")`）。 */
export const QODER_OPENAPI_BASE_URL = 'https://openapi.qoder.com.cn';
/** 官方 CLI 的 prod OAuth client_id（取自 qodercli bundle 内解码值）。 */
const QODER_CLIENT_ID = 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb';
/** `login` 原地等待授权的时长；超时后保留 state，提示改用 `login-poll`。 */
export const LOGIN_WAIT_MS = 120_000;
/** 设备令牌的有效窗口（官方 CLI 用 300s）。 */
const DEVICE_TOKEN_TTL_MS = 300_000;
/** 轮询间隔（官方 CLI 约 1s 一轮）。 */
const LOGIN_POLL_INTERVAL_MS = 2000;
const REQUEST_TIMEOUT_MS = 20_000;
/** 凭证落盘位置（`~/.waygate/qoc/credential.json`）。 */
export function credentialPath() {
    return join(commandDir('qoc'), 'credential.json');
}
/** 未完成登录的暂存，供 `login-poll` 续跑。 */
export function loginStatePath() {
    return join(commandDir('qoc'), 'login-state.json');
}
function writePrivate(path, content) {
    writeFileSync(path, content, { mode: 0o600 });
    try {
        chmodSync(path, 0o600);
    }
    catch {
        /* Windows 语义有限 */
    }
}
/* ─────────────────────── 设备授权流程 ─────────────────────── */
/** 第 ① 步：生成 PKCE + nonce，组装授权链接并落盘 state。 */
export async function startDeviceLogin() {
    /* PKCE：verifier 随机串，challenge = SHA-256(verifier) 的 base64url（无填充）。 */
    const codeVerifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
    const nonce = randomUUID();
    /* machine_id：官方客户端用真实机器标识；我们没有，用**持久化派生值**——
       不能每次随机（会被当成"同账号在多台设备间跳"）。 */
    const machineId = stableMachineId();
    const qs = new URLSearchParams({
        challenge,
        challenge_method: 'S256',
        nonce,
        machine_id: machineId,
        client_id: QODER_CLIENT_ID,
    });
    const authUrl = `${QODER_BASE_URL}/device/selectAccounts?${qs.toString()}`;
    const state = {
        codeVerifier,
        nonce,
        authUrl,
        machineId,
        expiresAt: Date.now() + DEVICE_TOKEN_TTL_MS,
    };
    writePrivate(loginStatePath(), JSON.stringify(state, null, 2) + '\n');
    return state;
}
/**
 * 稳定的机器标识：`~/.waygate/qoc/machine-id` 首次生成后复用。
 * 随机化会让上游把每次登录看成新设备（风控信号），故必须持久化。
 */
function stableMachineId() {
    const p = join(commandDir('qoc'), 'machine-id');
    try {
        if (existsSync(p)) {
            const v = readFileSync(p, 'utf8').trim();
            if (v)
                return v;
        }
    }
    catch {
        /* 读不到就重新生成 */
    }
    const id = `waygate-${randomUUID()}`;
    try {
        writePrivate(p, id + '\n');
    }
    catch {
        /* 落盘失败不阻断登录（本次仍可用） */
    }
    return id;
}
/** 读回未完成的登录会话（无 / 已过期则 null）。 */
export function readLoginState() {
    const p = loginStatePath();
    if (!existsSync(p))
        return null;
    try {
        const s = JSON.parse(readFileSync(p, 'utf8'));
        if (!s.codeVerifier || !s.nonce || !s.authUrl)
            return null;
        return s;
    }
    catch {
        return null;
    }
}
function clearLoginState() {
    try {
        if (existsSync(loginStatePath()))
            unlinkSync(loginStatePath());
    }
    catch {
        /* 清理失败不影响登录结果 */
    }
}
/**
 * 打一次轮询端点。
 *
 * ⚠️ **未授权时上游返回 HTTP 404**（实测 + 官方 CLI 同样以 404 判"继续等"）——
 * 所以「404 当失败」是错的。仅当拿到 `token` 才算成功。
 */
async function pollOnce(state) {
    const qs = new URLSearchParams({
        nonce: state.nonce,
        verifier: state.codeVerifier,
        challenge_method: 'S256',
    });
    let res;
    try {
        res = await fetch(`${QODER_OPENAPI_BASE_URL}/api/v1/deviceToken/poll?${qs.toString()}`, {
            method: 'GET',
            headers: { accept: 'application/json', 'user-agent': 'qoder/waygate' },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    }
    catch (err) {
        throw new UpstreamError(`轮询授权状态失败（openapi.qoder.com.cn 不可达）：${err.message}`);
    }
    /* ★ 404 = 尚未完成授权（不是错误）。 */
    if (res.status === 404)
        return { kind: 'pending' };
    const raw = await res.text().catch(() => '');
    let body = {};
    try {
        body = raw ? JSON.parse(raw) : {};
    }
    catch {
        return { kind: 'error', message: `轮询返回非 JSON（HTTP ${res.status}）：${raw.slice(0, 200)}` };
    }
    if (!res.ok) {
        const detail = String(body.errorMessage ?? body.errorCode ?? raw).slice(0, 200);
        return { kind: 'error', message: `轮询失败（HTTP ${res.status}）：${detail}` };
    }
    const token = typeof body.token === 'string' ? body.token : '';
    if (!token)
        return { kind: 'pending' };
    const identity = {
        token,
        refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : '',
        uid: typeof body.user_id === 'string' ? body.user_id : '',
        name: typeof body.user_name === 'string' ? body.user_name : 'qoder-user',
        userType: 'personal_standard',
        expiresAt: epochMs(body.expires_at) ?? (typeof body.expires_in === 'number' ? Date.now() + body.expires_in * 1000 : undefined),
        refreshExpiresAt: epochMs(body.refresh_token_expires_at)
            ?? (typeof body.refresh_token_expires_in === 'number' ? Date.now() + body.refresh_token_expires_in * 1000 : undefined),
        machineId: state.machineId,
    };
    if (!identity.uid) {
        return { kind: 'error', message: '取票成功但上游未返回 user_id —— 无法组装 COSY 身份，请重试' };
    }
    return { kind: 'ok', identity };
}
/** 把上游时间字段（ISO 字符串或秒/毫秒数）统一成 epoch ms。 */
function epochMs(v) {
    if (typeof v === 'string' && v.trim()) {
        const t = Date.parse(v);
        if (Number.isFinite(t))
            return t;
    }
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        /* 官方同时存在秒与毫秒两种量级：>1e12 视为毫秒。 */
        return v > 1e12 ? v : v * 1000;
    }
    return undefined;
}
/**
 * 第 ②③ 步：轮询取票（授权完成后调用）。
 *
 * `timeoutMs` 为原地等待上限：到点仍未授权 → 抛 `PendingLoginError`（**不是失败**），
 * state 保留，用户可跑 `login-poll` 续取（设备码 5 分钟内有效）。
 * `onTick` 每轮 pending 调一次（终端显示进度），否则用户面对最长 2 分钟完全静默。
 * `intervalMs` 仅测试用。
 */
export async function pollDeviceLogin(timeoutMs = LOGIN_WAIT_MS, onTick, intervalMs = LOGIN_POLL_INTERVAL_MS) {
    const state = readLoginState();
    if (!state) {
        throw new CredentialError('没有待完成的登录 —— 先跑 `qoc login`');
    }
    const startedAt = Date.now();
    const deadline = Math.min(Date.now() + timeoutMs, state.expiresAt);
    while (Date.now() < deadline) {
        const outcome = await pollOnce(state);
        if (outcome.kind === 'ok') {
            const path = saveIdentity(outcome.identity);
            clearLoginState();
            void path;
            return outcome.identity;
        }
        if (outcome.kind === 'error')
            throw new CredentialError(outcome.message);
        onTick?.({ waitedMs: Date.now() - startedAt, remainingMs: Math.max(0, deadline - Date.now()) });
        await new Promise((r) => setTimeout(r, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
    }
    if (Date.now() >= state.expiresAt) {
        clearLoginState();
        throw new CredentialError('授权会话已过期（5 分钟）—— 重新跑 `qoc login`');
    }
    throw new PendingLoginError('尚未完成授权');
}
/** 登录尚未完成（`login` 等待超时的正常待机态，不是错误）。 */
export class PendingLoginError extends Error {
    name = 'PendingLoginError';
    constructor(message) {
        super(message);
    }
}
/* ─────────────────────── 凭证读写 ─────────────────────── */
/** 读本工具已落盘的身份材料（无则 null）。 */
export function readSavedIdentity() {
    const p = credentialPath();
    if (!existsSync(p))
        return null;
    try {
        const id = JSON.parse(readFileSync(p, 'utf8'));
        return id.token && id.uid ? id : null;
    }
    catch {
        return null;
    }
}
/** 落盘身份材料（0600）。刷新轮换后也要调用本函数写回。 */
export function saveIdentity(identity) {
    const path = credentialPath();
    writePrivate(path, JSON.stringify(identity, null, 2) + '\n');
    return path;
}
/**
 * 刷新设备令牌（`deviceToken/refresh`）。
 *
 * ⚠️ refresh token **会轮换**（每次刷新都可能换新）—— 必须写回，否则下次刷新用已作废的旧值。
 * 刷新需要登录时的 `machine_id`，故 `machineId` 存在身份里。
 */
export async function refreshDeviceIdentity(identity) {
    if (!identity.refreshToken) {
        throw new CredentialError('凭证没有 refresh token —— 跑 `qoc login` 重新授权');
    }
    const body = { refresh_token: identity.refreshToken };
    if (identity.machineId) {
        body.machine_id = identity.machineId;
        body.machine_type = 'waygate';
    }
    let res;
    try {
        res = await fetch(`${QODER_OPENAPI_BASE_URL}/api/v1/deviceToken/refresh`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'qoder/waygate' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    }
    catch (err) {
        throw new UpstreamError(`刷新令牌失败（openapi.qoder.com.cn 不可达）：${err.message}`);
    }
    const raw = await res.text().catch(() => '');
    let parsed = {};
    try {
        parsed = raw ? JSON.parse(raw) : {};
    }
    catch {
        throw new CredentialError(`刷新返回非 JSON（HTTP ${res.status}）：${raw.slice(0, 200)}`);
    }
    if (!res.ok) {
        const detail = String(parsed.errorMessage ?? parsed.errorCode ?? raw).slice(0, 200);
        throw new CredentialError(`刷新令牌被拒（HTTP ${res.status}）：${detail}。` +
            'refresh token 可能已失效或被该账号的**另一处登录**顶掉了 —— 跑 `qoc login` 重新授权。');
    }
    const token = typeof parsed.device_token === 'string' ? parsed.device_token : '';
    if (!token)
        throw new CredentialError('刷新响应缺少 device_token');
    const next = {
        ...identity,
        token,
        refreshToken: typeof parsed.refresh_token === 'string' && parsed.refresh_token ? parsed.refresh_token : identity.refreshToken,
        expiresAt: epochMs(parsed.expires_at) ?? (typeof parsed.expires_in === 'number' ? Date.now() + parsed.expires_in * 1000 : undefined),
        refreshExpiresAt: epochMs(parsed.refresh_token_expires_at)
            ?? (typeof parsed.refresh_token_expires_in === 'number' ? Date.now() + parsed.refresh_token_expires_in * 1000 : undefined),
    };
    saveIdentity(next);
    return next;
}
