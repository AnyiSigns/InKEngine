import { useEffect, useState } from 'react';
import { Eye, GitBranch, Play, ShieldCheck, TriangleAlert } from 'lucide-react';

import { DagRenderer } from '@/app/dag';
import type { ArchitectureBackend, PatchDiff, ValidationResult, WorkflowTemplate } from '../backend';
import { Button } from '@/shared/ui/Button';

/** 模板 tab：workflow 清单 → 选一条 → DAG 编辑 → 结构校验 → canary 试跑 → 落链/回退。
 *  落链=参考（路由倾向走它，非锁定）。 */
export function TemplateTab({ backend }: { backend: ArchitectureBackend }) {
  const [templates, setTemplates] = useState<WorkflowTemplate[] | null>(null);
  const [selected, setSelected] = useState<WorkflowTemplate | null>(null);
  const [constraints, setConstraints] = useState<string[]>([]);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [canary, setCanary] = useState<{ passed: boolean; text: string } | null>(null);
  const [applied, setApplied] = useState<{ appliedAt: number; text: string } | null>(null);
  const [diff, setDiff] = useState<PatchDiff | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const load = async () => {
    const t = await backend.fetchWorkflowTemplates();
    setTemplates(t);
    if (t && t.length) {
      setSelected((prev) => {
        if (prev) return prev;
        setConstraints(t[0].constraintDomain);
        return t[0];
      });
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend]);

  if (templates === null) {
    return <div className="w3-muted" data-testid="tpl-loading">加载模板…</div>;
  }
  if (templates.length === 0) {
    return (
      <div className="w3-empty" data-testid="w3-empty">
        <GitBranch strokeWidth={1.5} />
        <div className="w3-empty-text">暂无可用模板</div>
      </div>
    );
  }

  function toggleConstraint(c: string) {
    setConstraints((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
    setValidation(null);
  }

  async function onValidate() {
    if (!selected) return;
    const result = await backend.validateTemplate({ ...selected, constraintDomain: constraints });
    setValidation(result);
    setCanary(null);
    setApplied(null);
  }

  async function onCanary() {
    if (!selected) return;
    const receipt = await backend.runCanary({ ...selected, constraintDomain: constraints });
    setCanary(receipt);
  }

  async function onApply() {
    if (!selected) return;
    const diffData = await backend.fetchPatchDiff(selected);
    setDiff(diffData);
    const result = await backend.applyTemplate(selected);
    setApplied(result);
  }

  return (
    <div className="w3-stack">
      <div className="w3-panel">
        <div className="w3-panel-title">
          <GitBranch size={14} strokeWidth={1.5} /> 模板清单
        </div>
        {templates.map((t) => (
          <div
            key={t.id}
            className="w3-row-item"
            data-testid={`tpl-row-${t.id}`}
            data-selected={selected?.id === t.id}
            onClick={() => {
              setSelected(t);
              setConstraints(t.constraintDomain);
              setValidation(null);
              setCanary(null);
              setApplied(null);
              setDiff(null);
            }}
          >
            <div className="w3-grow">
              <div className="w3-truncate">{t.name}</div>
              <div className="w3-muted w3-truncate">{t.description}</div>
            </div>
          </div>
        ))}
      </div>

      {selected && (
        <div className="w3-panel">
          <div className="w3-panel-title">
            <ShieldCheck size={14} strokeWidth={1.5} /> 编辑主对象：{selected.name}
          </div>
          <div className="w3-row">
            <span className="w3-muted">约束域</span>
            {selected.constraintDomain.map((c) => (
              <button
                key={c}
                type="button"
                className={`w3-chip ${constraints.includes(c) ? '' : 'w3-chip--off'}`}
                data-testid={`constraint-${c}`}
                data-active={constraints.includes(c)}
                onClick={() => toggleConstraint(c)}
              >
                {c}
              </button>
            ))}
          </div>

          <div className="w3-row" style={{ height: 280, marginTop: 12 }}>
            <DagRenderer graph={selected.graph} collapsedGroups={collapsed} onToggleGroup={(g) => setCollapsed((p) => ({ ...p, [g]: !p[g] }))} ariaLabel={`${selected.name} 结构图`} />
          </div>

          <div className="w3-row" style={{ marginTop: 12 }}>
            <Button variant="secondary" onClick={onValidate} data-testid="tpl-validate">
              校验
            </Button>
            <Button variant="secondary" onClick={onCanary} data-testid="tpl-canary">
              <Play size={14} strokeWidth={1.5} /> 试跑
            </Button>
            <Button variant="primary" onClick={onApply} data-testid="tpl-apply">
              落链
            </Button>
            {diff && (
              <Button variant="ghost" onClick={() => undefined} data-testid="tpl-view-diff">
                <Eye size={14} strokeWidth={1.5} /> 查看 diff
              </Button>
            )}
          </div>

          {validation && !validation.ok && (
            <div className="w3-error-line" data-testid="tpl-validation-error" role="alert">
              {validation.error}（建议改模板 / 路由重选）
            </div>
          )}
          {validation && validation.ok && (
            <div className="w3-badge w3-badge--ok" data-testid="tpl-validation-ok">
              结构校验通过
            </div>
          )}

          {canary && (
            <div className="w3-receipt" data-testid="tpl-canary-receipt">
              {canary.text}
            </div>
          )}

          {applied && (
            <div className="w3-receipt" data-testid="tpl-applied" data-reference="true">
              {applied.text}
            </div>
          )}

          {diff && (
            <div className="w3-diff" data-testid="tpl-diff">
              <div className="w3-muted" style={{ padding: '4px 12px' }}>
                {diff.title}
              </div>
              {diff.lines.map((l, i) => (
                <div key={i} className={`w3-diff-line w3-diff-${l.op}`} data-op={l.op}>
                  {l.text}
                </div>
              ))}
            </div>
          )}

          {!applied && validation?.ok && (
            <div className="w3-muted" style={{ marginTop: 8 }}>
              落链后路由按任务实时选链，本模板为高权重偏好（非强制）。
            </div>
          )}
        </div>
      )}

      <div className="w3-muted" style={{ display: 'none' }}>
        <TriangleAlert /> 约束失败提示位
      </div>
    </div>
  );
}
