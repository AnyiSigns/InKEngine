/**
 * 跨层消费一致性契约（W1）：web 现役命令面（BackendAdapter serve 映射）必须
 * 落在宿主方法面（BRIDGE_METHODS ∪ cli legacy_aliases）内——杜绝回归 -32601。
 *
 * 清单纪律（AGENTS 纪律 3 + CODING §9）：宿主侧允许面清单不再手抄——由
 * seed_data/web_command_surface.json 夹具承载（生成源 = @ink-ts/host
 * BRIDGE_METHODS + cli legacyAliasTable()，见 self_check/scripts/
 * sync_web_command_surface.ts，宿主侧增删方法/别名后重跑生成）。本文件只
 * 维护 web 侧现役命令面（被测主体）与负向兜底清单（删除命令不复现）。
 */

import { describe, expect, it } from 'vitest';

import surface from '../../../../seed_data/web_command_surface.json';

/** host bridge 点分方法表（@ink-ts/host BRIDGE_METHODS 生成快照）。 */
const BRIDGE_METHODS = (surface as { bridge_methods: string[] }).bridge_methods;

/** cli 扁平旧名别名面（hosts/cli/src/legacy_aliases.ts legacyAliasTable 生成快照）。 */
const LEGACY_ALIASES = (surface as { legacy_alias_flats: string[] }).legacy_alias_flats;

/**
 * web 现役 serve 命令面（shared/backend/backendAdapter.ts createServeBackend 映射）。
 * W1 收敛后不含：shell_open_path、offline、backend_status/engine_boot/first_run_dismiss、
 * approval_request|resolve、round_ledger_merge、mcp_market_preview|add|remove、
 * memory.update_frontmatter、knowledge 写类、ui_spec、path/cache 干预；
 * R8 后不含 tools_snapshot / graph.snapshot（tools.full / graph.instance 仍在）。
 */
const WEB_SERVE_COMMANDS = [
  'round_send', 'round_abort', 'round_resume', 'route_plan',
  'execution.run',
  'session_list', 'session_create', 'session_rename', 'session_delete',
  'session_refresh', 'session_messages', 'session_tree', 'session_branch',
  'workspace.state', 'workspace.set', 'workspace.revoke', 'workspace.mount.add',
  'capability_get', 'capability_put', 'security_tier_overrides_set',
  'backup_export', 'backup_preview', 'backup.restore',
  'recovery_snapshots', 'recovery_restore_snapshot', 'recovery.reset',
  'rounds.todos',
  'tools.full', 'tools_baseline_get', 'tools_baseline_set',
  'ui_components.get', 'ui_components.set_disabled',
  'mcp.status', 'mcp.enable', 'mcp.disable',
  'model_archive.snapshot', 'metrics.snapshot', 'assemble.stats',
  'graph.instance',
  'pool.snapshot', 'pool.evaluate', 'entities.snapshot', 'edge_evidence.list',
  'cache.stats',
  'model.reload', 'search_keys_put', 'growth.report',
  'models_refresh', 'models_config_get', 'models_config_put', 'models.config.role_pick',
  'dialog.open_directory',
  'knowledge.list', 'knowledge.graph', 'knowledge.export',
  'memory.list', 'memory.invalidate',
  'audit.list',
] as const;

/** 回归负向清单：不提供命令不应出现在 web 现役面。 */
const REMOVED_WEB_COMMANDS = [
  'shell_open_path', 'offline_settings_get', 'offline_settings_put', 'offline_detect',
  'backend_status', 'engine_boot', 'first_run_dismiss',
  'approval_request', 'approval_resolve',
  'round_ledger_list', 'round_ledger_merge', 'mcp_market_status', 'mcp_market_mount', 'mcp_market_unmount',
  'mcp_market_preview', 'mcp_market_add', 'mcp_market_remove',
  'mcp.market', 'mcp.mount', 'mcp.unmount',
  'memory.update_frontmatter',
  'knowledge.add', 'knowledge.promote', 'knowledge.archive', 'knowledge.restore',
  'knowledge.skill_import', 'knowledge.skill_reimport',
  'path_assemble', 'path_choose_candidate', 'path_set_multipath', 'path_set_assembler_enabled',
  'path_clear_candidate', 'cache_clear', 'cache_invalidate', 'cache_rebuild',
  'edge_evidence_update', 'edge_downgrade_tier', 'edge_restore_tier',
  'ui_spec.get', 'ui_spec.apply', 'ui_spec.revert_latest',
  'components_manifest',
  'tools_snapshot', 'graph_snapshot',
] as const;

const ALLOWED = new Set<string>([...BRIDGE_METHODS, ...LEGACY_ALIASES]);

describe('命令面跨层契约（web 调用 ⊆ 宿主 fixture 允许面）', () => {
  it('web 现役命令面全部落在宿主允许方法面内（不回归 -32601）', () => {
    const unknown = WEB_SERVE_COMMANDS.filter((cmd) => !ALLOWED.has(cmd));
    expect(unknown).toEqual([]);
  });

  it('web 现役命令面与清单无重复、无排序漂移依赖', () => {
    expect(new Set(WEB_SERVE_COMMANDS).size).toBe(WEB_SERVE_COMMANDS.length);
  });

  it('已删除命令不在现役面（K2/K6/R8 收敛负向）', () => {
    const leaked = REMOVED_WEB_COMMANDS.filter((cmd) =>
      (WEB_SERVE_COMMANDS as readonly string[]).includes(cmd),
    );
    expect(leaked).toEqual([]);
  });

  it('fixture 允许面本身覆盖全部现役命令（防宿主侧维护遗漏）', () => {
    expect(ALLOWED.has('rounds.send')).toBe(true);
    expect(ALLOWED.has('round_send')).toBe(true);
    expect(ALLOWED.has('session_messages')).toBe(true);
    expect(ALLOWED.has('audit.list')).toBe(true);
    expect(ALLOWED.has('recovery.reset')).toBe(true);
    expect(ALLOWED.has('backup.restore')).toBe(true);
    expect(ALLOWED.has('tools.full')).toBe(true);
    expect(ALLOWED.has('graph.instance')).toBe(true);
  });
});
