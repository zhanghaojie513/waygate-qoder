/**
 * 模型清单：拉 Qoder 网关的 `/algo/api/v2/model/list`（真接口，非本地种子）。
 *
 * 关键设计（沿用 relay 的取舍）：网关给的是「显示名 ↔ 内部 key」映射，而**客户端请求里
 * 传的是内部 key**。所以模型 id = 内部 key（路由键），displayName = 显示名给人看。
 */
import { type CosySession } from './protocol/cosy.js';
import type { QoderIdentity } from './credential.js';
import type { ModelEntry } from '@waygate/core';
export declare const QODER_MODEL_LIST_PATH = "/algo/api/v2/model/list?Encode=1";
/** 从网关响应里抽模型（取 chat 场景；enable=false 的跳过）。 */
export declare function parseQoderModels(payload: unknown): ModelEntry[];
/** 拉取模型清单（真打网关）。 */
export declare function fetchQoderModels(opts: {
    baseUrl: string;
    identity: QoderIdentity;
    session: CosySession;
    timeoutMs?: number;
}): Promise<ModelEntry[]>;
/** 便捷：从身份材料建会话 + 拉模型（适配器与 doctor 共用）。 */
export declare function loadModels(baseUrl: string, identity: QoderIdentity): Promise<ModelEntry[]>;
