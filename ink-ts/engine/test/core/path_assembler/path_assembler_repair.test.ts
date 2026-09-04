/**
 * 路径组装器修复算子矩阵单测（test_path_assembler.py「修复算子」段 1:1 移植）：
 * replace_node / add_branch / remove_node / reroute_edge 各自可达性、修复驱动
 * 轮序与不可达返回 None（→ 全量重组装兜底）、ENG9a-15 预解析视图等价、ENG9a-25
 * 单个缺口补不上不整体放弃。全部为纯函数层测试（零执行器依赖）。
 */

import { describe, expect, it } from 'vitest';

import {
  add_branch,
  remove_node,
  repair_chain,
  replace_node,
  reroute_edge,
  validate_chain,
} from '../../../src/core/path_assembler/index.js';
import { _build_contract_views } from '../../../src/core/path_assembler/validate.js';
import {
  ENTRY,
  make_registry,
  pool_of,
} from './helpers.js';

describe('修复算子各算子可达性', () => {
  it('test_replace_node_replaces_unreachable_tail：不可达收尾 → 替换为等价生产者', () => {
    const pool = pool_of(make_registry());
    const chain = ['intent_parse', 'domain_router', 'web_search', 'report_assemble'];
    const [ok, reasons] = validate_chain(chain, {
      pool,
      goal_fields: ['answer'],
      entry_fields: ENTRY,
    });
    expect(ok).toBe(false);
    expect(reasons.some((r) => r.includes('输入字段不可达'))).toBe(true);
    const repaired = replace_node(chain, {
      pool,
      goal_fields: ['answer'],
      entry_fields: ENTRY,
    });
    expect(repaired).toEqual([
      'intent_parse',
      'domain_router',
      'web_search',
      'answer_direct',
    ]);
    const [okRepaired] = validate_chain(repaired!, {
      pool,
      goal_fields: ['answer'],
      entry_fields: ENTRY,
    });
    expect(okRepaired).toBe(true);
  });

  it('test_add_branch_fills_gap：qa_check 缺 tests 前置 → 补 test_gen 链', () => {
    const pool = pool_of(make_registry());
    const chain = ['intent_parse', 'domain_router', 'code_gen', 'qa_check'];
    const repaired = add_branch(chain, {
      pool,
      goal_fields: ['quality_report'],
      entry_fields: ENTRY,
    });
    expect(repaired).toEqual([
      'intent_parse',
      'domain_router',
      'code_gen',
      'test_gen',
      'qa_check',
    ]);
    const [ok] = validate_chain(repaired!, {
      pool,
      goal_fields: ['quality_report'],
      entry_fields: ENTRY,
    });
    expect(ok).toBe(true);
  });

  it('test_add_branch_appends_goal_producer：目标缺口 → 链尾追加；无法生产 = None', () => {
    const pool = pool_of(make_registry());
    const chain = ['intent_parse', 'domain_router', 'web_search'];
    const repaired = add_branch(chain, {
      pool,
      goal_fields: ['answer'],
      entry_fields: ENTRY,
    });
    expect(repaired).toEqual([
      'intent_parse',
      'domain_router',
      'web_search',
      'answer_direct',
    ]);
    const missing_pool = {
      intent_parse: pool['intent_parse']!,
      domain_router: pool['domain_router']!,
    };
    expect(
      add_branch(chain, { pool: missing_pool, goal_fields: ['answer'], entry_fields: ENTRY }),
    ).toBeNull();
  });

  it('test_remove_node_prunes_redundant_tail：冗余尾结点删除', () => {
    const pool = pool_of(make_registry());
    const chain = [
      'intent_parse',
      'domain_router',
      'code_gen',
      'test_gen',
      'qa_check',
      'web_search',
    ];
    const [ok] = validate_chain(chain, {
      pool,
      goal_fields: ['quality_report'],
      entry_fields: ENTRY,
    });
    expect(ok).toBe(true);
    const repaired = remove_node(chain, {
      pool,
      goal_fields: ['quality_report'],
      entry_fields: ENTRY,
    });
    expect(repaired).toEqual([
      'intent_parse',
      'domain_router',
      'code_gen',
      'test_gen',
      'qa_check',
    ]);
  });

  it('test_reroute_edge_reorders_producer_before_consumer：生产者后置 → 移动结点', () => {
    const pool = pool_of(make_registry());
    const chain = ['intent_parse', 'domain_router', 'test_gen', 'code_gen'];
    const [ok] = validate_chain(chain, {
      pool,
      goal_fields: ['tests'],
      entry_fields: ENTRY,
    });
    expect(ok).toBe(false);
    const repaired = reroute_edge(chain, {
      pool,
      goal_fields: ['tests'],
      entry_fields: ENTRY,
    });
    expect(repaired).toEqual([
      'intent_parse',
      'domain_router',
      'code_gen',
      'test_gen',
    ]);
    const [okRepaired] = validate_chain(repaired!, {
      pool,
      goal_fields: ['tests'],
      entry_fields: ENTRY,
    });
    expect(okRepaired).toBe(true);
  });
});

describe('修复驱动', () => {
  it('test_repair_driver_fixes_and_keeps_valid：不可达 → 修复到合法；已合法 = 原样返回', () => {
    const pool = pool_of(make_registry());
    const broken = ['intent_parse', 'domain_router', 'web_search', 'report_assemble'];
    const fixed = repair_chain(broken, { pool, goal_fields: ['answer'], entry_fields: ENTRY });
    expect(fixed).toEqual([
      'intent_parse',
      'domain_router',
      'web_search',
      'answer_direct',
    ]);
    const valid = ['intent_parse', 'domain_router', 'web_search', 'answer_direct'];
    expect(repair_chain(valid, { pool, goal_fields: ['answer'], entry_fields: ENTRY })).toEqual(
      valid,
    );
  });

  it('test_repair_driver_unfixable_returns_none：修复也不可达 → None', () => {
    const pool = pool_of(make_registry());
    const broken = ['intent_parse', 'bogus_node', 'answer_direct'];
    expect(repair_chain(broken, { pool, goal_fields: ['answer'], entry_fields: ENTRY })).toBeNull();
  });
});

describe('契约视图 / 补链缺口推进（ENG9a 回归）', () => {
  it('test_validate_chain_with_prebuilt_views_matches：预解析视图校验与按池现建同语义', () => {
    const pool = pool_of(make_registry());
    const views = _build_contract_views(pool);
    const chain = ['intent_parse', 'domain_router', 'web_search', 'answer_direct'];
    const [okDirect, reasonsDirect] = validate_chain(chain, {
      pool,
      goal_fields: ['answer'],
      entry_fields: ENTRY,
    });
    const [okViews, reasonsViews] = validate_chain(chain, {
      pool,
      goal_fields: ['answer'],
      entry_fields: ENTRY,
      views,
    });
    expect(okDirect).toBe(okViews);
    expect(reasonsDirect).toEqual(reasonsViews);
    const broken = ['intent_parse', 'domain_router', 'web_search', 'report_assemble'];
    expect(
      repair_chain(broken, { pool, goal_fields: ['answer'], entry_fields: ENTRY, views }),
    ).toEqual(['intent_parse', 'domain_router', 'web_search', 'answer_direct']);
  });

  it('test_add_branch_continues_to_next_gap：单个缺口补不上不整体放弃（ENG9a-25）', () => {
    const pool = pool_of(make_registry());
    const chain = ['intent_parse', 'domain_router', 'web_search'];
    const repaired = add_branch(chain, {
      pool,
      goal_fields: ['answer'],
      entry_fields: ENTRY,
    });
    expect(repaired).toEqual([
      'intent_parse',
      'domain_router',
      'web_search',
      'answer_direct',
    ]);
    const missing_pool = {
      intent_parse: pool['intent_parse']!,
      domain_router: pool['domain_router']!,
      web_search: pool['web_search']!,
    };
    expect(
      add_branch(chain, {
        pool: missing_pool,
        goal_fields: ['answer'],
        entry_fields: ENTRY,
      }),
    ).toBeNull();
  });
});

// ── defer 说明 ──────────────────────────────────────────────────────────
// 本文件全部为纯函数算子/视图层测试（零执行器依赖），无 defer 项；依赖
// executor 的引擎执行类用例见 unit/draft/runtime 测试文件尾注。
