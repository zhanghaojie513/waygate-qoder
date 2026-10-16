/**
 * Qoder CN 每日签到与积分（命令：`qoc checkin` / `qoc credits`）。
 *
 * ## 端点（自客户端 app.asar + growth H5 逆向，2026-10-14 生产实测）
 *
 * ⚠️ 关键：这套端点在 **openapi.qoder.com.cn**（不是聊天用的 gateway.qoder.com.cn），
 * 且**不需要 COSY 的 md5 签名** —— 认证只用 `Authorization: Bearer <accessToken>`
 * 加几个 `Cosy-*` 身份头（签名是 `/algo` 聊天接口才要的）。
 *
 *   GET  /sash/api/v1/me/campaigns                        → 活动列表（含可领的签到）
 *   POST /sash/api/v1/me/campaigns/{campaignId}/claim     → 领取（**要 UUID，不是 campaignKey**）
 *   GET  /sash/api/v2/me/usage                            → **真实余额**（套餐内 + 资源包）★
 *   GET  /sash/api/v1/ai-conversations/credits-summary    → 历史累计消耗（不是余额）
 *   GET  /sash/api/v1/ai-conversations/seat-activity      → 连续活跃天数
 *   GET  /sash/api/v1/ai-conversations/credits-heatmap    → 每日消耗热力图
 *
 * ⚠️ 余额与累计消耗是**两个口径**：`v2/me/usage` 的 `addOnQuota`（资源包，签到赠送进这里）
 * 才是余额；`credits-summary.totalCredits` 是历史累计消耗。别混用。
 *
 * ## 签到规则（Qoder 官方标注，实测）
 * 「每天领 100 Credits」：每日 **10:00（UTC+8）** 刷新，领取后 **30 天**有效，
 * 有每日与累计上限。上游自带幂等（重复领返回已领状态，带 `replayed` 标记）。
 */
import { describeFetchError, fetchWithRetry } from 'waygate-core';
import { UpstreamError } from './errors.js';
/** 活动/积分接口的宿主（与聊天网关不同）。 */
export const QODER_OPENAPI_BASE = 'https://openapi.qoder.com.cn';
/**
 * 签到规则（Qoder **官方标注**原文口径）。
 *
 * 单独提为常量并被 `renderCheckin` / `renderCredits` 共用 —— 两处各写一遍迟早会漂移，
 * 而这句话里的时刻与有效期都是上游定的，改错用户就会白等或误判"领了没用"。
 */
export const CHECKIN_RULE = '每日 10:00（UTC+8）刷新，领取后 30 天有效';
/** Qoder 桌面端 clientType（COSY 身份头之一）。 */
const CLIENT_TYPE = '10';
const TIMEOUT_MS = 20_000;
/** 取数字（数字或数字字符串）；取不到 null。 */
function num(v) {
    if (typeof v === 'number' && Number.isFinite(v))
        return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))
        return Number(v);
    return null;
}
export class QoderActivity {
    token;
    constructor(token) {
        this.token = token;
    }
    /**
     * 打一次 openapi（带 Cosy 身份头；信封解析容错）。
     *
     * ★ 走 `fetchWithRetry`：该域实测有约 **70% 的连接超时率**（连续 10 次探测成功 3/超时 7），
     * 但重试能拿到正常结果 —— 是**连接抖动**不是上游故障。原来"打一次就完"，
     * 用户点签到七成概率看到 `fetch failed`。
     * 重试只针对连接层失败（4xx 不重试，见 core 的 retry.ts 注释）。
     */
    async call(path, init = {}) {
        const token = await this.token();
        let res;
        try {
            res = await fetchWithRetry(`${QODER_OPENAPI_BASE}${path}`, {
                method: init.method ?? 'GET',
                headers: {
                    authorization: `Bearer ${token}`,
                    accept: 'application/json',
                    'user-agent': 'Qoder',
                    'cosy-clienttype': CLIENT_TYPE,
                    ...(init.method === 'POST' ? { 'content-type': 'application/json' } : {}),
                },
                ...(init.method === 'POST' ? { body: '{}' } : {}),
            }, { timeoutMs: TIMEOUT_MS });
        }
        catch (err) {
            /* 把 "fetch failed" 变成可行动的文案（带 cause 码），用户才知道该重试而不是重登。 */
            throw new UpstreamError(`连不上 qoder openapi（${describeFetchError(err)}）—— 网络抖动，请重试`);
        }
        const text = await res.text();
        let parsed = null;
        try {
            parsed = text ? JSON.parse(text) : null;
        }
        catch {
            throw new UpstreamError(`${path} 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
        }
        if (!res.ok) {
            const o = (parsed ?? {});
            const detail = typeof o.errorMessage === 'string' ? o.errorMessage : typeof o.error === 'string' ? o.error : '';
            if (res.status === 401 || res.status === 403) {
                throw new UpstreamError(`鉴权失败（HTTP ${res.status}）—— 令牌可能已过期：在 Qoder 客户端重新登录后跑一次 qoc login`);
            }
            throw new UpstreamError(`${path} HTTP ${res.status}${detail ? `：${detail}` : ''}`);
        }
        return parsed;
    }
    /** 列活动（解析出可领项）。 */
    async campaigns() {
        const body = await this.call('/sash/api/v1/me/campaigns');
        const raw = Array.isArray(body.campaigns) ? body.campaigns : [];
        const campaigns = [];
        for (const item of raw) {
            if (!item || typeof item !== 'object')
                continue;
            const c = item;
            if (typeof c.campaignId !== 'string' || !c.campaignId)
                continue;
            const benefit = c.benefit && typeof c.benefit === 'object' ? c.benefit : null;
            const validity = benefit?.validity && typeof benefit.validity === 'object' ? benefit.validity : null;
            campaigns.push({
                campaignId: c.campaignId,
                campaignKey: typeof c.campaignKey === 'string' ? c.campaignKey : '',
                actionType: typeof c.actionType === 'string' ? c.actionType : '',
                claimStatus: typeof c.claimStatus === 'string' ? c.claimStatus : '',
                benefit: benefit
                    ? { kind: typeof benefit.kind === 'string' ? benefit.kind : '', amount: num(benefit.amount), validityDays: num(validity?.days) }
                    : null,
                title: pickTitle(c.placements),
                endAt: num(c.endAt),
            });
        }
        return { claimable: body.claimable === true, campaigns };
    }
    /**
     * 签到：领取所有「可领」的活动。
     * 上游自带幂等 —— 重复调用不会重复发放（返回 `replayed`/已领状态）。
     */
    async checkin() {
        const { campaigns } = await this.campaigns();
        const claimable = campaigns.filter((c) => c.actionType === 'CLAIM_BENEFIT' && c.claimStatus === 'CLAIMABLE');
        if (claimable.length === 0) {
            const claimed = campaigns.find((c) => c.claimStatus === 'CLAIMED');
            return {
                outcome: 'none',
                ok: true,
                granted: [],
                message: claimed ? '今天已签到' : '当前没有可领取的活动',
            };
        }
        const granted = [];
        let replayed = false;
        for (const c of claimable) {
            const body = await this.call(`/sash/api/v1/me/campaigns/${encodeURIComponent(c.campaignId)}/claim`, { method: 'POST' });
            if (body.replayed === true)
                replayed = true;
            const benefit = body.benefit && typeof body.benefit === 'object' ? body.benefit : null;
            const amount = num(benefit?.amount);
            if (amount !== null)
                granted.push({ kind: typeof benefit?.kind === 'string' ? benefit.kind : 'CREDITS', amount });
        }
        const total = granted.reduce((s, g) => s + g.amount, 0);
        return {
            outcome: replayed ? 'replayed' : 'claimed',
            ok: true,
            granted,
            message: granted.length > 0
                ? `签到成功 +${total} ${granted[0].kind}${granted.length > 1 ? `（${granted.length} 项）` : ''}`
                : '领取完成（上游未回报金额）',
        };
    }
    /**
     * 积分概况。
     * ⚠️ `totalCredits` 是**累计消耗**（近一年窗口内花掉的 credits），
     * 实测精确等于 heatmap 每日消耗之和 —— **不是余额**（余额见 quotaUsage()）。
     * `peakCredits` 是其中单日最高消耗。
     */
    async creditsSummary() {
        const b = await this.call('/sash/api/v1/ai-conversations/credits-summary');
        return {
            total: num(b.totalCredits),
            peak: num(b.peakCredits),
            peakDate: typeof b.peakDate === 'string' ? b.peakDate : null,
            unit: typeof b.unit === 'string' ? b.unit : 'credits',
        };
    }
    /**
     * **真实余额**（`v2/me/usage`）—— 桌面端「我的用量」那张卡的数据源。
     * 客户端 asar 里 v1/v2 端点并存，余额只在 v2；免费档套餐内为 0，签到全进资源包 `addOn`。
     */
    async quotaUsage() {
        const b = await this.call('/sash/api/v2/me/usage');
        const u = b.qoderUsage && typeof b.qoderUsage === 'object' ? b.qoderUsage : {};
        const pick = (v) => {
            if (!v || typeof v !== 'object')
                return null;
            const o = v;
            return {
                total: num(o.total),
                used: num(o.used),
                remaining: num(o.remaining),
                unit: typeof o.unit === 'string' && o.unit ? o.unit : null,
            };
        };
        return {
            userType: typeof u.userType === 'string' && u.userType ? u.userType : null,
            plan: pick(u.userQuota),
            addOn: pick(u.addOnQuota),
            orgResourcePackage: pick(u.orgResourcePackage),
            isQuotaExceeded: typeof u.isQuotaExceeded === 'boolean' ? u.isQuotaExceeded : null,
        };
    }
    /** 连续活跃天数（相当于「连签」）。 */
    async seatActivity() {
        const b = await this.call('/sash/api/v1/ai-conversations/seat-activity');
        return {
            currentConsecutiveDays: num(b.currentConsecutiveDays),
            maxConsecutiveDays: num(b.maxConsecutiveDays),
            cumulativeActiveDays: num(b.cumulativeActiveDays),
            lastActiveDate: typeof b.lastActiveDate === 'string' ? b.lastActiveDate : null,
        };
    }
    /** 每日消耗（热力图原始数据，取有值的最后 N 天）。 */
    async recentDailyUsage(days = 7) {
        const b = await this.call('/sash/api/v1/ai-conversations/credits-heatmap');
        const items = Array.isArray(b.items) ? b.items : [];
        const out = [];
        for (const it of items) {
            if (!it || typeof it !== 'object')
                continue;
            const o = it;
            if (typeof o.date !== 'string')
                continue;
            out.push({ date: o.date, value: num(o.value) ?? 0 });
        }
        return out.filter((x) => x.value > 0).slice(-days);
    }
}
/** 从 placements 里挑活动标题（优先中文）。 */
function pickTitle(placements) {
    if (!Array.isArray(placements))
        return null;
    for (const p of placements) {
        if (!p || typeof p !== 'object')
            continue;
        const content = p.content;
        if (!content || typeof content !== 'object')
            continue;
        const c = content;
        const zh = c.zh && typeof c.zh === 'object' ? c.zh : null;
        if (typeof zh?.title === 'string' && zh.title)
            return zh.title;
        const en = c.en && typeof c.en === 'object' ? c.en : null;
        if (typeof en?.title === 'string' && en.title)
            return en.title;
    }
    return null;
}
/** 人读渲染：签到结果。恒带一行官方规则（时刻与有效期是上游定的，光看结果推不出来）。 */
export function renderCheckin(r) {
    const icon = r.outcome === 'claimed' ? '✓' : r.outcome === 'none' ? '·' : '✓';
    return `${icon} ${r.message}\n\n${CHECKIN_RULE}（Qoder 官方标注）`;
}
/** 积分数值渲染：上游返回的是完整 double（如 0.008774678000000001），
 *  直接打印会带浮点尾巴。保留 4 位小数并去掉末尾 0 —— 只影响显示，不改数据。 */
function fmtCredits(v) {
    if (v === null)
        return '—';
    return v.toFixed(4).replace(/\.?0+$/, '') || '0';
}
/** 人读渲染：积分总览（余额在前，累计消耗在后 —— 余额才是用户关心的）。 */
export function renderCredits(s, seat, daily, quota) {
    const lines = [];
    lines.push('Qoder CN 积分概况');
    lines.push('');
    /* ── 余额（v2/me/usage）：置顶 —— 这是桌面端「我的用量」的口径，也是唯一「还能用多少」的数。 ── */
    const addOn = quota?.addOn ?? null;
    const plan = quota?.plan ?? null;
    const planTouched = plan !== null && ((plan.total ?? 0) > 0 || (plan.remaining ?? 0) > 0);
    if (addOn && addOn.remaining !== null) {
        if (planTouched && plan.remaining !== null) {
            lines.push(`剩余积分  ${fmtCredits((plan.remaining ?? 0) + (addOn.remaining ?? 0))} ${addOn.unit ?? 'credits'}`
                + `（套餐内 ${fmtCredits(plan.remaining)} + 资源包 ${fmtCredits(addOn.remaining)}）`);
        }
        else {
            lines.push(`剩余积分  ${fmtCredits(addOn.remaining)} / ${fmtCredits(addOn.total)} ${addOn.unit ?? 'credits'}`);
        }
        if (quota?.isQuotaExceeded === true)
            lines.push('状态      额度已用尽');
        lines.push('');
    }
    /* ── 消耗侧（credits-summary + seat-activity）：与余额无关的「已花掉」视角。 ── */
    lines.push(`累计消耗  ${fmtCredits(s.total)} ${s.unit}`);
    if (s.peak !== null)
        lines.push(`单日峰值  ${fmtCredits(s.peak)}${s.peakDate ? `（${s.peakDate}）` : ''}`);
    if (seat.currentConsecutiveDays !== null) {
        lines.push(`连续活跃  ${seat.currentConsecutiveDays} 天${seat.maxConsecutiveDays ? `（最长 ${seat.maxConsecutiveDays} 天）` : ''}`);
    }
    if (seat.cumulativeActiveDays !== null)
        lines.push(`累计活跃  ${seat.cumulativeActiveDays} 天`);
    if (daily.length > 0) {
        lines.push('');
        lines.push('近几日消耗：');
        for (const d of daily)
            lines.push(`  ${d.date}  ${fmtCredits(d.value)}`);
    }
    /* ── 口径：把每个数是什么讲清楚（它们来自不同端点，语义不同，最容易被误读）。 ── */
    lines.push('');
    lines.push('口径');
    lines.push('  剩余积分  当前可用余额（openapi 的 v2/me/usage：套餐内 + 资源包）。');
    lines.push('            签到赠送的 100 credits 进「资源包」，所以签完这里会涨。');
    lines.push('  累计消耗  这个账号在近一年里，于该平台消耗掉的 credits 总量 —— 与余额无关，');
    lines.push('            也不是「本工具转发的那部分」：它含官方客户端直连的用量（账号级口径）。');
    lines.push('  单日峰值  近一年里消耗最多的一天（累计消耗的组成部分）。');
    lines.push('  连续活跃  连续有消耗的天数（不是签到次数）。');
    lines.push('');
    lines.push(`每日可领 100 Credits（${CHECKIN_RULE}）—— 用 \`qoc checkin\` 领取。`);
    return lines.join('\n');
}
