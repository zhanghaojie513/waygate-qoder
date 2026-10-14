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
import type { ChatMessage, ChatRequestBody } from 'waygate-core';
/** Qoder 消息（v1：纯文本形态 + 空白 response_meta）。 */
interface QoderMessage {
    role: 'user' | 'assistant';
    content: string;
    response_meta: {
        id: string;
        usage: Record<string, number | object>;
    };
    reasoning_content_signature: string;
    contents: Array<{
        type: 'text';
        text: string;
    }>;
}
/** 折叠 OpenAI 消息序列为 Qoder user/assistant 交替历史 + 提取本轮 prompt。 */
export declare function buildQoderMessages(messages: ChatMessage[]): {
    history: QoderMessage[];
    prompt: string;
};
/** Qoder 请求体（ChatRequestBody 镜像，字段序照社区实现 —— 序列化形状稳定）。 */
export interface QoderRequestBody {
    request_id: string;
    request_set_id: string;
    chat_record_id: string;
    stream: boolean;
    chat_task: string;
    chat_context: {
        extra: {
            modelConfig: {
                is_reasoning: boolean;
                key: string;
            };
            originalContent: {
                type: string;
                text: string;
            };
        };
        text: {
            type: string;
            text: string;
        };
    };
    session_id: string;
    source: number;
    version: string;
    aliyun_user_type: string;
    session_type: string;
    agent_id: string;
    task_id: string;
    model_config: {
        key: string;
        is_vl: boolean;
        is_reasoning: boolean;
        source: string;
    };
    messages: QoderMessage[];
    business: {
        id: string;
        name: string;
        begin_at: number;
    };
    parameters: Record<string, unknown>;
    tools?: unknown;
}
/** 组装 Qoder 请求体。qoderModelKey = 目录 id（即网关内部 key，如 qfmodel）。 */
export declare function toQoderRequest(body: ChatRequestBody, qoderModelKey: string, userType: string): QoderRequestBody;
export {};
