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
/** 活动/积分接口的宿主（与聊天网关不同）。 */
export declare const QODER_OPENAPI_BASE = "https://openapi.qoder.com.cn";
/**
 * 签到规则（Qoder **官方标注**原文口径）。
 *
 * 单独提为常量并被 `renderCheckin` / `renderCredits` 共用 —— 两处各写一遍迟早会漂移，
 * 而这句话里的时刻与有效期都是上游定的，改错用户就会白等或误判"领了没用"。
 */
export declare const CHECKIN_RULE = "\u6BCF\u65E5 10:00\uFF08UTC+8\uFF09\u5237\u65B0\uFF0C\u9886\u53D6\u540E 30 \u5929\u6709\u6548";
/** 一个活动（campaign）。 */
export interface Campaign {
    campaignId: string;
    campaignKey: string;
    actionType: string;
    /** 'CLAIMABLE' = 可领 | 'CLAIMED' = 已领 | 其余为不可领。 */
    claimStatus: string;
    /** 奖励描述（如 CREDITS 100，30 天有效）。 */
    benefit: {
        kind: string;
        amount: number | null;
        validityDays: number | null;
    } | null;
    /** 活动标题（中/英，取得到时）。 */
    title: string | null;
    endAt: number | null;
}
export interface CampaignList {
    /** 服务端认为今天有可领的东西。 */
    claimable: boolean;
    campaigns: Campaign[];
}
export interface ClaimResult {
    ok: boolean;
    /** 'claimed'（本次真领到）| 'replayed'（补发/重复）| 'none'（无可领）。 */
    outcome: 'claimed' | 'replayed' | 'none';
    /** 本次领到的奖励（金额 + 类型）。 */
    granted: Array<{
        kind: string;
        amount: number;
    }>;
    message: string;
}
export interface CreditsSummary {
    total: number | null;
    peak: number | null;
    peakDate: string | null;
    unit: string;
}
/** 一组额度（套餐内 / 资源包 / 组织资源包同形）。 */
export interface Quota {
    total: number | null;
    used: number | null;
    remaining: number | null;
    unit: string | null;
}
/** `v2/me/usage` 解析结果 —— **真实余额**。 */
export interface QuotaUsage {
    userType: string | null;
    /** 套餐内 Credits（免费档为 0/0/0）。 */
    plan: Quota | null;
    /** 资源包 —— 签到赠送的 Credits 进这里（桌面端「我的用量」展示的那一项）。 */
    addOn: Quota | null;
    /** 组织资源包（企业版才有）。 */
    orgResourcePackage: Quota | null;
    isQuotaExceeded: boolean | null;
}
export interface SeatActivity {
    currentConsecutiveDays: number | null;
    maxConsecutiveDays: number | null;
    cumulativeActiveDays: number | null;
    lastActiveDate: string | null;
}
export declare class QoderActivity {
    private readonly token;
    constructor(token: () => Promise<string>);
    /**
     * 打一次 openapi（带 Cosy 身份头；信封解析容错）。
     *
     * ★ 走 `fetchWithRetry`：该域实测有约 **70% 的连接超时率**（连续 10 次探测成功 3/超时 7），
     * 但重试能拿到正常结果 —— 是**连接抖动**不是上游故障。原来"打一次就完"，
     * 用户点签到七成概率看到 `fetch failed`。
     * 重试只针对连接层失败（4xx 不重试，见 core 的 retry.ts 注释）。
     */
    private call;
    /** 列活动（解析出可领项）。 */
    campaigns(): Promise<CampaignList>;
    /**
     * 签到：领取所有「可领」的活动。
     * 上游自带幂等 —— 重复调用不会重复发放（返回 `replayed`/已领状态）。
     */
    checkin(): Promise<ClaimResult>;
    /**
     * 积分概况。
     * ⚠️ `totalCredits` 是**累计消耗**（近一年窗口内花掉的 credits），
     * 实测精确等于 heatmap 每日消耗之和 —— **不是余额**（余额见 quotaUsage()）。
     * `peakCredits` 是其中单日最高消耗。
     */
    creditsSummary(): Promise<CreditsSummary>;
    /**
     * **真实余额**（`v2/me/usage`）—— 桌面端「我的用量」那张卡的数据源。
     * 客户端 asar 里 v1/v2 端点并存，余额只在 v2；免费档套餐内为 0，签到全进资源包 `addOn`。
     */
    quotaUsage(): Promise<QuotaUsage>;
    /** 连续活跃天数（相当于「连签」）。 */
    seatActivity(): Promise<SeatActivity>;
    /** 每日消耗（热力图原始数据，取有值的最后 N 天）。 */
    recentDailyUsage(days?: number): Promise<Array<{
        date: string;
        value: number;
    }>>;
}
/** 人读渲染：签到结果。恒带一行官方规则（时刻与有效期是上游定的，光看结果推不出来）。 */
export declare function renderCheckin(r: ClaimResult): string;
/** 人读渲染：积分总览（余额在前，累计消耗在后 —— 余额才是用户关心的）。 */
export declare function renderCredits(s: CreditsSummary, seat: SeatActivity, daily: Array<{
    date: string;
    value: number;
}>, quota?: QuotaUsage | null): string;
