/**
 * growth 模块常量/孵化产物形态（growth.py 常量面移植）。
 *
 * 单点定义：孵化缓冲上限、孵化产物 L1 schema（insight 教训条目声明形态）、
 * L2 空样例库（insight 无规则执行语义——L2 跳过执行，空样例库即可）与
 * 成长指标时序（复利实证数据面：独立集合 growth_metrics、单键滚动缓冲、
 * METRICS_CAP 条上限防无限膨胀；与审计 set_audit 严格分离）。
 */

import { FIELD_STRING, SchemaField, SchemaSpec } from '../schema/schemaValidator.js';
import { FixtureSet } from '../rules/index.js';

// 孵化缓冲上限（信号跨回合累积但有界：超限丢弃最旧——防长时间无阈值
// 触发时内存膨胀；上限远高于现实单会话信号量，正常场景不触发）
export const _MAX_INCUBATING = 200;

// 孵化产物的 L1 schema（insight 教训条目声明形态：id/level/kind 字段关；
// 内容面注入扫描由闸门 L1 兜底——schema 只做结构口径）
export const _INSIGHT_SCHEMA = new SchemaSpec({
  name: 'growth.insight',
  fields: [
    new SchemaField({ name: 'id', required: true, kind: FIELD_STRING }),
    new SchemaField({ name: 'level', required: true, kind: FIELD_STRING }),
    new SchemaField({ name: 'kind', required: true, kind: FIELD_STRING }),
  ],
});

// L2 fixtures（insight 教训条目无规则执行语义——L2 跳过执行，空样例库即可）
export const _EMPTY_FIXTURES = new FixtureSet({ name: 'growth', cases: [] });

// 成长指标时序（复利实证数据面）：独立集合 growth_metrics，单键滚动
// 缓冲（METRICS_CAP 条上限防无限膨胀）；与审计 set_audit 严格分离
export const METRICS_COLLECTION = 'growth_metrics';
export const METRICS_KEY = 'snapshots';
export const METRICS_CAP = 1000;
