/**
 * 模型清单：拉 Qoder 网关的 `/algo/api/v2/model/list`（真接口，非本地种子）。
 *
 * 关键设计（沿用 relay 的取舍）：网关给的是「显示名 ↔ 内部 key」映射，而**客户端请求里
 * 传的是内部 key**。所以模型 id = 内部 key（路由键），displayName = 显示名给人看。
 */

import { buildCosyBearer, cosyChatHeaders, newCosySession, type CosySession } from './protocol/cosy.js';
import type { QoderIdentity } from './credential.js';
import type { ModelEntry } from 'waygate-core';
import { UpstreamError } from './errors.js';

export const QODER_MODEL_LIST_PATH = '/algo/api/v2/model/list?Encode=1';

interface GatewayItem {
  key?: unknown;
  display_name?: unknown;
  enable?: unknown;
}

/** 从网关响应里抽模型（取 chat 场景；enable=false 的跳过）。 */
export function parseQoderModels(payload: unknown): ModelEntry[] {
  if (!payload || typeof payload !== 'object') return [];
  const scenes = payload as Record<string, unknown>;
  /* 形状：{ sceneName: [ {key, display_name, enable, …} ] }；取 chat，缺失时取第一个非空场景。 */
  const raw = Array.isArray(scenes.chat)
    ? (scenes.chat as unknown[])
    : (Object.values(scenes).find((v) => Array.isArray(v) && v.length > 0) as unknown[] | undefined) ?? [];
  const out: ModelEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as GatewayItem;
    if (rec.enable === false) continue;
    const id = typeof rec.key === 'string' ? rec.key : null;
    if (!id) continue;
    const displayName = typeof rec.display_name === 'string' && rec.display_name ? rec.display_name : id;
    out.push({ id, displayName });
  }
  return out;
}

/** 拉取模型清单（真打网关）。 */
export async function fetchQoderModels(opts: {
  baseUrl: string;
  identity: QoderIdentity;
  session: CosySession;
  timeoutMs?: number;
}): Promise<ModelEntry[]> {
  const path = QODER_MODEL_LIST_PATH;
  const pathOnly = path.split('?')[0]!;
  const date = String(Math.floor(Date.now() / 1000));
  const bearer = buildCosyBearer(opts.session, date, '', pathOnly);
  const headers = cosyChatHeaders(opts.session, opts.identity, bearer, date, 'application/json');

  const res = await fetch(`${opts.baseUrl}${path}`, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  if (!res.ok) throw new UpstreamError(`模型清单 HTTP ${res.status}（凭证过期？在客户端重新登录后跑一次 qoc login）`);
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UpstreamError('模型清单响应不是 JSON（网关协议变了？）');
  }
  const models = parseQoderModels(parsed);
  if (models.length === 0) throw new UpstreamError('模型清单解析出 0 个模型（响应形状变化？）');
  return models;
}

/** 便捷：从身份材料建会话 + 拉模型（适配器与 doctor 共用）。 */
export async function loadModels(baseUrl: string, identity: QoderIdentity): Promise<ModelEntry[]> {
  return fetchQoderModels({ baseUrl, identity, session: newCosySession(identity) });
}
