/**
 * Qoder CN 适配器：把「官方 Qoder CLI 的浏览器设备授权」变成「本地 Anthropic/OpenAI 兼容反代」。
 *
 * 职责：凭证（设备授权登录取令牌 + 自动续期）→ 协议（COSY 签名 + 翻译 + 流解码）→ 交给 core 的 HTTP 服务。
 * 上游知识全在本文件与 protocol/ 里，core 不含任何 Qoder 细节。
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commandDir, type Adapter, type ChatRequestBody, type CredentialStatus, type ModelEntry, type UpstreamCallResult } from 'waygate-core';
import {
  LOGIN_WAIT_MS,
  PendingLoginError,
  pollDeviceLogin,
  readSavedIdentity,
  refreshDeviceIdentity,
  saveIdentity,
  startDeviceLogin,
  credentialPath as identityPath,
  type QoderIdentity,
} from './credential.js';
import { QoderActivity, renderCheckin, renderCredits } from './activity.js';
import { CredentialError, UpstreamError } from './errors.js';
import { loadModels } from './models.js';
import {
  buildCosyBearer,
  cosyChatHeaders,
  DEFAULT_QODER_BASE_URL,
  DEFAULT_QODER_CHAT_PATH,
  newCosySession,
  qEncode,
} from './protocol/cosy.js';
import { qoderToOpenAiSse } from './protocol/stream-decode.js';
import { toQoderRequest } from './protocol/translate.js';

/** 凭证落盘位置（`~/.waygate/qoc/credential.json`）—— `qoc login` 后复用。 */
export function credentialPath(): string {
  return identityPath();
}

/** 提前刷新余量：到期前 5 分钟就换新（设备令牌寿命短，余量给足）。 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

let identityCache: QoderIdentity | null = null;
let refreshInFlight: Promise<QoderIdentity> | null = null;

/**
 * 读身份材料（同步，只读本地副本）。
 * 走到这里说明**已 `qoc login`** —— 不再回退去解密客户端登录态。
 */
export function resolveIdentity(): QoderIdentity {
  if (identityCache) return identityCache;
  const id = readSavedIdentity();
  if (!id) {
    throw new CredentialError('未登录 —— 先跑 `qoc login`（浏览器授权一次）');
  }
  identityCache = id;
  return id;
}

/**
 * 取**可用**的身份材料：临期则先续期（并发去重），并把轮换后的令牌写回。
 *
 * ⚠️ 与旧的「读客户端」路线不同，这里**必须**自己续期 —— 没有客户端文件可回退，
 * 不刷新就会在令牌到期后彻底不可用（表现为 401）。
 */
export async function ensureFreshIdentity(): Promise<QoderIdentity> {
  const id = resolveIdentity();
  if (!id.expiresAt || Date.now() + REFRESH_MARGIN_MS < id.expiresAt) return id;
  if (!id.refreshToken) return id; /* 没有 refresh token 就先用着，到期后由 401 提示重登 */

  if (refreshInFlight) return refreshInFlight;
  const job = refreshDeviceIdentity(id)
    .then((next) => {
      identityCache = next;
      return next;
    })
    .finally(() => {
      refreshInFlight = null;
    });
  refreshInFlight = job;
  return job;
}

/** 落盘身份材料（0600）并更新内存缓存。 */
export function saveIdentityCached(identity: QoderIdentity): string {
  const path = saveIdentity(identity);
  identityCache = identity;
  return path;
}

/**
 * 轮询进度行 —— 用 `\r` 覆盖同一行，不刷屏。
 * 没有它，用户面对的是最长 2 分钟的**完全静默**，分不清"在等"还是"卡死了"。
 */
function tickTo(out: NodeJS.WriteStream): (info: { waitedMs: number; remainingMs: number }) => void {
  return ({ waitedMs, remainingMs }) => {
    const w = Math.round(waitedMs / 1000);
    const r = Math.round(remainingMs / 1000);
    out.write(`\r  ⏳ 等待授权完成… ${w}s（最多再等 ${r}s，按 Ctrl+C 可中断）   `);
  };
}

/** 登录成功后的身份摘要（**绝不回显令牌**）。 */
function describeIdentity(id: QoderIdentity): string {
  const left = id.expiresAt ? Math.round((id.expiresAt - Date.now()) / 60000) : null;
  return `账号 ${id.name}（uid ${id.uid.slice(0, 8)}…）${left !== null ? `，令牌有效约 ${left} 分钟` : ''}`;
}

/** 登录成功后的互斥提示 —— 设备授权**不解除**互斥。 */
function mutualExclusionNotice(): string {
  return (
    '\n⚠️  凭证互斥（必读）：Qoder 同一账号只能有一个有效会话。\n' +
    '    请给本工具用**专用账号**，并且**永不用它登 Qoder 桌面客户端** ——\n' +
    '    只要在别处登录一次，这里的令牌就会被顶掉（表现为 401，需重跑 qoc login）。\n'
  );
}

export function createQoderAdapter(opts: { baseUrl?: string; chatPath?: string } = {}): Adapter {
  const baseUrl = opts.baseUrl ?? DEFAULT_QODER_BASE_URL;
  const chatPath = opts.chatPath ?? DEFAULT_QODER_CHAT_PATH;

  /* 签到/积分用同一个 access token（无需额外登录）。 */
  const activity = new QoderActivity(async () => resolveIdentity().token);

  return {
    command: 'qoc',
    displayName: 'Qoder CN',
    defaultPort: 8789,
    upstreamLabel: `${baseUrl}  (COSY 签名协议)`,
    loginHint: '登录（官方 CLI 浏览器设备授权；按提示在浏览器选账号完成授权）',

    /** Qoder 专属：每日签到 + 积分概况 + 登录续取。 */
    extraCommands: [
      {
        name: 'login-poll',
        summary: `完成登录：轮询取票（浏览器授权后执行；\`login\` 等待超时也用它）`,
        usage: 'login-poll',
        async run() {
          try {
            const id = await pollDeviceLogin(LOGIN_WAIT_MS, tickTo(process.stdout));
            return '✓ 登录成功 → ' + credentialPath() + '\n' + describeIdentity(id) + '\n' + mutualExclusionNotice();
          } catch (err) {
            if (err instanceof PendingLoginError) {
              return '⏳ 还没看到你的授权完成 —— 请先在浏览器里打开链接选账号完成授权，然后重跑：qoc login-poll';
            }
            throw err;
          }
        },
      },
      {
        name: 'checkin',
        summary: '每日签到领 100 Credits（用本工具令牌代签，无需开客户端）',
        usage: 'checkin',
        async run({ json }) {
          const r = await activity.checkin();
          return json ? JSON.stringify(r, null, 2) : renderCheckin(r);
        },
      },
      {
        name: 'credits',
        summary: '积分概况（剩余余额 / 累计消耗 / 连续活跃）',
        usage: 'credits',
        async run({ json }) {
          const [s, seat, daily, quota] = await Promise.all([
            activity.creditsSummary(),
            activity.seatActivity(),
            activity.recentDailyUsage(7),
            activity.quotaUsage().catch(() => null),
          ]);
          return json
            ? JSON.stringify({ summary: s, seatActivity: seat, recentDaily: daily, quotaUsage: quota }, null, 2)
            : renderCredits(s, seat, daily, quota);
        },
      },
    ],

    async credentialStatus(): Promise<CredentialStatus> {
      try {
        const id = resolveIdentity();
        /* 只显示账号与 uid 前缀 —— **绝不回显令牌**（哪怕打码，前几位也是敏感信息）。 */
        const left = id.expiresAt ? Math.round((id.expiresAt - Date.now()) / 60000) : null;
        const state = left !== null ? (left > 0 ? `令牌有效约 ${left} 分钟` : '令牌可能已过期（下次请求自动续期）') : '令牌到期时间未知';
        return {
          ok: true,
          detail: `已登录：${id.name}（uid ${id.uid.slice(0, 8)}…；${state}）`,
          source: existsSync(credentialPath()) ? credentialPath() : undefined,
        };
      } catch (err) {
        return { ok: false, detail: (err as Error).message };
      }
    },

    /**
     * 登录 = 官方 Qoder CLI 的浏览器设备授权（`qoc login`）。
     *
     * **原地等 2 分钟**：打印授权链接后就地轮询，用户在浏览器选账号完成后**自动继续**；
     * 超时 → 抛 `PendingLoginError`，state 保留，提示改用 `qoc login-poll`（5 分钟内有效）。
     */
    async login(): Promise<void> {
      const out = process.stdout;
      const state = await startDeviceLogin();
      out.write(
        '请用浏览器打开下面的链接完成授权（选你的 Qoder 账号）：\n\n' +
          `  ${state.authUrl}\n\n` +
          `完成后本终端会**自动继续**（最多等 ${Math.round(LOGIN_WAIT_MS / 1000)} 秒）。\n\n` +
          `（令牌只保存在本机 ${credentialPath()}，权限 0600。）\n`,
      );
      try {
        const id = await pollDeviceLogin(LOGIN_WAIT_MS, tickTo(out));
        out.write('\n✓ 登录成功 → ' + credentialPath() + '\n' + describeIdentity(id) + '\n' + mutualExclusionNotice());
      } catch (err) {
        if (err instanceof PendingLoginError) {
          out.write(
            `\n⏳ 等了 ${Math.round(LOGIN_WAIT_MS / 1000)} 秒还没看到授权完成。\n` +
              '   完成浏览器授权后，回来执行：qoc login-poll\n' +
              '   （授权会话 5 分钟内有效；超过就得重新跑 qoc login。）\n',
          );
        }
        throw err;
      }
    },

    async listModels(): Promise<ModelEntry[]> {
      return loadModels(baseUrl, await ensureFreshIdentity());
    },

    async doctorChecks() {
      /* [复核修正] 此前 .catch(()=>null) 吞掉了所有网络错误 → 「上游连通」恒报 ✓。
         fetch 只在网络不可达（DNS/超时/拒连）时抛错；HTTP 404/502 不抛（反而证明可达）。 */
      const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
      try {
        await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(8000) });
        checks.push({ name: '上游连通', ok: true, detail: `${baseUrl} 可达` });
      } catch (err) {
        checks.push({ name: '上游连通', ok: false, detail: (err as Error).message });
      }
      /* 令牌续期体检：既验证刷新链可用，也把轮换写回。 */
      try {
        await ensureFreshIdentity();
        checks.push({ name: '令牌续期', ok: true, detail: '可续期（必要时自动刷新）' });
      } catch (err) {
        checks.push({ name: '令牌续期', ok: false, detail: (err as Error).message });
      }
      return checks;
    },

    async chat(body: ChatRequestBody, signal: AbortSignal): Promise<UpstreamCallResult> {
      /* 用**续期后**的身份 —— 设备令牌寿命短，临期必须先换（无客户端文件可回退）。 */
      const identity = await ensureFreshIdentity();

      /* [零内容重试] Qoder 网关在大上下文时会「HTTP 200 但零字节断流」（实测 2026-10-12：
         2.7 万 token 时 27.8s 零字节；同日同模型重发 4.9s 成功）。客户端此时什么都还没收到，
         重发完全无感 —— 上限 1 次，避免上游真故障时把延迟翻倍。
         必须**在把流交给客户端前**探首块：一旦 core 提交了 200 响应头就没法重发了。 */
      const MAX_RETRY = 1;
      let lastErr: Error | null = null;

      for (let attempt = 0; attempt <= MAX_RETRY; attempt += 1) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 1000));

        const session = newCosySession(identity);
        const qoderBody = toQoderRequest(body, body.model, identity.userType);
        /* 请求体必须走网关的自定义 base64（Encode=1）—— 直接发 JSON 会被上游
           CustomBase64Util.decode0 拒绝（实测：event:error + Java 栈）。 */
        const encoded = qEncode(JSON.stringify(qoderBody));
        const pathOnly = chatPath.split('?')[0]!;
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
        let first: { done: boolean; value?: Uint8Array };
        try {
          first = await reader.read();
        } catch (err) {
          lastErr = err as Error;
          if (attempt < MAX_RETRY) continue;
          throw new UpstreamError(`读取上游流失败：${(err as Error).message}`);
        }
        if (first.done || !first.value || first.value.length === 0) {
          lastErr = new UpstreamError('零内容断流（耗时较长或上下文过大）');
          if (attempt < MAX_RETRY) continue;
          throw lastErr;
        }

        const withFirst = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(first.value!);
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
