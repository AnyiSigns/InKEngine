/**
 * 事件类型声明族：附件/审计/组装候选/组装时间线。
 * 只声明类型（类型是数据），事件由使用方在对应时机产出。
 */

import { FIELD_NUMBER, FIELD_STRING, SchemaField, SchemaSpec } from '../schema/schemaValidator.js';
import { EventTypeSpec } from './eventTypeSpec.js';
import type { EventTypeRegistryLike } from './registryTypes.js';

export const EVENT_AUDIT_ASSEMBLY = 'assembly_audit';
export const EVENT_ASSEMBLY_CANDIDATE = 'assembly_candidate';
export const EVENT_AUDIT_JUNCTION = 'junction_verdict_audit';
export const EVENT_AUDIT_FINGERPRINT_REPLACE = 'fingerprint_replace_audit';
export const EVENT_AUDIT_POLICY_REVIEW = 'policy_edge_review_audit';
export const EVENT_AUDIT_PROMOTION = 'recommended_prior_promotion';

export const EVENT_TURN_STARTED = 'turn_started';
export const EVENT_ASSEMBLY_STARTED = 'assembly_started';
export const EVENT_ASSEMBLY_DONE = 'assembly_done';
export const EVENT_EXECUTION_STARTED = 'execution_started';

const AUDIT_TS = new SchemaField({ name: 'ts', kind: FIELD_NUMBER });
const AUDIT_DOMAIN = new SchemaField({ name: 'domain', required: true, kind: FIELD_STRING });
const AUDIT_FINGERPRINT = new SchemaField({ name: 'fingerprint', kind: FIELD_STRING });

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
      name: EVENT_AUDIT_ASSEMBLY,
      schema: new SchemaSpec({ name: 'audit.assembly', fields: [AUDIT_TS, AUDIT_DOMAIN, AUDIT_FINGERPRINT] }),
      meta: { purpose: 'audit' },
    }),
    new EventTypeSpec({
      name: EVENT_AUDIT_JUNCTION,
      schema: new SchemaSpec({ name: 'audit.junction', fields: [AUDIT_TS, AUDIT_DOMAIN] }),
      meta: { purpose: 'audit' },
    }),
    new EventTypeSpec({
      name: EVENT_AUDIT_FINGERPRINT_REPLACE,
      schema: new SchemaSpec({
        name: 'audit.fingerprint_replace',
        fields: [AUDIT_TS, AUDIT_DOMAIN, AUDIT_FINGERPRINT],
      }),
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

export function assembly_candidate_event_spec(): EventTypeSpec {
  return new EventTypeSpec({
    name: EVENT_ASSEMBLY_CANDIDATE,
    schema: new SchemaSpec({
      name: 'audit.assembly_candidate',
      fields: [AUDIT_TS, AUDIT_DOMAIN, AUDIT_FINGERPRINT],
    }),
    meta: { purpose: 'audit' },
  });
}

export function output_gate_event_specs(): EventTypeSpec[] {
  return [
    new EventTypeSpec({ name: EVENT_TURN_STARTED, schema: new SchemaSpec({ name: 'timeline.turn_started' }), meta: { purpose: 'timeline' } }),
    new EventTypeSpec({ name: EVENT_ASSEMBLY_STARTED, schema: new SchemaSpec({ name: 'timeline.assembly_started' }), meta: { purpose: 'timeline' } }),
    new EventTypeSpec({ name: EVENT_ASSEMBLY_DONE, schema: new SchemaSpec({ name: 'timeline.assembly_done' }), meta: { purpose: 'timeline' } }),
    new EventTypeSpec({ name: EVENT_EXECUTION_STARTED, schema: new SchemaSpec({ name: 'timeline.execution_started' }), meta: { purpose: 'timeline' } }),
  ];
}

export function register_audit_event_types(registry: EventTypeRegistryLike): void {
  for (const spec of audit_event_specs()) registry.register(spec);
}

export function register_path_assembly_event_types(registry: EventTypeRegistryLike): void {
  registry.register(assembly_candidate_event_spec());
}

export function register_output_gate_event_types(registry: EventTypeRegistryLike): void {
  for (const spec of output_gate_event_specs()) registry.register(spec);
}
