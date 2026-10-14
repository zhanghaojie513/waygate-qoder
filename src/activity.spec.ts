/**
 * Qoder 签到与积分测试（假 fetch，不碰真实上游）。
 * 重点：活动解析、领取用 UUID（不是 campaignKey）、幂等判定、积分/活跃度解析。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { QoderActivity, renderCheckin, renderCredits } from './activity.js';

afterEach(() => vi.unstubAllGlobals());

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** 探针实测的 campaigns 响应（精简）。 */
const CAMPAIGNS_CLAIMABLE = {
  uid: 'u-1',
  showCampaign: true,
  claimable: true,
  campaigns: [
    {
      campaignId: '01a130ea-7c31-71b3-a22b-cbe019571350',
      campaignKey: 'act-20261013-603',
      actionType: 'CLAIM_BENEFIT',
      claimStatus: 'CLAIMABLE',
      benefit: { kind: 'CREDITS', amount: 100, validity: { mode: 'RELATIVE_DAYS', days: 30 } },
      placements: [{ type: 'POPUP', content: { zh: { title: '每天领 100 Credits' } } }],
    },
  ],
};

describe('QoderActivity.campaigns', () => {
  it('解析活动（含 benefit / 标题 / 状态）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(CAMPAIGNS_CLAIMABLE)));
    const list = await new QoderActivity(async () => 'tok').campaigns();
    expect(list.claimable).toBe(true);
    expect(list.campaigns).toHaveLength(1);
    const c = list.campaigns[0]!;
    expect(c.campaignId).toBe('01a130ea-7c31-71b3-a22b-cbe019571350');
    expect(c.claimStatus).toBe('CLAIMABLE');
    expect(c.benefit).toEqual({ kind: 'CREDITS', amount: 100, validityDays: 30 });
    expect(c.title).toBe('每天领 100 Credits');
  });

  it('请求头：Bearer token + Cosy-ClientType（无需 md5 签名）', async () => {
    let seen: Record<string, string> = {};
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      seen = init.headers as Record<string, string>;
      return ok({ claimable: false, campaigns: [] });
    }));
    await new QoderActivity(async () => 'my-token').campaigns();
    expect(seen.authorization).toBe('Bearer my-token');
    expect(seen['cosy-clienttype']).toBe('10');
    expect(seen['user-agent']).toBe('Qoder');
  });
});

describe('QoderActivity.checkin', () => {
  it('可领 → 用 campaignId（UUID）POST claim', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(u)}`);
      if (String(u).includes('/claim')) {
        return ok({ grantId: 'g-1', status: 'CLAIMED', replayed: false, benefit: { kind: 'CREDITS', amount: 100 } });
      }
      return ok(CAMPAIGNS_CLAIMABLE);
    }));
    const r = await new QoderActivity(async () => 'tok').checkin();
    expect(r.outcome).toBe('claimed');
    expect(r.granted).toEqual([{ kind: 'CREDITS', amount: 100 }]);
    expect(r.message).toContain('+100');
    /* ★ 必须用 campaignId 而非 campaignKey —— 传 key 上游报 FIELD_VALIDATION_FAILED */
    expect(calls.some((c) => c.startsWith('POST') && c.includes('01a130ea-7c31-71b3-a22b-cbe019571350/claim'))).toBe(true);
    expect(calls.some((c) => c.includes('act-20261013-603/claim'))).toBe(false);
  });

  it('今天已领（CLAIMED）→ none 且不打 claim', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
      calls.push(String(u));
      void init;
      return ok({ claimable: false, campaigns: [{ ...CAMPAIGNS_CLAIMABLE.campaigns[0], claimStatus: 'CLAIMED' }] });
    }));
    const r = await new QoderActivity(async () => 'tok').checkin();
    expect(r.outcome).toBe('none');
    expect(r.message).toContain('今天已签到');
    expect(calls.every((u) => !u.includes('/claim'))).toBe(true);
  });

  it('replayed=true → outcome 标 replayed（补发语义）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (String(u).includes('/claim')) return ok({ status: 'CLAIMED', replayed: true, benefit: { kind: 'CREDITS', amount: 100 } });
      return ok(CAMPAIGNS_CLAIMABLE);
    }));
    const r = await new QoderActivity(async () => 'tok').checkin();
    expect(r.outcome).toBe('replayed');
  });

  it('401 → 提示重新登录', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ errorMessage: 'unauthorized' }), { status: 401 })));
    await expect(new QoderActivity(async () => 'tok').checkin()).rejects.toThrow('重新登录');
  });
});

describe('QoderActivity.credits', () => {
  it('积分总览 + 活跃度 + 每日消耗解析', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (String(u).includes('credits-summary')) return ok({ peakCredits: 240.55, peakDate: '2026-10-12', totalCredits: 241.81, unit: 'credits' });
      if (String(u).includes('seat-activity')) return ok({ cumulativeActiveDays: 3, currentConsecutiveDays: 3, maxConsecutiveDays: 3, lastActiveDate: '2026-10-13' });
      if (String(u).includes('heatmap')) return ok({ items: [{ date: '2026-10-11', value: 0 }, { date: '2026-10-12', value: 240.55 }, { date: '2026-10-13', value: 0.008 }] });
      return ok({});
    }));
    const a = new QoderActivity(async () => 'tok');
    const s = await a.creditsSummary();
    expect(s.total).toBe(241.81);
    expect(s.peakDate).toBe('2026-10-12');
    const seat = await a.seatActivity();
    expect(seat.currentConsecutiveDays).toBe(3);
    const daily = await a.recentDailyUsage(7);
    expect(daily).toHaveLength(2); // 过滤掉 value=0 的那天
    expect(daily[0]).toEqual({ date: '2026-10-12', value: 240.55 });
  });

  it('quotaUsage：解析 v2/me/usage 的真实余额（资源包 + 套餐内）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (String(u).includes('v2/me/usage')) {
        return ok({
          displayMode: 'qoder',
          qoderUsage: {
            userId: 'u1',
            userType: 'personal_standard',
            userQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: 'credits' },
            addOnQuota: { total: 500, used: 5, remaining: 495, percentage: 0.02, unit: 'credits' },
            isQuotaExceeded: false,
          },
        });
      }
      return ok({});
    }));
    const a = new QoderActivity(async () => 'tok');
    const q = await a.quotaUsage();
    expect(q.userType).toBe('personal_standard');
    expect(q.addOn).toEqual({ total: 500, used: 5, remaining: 495, unit: 'credits' });
    expect(q.plan?.total).toBe(0);
    expect(q.orgResourcePackage).toBeNull(); // 个人档没有组织资源包
    expect(q.isQuotaExceeded).toBe(false);
  });
});

describe('渲染', () => {
  it('renderCheckin 三种结局', () => {
    expect(renderCheckin({ ok: true, outcome: 'claimed', granted: [], message: '签到成功 +100 CREDITS' })).toContain('✓');
    expect(renderCheckin({ ok: true, outcome: 'none', granted: [], message: '今天已签到' })).toContain('·');
  });
  it('renderCredits 含合计与提示', () => {
    const text = renderCredits(
      { total: 241.81, peak: 240.55, peakDate: '2026-10-12', unit: 'credits' },
      { currentConsecutiveDays: 3, maxConsecutiveDays: 3, cumulativeActiveDays: 3, lastActiveDate: null },
      [{ date: '2026-10-12', value: 240.55 }],
    );
    expect(text).toContain('累计消耗  241.81');
    expect(text).toContain('连续活跃  3 天');
    expect(text).toContain('qoc checkin');
    /* 口径说明必须点明「累计消耗」是什么：账号级近一年、与余额无关、含客户端直连。 */
    expect(text).toContain('口径');
    expect(text).toContain('近一年');
    expect(text).toContain('与余额无关');
    expect(text).toContain('含官方客户端直连');
  });

  it('renderCredits：有余额时置顶显示资源包剩余（余额优先于累计消耗）', () => {
    const text = renderCredits(
      { total: 241.81, peak: 240.55, peakDate: '2026-10-12', unit: 'credits' },
      { currentConsecutiveDays: 3, maxConsecutiveDays: 3, cumulativeActiveDays: 3, lastActiveDate: null },
      [],
      {
        userType: 'personal_standard',
        plan: { total: 0, used: 0, remaining: 0, unit: 'credits' },
        addOn: { total: 500, used: 5, remaining: 495, unit: 'credits' },
        orgResourcePackage: null,
        isQuotaExceeded: false,
      },
    );
    /* 余额行在累计消耗之前（用户先看到余额）。 */
    expect(text).toContain('剩余积分  495 / 500 credits');
    expect(text.indexOf('剩余积分')).toBeLessThan(text.indexOf('累计消耗'));
  });
});
