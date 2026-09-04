/**
 * 知识集组装注入面：种子注入 + 条目 → 上下文源清单。
 *
 * build_knowledge_sources 是「知识注入 = 调配器思想复用」的组装入口：
 * 检索命中条目经此转为 ContextSource（type=装配源类别、weight=可信度、
 * relevance=任务相关度、ttl=时效、内容 = 条目渲染，层级留在 meta——装配
 * 分级按源类别分配预算，层级供常驻基线/任务激活的判定消费）。预算分配、
 * 跨源去重、逐源留痕全由 context 模块承接（本模块零重复实现）。
 *
 * 差异说明（迁移边界）：指令注入扫描（scan_text_injection，knowledge_gate
 * 未迁移）在本层以 InjectionScanner seam 表达——未注入扫描器时不做剔除
 * （injection_scan 保持默认开，检出动作由宿主注入等价实现补齐）。
 */

import { ContextSource } from '../context/context_types.js';
import {
  KIND_PATH,
  KIND_SCRIPT,
  SEED_ID_PREFIX,
  type InjectionScanner,
} from './_types.js';
import type { KnowledgeEntry } from './knowledge_entry.js';
import type { KnowledgeSet } from './knowledge_set.js';

export type { InjectionScanner } from './_types.js';

/** 缺省指令注入扫描器：knowledge_gate.scan_text_injection 未迁移前的
 *  no-op（不剔除任何条目）——injection_scan 语义面保留，检出逻辑待迁移。 */
export const DEFAULT_INJECTION_SCANNER: InjectionScanner = (content: string) => {
  void content;
  return [];
};

/** 种子注入：批量写入最小可用种子（幂等——同 id 跳过，不覆盖演化）。
 *
 * 通用种子（引擎内置）与领域种子（随引擎随带）统一经此入口注入；幂等性
 * 保证「种子只读基线 + 演化补丁链」的分层语义——重复初始化不会覆盖使用
 * 中沉淀的知识。同 id 跳过是明确的冲突信号（种子基线长期遮蔽演化沉淀属
 * 可观测信号，静默跳过会让「种子与演化冲突」不可见）——core 无日志面，
 * 冲突可见性由返回值差值承载。 */
export function seed_knowledge_set(
  knowledge_set: KnowledgeSet,
  entries: readonly KnowledgeEntry[],
): number {
  let injected = 0;
  for (const entry of entries) {
    if (knowledge_set.get(entry.id) === null) {
      knowledge_set.add(entry);
      injected += 1;
    }
  }
  return injected;
}

/** build_knowledge_sources 命名选项（Python kw-only args 的 TS 映射）。 */
export interface BuildKnowledgeSourcesOptions {
  relevance?: number;
  ttl?: number | null;
  max_chars?: number | null;
  /** 知识注入开关（false = 回退种子基线：只保留 seed. 前缀条目）。 */
  injection_enabled?: boolean;
  /** 注入前指令注入扫描（true = 检出剔除；扫描器经 scanner 注入）。 */
  injection_scan?: boolean;
  /** 装配源类别（知识池的分配键；须在输入调配管线的源类别集合内）。 */
  source_type?: string;
  /** 指令注入扫描器（缺省 = no-op，见文件头差异说明）。 */
  scanner?: InjectionScanner | null;
}

/**
 * 知识条目 → 上下文源清单（知识注入 = 调配器思想复用的组装入口）。
 *
 * injection_enabled=false = 一键关闭知识注入：只保留种子条目（id 以 seed.
 * 前缀）作为注入源——回退到种子基线（引擎内置最小可用），演化沉淀的
 * 知识不再进入上下文。injection_scan=true + 注入扫描器 = 注入防线：检出
 * 指令型措辞的条目剔除，不放行进提示词（web/用户来源知识条目可能携带
 * 指令型措辞；扫描与注入开关正交——种子基线同样过防线）。
 *
 * 执行类 kind（path/script）剔除：执行物非 prompt 文本，不进上下文注入，
 * 消费分派（path=路径组装先例 / script=工具执行）与注入面分离。
 */
export function build_knowledge_sources(
  entries: readonly KnowledgeEntry[],
  options: BuildKnowledgeSourcesOptions = {},
): ContextSource[] {
  const relevance = options.relevance ?? 0.5;
  const ttl = options.ttl ?? null;
  const maxChars = options.max_chars ?? null;
  const injectionEnabled = options.injection_enabled ?? true;
  const injectionScan = options.injection_scan ?? true;
  const sourceType = options.source_type ?? 'knowledge';
  let selected = entries;
  if (!injectionEnabled) {
    selected = selected.filter((e) => e.id.startsWith(SEED_ID_PREFIX));
  }
  selected = selected.filter((e) => e.kind !== KIND_PATH && e.kind !== KIND_SCRIPT);
  const scanner = options.scanner ?? (injectionScan ? DEFAULT_INJECTION_SCANNER : null);
  const sources: ContextSource[] = [];
  for (const entry of selected) {
    if (injectionScan && scanner !== null) {
      const hits = scanner(entry.render_content());
      if (hits.length > 0) continue; // 检出即剔除，不放行
    }
    sources.push(
      entry.as_context_source({ relevance, ttl, budget_chars: maxChars }),
    );
  }
  let result = sources;
  if (sourceType) {
    // Python dataclasses.replace(s, type=source_type)：rebuild 保留全部字段，
    // 仅替换源类别（层级留在 meta，常驻基线/任务激活判定消费 meta.level）
    result = sources.map(
      (s) =>
        new ContextSource(sourceType, s.content, {
          title: s.title,
          weight: s.weight,
          relevance: s.relevance,
          priority: s.priority,
          ttl: s.ttl,
          max_chars: s.max_chars,
          dedup_key: s.dedup_key,
          meta: { ...s.meta },
          created_at: s.created_at,
        }),
    );
  }
  result.sort((a, b) => b.weight - a.weight || b.priority - a.priority);
  return result;
}