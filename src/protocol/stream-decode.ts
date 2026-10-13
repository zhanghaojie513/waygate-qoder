/**
 * 入站解码：Qoder SSE → OpenAI SSE chunk 流（v0.6.0）。
 *
 * 网关帧形状（agent_chat_generation，Encode=1）：`data: {"body":"<JSON 字符串>",…}` ——
 * 双层 JSON：wrapper.body 是**字符串化的 OpenAI 形状 chunk**（choices[].delta /
 * usage / finish_reason），实测 2026-10-11（见记忆 waygate-qoder-integration）。
 *
 * usage 口径（本文件的要害）：
 *   · 网关 usage 带 Qoder 扩展字段 `credits`（名义费率值）与 `billable`（是否实际扣费）；
 *   · 落库铁律（反代保真）：`credit`（本服务落库的唯一权威字段）= **billable ? credits : 0**
 *     —— 免费档 billable:false 的真实扣费就是 0；名义值不冒充实扣（与 v0.5.8 口径一致）；
 *   · billable 字段缺失按 true（社区同判：缺失模型不静默清零积分）；
 *   · reasoning / cached tokens 进标准 details 位 —— extractReasoningTokens /
 *     extractCachedTokens 现有链路直接可读。
 *
 * 思考流：delta.reasoning_content → 原样下发（DeepSeek 惯例字段，ZCode 等客户端认识）。
 * 流结束信号：网关直接关流（无显式 stop 帧）→ flush() 补收尾 usage chunk + [DONE]。
 */

import { UpstreamError } from '../errors.js';

interface DecoderState {
  id: string;
  model: string;
  created: number;
  finish: string | null;
  sawContentOrUsage: boolean;
  usage: null | {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details: { cached_tokens: number };
    completion_tokens_details: { reasoning_tokens: number };
    /** 本服务落库用的实扣值（见头部口径说明）。缺失 = 上游未回报（未知）。 */
    credit?: number;
  };
}

function chunkJson(state: DecoderState, delta: Record<string, unknown>, finish: string | null, withUsage = false): string {
  const chunk: Record<string, unknown> = {
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  if (withUsage && state.usage) chunk.usage = state.usage;
  return JSON.stringify(chunk);
}

/** 解析单个内层 chunk（OpenAI 形状），返回应下发的行（null = 无输出）。 */
function onInnerChunk(state: DecoderState, inner: Record<string, unknown>): string | null {
  /* usage 两种形态都收：独立末帧（choices 空）或挂在最后一个内容帧上（GLM 式）。 */
  const usage = inner.usage as Record<string, unknown> | undefined;
  if (usage && typeof usage === 'object') {
    const prompt = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
    const completion = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
    const cached = ((usage.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens ?? 0) as number;
    const reasoning = ((usage.completion_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens ?? 0) as number;
    /* ★ credits 口径：billable 显式为 false → 实扣 0；缺失/true → 名义 credits 值。
       credits 缺失且 billable=true → credit 不设（extractUpstreamCredit 判 unknown）。 */
    let credit: number | undefined;
    if (usage.billable === false) credit = 0;
    else if (typeof usage.credits === 'number' && Number.isFinite(usage.credits) && usage.credits >= 0) {
      credit = Math.round(usage.credits * 100) / 100;
    }
    state.usage = {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : prompt + completion,
      prompt_tokens_details: { cached_tokens: cached },
      completion_tokens_details: { reasoning_tokens: reasoning },
      ...(credit !== undefined ? { credit } : {}),
    };
    state.sawContentOrUsage = true;
  }
  if (typeof inner.id === 'string' && inner.id && !state.id) state.id = inner.id;
  /* ⚠️ inner.model 一律**丢弃**：网关回的是 'auto'（它自己的会话标签，不是模型名）——
     实测 2026-10-11 全链路：落库 model 被写成 'auto'，会让按模型聚合塌成一桶。
     落库取的 model 由 ctx.modelId（路由解析出的目录 id）兜底，正是我们要的真值。 */

  const choices = inner.choices as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  /* choices.length === 0 已在上一行挡掉；此处下标必然有效。 */
  const choice = choices[0]!;
  const delta = (choice.delta ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof delta.role === 'string' && delta.role) out.role = delta.role;
  if (typeof delta.content === 'string' && delta.content) out.content = delta.content;
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) out.reasoning_content = delta.reasoning_content;
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) out.tool_calls = delta.tool_calls;
  const finish = typeof choice.finish_reason === 'string' ? choice.finish_reason : null;
  if (finish) state.finish = finish;
  const hasOut = Object.keys(out).length > 0;
  if (hasOut) state.sawContentOrUsage = true;
  /* usage 挂在内容帧上时（GLM 式）也要把 usage 带出去 —— 但聚合器取「最后一个非空
     usage」，独立末帧模式由 flush() 兜底补发，这里只在有内容时附带。 */
  return hasOut ? chunkJson(state, out, finish) : null;
}

/** 处理一帧（可能多行），返回应下发的行列表。 */
function handleFrame(state: DecoderState, frame: string): string[] {
  const out: string[] = [];
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let wrapper: Record<string, unknown>;
    try {
      wrapper = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue; // 坏帧跳过（与 openai 路径同口径）
    }
    /* 流内错误信封（业务码伪装成功流）：网关 10605 准入拒绝等会以
       statusCodeValue/错误体出现在帧里 —— 抛 RelayHttpError 让主管道按失败落库。 */
    const errBody = wrapper.error as Record<string, unknown> | string | undefined;
    if (errBody) {
      const msg = typeof errBody === 'string' ? errBody : String((errBody as Record<string, unknown>).message ?? 'unknown');
      throw new UpstreamError(`上游（qoder）流内错误：${msg}`);
    }
    const bodyStr = wrapper.body;
    if (typeof bodyStr !== 'string' || bodyStr === '') continue;
    let inner: Record<string, unknown>;
    try {
      inner = JSON.parse(bodyStr) as Record<string, unknown>;
    } catch {
      continue;
    }
    const line2 = onInnerChunk(state, inner);
    if (line2 !== null) out.push(`data: ${line2}\n\n`);
  }
  return out;
}

/** 转换流：Qoder SSE → OpenAI SSE。网关关流时 flush 补 usage 收尾帧 + [DONE]。
 *  `model` 由调用方注入（路由解析出的目录 id）—— 网关响应里的 model 是 'auto'
 *  占位，不能用（见 onInnerChunk 的注释）；注入后 chunk 与落库取的模型名都正确。 */
export function qoderToOpenAiSse(model = ''): TransformStream<Uint8Array, Uint8Array> {
  const state: DecoderState = {
    id: '',
    model,
    created: Math.floor(Date.now() / 1000),
    finish: null,
    sawContentOrUsage: false,
    usage: null,
  };
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = '';

  const handle = (frame: string, emit: (s: string) => void): void => {
    for (const line of handleFrame(state, frame)) emit(line);
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const emit = (s: string) => controller.enqueue(encoder.encode(s));
      buffer += decoder.decode(chunk, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        handle(frame, emit);
      }
    },
    flush(controller) {
      const emit = (s: string) => controller.enqueue(encoder.encode(s));
      const tail = buffer + decoder.decode();
      if (tail.trim() !== '') handle(tail, emit);
      /* 网关关流 = 结束信号（无显式 stop 帧）：补收尾帧（带 usage）+ [DONE]。
         ⚠️ 一帧内容/usage 都没见过就关流 = 上游异常 —— 不补帧不补 DONE，
         readUpstreamSse 按既有断流语义判失败（绝不伪造成功空流）。 */
      if (!state.sawContentOrUsage) return;
      const fin = chunkJson(state, {}, state.finish ?? 'stop', true);
      emit(`data: ${fin}\n\n`);
      emit('data: [DONE]\n\n');
    },
  });
}
