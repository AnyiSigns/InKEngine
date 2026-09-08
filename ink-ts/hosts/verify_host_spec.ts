#!/usr/bin/env tsx
/**
 * verify:host-spec —— 宿主面插件（hosts/<host>.spec.json）数据/装配面一致性审计。
 *
 * 断言：
 * 1. hosts/ 至少含一份 spec，id 全局唯一且 = 文件名；
 * 2. 四宿主定案（PLUGINS §2 / component_data §五）：cli/web 为 implemented=true
 *    （本仓可装配），tauri/ide 为 implemented=false（装配实现在外部壳仓，须带
 *    note）；实现面清单变动需同步本脚本与 component_data §九；
 * 3. 每份 spec 经 host_spec.validateHostSpec 形状校验（HostFaces 词汇对齐）；
 * 4. implemented=true 的 spec 必须带 renderer，且 renderer.entry 在仓库根下真实
 *    存在（cli→hosts/cli/src/tui、web→hosts/web/src）；implemented=false 不许本仓装配。
 *
 * 退出码：0 = PASS；1 = 任一违规。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HOST_SURFACES,
  loadHostSpec,
  validateHostSpec,
  type HostSpec,
} from './lib/src/host_spec.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const HOSTS = join(ROOT, 'hosts');

const violations: string[] = [];
const seen = new Set<string>();

function readRaw(id: string): HostSpec {
  return JSON.parse(readFileSync(join(HOSTS, `${id}.spec.json`), 'utf8')) as HostSpec;
}

for (const entry of readdirSync(HOSTS).sort()) {
  if (!entry.endsWith('.spec.json')) continue;
  const id = entry.slice(0, -'.spec.json'.length);
  if (seen.has(id)) violations.push(`重复宿主 spec id: ${id}`);
  seen.add(id);
  try {
    const spec = readRaw(id);
    const validated = validateHostSpec(spec);
    if (validated.id !== id) violations.push(`${id}: spec.id 与文件名不符`);
    if (validated.implemented) {
      if (validated.renderer === undefined || validated.renderer.entry === '') {
        violations.push(`${id}: implemented=true 的宿主须带 renderer（呈现面实现指针）`);
      } else {
        const target = join(ROOT, validated.renderer.entry);
        if (!existsSync(target)) {
          violations.push(`${id}: renderer.entry 不存在: ${validated.renderer.entry}（相对仓库根）`);
        }
      }
    }
  } catch (error) {
    violations.push(`${id}: ${(error as Error).message}`);
  }
}

// 四宿主定案不变式
const specIds = [...seen].sort();
for (const required of ['cli', 'web', 'tauri', 'ide']) {
  if (!specIds.includes(required)) violations.push(`缺宿主 spec: ${required}`);
}
if (specIds.some((id) => !['cli', 'web', 'tauri', 'ide'].includes(id))) {
  violations.push(`未知宿主 spec id（只允许 tauri/cli/web/ide 四份）: ${specIds.join(', ')}`);
}
for (const id of ['cli', 'web']) {
  const spec = loadHostSpec(id, { root: ROOT });
  if (!spec.implemented) violations.push(`${id}: cli/web 应 implemented=true（本仓可装配）`);
}
for (const id of ['tauri', 'ide']) {
  const spec = loadHostSpec(id, { root: ROOT });
  if (spec.implemented) violations.push(`${id}: tauri/ide 装配实现在外部壳仓，implemented 应=false`);
  if (typeof spec.note !== 'string' || spec.note === '') {
    violations.push(`${id}: implemented=false 的 spec 须带 note（装配实现所在/外部壳仓）`);
  }
}
const surfaceSet = new Set([...specIds].map((id) => loadHostSpec(id, { root: ROOT }).host.surface));
if (surfaceSet.size !== specIds.length) violations.push('host.surface 须一一对应（一宿主一面）');

if (violations.length > 0) {
  console.error(`verify:host-spec FAIL (${violations.length} 违规)`);
  for (const item of violations) console.error(`  ${item}`);
  process.exit(1);
}
const surfaces = [...surfaceSet].join(',');
console.log(
  `verify:host-spec PASS（${specIds.length} 宿主 spec：${surfaces}；cli/web 本仓装配、tauri/ide 外部壳仓占位）`,
);
