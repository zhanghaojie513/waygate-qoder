/**
 * 出站翻译：OpenAI Chat Completions → Qoder agent_chat_generation（v0.6.0）。
 *
 * 与 anthropic-upstream/translate.ts（OpenAI→Anthropic）同族：入口收本服务统一的
 * ChatRequestBody（已过 prompt 改写），出口是 Qoder 网关的请求体（JSON 字符串 ——
 * 外层再由 cosy.ts 的 qEncode 编码）。
 *
 * 消息折叠策略（v1 口径，与 Anthropic 路线一致）：
 *   · system 消息 → 顶部 system 块？Qoder 无独立 system 字段 —— 并入首条 user 文本
 *     （网关侧 chat_context 才是「本轮输入」的主通道，messages 是会话历史）；
 *   · role:"tool" 的工具结果 → 序列化并进紧随的 user 消息文本（Anthropic 路线同款）；
 *   · assistant 的 tool_calls 历史 → 序列化为其文本的一部分（v1 不回灌原生
 *     tool_calls 块 —— 客户端通常重发完整历史，序列化保语义）；
 *   · 未识别字段静默忽略（与两个入站方向口径一致）。
 *
 * 参数透传（verbatim 政策，与社区实现一致）：temperature/top_p/stop 等 **原样**进
 * parameters；网关是裁判。max_tokens 缺省补 8192（官方客户端自己的回落）。
 * reasoning_effort 若客户端给了（o 系参数），映射 model_config.is_reasoning。
 */

import { randomUUID } from 'node:crypto';
import type { ChatMessage, ChatRequestBody } from '@waygate/core';

/** Qoder 消息（v1：纯文本形态 + 空白 response_meta）。 */
interface QoderMessage {
  role: 'user' | 'assistant';
  content: string;
  response_meta: { id: string; usage: Record<string, number | object> };
  reasoning_content_signature: string;
  contents: Array<{ type: 'text'; text: string }>;
}

const BLANK_USAGE = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  completion_tokens_details: { reasoning_tokens: 0 },
  prompt_tokens_details: { cached_tokens: 0 },
};

function qMsg(role: 'user' | 'assistant', text: string): QoderMessage {
  return {
    role,
    content: '',
    response_meta: { id: '', usage: { ...BLANK_USAGE, completion_tokens_details: { ...BLANK_USAGE.completion_tokens_details }, prompt_tokens_details: { ...BLANK_USAGE.prompt_tokens_details } } },
    reasoning_content_signature: '',
    contents: [{ type: 'text', text }],
  };
}

/** 工具调用历史序列化（人类可读、保 id/name/arguments 全量）。 */
function serializeToolCalls(calls: unknown): string {
  if (!Array.isArray(calls)) return '';
  return calls
    .map((c) => {
      const fn = (c as { function?: { name?: string; arguments?: string } }).function ?? {};
      return `[tool_call id=${(c as { id?: string }).id ?? ''} name=${fn.name ?? ''}] ${fn.arguments ?? ''}`;
    })
    .join('\n');
}

/** 折叠 OpenAI 消息序列为 Qoder user/assistant 交替历史 + 提取本轮 prompt。 */
export function buildQoderMessages(messages: ChatMessage[]): { history: QoderMessage[]; prompt: string } {
  const folded: QoderMessage[] = [];
  /** 待并入下一条 user 的碎片（system 前缀 / tool 结果 / assistant 工具调用说明）。 */
  let pendingUserPrefix: string[] = [];
  let latestUserPrompt = '';

  for (const m of messages) {
    const text = typeof m.content === 'string' ? m.content : m.content == null ? '' : JSON.stringify(m.content);
    if (m.role === 'system') {
      pendingUserPrefix.push(`[system] ${text}`);
      continue;
    }
    if (m.role === 'tool') {
      pendingUserPrefix.push(`[tool_result ${String(m.tool_call_id ?? '')}] ${text}`);
      continue;
    }
    if (m.role === 'assistant') {
      const tc = serializeToolCalls(m.tool_calls);
      const full = tc ? `${text}\n${tc}` : text;
      if (full.trim()) folded.push(qMsg('assistant', full));
      continue;
    }
    /* user（未知角色按 user 处理 —— 与网关宽容口径一致） */
    const merged = [...pendingUserPrefix, text].filter((s) => s !== '').join('\n\n');
    pendingUserPrefix = [];
    latestUserPrompt = merged;
    folded.push(qMsg('user', merged));
  }
  /* 残余 system/tool 碎片（序列以非 user 结尾的病态情况）：并入最后一条 user。 */
  if (pendingUserPrefix.length > 0 && folded.length > 0) {
    const last = folded[folded.length - 1];
    if (last && last.role === 'user') {
      last.contents = [{ type: 'text', text: `${last.contents[0]?.text ?? ''}\n\n${pendingUserPrefix.join('\n\n')}` }];
      latestUserPrompt = last.contents[0]?.text ?? '';
    } else {
      folded.push(qMsg('user', pendingUserPrefix.join('\n\n')));
      latestUserPrompt = pendingUserPrefix.join('\n\n');
    }
    pendingUserPrefix = [];
  }
  if (!latestUserPrompt && folded.length > 0) {
    const last = folded[folded.length - 1];
    if (last && last.role === 'user') latestUserPrompt = last.contents[0]?.text ?? '';
  }
  return { history: folded, prompt: latestUserPrompt };
}

/** Qoder 请求体（ChatRequestBody 镜像，字段序照社区实现 —— 序列化形状稳定）。 */
export interface QoderRequestBody {
  request_id: string;
  request_set_id: string;
  chat_record_id: string;
  stream: boolean;
  chat_task: string;
  chat_context: {
    extra: { modelConfig: { is_reasoning: boolean; key: string }; originalContent: { type: string; text: string } };
    text: { type: string; text: string };
  };
  session_id: string;
  source: number;
  version: string;
  aliyun_user_type: string;
  session_type: string;
  agent_id: string;
  task_id: string;
  model_config: { key: string; is_vl: boolean; is_reasoning: boolean; source: string };
  messages: QoderMessage[];
  business: { id: string; name: string; begin_at: number };
  parameters: Record<string, unknown>;
  tools?: unknown;
}

/** parameters 透传白名单（其余字段不进 parameters —— verbatim 政策内只搬已知键，
 *  防止把 stream_options 之类的 OpenAI 控制字段误投给网关）。 */
const PARAM_PASSTHROUGH = ['temperature', 'top_p', 'stop', 'frequency_penalty', 'presence_penalty', 'seed', 'response_format', 'tool_choice', 'reasoning_effort', 'max_thinking_tokens'] as const;

/** 组装 Qoder 请求体。qoderModelKey = 目录 id（即网关内部 key，如 qfmodel）。 */
export function toQoderRequest(body: ChatRequestBody, qoderModelKey: string, userType: string): QoderRequestBody {
  const { history, prompt } = buildQoderMessages(body.messages);
  const nid = randomUUID();
  const isReasoning = body.reasoning_effort != null && body.reasoning_effort !== 'none';

  const parameters: Record<string, unknown> = {};
  for (const k of PARAM_PASSTHROUGH) {
    if (body[k] !== undefined) parameters[k] = body[k];
  }
  if (body.max_tokens !== undefined) parameters.max_tokens = body.max_tokens;
  else if (parameters.max_tokens === undefined) parameters.max_tokens = 8192; // 官方客户端自己的回落

  return {
    request_id: nid,
    request_set_id: randomUUID(),
    chat_record_id: nid,
    stream: true, // 恒开流（管道流式原生，与 anthropic 路线同口径）
    chat_task: 'FREE_INPUT',
    chat_context: {
      extra: {
        modelConfig: { is_reasoning: isReasoning, key: qoderModelKey },
        originalContent: { type: 'text', text: prompt },
      },
      text: { type: 'text', text: prompt },
    },
    session_id: randomUUID(),
    source: 1,
    version: '3',
    aliyun_user_type: userType,
    session_type: 'qodercli',
    agent_id: 'agent_common',
    task_id: 'common',
    model_config: { key: qoderModelKey, is_vl: true, is_reasoning: isReasoning, source: 'system' },
    messages: history,
    business: { id: randomUUID(), name: prompt.slice(0, 30) || 'chat', begin_at: Date.now() },
    parameters,
    tools: Array.isArray(body.tools) ? body.tools : undefined,
  };
}
