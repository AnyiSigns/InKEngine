/**
 * 组装路径 DAG：本次任务路径图形化（节点=结点/工具/事件，边=组装关系，
 * 汇流点高亮 junction）。
 *
 * 消费事件流：assembly_candidate（候选链 → 节点与边）、junction_verdict
 * （胜出分支 → 汇流点高亮）、plan_start（根节点）。实时随事件更新，
 * 复用通道中枢订阅（不另起通道）。缺字段降级收敛，不崩。
 */

import { useEffect, useState } from 'react';

import type { ChannelHub, HubEvent } from '@/shared/session/channelHub';
import type { EventTypeName } from '@/shared/session/eventTypes';
import { getBindSource } from '@/renderer/bindSource';

interface DagNode {
  id: string;
  label: string;
  kind: 'node' | 'tool' | 'junction' | 'plan';
  junction: boolean;
}

interface DagEdge {
  from: string;
  to: string;
}

interface DagModel {
  nodes: Record<string, DagNode>;
  edges: DagEdge[];
  order: string[];
}

function emptyDag(): DagModel {
  return { nodes: {}, edges: [], order: [] };
}

function applyCandidate(model: DagModel, payload: Record<string, unknown>): DagModel {
  const candidates = Array.isArray(payload.candidates) ? (payload.candidates as Array<Record<string, unknown>>) : [];
  const nodes = { ...model.nodes };
  const order = [...model.order];
  const edges = [...model.edges];
  for (const candidate of candidates) {
    const chain = Array.isArray(candidate.chain) ? (candidate.chain as string[]) : [];
    let prev: string | null = null;
    for (const id of chain) {
      if (!nodes[id]) {
        nodes[id] = { id, label: id, kind: 'node', junction: false };
        order.push(id);
      }
      if (prev) {
        const exists = edges.some((e) => e.from === prev && e.to === id);
        if (!exists) edges.push({ from: prev, to: id });
      }
      prev = id;
    }
  }
  return { nodes, edges, order };
}

function applyJunction(model: DagModel, payload: Record<string, unknown>): DagModel {
  const winner = typeof payload.winner === 'string' ? payload.winner : '';
  const nodes = { ...model.nodes };
  if (winner && nodes[winner]) {
    nodes[winner] = { ...nodes[winner], kind: 'junction', junction: true };
  }
  return { ...model, nodes };
}

function applyPlan(model: DagModel, payload: Record<string, unknown>): DagModel {
  const id = 'plan';
  const label = typeof payload.workflow === 'string' ? payload.workflow : '规划';
  if (nodesHas(model, id)) return model;
  return {
    nodes: { ...model.nodes, [id]: { id, label, kind: 'plan', junction: false } },
    edges: model.edges,
    order: [id, ...model.order],
  };
}

function nodesHas(model: DagModel, id: string): boolean {
  return Object.prototype.hasOwnProperty.call(model.nodes, id);
}

/** 组装路径 DAG（实时事件流驱动；汇流点高亮）。 */
export function PathDag({ hub: hubProp }: { hub?: ChannelHub }) {
  const contextHub = getBindSource()?.hub ?? null;
  const hub = hubProp ?? contextHub;
  const [model, setModel] = useState<DagModel>(emptyDag());

  useEffect(() => {
    if (!hub) return;
    const asEvent = (s: string) => s as EventTypeName;
    const offs: Array<() => void> = [];
    offs.push(
      hub.onEvent(asEvent('assembly_candidate'), (event: HubEvent) => {
        setModel((m) => applyCandidate(m, (event.payload ?? {}) as Record<string, unknown>));
      }),
    );
    offs.push(
      hub.onEvent(asEvent('junction_verdict'), (event: HubEvent) => {
        setModel((m) => applyJunction(m, (event.payload ?? {}) as Record<string, unknown>));
      }),
    );
    offs.push(
      hub.onEvent(asEvent('plan_start'), (event: HubEvent) => {
        setModel((m) => applyPlan(m, (event.payload ?? {}) as Record<string, unknown>));
      }),
    );
    return () => {
      for (const off of offs) off();
    };
  }, [hub]);

  const nodes = model.order.map((id) => model.nodes[id]).filter(Boolean);

  return (
    <section className="ink-panel p-3" data-ui="path_dag">
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-semibold tracking-tight">组装路径</span>
        <span className="ml-auto text-[10px] ink-text-faint">
          节点 {nodes.length} · 边 {model.edges.length}
        </span>
      </div>

      {nodes.length === 0 ? (
        <div className="mt-2 text-[11px] ink-text-faint">暂无路径（assembly_candidate 到达后实时绘制）</div>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {nodes.map((node) => (
              <span
                key={node.id}
                data-ui="dag_node"
                data-id={node.id}
                data-junction={node.junction ? 'true' : 'false'}
                className={
                  node.junction
                    ? 'rounded-md border ink-accent-border px-2 py-0.5 text-[10px] ink-accent'
                    : 'rounded-md border ink-border px-2 py-0.5 text-[10px] ink-text-base'
                }
              >
                {node.label}
              </span>
            ))}
          </div>
          {model.edges.length > 0 ? (
            <div className="mt-2 space-y-0.5">
              {model.edges.map((edge, index) => (
                <div key={index} data-ui="dag_edge" className="text-[10px] ink-text-faint">
                  {edge.from} → {edge.to}
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
