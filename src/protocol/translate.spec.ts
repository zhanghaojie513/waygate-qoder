/**
 * translate.spec：消息折叠（system/tool/工具调用历史）、参数透传白名单、
 * 请求体形状（chat_context 双通道 / 恒开流 / max_tokens 回落）。
 */
import { describe, expect, it } from 'vitest';
import { buildQoderMessages, toQoderRequest } from './translate.js';
import type { ChatMessage, ChatRequestBody } from 'waygate-core';

const msg = (role: string, content: string | null, extra: Record<string, unknown> = {}): ChatMessage =>
  ({ role, content, ...extra }) as ChatMessage;

describe('qoder translate · 消息折叠', () => {
  it('纯 user 对话：历史保序，prompt = 最后一条 user', () => {
    const { history, prompt } = buildQoderMessages([
      msg('user', '第一问'),
      msg('assistant', '第一答'),
      msg('user', '第二问'),
    ]);
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(prompt).toBe('第二问');
    expect(history[0].contents[0].text).toBe('第一问');
  });

  it('★ system 前缀并入首条 user；tool 结果并入下一条 user', () => {
    const { history, prompt } = buildQoderMessages([
      msg('system', '你是助手'),
      msg('user', '帮我调工具'),
      msg('assistant', null, { tool_calls: [{ id: 't1', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] }),
      msg('tool', '晴 25 度', { tool_call_id: 't1' }),
    ]);
    expect(history[0].role).toBe('user');
    expect(history[0].contents[0].text).toContain('[system] 你是助手');
    expect(history[0].contents[0].text).toContain('帮我调工具');
    /* assistant 工具调用序列化进行文（v1 口径） */
    expect(history[1].contents[0].text).toContain('[tool_call id=t1 name=get_weather]');
    /* tool 结果并入下一条 user —— 没有 user 跟随时并入末条 user（本例末条是 assistant
       之后的 tool，故追加为新的 user） */
    const last = history[history.length - 1];
    expect(last.role).toBe('user');
    expect(last.contents[0].text).toContain('[tool_result t1] 晴 25 度');
    expect(prompt).toBe(last.contents[0].text);
  });

  it('序列以 system 结尾的病态输入：不丢内容', () => {
    const { history } = buildQoderMessages([msg('user', '问'), msg('system', '补充指令')]);
    const last = history[history.length - 1];
    expect(last.role).toBe('user');
    expect(last.contents[0].text).toContain('补充指令');
  });
});

describe('qoder translate · toQoderRequest', () => {
  const base: ChatRequestBody = { model: 'Qwen3.8-Flash', messages: [msg('user', 'hi')] };

  it('★ 形状：恒开流 / chat_context 双通道同文 / model_config.key=内部key / session_type=qodercli', () => {
    const body = toQoderRequest(base, 'qfmodel', 'personal_standard');
    expect(body.stream).toBe(true);
    expect(body.chat_context.text.text).toBe('hi');
    expect(body.chat_context.extra.originalContent.text).toBe('hi');
    expect(body.chat_context.extra.modelConfig.key).toBe('qfmodel');
    expect(body.model_config.key).toBe('qfmodel');
    expect(body.session_type).toBe('qodercli');
    expect(body.agent_id).toBe('agent_common');
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].response_meta).toEqual({ id: '', usage: expect.any(Object) });
  });

  it('★ max_tokens：客户端给了透传；没给回落 8192（官方客户端回落）', () => {
    expect(toQoderRequest({ ...base, max_tokens: 512 }, 'qfmodel', 'personal_standard').parameters.max_tokens).toBe(512);
    expect(toQoderRequest(base, 'qfmodel', 'personal_standard').parameters.max_tokens).toBe(8192);
  });

  it('参数白名单：temperature 透传，stream_options 不进 parameters', () => {
    const body = toQoderRequest(
      { ...base, temperature: 0.3, stream_options: { include_usage: true } } as ChatRequestBody,
      'qfmodel',
      'personal_standard',
    );
    expect(body.parameters.temperature).toBe(0.3);
    expect(body.parameters).not.toHaveProperty('stream_options');
    expect(body.parameters).not.toHaveProperty('messages');
  });

  it('reasoning_effort 映射 is_reasoning；缺省 false', () => {
    expect(toQoderRequest(base, 'qfmodel', 'personal_standard').model_config.is_reasoning).toBe(false);
    expect(
      toQoderRequest({ ...base, reasoning_effort: 'high' } as ChatRequestBody, 'qfmodel', 'personal_standard').model_config.is_reasoning,
    ).toBe(true);
    expect(
      toQoderRequest({ ...base, reasoning_effort: 'none' } as ChatRequestBody, 'qfmodel', 'personal_standard').model_config.is_reasoning,
    ).toBe(false);
  });

  it('tools 数组透传，其它形态不带该键', () => {
    const tools = [{ type: 'function', function: { name: 'f', parameters: {} } }];
    expect(toQoderRequest({ ...base, tools } as ChatRequestBody, 'qfmodel', 'personal_standard').tools).toEqual(tools);
    expect(toQoderRequest(base, 'qfmodel', 'personal_standard').tools).toBeUndefined();
  });

  /*
   * ★★ 2026-10-16 修复的回归钉：`enable_thinking` 必须与 `is_reasoning` **成对**。
   *
   * 此前只发 `is_reasoning: false`、从不发 `enable_thinking` —— 请求自相矛盾，
   * 网关按自己的默认开着思考。qfmodel 上表现为「思考烧掉整个 token 预算、正文只剩一两个字」，
   * 客户端报 empty_model_response。实测补上 `enable_thinking:false` 后 reasoning 归零。
   */
  describe('enable_thinking 与 is_reasoning 成对（qfmodel 空正文的修复）', () => {
    it('未给 reasoning_effort → 两个字段都取 false（不是只发其中一个）', () => {
      const b = toQoderRequest(base, 'qfmodel', 'personal_standard');
      expect(b.model_config.is_reasoning).toBe(false);
      expect(b.parameters.enable_thinking).toBe(false);
    });

    it('给了 reasoning_effort → 两个字段都取 true', () => {
      const b = toQoderRequest({ ...base, reasoning_effort: 'high' } as ChatRequestBody, 'qfmodel', 'personal_standard');
      expect(b.model_config.is_reasoning).toBe(true);
      expect(b.parameters.enable_thinking).toBe(true);
    });

    it('reasoning_effort=none → 两个字段都取 false（显式关思考）', () => {
      const b = toQoderRequest({ ...base, reasoning_effort: 'none' } as ChatRequestBody, 'qfmodel', 'personal_standard');
      expect(b.model_config.is_reasoning).toBe(false);
      expect(b.parameters.enable_thinking).toBe(false);
    });

    it('两处判定同源 —— 不存在 is_reasoning=true 而 enable_thinking=false 的组合', () => {
      for (const eff of [undefined, 'none', 'low', 'medium', 'high']) {
        const b = toQoderRequest(
          eff === undefined ? base : ({ ...base, reasoning_effort: eff } as ChatRequestBody),
          'qfmodel',
          'personal_standard',
        );
        expect(b.parameters.enable_thinking).toBe(b.model_config.is_reasoning);
        expect(b.chat_context.extra.modelConfig.is_reasoning).toBe(b.model_config.is_reasoning);
      }
    });
  });
});
