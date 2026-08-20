/**
 * 孵化面板：知识集演化视图（CRUD 壳）。
 *
 * 展示集内知识条目（概览 + 按种类/层级统计），数据源为观察通道
 * （/api/self/knowledge，与 inspect_knowledge 内省同源）；条目写入
 * 走补丁链管线（唯一写入路径），面板侧只读。候选知识区列出未被
 * 引用的条目（候选形态：待确认沉淀），采纳/拒绝按钮在审批通道
 * 接入前保持禁用——面板只读展示，不伪造审批动作。
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

const KIND_LABELS: Record<string, string> = {
  rule: '规则',
  template: '模板',
  weight: '参数',
  knowledge: '知识',
};

export function IncubatorPanel() {
  const [snapshot, setSnapshot] = useState<KnowledgeSnapshot | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void fetchJson<KnowledgeSnapshot>('/api/self/knowledge')
      .then(setSnapshot)
      .catch(() => setFailed(true));
  }, []);

  if (failed) {
    return (
      <div className="rounded-md border border-dashed border-destructive/25 px-4 py-6 text-center text-[11px] text-destructive/60">
        知识集读取失败（观察通道不可用）
      </div>
    );
  }
  if (!snapshot) {
    return (
      <div className="rounded-md border border-dashed border-foreground/15 px-4 py-6 text-center text-[11px] text-muted-foreground/50">
        知识集加载中…
      </div>
    );
  }

  const kinds = Object.entries(snapshot.by_kind).sort(([a], [b]) => a.localeCompare(b));
  const candidates = snapshot.entries
    .filter((entry) => entry.usage_count === 0)
    .slice(0, 5);

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

      <div className="rounded-md border border-violet-500/20 bg-violet-500/[0.04] px-3 py-2">
        <div className="text-[10px] font-medium text-violet-500/80">候选知识（未被引用的条目，待确认沉淀）</div>
        {candidates.length === 0 ? (
          <div className="mt-1.5 text-[10px] text-muted-foreground/40">
            暂无候选（知识条目被引用后即出列）
          </div>
        ) : (
          <div className="mt-1.5 space-y-1.5">
            {candidates.map((entry) => (
              <div
                key={entry.id}
                className="rounded-md border border-violet-500/15 bg-background/60 px-2.5 py-1.5"
              >
                <div className="flex items-center gap-2">
                  <span className="rounded bg-violet-500/15 px-1 py-px text-[9px] text-violet-500/80 font-mono">
                    {entry.kind}
                  </span>
                  <span className="truncate text-[11px] text-foreground/80">{entry.title}</span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-[9px] text-foreground/35">
                    可信度 {entry.credibility.toFixed(2)} · 未被引用
                  </span>
                  {entry.tags.slice(0, 3).map((tag) => (
                    <span key={tag} className="rounded bg-foreground/10 px-1 py-px text-[9px] text-foreground/45">
                      {tag}
                    </span>
                  ))}
                  <span className="ml-auto flex gap-1">
                    <button
                      disabled
                      title="采纳（审批通道接入后可用）"
                      className="rounded border border-foreground/10 px-1.5 py-px text-[9px] text-foreground/30 cursor-not-allowed"
                    >
                      采纳
                    </button>
                    <button
                      disabled
                      title="拒绝（审批通道接入后可用）"
                      className="rounded border border-foreground/10 px-1.5 py-px text-[9px] text-foreground/30 cursor-not-allowed"
                    >
                      拒绝
                    </button>
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
