/**
 * 事件类型声明族：附件/审计/时间线。
 * 只声明类型（类型是数据），事件由使用方在对应时机产出。
 */

import { FIELD_NUMBER, FIELD_STRING, SchemaField, SchemaSpec } from '../schema/schemaValidator.js';
import { EventTypeSpec } from './eventTypeSpec.js';
import type { EventTypeRegistryLike } from './registryTypes.js';

export const EVENT_AUDIT_JUNCTION = 'junction_verdict_audit';
export const EVENT_AUDIT_POLICY_REVIEW = 'policy_edge_review_audit';
export const EVENT_AUDIT_PROMOTION = 'recommended_prior_promotion';

export const EVENT_TURN_STARTED = 'turn_started';
export const EVENT_EXECUTION_STARTED = 'execution_started';

const AUDIT_TS = new SchemaField({ name: 'ts', kind: FIELD_NUMBER });
const AUDIT_DOMAIN = new SchemaField({ name: 'domain', required: true, kind: FIELD_STRING });

export function attachment_event_spec(
  name: string = 'attachment',
  renderer: string = 'AttachmentRow',
): EventTypeSpec {
  return new EventTypeSpec({
    name,
    schema: null,
    renderer,
    system: false,
    meta: { purpose: 'attachment' },
  });
}

export function audit_event_specs(): EventTypeSpec[] {
  return [
    new EventTypeSpec({
      name: EVENT_AUDIT_JUNCTION,
      schema: new SchemaSpec({ name: 'audit.junction', fields: [AUDIT_TS, AUDIT_DOMAIN] }),
      meta: { purpose: 'audit' },
    }),
    new EventTypeSpec({
      name: EVENT_AUDIT_POLICY_REVIEW,
      schema: new SchemaSpec({ name: 'audit.policy_review', fields: [AUDIT_TS, AUDIT_DOMAIN] }),
      meta: { purpose: 'audit' },
    }),
    new EventTypeSpec({
      name: EVENT_AUDIT_PROMOTION,
      schema: new SchemaSpec({ name: 'audit.promotion', fields: [AUDIT_TS, AUDIT_DOMAIN] }),
      meta: { purpose: 'audit' },
    }),
  ];
}

export function output_gate_event_specs(): EventTypeSpec[] {
  return [
    new EventTypeSpec({ name: EVENT_TURN_STARTED, schema: new SchemaSpec({ name: 'timeline.turn_started' }), meta: { purpose: 'timeline' } }),
    new EventTypeSpec({ name: EVENT_EXECUTION_STARTED, schema: new SchemaSpec({ name: 'timeline.execution_started' }), meta: { purpose: 'timeline' } }),
  ];
}

export function register_audit_event_types(registry: EventTypeRegistryLike): void {
  for (const spec of audit_event_specs()) registry.register(spec);
}

export function register_output_gate_event_types(registry: EventTypeRegistryLike): void {
  for (const spec of output_gate_event_specs()) registry.register(spec);
}