/**
 * stream-decode.spec：双层 JSON 解包、usage/credits 口径（billable 语义是本模块的要害）、
 * 收尾帧与 [DONE]、空流不伪造成功。
 */
import { describe, expect, it } from 'vitest';
import { qoderToOpenAiSse } from './stream-decode.js';

/** 把网关帧（wrapper.body = 字符串化内层）喂进转换流，收全部输出行。 */
async function run(frames: string[], model = ''): Promise<string[]> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    },
  });
  const out: string[] = [];
  const reader = stream.pipeThrough(qoderToOpenAiSse(model)).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(...dec.decode(value).split('\n\n').filter(Boolean));
  }
  return out;
}

const wrap = (inner: unknown): string => `data: ${JSON.stringify({ body: JSON.stringify(inner) })}\n\n`;

describe('qoder stream-decode · 解包与透传', () => {
  it('★ 内容增量 → OpenAI chunk；reasoning_content 原样透传；model 用注入值（网关的 auto 被丢弃）', async () => {
    const lines = await run(
      [
        wrap({ id: 'r1', model: 'auto', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }),
        wrap({ choices: [{ index: 0, delta: { content: '你' }, finish_reason: null }] }),
        wrap({ choices: [{ index: 0, delta: { reasoning_content: '思考中' }, finish_reason: null }] }),
        wrap({ choices: [{ index: 0, delta: { content: '好' }, finish_reason: 'stop' }] }),
      ],
      'qfmodel',
    );
    const chunks = lines.filter((l) => l !== 'data: [DONE]').map((l) => JSON.parse(l.slice(6)));
    expect(chunks[0].choices[0].delta.role).toBe('assistant');
    expect(chunks.map((c) => c.choices[0].delta.content ?? '').join('')).toBe('你好');
    expect(chunks[2].choices[0].delta.reasoning_content).toBe('思考中');
    expect(chunks[3].choices[0].finish_reason).toBe('stop');
    /* id 取首帧；model **恒为注入值** —— 网关响应里的 'auto' 是会话标签不是模型名，
       落库 model 被写成 auto 会让按模型聚合塌成一桶（2026-10-11 E2E 实测）。 */
    expect(chunks[0].id).toBe('r1');
    expect(chunks.every((c) => c.model === 'qfmodel')).toBe(true);
    /* 收尾：usage 帧 + [DONE] */
    expect(lines[lines.length - 1]).toBe('data: [DONE]');
    const fin = JSON.parse(lines[lines.length - 2].slice(6));
    expect(fin.choices[0].finish_reason).toBe('stop');
  });

  it('★★ credits 口径：billable:false → credit=0（实扣 0，名义值不冒充）；billable 缺失/true → credits 值', async () => {
    const free = await run([
      wrap({ choices: [{ delta: { content: 'x' } }] }),
      wrap({ usage: { prompt_tokens: 66, completion_tokens: 30, total_tokens: 96, credits: 0.002973, original_credits: 0.002973, billable: false } }),
    ]);
    const freeUsage = JSON.parse(free[free.length - 2].slice(6)).usage;
    expect(freeUsage.credit).toBe(0);
    expect(freeUsage.prompt_tokens).toBe(66);
    expect(freeUsage.completion_tokens).toBe(30);
    expect(freeUsage).not.toHaveProperty('credits'); // 名义值不透传给客户端

    const paid = await run([
      wrap({ choices: [{ delta: { content: 'x' } }] }),
      wrap({ usage: { prompt_tokens: 10, completion_tokens: 5, credits: 0.5, billable: true } }),
    ]);
    expect(JSON.parse(paid[paid.length - 2].slice(6)).usage.credit).toBe(0.5);

    const noFlag = await run([
      wrap({ choices: [{ delta: { content: 'x' } }] }),
      wrap({ usage: { prompt_tokens: 10, completion_tokens: 5, credits: 0.25 } }),
    ]);
    expect(JSON.parse(noFlag[noFlag.length - 2].slice(6)).usage.credit).toBe(0.25);

    const noCredits = await run([
      wrap({ choices: [{ delta: { content: 'x' } }] }),
      wrap({ usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    ]);
    expect(JSON.parse(noCredits[noCredits.length - 2].slice(6)).usage).not.toHaveProperty('credit');
  });

  it('★ cached / reasoning tokens 进标准 details 位', async () => {
    const lines = await run([
      wrap({ choices: [{ delta: { content: 'x' } }] }),
      wrap({
        usage: {
          prompt_tokens: 100, completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 80 },
          completion_tokens_details: { reasoning_tokens: 20 },
          credits: 1, billable: true,
        },
      }),
    ]);
    const usage = JSON.parse(lines[lines.length - 2].slice(6)).usage;
    expect(usage.prompt_tokens_details.cached_tokens).toBe(80);
    expect(usage.completion_tokens_details.reasoning_tokens).toBe(20);
  });

  it('★ 空流（无内容无 usage 即关流）→ 不补收尾帧、不补 [DONE]（不伪造成功）', async () => {
    const lines = await run([`data: ${JSON.stringify({ ping: 1 })}\n\n`]);
    expect(lines).toHaveLength(0);
  });

  it('tool_calls 增量透传', async () => {
    const lines = await run([
      wrap({ choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'f', arguments: '' } }] } }] }),
    ]);
    const delta = JSON.parse(lines[0].slice(6)).choices[0].delta;
    expect(delta.tool_calls[0].function.name).toBe('f');
  });

  it('坏帧跳过不炸；非 data: 行忽略', async () => {
    const lines = await run(['event: ping\ndata: not-json\n\n', wrap({ choices: [{ delta: { content: 'ok' } }] })]);
    expect(lines.some((l) => l.includes('"ok"'))).toBe(true);
  });
});
