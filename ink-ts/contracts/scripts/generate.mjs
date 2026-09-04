import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACTS = join(HERE, '..');
const OUT = join(CONTRACTS, 'src', 'generated');

const readJson = (p) => JSON.parse(readFileSync(join(CONTRACTS, p), 'utf-8'));
const schema = (name) => readJson(`schemas/${name}.schema.json`);
const fixture = (name) => readJson(`fixtures/${name}.fixture.json`);

const HEADER =
  '// 生成文件（generated）：由 scripts/generate.mjs 依据 contracts/schemas 与 ' +
  'fixtures 生成，勿手改。数据面契约以 JSON 为准。';

const erSchema = schema('endpoint_registry');
const erFixture = fixture('endpoint_registry');
const ppSchema = schema('patch_protocol');
const ppFixture = fixture('patch_protocol');

function writeGenerated(name, body) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), `${HEADER}\n\n${body}\n`);
}

function union(items) {
  return items.map((v) => JSON.stringify(v)).join(' | ');
}

// schema 枚举 union（内联）约束 fixture 常量数组；漂移在类型检查期暴露。
function enumConst(name, typeName, values, schemaEnum) {
  return [
    `export const ${name} = [`,
    ...values.map((v) => `  ${JSON.stringify(v)},`),
    `] as const satisfies readonly (${union(schemaEnum)})[];`,
    ``,
    `export type ${typeName} = (typeof ${name})[number];`,
  ].join('\n');
}

const endpointBody = [
  `export const BUILTIN_ENDPOINT_NAMES = [`,
  ...erFixture.builtin_endpoints.map((e) => `  ${JSON.stringify(e.name)},`),
  `] as const;`,
  ``,
  `export type BuiltinEndpointName = (typeof BUILTIN_ENDPOINT_NAMES)[number];`,
  ``,
  `export type FieldKind = ${union(erSchema.definitions.output_field.properties.kind.enum)};`,
  ``,
  `export interface EndpointOutputField {`,
  `  name: string;`,
  `  required: boolean;`,
  `  kind: FieldKind;`,
  `}`,
  ``,
  `export interface BuiltinEndpointSpec {`,
  `  name: BuiltinEndpointName;`,
  `  actions: readonly string[];`,
  `  config_requirements: readonly string[];`,
  `  output_fields: readonly EndpointOutputField[];`,
  `  sandbox_ops: readonly string[];`,
  `}`,
  ``,
  `export const BUILTIN_ENDPOINTS = [`,
  ...erFixture.builtin_endpoints.map(
    (e) =>
      `  { name: ${JSON.stringify(e.name)}, actions: ${JSON.stringify(e.actions)} as const, ` +
      `config_requirements: ${JSON.stringify(e.config_requirements)} as const, ` +
      `output_fields: ${JSON.stringify(e.output_fields)} as const, ` +
      `sandbox_ops: ${JSON.stringify(e.sandbox_ops)} as const } as const,`,
  ),
  `] as const satisfies readonly BuiltinEndpointSpec[];`,
].join('\n');

const defaultLevelEntries = Object.entries(ppFixture.default_approval_levels).map(
  ([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`,
);

const patchBody = [
  enumConst('PATCH_KINDS', 'PatchKind', ppFixture.patch_kinds, ppSchema.properties.patch_kinds.items.enum),
  ``,
  enumConst('APPROVAL_LEVELS', 'ApprovalLevel', ppFixture.approval_levels, ppSchema.properties.approval_levels.items.enum),
  ``,
  `export type KnownDefaultPatchKind = Exclude<PatchKind, 'entity'>;`,
  ``,
  `export const DEFAULT_APPROVAL_LEVELS = {`,
  ...defaultLevelEntries,
  `} as const satisfies Record<KnownDefaultPatchKind, ApprovalLevel>;`,
  ``,
  enumConst('AUDIT_STATUSES', 'AuditStatus', ppFixture.audit_statuses, ppSchema.properties.audit_statuses.items.enum),
  ``,
  enumConst('PATCH_OPS', 'PatchOp', ppFixture.patch_ops, ppSchema.properties.patch_ops.items.enum),
  ``,
  `export const GUARDED_COLLECTIONS = [`,
  ...ppFixture.guarded_collections.map((k) => `  ${JSON.stringify(k)},`),
  `] as const;`,
  ``,
  `export const GUARDED_PREFIXES = [`,
  ...ppFixture.guarded_prefixes.map((k) => `  ${JSON.stringify(k)},`),
  `] as const;`,
].join('\n');

writeGenerated('endpointTypes.ts', endpointBody);
writeGenerated('patchProtocol.ts', patchBody);
writeGenerated(
  'index.ts',
  ["export * from './endpointTypes.js';", "export * from './patchProtocol.js';"].join('\n'),
);

console.log('generated src/generated/{endpointTypes,patchProtocol,index}.ts');
