import { FlaskConical, Droplets, DoorOpen } from 'lucide-react';

import type { GateVerdict, IncubationState, SignalType } from './backend';
import { SIGNAL_LABEL } from './backend';

const VERDICT_BADGE: Record<GateVerdict, { cls: string; label: string }> = {
  pass: { cls: 'w3-badge--ok', label: '通过' },
  neutral: { cls: 'w3-badge--neutral', label: '观察中' },
  fail: { cls: 'w3-badge--warn', label: '未通过' },
};

/** 孵化三段横向进度条（信号→蒸馏→闸门）。 */
export function IncubationPanel({
  state,
  onOpenSignal,
}: {
  state: IncubationState;
  onOpenSignal: (type: SignalType) => void;
}) {
  const verdict = VERDICT_BADGE[state.gate.verdict];
  return (
    <div className="w3-incubation" data-testid="incubation">
      <div className="w3-stage">
        <div className="w3-stage-head">
          <span>
            <Droplets size={14} strokeWidth={1.5} /> 信号
          </span>
        </div>
        <div className="w3-row" style={{ flexWrap: 'wrap' }}>
          {state.signals.map((s) => (
            <button
              key={s.type}
              type="button"
              className="w3-chip"
              data-testid={`signal-${s.type}`}
              data-count={s.count}
              onClick={() => onOpenSignal(s.type)}
            >
              {SIGNAL_LABEL[s.type]} {s.count}
            </button>
          ))}
        </div>
      </div>

      <div className="w3-stage">
        <div className="w3-stage-head">
          <span>
            <FlaskConical size={14} strokeWidth={1.5} /> 蒸馏
          </span>
        </div>
        <div className="w3-muted">{state.distill.summary}</div>
        <div className="w3-muted" style={{ marginTop: 6 }}>
          证据 {state.distill.evidenceCount} 条
        </div>
      </div>

      <div className="w3-stage">
        <div className="w3-stage-head">
          <span>
            <DoorOpen size={14} strokeWidth={1.5} /> 闸门
          </span>
          <span className={`w3-badge ${verdict.cls}`} data-testid="gate-verdict">
            {verdict.label}
          </span>
        </div>
        <div className="w3-muted">{state.gate.note}</div>
      </div>
    </div>
  );
}
