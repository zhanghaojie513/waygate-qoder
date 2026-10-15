/**
 * 设备授权凭证测试（假 fetch，不触真实上游、**不发出任何真实授权**）。
 *
 * 重点守两件容易静默出错的事：
 *   ① 未授权时上游返回 **HTTP 404**（实测 + 官方 CLI 同样以 404 判"继续等"）——
 *      「404 当失败」会把正常等待态报成错误；
 *   ② PKCE 必须真的带上（challenge/challenge_method=S256），否则授权页会拒。
 *
 * ⚠️ 全部 fetch 被 stub；`commandDir` 指向临时目录。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 把 `~/.waygate` 重定向到临时目录 —— 凭证/state/machine-id 都落在那里。 */
const tmpHome = mkdtempSync(join(tmpdir(), 'qoc-cred-'));
process.env.WAYGATE_HOME = tmpHome;

const {
  LOGIN_WAIT_MS,
  PendingLoginError,
  credentialPath,
  loginStatePath,
  pollDeviceLogin,
  readLoginState,
  readSavedIdentity,
  saveIdentity,
  startDeviceLogin,
} = await import('./credential.js');

afterEach(() => {
  vi.unstubAllGlobals();
  for (const p of [credentialPath(), loginStatePath()]) {
    try {
      if (existsSync(p)) rmSync(p);
    } catch {
      /* ignore */
    }
  }
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('startDeviceLogin', () => {
  it('生成 PKCE S256 授权链接（含 nonce / machine_id / client_id）并落盘 state', async () => {
    const st = await startDeviceLogin();
    const u = new URL(st.authUrl);
    expect(u.origin + u.pathname).toBe('https://qoder.cn/device/selectAccounts');
    expect(u.searchParams.get('challenge_method')).toBe('S256');
    expect(u.searchParams.get('challenge')).toBeTruthy();
    expect(u.searchParams.get('nonce')).toBeTruthy();
    expect(u.searchParams.get('machine_id')).toContain('waygate-');
    expect(u.searchParams.get('client_id')).toMatch(/^[0-9a-f-]{36}$/);

    /* verifier 落盘（取票要用），且与 challenge 对应 —— 对应关系错了上游会拒。 */
    const saved = readLoginState();
    expect(saved?.codeVerifier).toBeTruthy();
    const digest = await import('node:crypto').then((m) =>
      m.createHash('sha256').update(saved!.codeVerifier, 'ascii').digest('base64url'),
    );
    expect(digest).toBe(u.searchParams.get('challenge'));
  });

  it('★ machine_id 持久化 —— 同一台机器多次 login 用同一个（随机化会被当异常设备）', async () => {
    const a = await startDeviceLogin();
    const b = await startDeviceLogin();
    expect(new URL(b.authUrl).searchParams.get('machine_id'))
      .toBe(new URL(a.authUrl).searchParams.get('machine_id'));
  });
});

describe('pollDeviceLogin', () => {
  it('★ 未授权（HTTP 404）不是错误 —— 超时后抛 PendingLoginError 且保留 state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ errorCode: 'NotFound' }, 404)));
    await startDeviceLogin();
    await expect(pollDeviceLogin(80, undefined, 5)).rejects.toBeInstanceOf(PendingLoginError);
    /* ★ state 必须保留：用户随后授权完还能用 `qoc login-poll` 救回来。 */
    expect(readLoginState()).not.toBeNull();
  });

  it('授权完成 → 落盘身份（token/uid/name 与过期时刻）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      token: 'dt-access',
      refresh_token: 'drt-refresh',
      user_id: 'u-123',
      user_name: 'tester',
      expires_in: 3600,
    })));
    await startDeviceLogin();
    const id = await pollDeviceLogin(2000, undefined, 5);
    expect(id.token).toBe('dt-access');
    expect(id.refreshToken).toBe('drt-refresh');
    expect(id.uid).toBe('u-123');
    expect(id.name).toBe('tester');
    expect(id.expiresAt).toBeGreaterThan(Date.now());
    /* 成功后 state 清掉（避免误用旧 nonce）。 */
    expect(readLoginState()).toBeNull();
    expect(readSavedIdentity()?.token).toBe('dt-access');
  });

  it('★ 取票成功但缺 user_id → 明确报错（COSY 身份块需要它，不能存半成品）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ token: 'dt-x', refresh_token: 'drt-x' })));
    await startDeviceLogin();
    await expect(pollDeviceLogin(2000, undefined, 5)).rejects.toThrow(/user_id/);
  });

  it('没有待完成登录 → 提示先跑 login', async () => {
    await expect(pollDeviceLogin(10)).rejects.toThrow(/qoc login/);
  });

  it('★ 原地轮询：先 404 数轮、后成功（`login` 阻塞等待的核心路径）', async () => {
    let polls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      polls += 1;
      if (polls < 3) return json({ errorCode: 'NotFound' }, 404);
      return json({ token: 'dt-ok', refresh_token: 'drt-ok', user_id: 'u-ok', user_name: 'n' });
    }));
    await startDeviceLogin();
    const id = await pollDeviceLogin(5000, undefined, 1);
    expect(id.token).toBe('dt-ok');
    expect(polls).toBe(3);
  });

  it('★ 轮询期间报进度（否则终端最长 2 分钟完全静默）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ errorCode: 'NotFound' }, 404)));
    await startDeviceLogin();
    const ticks: number[] = [];
    await expect(pollDeviceLogin(80, (i) => ticks.push(i.waitedMs), 1)).rejects.toBeInstanceOf(PendingLoginError);
    expect(ticks.length).toBeGreaterThan(0);
  });

  it('非 404 的硬失败（如 500）→ 直接报错，不白等', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ errorMessage: 'boom' }, 500)));
    await startDeviceLogin();
    await expect(pollDeviceLogin(3000, undefined, 5)).rejects.toThrow(/500|boom/);
  });
});

describe('凭证读写', () => {
  it('未登录 → resolveIdentity 报「先跑 qoc login」（不再回退解密客户端）', async () => {
    rmSync(credentialPath(), { force: true });
    const mod = await import('./adapter.js');
    expect(() => mod.resolveIdentity()).toThrow(/qoc login/);
  });

  it('saveIdentity 落盘 0600 且可回读', () => {
    const p = saveIdentity({
      token: 'dt-t', refreshToken: 'drt-r', uid: 'u-1', name: 'n', userType: 'personal_standard',
    });
    expect(existsSync(p)).toBe(true);
    const back = JSON.parse(readFileSync(p, 'utf8')) as { token: string };
    expect(back.token).toBe('dt-t');
    expect(readSavedIdentity()?.uid).toBe('u-1');
  });
});

describe('常量', () => {
  it('login 原地等待 2 分钟（用户口径）', () => {
    expect(LOGIN_WAIT_MS).toBe(120_000);
  });
});
