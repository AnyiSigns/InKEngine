/**
 * 孵化面板：知识集演化视图 + 演化收敛指标 + 种子沉淀池。
 *
 * 数据源均为只读观察通道：知识条目（/api/self/knowledge）、演化指标
 * 与冷却状态（/api/self/evolution）、沉淀种子清单（/api/self/seeds）。
 * 条目写入走补丁链管线（唯一写入路径），面板侧只读——孵化沉淀由
 * 引擎在回合尾自动进行（行为信号 → 蒸馏 → 知识条目），无需人工采纳。
 */

import { useEffect, useState } from 'react';
import { FlaskConical } from 'lucide-react';

import { fetchJson } from '@/shared/api';

interface KnowledgeEntryView {
  id: string;
  kind: string;
  level: string;
  title: string;
  tags: string[];
  credibility: number;
  usage_count: number;
}

interface KnowledgeSnapshot {
  entries: KnowledgeEntryView[];
  count: number;
  by_kind: Record<string, number>;
  by_level: Record<string, number>;
}

interface TargetStat {
  target: string;
  rewrites: number;
  rejections: number;
  reverts: number;
}

interface EvolutionSnapshot {
  metrics: {
    proposals: number;
    applied: number;
    rejected: number;
    conflicts: number;
    invalid: number;
    reverts: number;
    adoption_ratio: number;
    revert_rate: number;
    incubation: number;
    targets: TargetStat[];
  };
  cooldowns: {
    target: string;
    state: 'cooldown' | 'frozen';
    until: number;
    cooldown_count: number;
  }[];
  incubation: {
    event: string;
    created_at: number;
    entry?: string;
    query?: string;
  }[];
}

interface SeedView {
  name: string;
  description: string;
  format: string;
  source_set: string;
  harvested_at: number;
  knowledge_count: number;
  note: string;
}

const KIND_LABELS: Record<string, string> = {
  rule: '规则',
  template: '模板',
  weight: '参数',
  knowledge: '知识',
};

const COOLDOWN_LABELS: Record<string, string> = {
  cooldown: '冷却中',
  frozen: '已冻结',
};

const INCUBATION_LABELS: Record<string, string> = {
  applied: '沉淀落地',
  reuse: '复用命中',
  unchanged: '内容不变',
  skipped: '未达阈值',
  none: '无可沉淀',
  rejected: '沉淀被拒',
  conflict: '基准冲突',
};

function percent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

export function IncubatorPanel() {
  const [snapshot, setSnapshot] = useState<KnowledgeSnapshot | null>(null);
  const [evolution, setEvolution] = useState<EvolutionSnapshot | null>(null);
  const [seeds, setSeeds] = useState<SeedView[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void Promise.all([
      fetchJson<KnowledgeSnapshot>('/api/self/knowledge'),
      fetchJson<EvolutionSnapshot>('/api/self/evolution'),
      fetchJson<{ seeds: SeedView[] }>('/api/self/seeds'),
    ])
      .then(([knowledge, evolutionData, seedsData]) => {
        setSnapshot(knowledge);
        setEvolution(evolutionData);
        setSeeds(seedsData.seeds);
      })
      .catch(() => setFailed(true));
  }, []);

  if (failed) {
    return (
      <div className="rounded-md border border-dashed border-destructive/25 px-4 py-6 text-center text-[11px] text-destructive/60">
        孵化视图读取失败（观察通道不可用）
      </div>
    );
  }
  if (!snapshot || !evolution) {
    return (
      <div className="rounded-md border border-dashed border-foreground/15 px-4 py-6 text-center text-[11px] text-muted-foreground/50">
        孵化视图加载中…
      </div>
    );
  }

  const kinds = Object.entries(snapshot.by_kind).sort(([a], [b]) => a.localeCompare(b));
  const { metrics, cooldowns, incubation } = evolution;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <FlaskConical size={12} strokeWidth={1.6} className="text-violet-500/80" />
        <span className="text-[11px] font-medium text-foreground/60">知识集孵化</span>
        <span className="ml-auto text-[10px] text-foreground/30 tabular-nums">
          {snapshot.count} 条
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {kinds.map(([kind, count]) => (
          <span
            key={kind}
            className="rounded-full border border-foreground/10 px-2 py-0.5 text-[10px] text-muted-foreground/70"
          >
            {KIND_LABELS[kind] || kind} {count}
          </span>
        ))}
        {Object.entries(snapshot.by_level).map(([level, count]) => (
          <span
            key={level}
            className="rounded-full border border-violet-500/25 px-2 py-0.5 text-[10px] text-violet-500/80"
          >
            {level} {count}
          </span>
        ))}
      </div>

      {/* 演化收敛指标：回退率/采纳比/孵化沉淀，越用越进化的量化视图 */}
      <div className="rounded-md border border-foreground/[0.08] bg-foreground/[0.03] px-3 py-2">
        <div className="text-[10px] font-medium text-foreground/60">演化收敛指标</div>
        <div className="mt-1.5 grid grid-cols-4 gap-1 text-center">
          <div className="rounded bg-background/60 px-1 py-1">
            <div className="text-[11px] font-medium text-foreground/80 tabular-nums">
              {metrics.proposals}
            </div>
            <div className="text-[9px] text-foreground/40">提案</div>
          </div>
          <div className="rounded bg-background/60 px-1 py-1">
            <div className="text-[11px] font-medium text-emerald-500/80 tabular-nums">
              {percent(metrics.adoption_ratio)}
            </div>
            <div className="text-[9px] text-foreground/40">采纳率</div>
          </div>
          <div className="rounded bg-background/60 px-1 py-1">
            <div className="text-[11px] font-medium text-amber-500/80 tabular-nums">
              {percent(metrics.revert_rate)}
            </div>
            <div className="text-[9px] text-foreground/40">回退率</div>
          </div>
          <div className="rounded bg-background/60 px-1 py-1">
            <div className="text-[11px] font-medium text-violet-500/80 tabular-nums">
              {metrics.incubation}
            </div>
            <div className="text-[9px] text-foreground/40">孵化沉淀</div>
          </div>
        </div>
        {metrics.targets.length > 0 && (
          <div className="mt-1.5 space-y-1">
            {metrics.targets.map((target) => (
              <div
                key={target.target}
                className="flex items-center gap-1.5 text-[9px] text-foreground/45"
              >
                <span className="truncate font-mono">{target.target}</span>
                <span className="ml-auto shrink-0 tabular-nums">
                  改 {target.rewrites} · 拒 {target.rejections} · 退 {target.reverts}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 冷却/冻结状态：同目标反复折腾时的收敛管制视图 */}
      {cooldowns.length > 0 && (
        <div className="rounded-md border border-amber-500/20 bg-amber-500/[0.04] px-3 py-2">
          <div className="text-[10px] font-medium text-amber-500/80">演化收敛管制</div>
          <div className="mt-1.5 space-y-1">
            {cooldowns.map((state) => (
              <div key={state.target} className="flex items-center gap-1.5 text-[9px] text-foreground/50">
                <span className="rounded bg-amber-500/15 px-1 py-px text-[9px] text-amber-500/80">
                  {COOLDOWN_LABELS[state.state] || state.state}
                </span>
                <span className="truncate font-mono">{state.target}</span>
                <span className="ml-auto shrink-0 tabular-nums">
                  {new Date(state.until * 1000).toLocaleTimeString()} 恢复
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 孵化留痕：最近沉淀日志（行为信号 → 蒸馏的直观反馈） */}
      {incubation.length > 0 && (
        <div className="rounded-md border border-foreground/[0.08] px-3 py-2">
          <div className="text-[10px] font-medium text-foreground/60">最近孵化</div>
          <div className="mt-1.5 space-y-1">
            {incubation.map((item, index) => (
              <div key={`${item.created_at}-${index}`} className="flex items-center gap-1.5 text-[9px] text-foreground/45">
                <span className="rounded bg-violet-500/15 px-1 py-px text-[9px] text-violet-500/80">
                  {INCUBATION_LABELS[item.event] || item.event}
                </span>
                <span className="truncate">{item.query || item.entry || ''}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {snapshot.entries.length === 0 ? (
        <div className="rounded-md border border-dashed border-foreground/15 px-3 py-4 text-center text-[11px] text-muted-foreground/50">
          知识集为空（通用种子注入后即含基线条目）
        </div>
      ) : (
        <div className="space-y-1.5">
          {snapshot.entries.map((entry) => (
            <div
              key={entry.id}
              className="rounded-md border border-foreground/[0.08] bg-foreground/[0.03] px-2.5 py-1.5"
            >
              <div className="flex items-center gap-2">
                <span className="rounded bg-violet-500/15 px-1 py-px text-[9px] text-violet-500/80 font-mono">
                  {entry.kind}
                </span>
                <span className="truncate text-[11px] text-foreground/80">{entry.title}</span>
                <span className="ml-auto shrink-0 text-[9px] text-foreground/30 font-mono">
                  {entry.id}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <span className="text-[9px] text-foreground/35">
                  可信度 {entry.credibility.toFixed(2)} · 已用 {entry.usage_count} 次
                </span>
                {entry.tags.map((tag) => (
                  <span key={tag} className="rounded bg-foreground/10 px-1 py-px text-[9px] text-foreground/45">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 沉淀种子池：集内成熟形态的导出物（活的变死，死催活） */}
      <div className="rounded-md border border-violet-500/20 bg-violet-500/[0.04] px-3 py-2">
        <div className="text-[10px] font-medium text-violet-500/80">种子沉淀池</div>
        {!seeds || seeds.length === 0 ? (
          <div className="mt-1.5 text-[10px] text-muted-foreground/40">
            暂无沉淀种子（AI 可经 harvest_seed 工具把成熟领域形态沉淀为共享种子）
          </div>
        ) : (
          <div className="mt-1.5 space-y-1.5">
            {seeds.map((seed) => (
              <div
                key={seed.name}
                className="rounded-md border border-violet-500/15 bg-background/60 px-2.5 py-1.5"
              >
                <div className="flex items-center gap-2">
                  <span className="rounded bg-violet-500/15 px-1 py-px text-[9px] text-violet-500/80 font-mono">
                    seed
                  </span>
                  <span className="truncate text-[11px] text-foreground/80">{seed.name}</span>
                  <span className="ml-auto shrink-0 text-[9px] text-foreground/35 tabular-nums">
                    {seed.knowledge_count} 条知识 · {new Date(seed.harvested_at * 1000).toLocaleDateString()}
                  </span>
                </div>
                <div className="mt-0.5 truncate text-[9px] text-foreground/45">
                  {seed.description || seed.note || '（无描述）'}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
