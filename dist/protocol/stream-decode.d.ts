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
/** 转换流：Qoder SSE → OpenAI SSE。网关关流时 flush 补 usage 收尾帧 + [DONE]。
 *  `model` 由调用方注入（路由解析出的目录 id）—— 网关响应里的 model 是 'auto'
 *  占位，不能用（见 onInnerChunk 的注释）；注入后 chunk 与落库取的模型名都正确。 */
export declare function qoderToOpenAiSse(model?: string): TransformStream<Uint8Array, Uint8Array>;
