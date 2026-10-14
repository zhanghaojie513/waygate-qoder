/**
 * Qoder CN 适配器：把「本机客户端登录态」变成「本地 Anthropic/OpenAI 兼容反代」。
 *
 * 职责：凭证（读客户端登录态）→ 协议（COSY 签名 + 翻译 + 流解码）→ 交给 core 的 HTTP 服务。
 * 上游知识全在本文件与 protocol/ 里，core 不含任何 Qoder 细节。
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commandDir } from 'waygate-core';
import { readQoderIdentity } from './credential.js';
import { CredentialError, UpstreamError } from './errors.js';
import { loadModels } from './models.js';
import { buildCosyBearer, cosyChatHeaders, DEFAULT_QODER_BASE_URL, DEFAULT_QODER_CHAT_PATH, newCosySession, qEncode, } from './protocol/cosy.js';
import { qoderToOpenAiSse } from './protocol/stream-decode.js';
import { toQoderRequest } from './protocol/translate.js';
/** 凭证落盘位置（`~/.waygate/qoc/credential.json`）—— 首次 login 后复用，避免每次读客户端文件。 */
export function credentialPath() {
    return join(commandDir('qoc'), 'credential.json');
}
/**
 * 取身份材料：优先本地缓存副本（login 落盘），否则现读客户端登录态。
 * [复核修正] 加内存缓存 —— 此前每个聊天请求都调本函数；凭证文件不存在时
 * 每次都会走 DPAPI 解密（起 PowerShell 进程），代价极高。
 */
let identityCache = null;
export function resolveIdentity() {
    if (identityCache)
        return identityCache;
    const cached = credentialPath();
    if (existsSync(cached)) {
        const parsed = JSON.parse(readFileSync(cached, 'utf8'));
        if (parsed.token && parsed.uid) {
            identityCache = parsed;
            return parsed;
        }
    }
    identityCache = readQoderIdentity();
    return identityCache;
}
/** 落盘身份材料（0600）并更新内存缓存。 */
export function saveIdentity(identity) {
    const path = credentialPath();
    writeFileSync(path, JSON.stringify(identity, null, 2) + '\n', { mode: 0o600 });
    try {
        chmodSync(path, 0o600);
    }
    catch {
        /* Windows 语义有限 */
    }
    identityCache = identity;
    return path;
}
export function createQoderAdapter(opts = {}) {
    const baseUrl = opts.baseUrl ?? DEFAULT_QODER_BASE_URL;
    const chatPath = opts.chatPath ?? DEFAULT_QODER_CHAT_PATH;
    return {
        command: 'qoc',
        displayName: 'Qoder CN',
        defaultPort: 8789,
        upstreamLabel: `${baseUrl}  (COSY 签名协议)`,
        async credentialStatus() {
            try {
                const id = resolveIdentity();
                /* 只显示账号与 uid 前缀 —— **绝不回显令牌**（哪怕打码，前几位也是敏感信息）。 */
                return {
                    ok: true,
                    detail: `已登录：${id.name}（uid ${id.uid.slice(0, 8)}…）`,
                    source: existsSync(credentialPath()) ? credentialPath() : undefined,
                };
            }
            catch (err) {
                return { ok: false, detail: err.message };
            }
        },
        async login() {
            const id = readQoderIdentity();
            const path = saveIdentity(id);
            process.stdout.write(`已读取客户端登录态：${id.name}（uid ${id.uid}）\n已保存到 ${path}\n`);
        },
        async listModels() {
            return loadModels(baseUrl, resolveIdentity());
        },
        async doctorChecks() {
            /* [复核修正] 此前 .catch(()=>null) 吞掉了所有网络错误 → 「上游连通」恒报 ✓。
               fetch 只在网络不可达（DNS/超时/拒连）时抛错；HTTP 404/502 不抛（反而证明可达）。 */
            try {
                await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(8000) });
                return [{ name: '上游连通', ok: true, detail: `${baseUrl} 可达` }];
            }
            catch (err) {
                return [{ name: '上游连通', ok: false, detail: err.message }];
            }
        },
        async chat(body, signal) {
            const identity = resolveIdentity();
            /* [零内容重试] Qoder 网关在大上下文时会「HTTP 200 但零字节断流」（实测 2026-10-12：
               2.7 万 token 时 27.8s 零字节；同日同模型重发 4.9s 成功）。客户端此时什么都还没收到，
               重发完全无感 —— 上限 1 次，避免上游真故障时把延迟翻倍。
               必须**在把流交给客户端前**探首块：一旦 core 提交了 200 响应头就没法重发了。 */
            const MAX_RETRY = 1;
            let lastErr = null;
            for (let attempt = 0; attempt <= MAX_RETRY; attempt += 1) {
                if (attempt > 0)
                    await new Promise((r) => setTimeout(r, 1000));
                const session = newCosySession(identity);
                const qoderBody = toQoderRequest(body, body.model, identity.userType);
                /* 请求体必须走网关的自定义 base64（Encode=1）—— 直接发 JSON 会被上游
                   CustomBase64Util.decode0 拒绝（实测：event:error + Java 栈）。 */
                const encoded = qEncode(JSON.stringify(qoderBody));
                const pathOnly = chatPath.split('?')[0];
                const date = String(Math.floor(Date.now() / 1000));
                const bearer = buildCosyBearer(session, date, encoded, pathOnly);
                const res = await fetch(`${baseUrl}${chatPath}`, {
                    method: 'POST',
                    headers: cosyChatHeaders(session, identity, bearer, date, 'text/event-stream'),
                    body: encoded,
                    signal,
                });
                if (!res.ok) {
                    const text = await res.text().catch(() => '');
                    if (res.status === 401 || res.status === 403) {
                        throw new UpstreamError(`上游鉴权失败（HTTP ${res.status}）—— 令牌可能已过期：在 Qoder 客户端重新登录后跑一次 qoc login`);
                    }
                    throw new UpstreamError(`上游 HTTP ${res.status}${text ? `：${text.slice(0, 200)}` : ''}`);
                }
                if (!res.body) {
                    lastErr = new UpstreamError('上游返回 200 但响应体为空');
                    continue;
                }
                /* 探首块：拿到就把它塞回新流（不能丢首帧内容）；拿不到 → 零内容断流 → 重试。 */
                const reader = res.body.getReader();
                let first;
                try {
                    first = await reader.read();
                }
                catch (err) {
                    lastErr = err;
                    if (attempt < MAX_RETRY)
                        continue;
                    throw new UpstreamError(`读取上游流失败：${err.message}`);
                }
                if (first.done || !first.value || first.value.length === 0) {
                    lastErr = new UpstreamError('零内容断流（耗时较长或上下文过大）');
                    if (attempt < MAX_RETRY)
                        continue;
                    throw lastErr;
                }
                const withFirst = new ReadableStream({
                    start(controller) {
                        controller.enqueue(first.value);
                    },
                    async pull(controller) {
                        const { done, value } = await reader.read();
                        if (done) {
                            controller.close();
                            return;
                        }
                        controller.enqueue(value);
                    },
                    cancel(reason) {
                        void reader.cancel(reason);
                    },
                });
                /* 网关 SSE → OpenAI SSE（core 只负责把流吐给客户端）。 */
                return { stream: withFirst.pipeThrough(qoderToOpenAiSse(body.model)), status: 200 };
            }
            throw lastErr ?? new UpstreamError('上游调用失败');
        },
    };
}
export { CredentialError };
