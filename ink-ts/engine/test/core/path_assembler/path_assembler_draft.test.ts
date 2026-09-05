/**
 * 路径组装器草稿层与请求/观测单测（test_path_assembler.py 草稿段 1:1 移植）：
 * 草稿解析形态与上限 / 负面草稿矩阵（不可达收尾算法修复 / 修复不可达全量兜底 /
 * 固执重试上限 / 空响应与超时直接兜底）/ 反馈消毒 / 检索器协议注入草稿窗口 / 组装审计
 * 记录 / 请求 JSON 往返 / canary 重建级校验 / 候选事件类型注册。
 *
 * 依赖引擎执行器的 canary 单回合执行类用例已回补：见
 * path_assembler_canary.test.ts（候选重建 + 单回合试跑/破坏性执行拒绝/
 * canary 态标记/步数护栏/超时中止）。
 */

import { describe, expect, it } from 'vitest';

import { EventTypeRegistry } from '../../../src/core/event_types/registry.js';
import { EVENT_STATUS_REGISTERED } from '../../../src/core/event_types/eventTypeSpec.js';
import {
  EVENT_ASSEMBLY_CANDIDATE,
  assembly_candidate_event_spec,
  register_path_assembly_event_types,
} from '../../../src/core/event_types/eventTypeSpecs.js';
import { graph_fingerprint } from '../../../src/core/fingerprint/fingerprint.js';
import {
  CANDIDATE_SOURCE_ALGORITHM,
  AssemblyRequest,
  InMemoryPoolRetriever,
  MAX_DRAFT_ITEMS,
  MAX_ITEM_CHARS,
  canary_instantiate,
  parse_draft_chain,
  validate_chain,
} from '../../../src/core/path_assembler/index.js';
import {
  DUMMY_NOW,
  ENTRY,
  FixedDraftProvider,
  draft_envelope,
  make_assembler,
  make_registry,
  make_request,
  pool_of,
} from './helpers.js';

describe('草稿解析（纯函数）', () => {
  it('test_parse_draft_chain_variants：json/fence/空白/字符串数组；空或非 JSON = None', () => {
    expect(parse_draft_chain('["a","b"]')).toEqual(['a', 'b']);
    expect(parse_draft_chain('```json\n["a"]\n```')).toEqual(['a']);
    expect(parse_draft_chain(null)).toBeNull();
    expect(parse_draft_chain('')).toBeNull();
    expect(parse_draft_chain('这是计划文字')).toBeNull();
    expect(parse_draft_chain('{"main": ["a"]}')).toBeNull();
    expect(parse_draft_chain('["a", 3]')).toBeNull();
  });

  it('test_parse_draft_chain_imposes_limits：条数/单条长度上限 = 解析失败', () => {
    expect(parse_draft_chain(JSON.stringify(Array(MAX_DRAFT_ITEMS + 1).fill('a')))).toBeNull();
    expect(parse_draft_chain(JSON.stringify(['x'.repeat(MAX_ITEM_CHARS + 1)]))).toBeNull();
    expect(parse_draft_chain(JSON.stringify(['a', 'b']))).toEqual(['a', 'b']);
    expect(parse_draft_chain(JSON.stringify(['a'.repeat(MAX_ITEM_CHARS)]))).toEqual([
      'a'.repeat(MAX_ITEM_CHARS),
    ]);
  });
});

describe('草稿层正面/负面矩阵', () => {
  it('test_draft_valid_chain_used_and_audited：草稿合法 → 进候选；审计记录落库', async () => {
    const records: Record<string, unknown>[] = [];
    const provider = new FixedDraftProvider(
      '["intent_parse","domain_router","code_gen","test_gen","qa_check"]',
    );
    const result = await make_assembler(null, { sink: (r) => records.push(r) }).assemble(
      make_request(['code', 'tests', 'quality_report'], { provider }),
      draft_envelope(),
    );
    expect(result.llm_attempts).toBe(1);
    expect(result.is_empty).toBe(false);
    expect(records.length).toBe(1);
    const record = records[0]!;
    expect(record['domain']).toBe('code');
    expect(record['fingerprint']).toBe(result.fingerprint);
    expect(record['goal_fields']).toEqual(['code', 'quality_report', 'tests']);
    const candidates = record['candidates'] as Record<string, unknown>[];
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!['rank']).toBe(1);
    expect(record['llm_attempts']).toBe(1);
    expect(result.fingerprint).toBe(graph_fingerprint(result.candidates[0]!.graph));
  });

  it('test_draft_t2_unreachable_tail_repaired_by_algorithm：不可达收尾 → 算法修复替换', async () => {
    const provider = new FixedDraftProvider(
      '["intent_parse","domain_router","web_search","report_assemble"]',
    );
    const result = await make_assembler().assemble(
      make_request(['answer'], { provider, top_k: 3 }),
      draft_envelope(),
    );
    expect(result.llm_attempts).toBe(1);
    expect(result.fallback_reason).toBeNull();
    expect(result.stats['repair_attempts']).toBe(1);
    expect(result.candidates.some((c) => c.chain[c.chain.length - 1] === 'answer_direct')).toBe(
      true,
    );
    for (const candidate of result.candidates) {
      const [ok, reasons] = validate_chain(candidate.chain, {
        pool: pool_of(make_registry()),
        goal_fields: ['answer'],
        entry_fields: ENTRY,
      });
      expect(ok).toBe(true);
      expect(reasons).toEqual([]);
    }
  });

  it('test_draft_unfixable_falls_back_to_full_algorithm：修复不可达 → 全量算法兜底', async () => {
    const provider = new FixedDraftProvider('["intent_parse","bogus_node"]');
    const result = await make_assembler().assemble(
      make_request(['answer'], { provider }),
      draft_envelope(),
    );
    expect(result.is_empty).toBe(false);
    expect(result.candidates.every((c) => c.source === CANDIDATE_SOURCE_ALGORITHM)).toBe(true);
    expect(result.candidates[0]!.repaired).toBe(false);
    expect(result.fallback_reason).toContain('重试耗尽');
  });

  it('test_draft_stubborn_same_invalid_three_times_force_fallback：固执草稿 3 次后强制兜底', async () => {
    const provider = new FixedDraftProvider('["intent_parse","stubborn_node"]');
    const result = await make_assembler().assemble(
      make_request(['answer'], { provider }),
      draft_envelope(),
    );
    expect(provider.calls.length).toBe(3);
    expect(result.llm_attempts).toBe(3);
    expect(result.stats['repair_attempts']).toBe(3);
    expect(result.is_empty).toBe(false);
    expect(result.fallback_reason).toContain('重试耗尽');
  });

  it('test_draft_empty_response_no_retry_direct_fallback：空响应不重试直接兜底', async () => {
    const provider = new FixedDraftProvider('');
    const result = await make_assembler().assemble(
      make_request(['answer'], { provider }),
      draft_envelope(),
    );
    expect(provider.calls.length).toBe(1);
    expect(result.llm_attempts).toBe(1);
    expect(result.fallback_reason).toContain('解析失败');
    expect(result.is_empty).toBe(false);
  });

  it('test_draft_non_json_no_retry_direct_fallback：非 JSON 不重试直接兜底', async () => {
    const provider = new FixedDraftProvider('我觉得可以先检索再做答……');
    const result = await make_assembler().assemble(
      make_request(['answer'], { provider }),
      draft_envelope(),
    );
    expect(provider.calls.length).toBe(1);
    expect(result.llm_attempts).toBe(1);
    expect(result.fallback_reason).toContain('解析失败');
  });

  it('test_draft_provider_timeout_falls_back_to_algorithm：草稿源超时 → 不重试直接算法兜底', async () => {
    const provider = new SlowDraftProvider(500);
    const result = await make_assembler().assemble(
      make_request(['answer'], { provider }),
      draft_envelope({ draft_timeout: 0.05, llm_retry_limit: 2 }),
    );
    expect(provider.calls).toBe(1);
    expect(result.llm_attempts).toBe(1);
    expect(result.is_empty).toBe(false);
    expect(result.fallback_reason).toContain('草稿源调用异常');
  });

  it('test_draft_feedback_only_codes_and_whitelisted_names：反馈消毒不回模型自造名原文', async () => {
    const provider = new FixedDraftProvider(
      '["evil_node"]',
      '["intent_parse","domain_router","web_search","answer_direct"]',
    );
    const result = await make_assembler().assemble(
      make_request(['answer'], { provider }),
      draft_envelope({ llm_retry_limit: 1 }),
    );
    expect(result.llm_attempts).toBe(2);
    expect(provider.calls.length).toBe(2);
    const feedback = provider.calls[1]!.feedback;
    expect(feedback.includes('evil_node')).toBe(false);
    expect(feedback.includes('unknown_node')).toBe(true);
  });

  it('test_retriever_protocol_injected_draft_window：草稿层窗口经检索器缩小', async () => {
    const registry = make_registry();
    const retriever = new InMemoryPoolRetriever(pool_of(registry));
    const provider = new FixedDraftProvider(
      '["intent_parse","domain_router","web_search","answer_direct"]',
    );
    const draft_result = await make_assembler(registry, { retriever }).assemble(
      make_request(['answer'], { provider }),
      draft_envelope(),
    );
    expect(draft_result.llm_attempts).toBe(1);
    const seen = provider.calls[0]!.node_summaries;
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]!.type_name.length).toBeGreaterThan(0);
    expect(Array.isArray(seen[0]!.outputs)).toBe(true);
  });
});

describe('请求数据形态 / 观测出口', () => {
  it('test_assembly_request_json_roundtrip：to_dict/from_dict 往返（注入件分列）', () => {
    const request = make_request(['answer'], { entry: ['user_query'], tier: 2, top_k: 3 });
    const data = request.to_dict();
    expect(data['domain']).toBe('code');
    expect(data['max_safety_tier']).toBe(2);
    expect(data['entry_fields']).toEqual(['user_query']);
    const rebuilt = AssemblyRequest.from_dict(data);
    expect(rebuilt.goal_fields()).toEqual([...request.goal_fields()].sort());
    expect(rebuilt.entry_fields).toEqual(request.entry_fields);
    expect(rebuilt.max_safety_tier).toBe(2);
    expect(rebuilt.top_k).toBe(3);
    const roundtrip = AssemblyRequest.from_dict(rebuilt.to_dict());
    expect(roundtrip.goal_fields()).toEqual(rebuilt.goal_fields());
  });

  it('test_canary_instantiate_rebuilds_candidate：重建级校验同指纹', async () => {
    const registry = make_registry();
    const result = await make_assembler(registry).assemble(make_request(['answer']));
    const data = result.candidates[0]!.to_dict()['graph'] as Record<string, unknown>;
    const rebuilt = canary_instantiate(data, { registry });
    expect(rebuilt.digest()).toBe(result.candidates[0]!.graph.digest());
  });

  it('test_candidate_event_type_registered：组装候选事件类型注册并可判定', () => {
    const registry = new EventTypeRegistry();
    const eventSpec = assembly_candidate_event_spec();
    expect(eventSpec.name).toBe(EVENT_ASSEMBLY_CANDIDATE);
    register_path_assembly_event_types(registry);
    const registered = registry.get(EVENT_ASSEMBLY_CANDIDATE);
    expect(registered).not.toBeNull();
    expect(registered!.name).toBe(eventSpec.name);
    const verdict = registry.classify(EVENT_ASSEMBLY_CANDIDATE, {
      domain: 'code',
      ts: DUMMY_NOW,
      fingerprint: 'abc',
    });
    expect(verdict.status).toBe(EVENT_STATUS_REGISTERED);
    expect(verdict.violations).toEqual([]);
    const missing_domain = registry.classify(EVENT_ASSEMBLY_CANDIDATE, { ts: DUMMY_NOW });
    expect(missing_domain.violations.some((v) => v.includes('domain'))).toBe(true);
  });
});

/** 慢速草稿源（验证草稿层超时兜底；不重试直接转算法兜底）。 */
class SlowDraftProvider {
  calls = 0;
  readonly delayMs: number;

  constructor(delayMs: number) {
    this.delayMs = delayMs;
  }

  async draft(): Promise<string> {
    this.calls += 1;
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return '["intent_parse"]';
  }
}

// ── 覆盖说明 ──────────────────────────────────────────────────────────
// 原 defer 的执行类用例（canary 单回合试跑）已随 executor 接线回补，落位
// path_assembler_canary.test.ts：
//   test_integration_candidate_roundtrip_and_canary_run / test_canary_round_
//   rejects_broken_execution / test_canary_active_context_flag /
//   test_canary_step_budget_caps_execution / test_canary_timeout_aborts
