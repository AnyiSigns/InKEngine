import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EVENT_TYPE_NAMES, EVENT_TYPE_SPECS } from '@/shared/session/eventTypes';

interface SeedEventSpec {
  name: string;
}

/**
 * 事件类型镜像门禁：seed_data/event_types.json（引擎绑定白名单真源）↔
 * 前端 eventTypes 注册表必须双向一致。新增引擎事件类型时三处同改：
 * 引擎发射点 → seed json 登记 → 前端本表镜像（ingest 落位）；任一侧
 * 漂移（漏登记/多登记/改名）即失败，杜绝「引擎发新事件、前端静默丢弃」。
 */
describe('事件类型镜像对码门禁', () => {
  const seedPath = resolve(__dirname, '../../../../seed_data/event_types.json');
  const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as { events: SeedEventSpec[] };
  const seedNames = seed.events.map((e) => e.name);

  it('seed json 全量事件名在前端注册表中镜像登记', () => {
    const frontend = new Set<string>(EVENT_TYPE_NAMES);
    const missing = seedNames.filter((n) => !frontend.has(n));
    expect(missing).toEqual([]);
  });

  it('前端注册表无 seed json 之外的多余事件名', () => {
    const seedSet = new Set(seedNames);
    const extra = EVENT_TYPE_NAMES.filter((n) => !seedSet.has(n));
    expect(extra).toEqual([]);
  });

  it('事件类型声明（specs）与名称注册表一一对应', () => {
    const specNames = EVENT_TYPE_SPECS.map((s) => s.name);
    expect(specNames.map((n) => n as string)).toEqual(Array.from(EVENT_TYPE_NAMES));
  });
});
