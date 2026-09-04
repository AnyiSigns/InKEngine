// 生成文件（generated）：由 scripts/generate.mjs 依据 contracts/schemas 与 fixtures 生成，勿手改。数据面契约以 JSON 为准。

export const BUILTIN_ENDPOINT_NAMES = [
  "http_fetch",
  "process_exec",
  "file_ops",
  "mcp",
  "web_search",
  "collab_request",
  "task_manager",
] as const;

export type BuiltinEndpointName = (typeof BUILTIN_ENDPOINT_NAMES)[number];

export type FieldKind = "string" | "number" | "object" | "array" | "boolean";

export interface EndpointOutputField {
  name: string;
  required: boolean;
  kind: FieldKind;
}

export interface BuiltinEndpointSpec {
  name: BuiltinEndpointName;
  actions: readonly string[];
  config_requirements: readonly string[];
  output_fields: readonly EndpointOutputField[];
  sandbox_ops: readonly string[];
}

export const BUILTIN_ENDPOINTS = [
  { name: "http_fetch", actions: ["connect"] as const, config_requirements: [] as const, output_fields: [{"name":"status_code","required":true,"kind":"number"},{"name":"body","required":true,"kind":"string"}] as const, sandbox_ops: [] as const } as const,
  { name: "process_exec", actions: ["exec"] as const, config_requirements: ["allowlist"] as const, output_fields: [{"name":"stdout","required":true,"kind":"string"},{"name":"exit_code","required":true,"kind":"number"}] as const, sandbox_ops: ["exec"] as const } as const,
  { name: "file_ops", actions: ["read","write","delete","edit","search","search_paths"] as const, config_requirements: ["root"] as const, output_fields: [{"name":"result","required":true,"kind":"string"}] as const, sandbox_ops: ["read","write","delete","edit","search","search_paths"] as const } as const,
  { name: "mcp", actions: ["call"] as const, config_requirements: ["server_id"] as const, output_fields: [{"name":"result","required":true,"kind":"object"}] as const, sandbox_ops: [] as const } as const,
  { name: "web_search", actions: ["search"] as const, config_requirements: [] as const, output_fields: [{"name":"results","required":true,"kind":"array"}] as const, sandbox_ops: [] as const } as const,
  { name: "collab_request", actions: ["request"] as const, config_requirements: [] as const, output_fields: [] as const, sandbox_ops: [] as const } as const,
  { name: "task_manager", actions: ["manage"] as const, config_requirements: [] as const, output_fields: [] as const, sandbox_ops: [] as const } as const,
] as const satisfies readonly BuiltinEndpointSpec[];
