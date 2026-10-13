/**
 * cosy.ts 单测：编码往返、会话材料、签名形状、指纹常量钉住（版本字典漂移时这里红）。
 * 不打真网关 —— 端到端验证在 tools 层做。
 */
import { describe, expect, it } from 'vitest';
import {
  buildCosyBearer,
  machineIdentity,
  newCosySession,
  qDecode,
  qEncode,
  signCosyRequest,
  sigPath,
  QODER_CLI_VERSION,
  QODER_COSY_VERSION,
  QODER_OUT_UA,
  type QoderIdentity,
} from './cosy.js';

const identity: QoderIdentity = {
  token: 'dt-testtoken',
  refreshToken: 'drt-testrefresh',
  uid: '00000000-0000-0000-0000-000000000001',
  name: 'tester',
  userType: 'personal_standard',
};

describe('qoder cosy · 自定义 base64', () => {
  it('★ 编码-解码往返无损（含中文 / padding / 字母表替换）', () => {
    for (const s of ['hello', '{"a":1}', '中文内容测试', 'x'.repeat(100), '']) {
      expect(qDecode(qEncode(s))).toBe(s);
    }
  });
  it('编码输出不含标准 base64 的 + / =（全部被字母表替换或 $ 化）', () => {
    const out = qEncode('{"model":"qfmodel","messages":[1,2,3]}');
    expect(out).not.toContain('+');
    expect(out).not.toContain('/');
    expect(out).not.toContain('=');
  });
  it('★ 已知向量：与 2026-10-11 真网关通过的 POC 输出形状一致（长度段轮转）', () => {
    // 三段轮转的核心性质：encode 长度 == base64 长度
    const s = 'abc';
    expect(qEncode(s)).toHaveLength(Buffer.from(s).toString('base64').length);
  });
});

describe('qoder cosy · 会话与签名', () => {
  it('会话材料形状：cosyKey 是 base64（RSA 128 字节 → 172 字符），info 可 base64 解出 AES 块', () => {
    const sess = newCosySession(identity);
    expect(sess.cosyKey).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(sess.cosyKey).toHaveLength(172); // 1024-bit RSA 输出 128B → base64 172 字符
    const raw = Buffer.from(sess.info, 'base64');
    expect(raw.length % 16).toBe(0); // AES-CBC 块对齐
    expect(raw.length).toBeGreaterThan(16);
  });
  it('每次会话 tempKey 不同 → cosyKey 不同（不复用会话密钥）', () => {
    expect(newCosySession(identity).cosyKey).not.toBe(newCosySession(identity).cosyKey);
  });
  it('bearer 形状：Bearer COSY.<payloadB64>.<32位md5>', () => {
    const sess = newCosySession(identity);
    const bearer = buildCosyBearer(sess, '1760000000', 'ENCODEDBODY', '/api/v2/model/list');
    expect(bearer).toMatch(/^Bearer COSY\.[A-Za-z0-9+/=]+\.[0-9a-f]{32}$/);
    // payload 可解出五字段
    const payload = JSON.parse(Buffer.from(bearer.split('.')[1]!, 'base64').toString('utf8'));
    expect(payload).toMatchObject({ cosyVersion: QODER_COSY_VERSION, ideVersion: '', version: 'v1' });
    expect(payload.info).toBe(sess.info);
    expect(typeof payload.requestId).toBe('string');
  });
  it('★ 签名可复算：sig === md5(payload\\ncosyKey\\ndate\\nbody\\npath)，任一输入变则变', () => {
    const sess = newCosySession(identity);
    const bearer = buildCosyBearer(sess, '123', 'body', '/algo/p');
    const [, payloadB64, sig] = bearer.split('.') as [string, string, string];
    expect(sig).toBe(signCosyRequest(payloadB64, sess.cosyKey, '123', 'body', '/p'));
    // requestId 每请求新生成 → bearer 唯一，但给定 payload 的签名确定
    const b2 = buildCosyBearer(sess, '123', 'body', '/algo/p');
    expect(b2).not.toBe(bearer);
    const c = buildCosyBearer(sess, '124', 'body', '/algo/p');
    expect(c.split('.')[2]).not.toBe(sig);
  });
  it('sigPath 剥 /algo 前缀，无前缀原样', () => {
    expect(sigPath('/algo/api/v2/model/list')).toBe('/api/v2/model/list');
    expect(sigPath('/api/v2/model/list')).toBe('/api/v2/model/list');
  });
});

describe('qoder cosy · 机器身份与指纹常量', () => {
  it('机器身份进程内稳定且形状合法', () => {
    const a = machineIdentity();
    const b = machineIdentity();
    expect(a).toBe(b);
    expect(a.machineToken).toHaveLength(50);
    expect(a.machineType).toHaveLength(18);
    expect(a.machineId).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('★ 指纹版本字典钉住（客户端升级时改这里 + 本测试）', () => {
    expect(QODER_CLI_VERSION).toBe('1.1.61'); // 2026-10-11 实测
    expect(QODER_COSY_VERSION).toBe('0.1.43');
    expect(QODER_OUT_UA).toBe(`qodercli/1.1.61 node/${process.versions.node}`);
  });
});
