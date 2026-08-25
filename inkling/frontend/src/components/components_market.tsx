/**
 * 组件市场浏览入口（前端侧）：列表 + 来源信誉展示。
 *
 * 数据源：bindValue 注入市场 JSON；缺省回落内置候选清单（与
 * seed_data/components_market.json 同源）。挂载链复用既有 Artifact
 * 补丁链（本道不做壳侧）。来源信誉 = 风险档 + 维护状态双标记。
 */

import { ShieldCheck, ShieldAlert, ShieldX } from 'lucide-react';

import { cn } from '@/shared/cn';

export type ComponentRisk = 'low' | 'medium' | 'high';
export type ComponentMaintenance = 'maintained' | 'experimental' | 'deprecated';

export interface ComponentMarketEntry {
  id: string;
  name: string;
  source: string;
  version: string;
  risk: ComponentRisk;
  risk_note: string;
  artifact_url: string;
  test_manifest: { required: string[]; note: string };
  maintenance: ComponentMaintenance;
}

export interface ComponentMarket {
  premounted: boolean;
  mount_policy: { required: string[]; note: string };
  components: ComponentMarketEntry[];
}

export const COMPONENTS_MARKET_DEFAULT: ComponentMarket = {
  premounted: false,
  mount_policy: {
    required: ['vetting 静态钩子核对', '审批卡预览（可 edit 改传输/命令）', 'L2 人工审批', '补丁链挂载可回退'],
    note: '出厂零预挂：市场目录是候选清单，任何挂载都须走既有 vetting → 观察 → 审批 → 补丁链链路',
  },
  components: [
    {
      id: 'market.focus_dashboard',
      name: '专注仪表盘',
      source: '社区公开组件（示例条目）',
      version: '0.1.0',
      risk: 'low',
      risk_note: '仅本地渲染会话指标，无网络/文件系统权限；首次接入仍走观察期播报',
      artifact_url: 'https://components.inkling.dev/focus_dashboard.tar.gz',
      test_manifest: { required: ['render_smoke', 'no_network_egress'], note: '挂载前须通过冒烟与零出网两项门禁' },
      maintenance: 'maintained',
    },
    {
      id: 'market.web_clipper',
      name: '网页摘录',
      source: '社区公开组件（示例条目）',
      version: '0.2.1',
      risk: 'medium',
      risk_note: '抓取外部网页：挂载后须走网络策略域名白名单 + review 审批，摘录来源分级 web 最低',
      artifact_url: 'https://components.inkling.dev/web_clipper.tar.gz',
      test_manifest: { required: ['render_smoke', 'domain_allowlist_enforced'], note: '挂载前须通过冒烟与域名白名单强制两项门禁' },
      maintenance: 'maintained',
    },
    {
      id: 'market.fs_indexer',
      name: '文件索引器',
      source: 'MCP 官方参考实现（示例条目）',
      version: '0.3.0',
      risk: 'high',
      risk_note: '遍历工作区文件：须文件沙箱根目录限定（file_ops 权限分级 allow/review），首次越界操作强制 L2 人工审批',
      artifact_url: 'https://components.inkling.dev/fs_indexer.tar.gz',
      test_manifest: { required: ['render_smoke', 'sandbox_root_enforced', 'no_delete'], note: '挂载前须通过冒烟、沙箱根目录强制、零删除三项门禁' },
      maintenance: 'experimental',
    },
  ],
};

const RISKS: ComponentRisk[] = ['low', 'medium', 'high'];
const MAINTENANCES: ComponentMaintenance[] = ['maintained', 'experimental', 'deprecated'];

/**
 * schema 校验（仿 mcp_market 字段口径）：缺字段/类型错/枚举越界全覆盖。
 * 返回错误明细，供自检与测试断言。
 */
export function validateComponentsMarket(value: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!value || typeof value !== 'object') {
    return { ok: false, errors: ['market 应为对象'] };
  }
  const market = value as Record<string, unknown>;
  if (typeof market.premounted !== 'boolean') errors.push('premounted 应为布尔');
  const policy = market.mount_policy as Record<string, unknown> | undefined;
  if (!policy || typeof policy !== 'object') {
    errors.push('mount_policy 缺失');
  } else {
    if (!Array.isArray(policy.required)) errors.push('mount_policy.required 应为数组');
    if (typeof policy.note !== 'string') errors.push('mount_policy.note 应为字符串');
  }
  const components = market.components as unknown[] | undefined;
  if (!Array.isArray(components)) {
    errors.push('components 应为数组');
    return { ok: false, errors };
  }
  const ids = new Set<string>();
  components.forEach((entry, index) => {
    const prefix = `components[${index}]`;
    if (!entry || typeof entry !== 'object') {
      errors.push(`${prefix} 应为对象`);
      return;
    }
    const c = entry as Record<string, unknown>;
    const need = (cond: boolean, msg: string) => { if (!cond) errors.push(`${prefix}.${msg}`); };
    need(typeof c.id === 'string' && (c.id as string).length > 0, 'id 非空字符串');
    need(typeof c.name === 'string' && (c.name as string).length > 0, 'name 非空字符串');
    need(typeof c.source === 'string' && (c.source as string).length > 0, 'source 非空字符串');
    need(typeof c.version === 'string' && (c.version as string).length > 0, 'version 非空字符串');
    need(typeof c.risk === 'string' && RISKS.includes(c.risk as ComponentRisk), `risk 应为 ${RISKS.join('|')}`);
    need(typeof c.risk_note === 'string' && (c.risk_note as string).length > 0, 'risk_note 非空字符串');
    need(typeof c.artifact_url === 'string' && (c.artifact_url as string).length > 0, 'artifact_url 非空字符串');
    const manifest = c.test_manifest as Record<string, unknown> | undefined;
    if (!manifest || typeof manifest !== 'object') {
      errors.push(`${prefix}.test_manifest 缺失`);
    } else {
      need(Array.isArray(manifest.required), 'test_manifest.required 应为数组');
      need(typeof manifest.note === 'string', 'test_manifest.note 应为字符串');
    }
    need(typeof c.maintenance === 'string' && MAINTENANCES.includes(c.maintenance as ComponentMaintenance), `maintenance 应为 ${MAINTENANCES.join('|')}`);
    if (typeof c.id === 'string') {
      if (ids.has(c.id)) errors.push(`${prefix}.id 重复：${c.id}`);
      ids.add(c.id);
    }
  });
  return { ok: errors.length === 0, errors };
}

const RISK_TONE: Record<ComponentRisk, string> = {
  low: 'ink-text-muted',
  medium: 'ink-text-faint',
  high: 'ink-accent',
};

function RiskBadge({ risk }: { risk: ComponentRisk }) {
  const Icon = risk === 'high' ? ShieldX : risk === 'medium' ? ShieldAlert : ShieldCheck;
  return (
    <span className={cn('ink-chip font-mono text-[9px]', RISK_TONE[risk])} data-risk={risk}>
      <Icon size={9} strokeWidth={1.6} aria-hidden />
      {risk}
    </span>
  );
}

interface ComponentsMarketProps {
  bindValue?: unknown;
  entries?: ComponentMarketEntry[];
  /** 挂载回调（宿主接线；本道仅预览，复用既有补丁链） */
  onMount?: (id: string) => void;
}

export function ComponentsMarket({ bindValue, entries, onMount }: ComponentsMarketProps) {
  const market = (bindValue as ComponentMarket | undefined)
    ?? (entries ? { premounted: false, mount_policy: { required: [], note: '' }, components: entries } : COMPONENTS_MARKET_DEFAULT);
  const list = market.components ?? [];

  return (
    <section className="ink-panel p-4" data-ui="components_market">
      <div className="flex items-center gap-2.5">
        <span className="ink-icon-chip">
          <ShieldCheck size={12} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
        </span>
        <span className="text-[12px] font-semibold tracking-tight">组件市场</span>
        <span className="ml-auto text-[10px] ink-text-faint">{list.length} 候选组件（出厂零预挂）</span>
      </div>

      {list.length === 0 ? (
        <div className="mt-3 rounded-xl border border-dashed px-3 py-5 text-center text-[11px] ink-border ink-text-faint">
          组件市场为空（候选清单经 vetting 转正后挂载）
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {list.map((entry) => (
            <li key={entry.id} className="flex items-start gap-3" data-component={entry.id}>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-[var(--ink-font-xs)] font-medium">{entry.name}</span>
                  <span className="ink-chip font-mono text-[9px] ink-text-faint">{entry.version}</span>
                  <RiskBadge risk={entry.risk} />
                  <span className="ink-chip text-[9px] ink-text-faint" data-maintenance={entry.maintenance}>{entry.maintenance}</span>
                </span>
                <span className="mt-0.5 block truncate text-[10px] ink-text-faint">{entry.source}</span>
                <span className="mt-0.5 block text-[9px] leading-relaxed ink-text-faint">{entry.risk_note}</span>
                <span className="mt-0.5 block truncate font-mono text-[9px] ink-text-faint">{entry.artifact_url}</span>
                {entry.test_manifest?.required?.length > 0 && (
                  <span className="mt-0.5 block text-[9px] ink-text-faint">
                    门禁：{entry.test_manifest.required.join('、')}
                  </span>
                )}
              </span>
              <button
                type="button"
                data-ui={`component_mount_${entry.id}`}
                onClick={() => onMount?.(entry.id)}
                className="shrink-0 rounded-md px-2 py-1 text-[10px] ink-text-muted hover:text-[var(--ink-text-base)] cursor-pointer border border-[var(--ink-border)] bg-transparent"
              >
                挂载
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
