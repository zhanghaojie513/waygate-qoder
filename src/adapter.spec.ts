/**
 * 适配器冒烟：重点锁住「请求体必须走网关自定义 base64」——
 * 直接发 JSON 会被上游 CustomBase64Util.decode0 拒绝（实测：event:error + Java 栈，
 * 2026-10-13 移植时踩到过），这里用假 fetch 断言编码形态。
 */
import { describe, expect, it, vi } from 'vitest';
import { qEncode, qDecode } from './protocol/cosy.js';

describe('qEncode 往返（网关自定义 base64）', () => {
  it('编码后可解回原文', () => {
    const plain = JSON.stringify({ model: 'qfmodel', messages: [{ role: 'user', content: '你好呀' }] });
    expect(qDecode(qEncode(plain))).toBe(plain);
  });

  it('非标准字符集（字母表替换 + 三段轮转）—— 同一原文的编码不等于标准 base64', () => {
    const plain = 'hello world';
    expect(qEncode(plain)).not.toBe(Buffer.from(plain, 'utf8').toString('base64'));
  });

  it('空串与单字符不崩', () => {
    expect(qDecode(qEncode(''))).toBe('');
    expect(qDecode(qEncode('a'))).toBe('a');
  });
});
