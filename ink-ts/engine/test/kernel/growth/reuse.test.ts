/**
 * growth 蒸馏决策点复用判定单测：同主题命中跳过蒸馏（防知识膨胀）、
 * 不同教训不误命中、reuse_first=false 回到「每次蒸馏」基线。
 */

import { describe, expect, it } from 'vitest';

import { EngineEvent } from '../../../src/dock/ports/events.js';
import {
  GrowthConfig,
  GrowthPipeline,
} from '../../../src/kernel/growth/index.js';
import { KIND_INSIGHT, KnowledgeSet } from '../../../src/core/knowledge_set/index.js';

function makeEvent(message: string): EngineEvent {
  return new EngineEvent({
    type: 'review_pass',
    payload: { message },
    thread_id: 't',
    round_id: 'r',
  });
}

/** 含确定性递增 id 源的管线（同知识集多次落位不冲突）。 */
function makePipe(ks: KnowledgeSet, options: Partial<{ reuse_first: boolean }> = {}): GrowthPipeline {
  let seq = 0;
  return new GrowthPipeline(ks, {
    config: new GrowthConfig(options),
    uuid_gen: () => (++seq).toString(16).padStart(12, '0'),
  });
}

async function flushRound(pipe: GrowthPipeline, message: string, complexity = 5): Promise<void> {
  await pipe.send(makeEvent(message));
  await pipe.flush_round({ complexity });
}

describe('growth 蒸馏决策点 reuse 判定', () => {
  it('同教训重复出现：复用命中跳过蒸馏落位（landed 不重复）', async () => {
    const ks = new KnowledgeSet('u1');
    const pipe = makePipe(ks);
    await flushRound(pipe, '不要用 X 方案');
    expect(pipe.snapshot()['landed']).toBe(1);
    await flushRound(pipe, '不要用 X 方案');
    const snap = pipe.snapshot();
    expect(snap['landed']).toBe(1);
    expect(String(snap['last_flush_note'])).toContain('复用命中已有知识');
    const insights = ks.entries().filter((e) => e.kind === KIND_INSIGHT);
    expect(insights.length).toBe(1);
  });

  it('不同教训（仅词元部分重叠）不误命中：各自落位', async () => {
    const ks = new KnowledgeSet('u1');
    const pipe = makePipe(ks);
    await flushRound(pipe, '第一次失败教训');
    await flushRound(pipe, '第二次失败教训');
    expect(pipe.snapshot()['landed']).toBe(2);
    expect(ks.entries().filter((e) => e.kind === KIND_INSIGHT).length).toBe(2);
  });

  it('reuse_first=false：重复教训每次照常蒸馏（回到基线）', async () => {
    const pipe = makePipe(new KnowledgeSet('u1'), { reuse_first: false });
    await flushRound(pipe, '重复的教训文本');
    await flushRound(pipe, '重复的教训文本');
    expect(pipe.snapshot()['landed']).toBe(2);
  });
});
