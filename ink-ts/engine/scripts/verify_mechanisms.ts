#!/usr/bin/env tsx
/**
 * verify:mechanisms —— 阶段1 机制件三键校验（依赖单向 / 装配完整 / 0-IO）。
 *
 * 三键口径（对应 component_data_endgame §七 阶段1 verify）：
 * 1. 依赖单向：全量机制契约密封（seal_mechanism_registry）——id 唯一/depends
 *    在册/无自环/无循环；输出拓扑装配序。
 * 2. 装配完整：runtime 契约 depends 闭包 ∪ 自足叶子机制（depends=[] 且
 *    effects=[]——宿主/UI 直用原语如 round_steps，不经 runtime 装配）= 全量
 *    机制集合（孤儿机制/漏装配即校验失败）；每机制 effects 只引用已登记端口。
 * 3. 0-IO：kernel 机制层零自持 IO——禁 node:*（除 node:async_hooks 白名单，
 *    gate 同步口径）、禁裸第三方 import、禁 IO 全局原语（fetch/process.env/
 *    process.exit/process.cwd/WebSocket/XMLHttpRequest、setTimeout 定时器属
 *    等待语义不属 IO 不拦）；执行体一律经注入 seam（SpawnSeam/Storage/AsyncLLM）。
 *
 * 退出码：0 = PASS；1 = 任一键违规（打印违规清单）。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  ALL_MECHANISM_CONTRACTS,
  MECHANISM_PORT_IDS,
  topo_order,
  validate_mechanism_registry,
  type MechanismContract,
} from '../src/kernel/registry/index.js';
import { runtime_contract } from '../src/kernel/runtime/contract.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, '..');
const KERNEL_SRC = join(ENGINE, 'src', 'kernel');

/** gate 同步白名单：core/kernel 允许的 node 内置模块（镜像 gate config）。 */
const CORE_ALLOWED_NODE = new Set(['node:async_hooks']);
/** 裸第三方包 import 拒绝（与 gate CORE_ALLOWED_PACKAGES=[] 同步）。 */
const BARE_PACKAGE_RE = /^\s*[a-zA-Z@][^./]*$/;
/** 全局 IO 原语（直接调 = 自持 IO；执行体应经注入 seam）。 */
const IO_GLOBAL_TOKENS: readonly { token: RegExp; label: string }[] = [
  { token: /\bfetch\s*\(/g, label: 'fetch(' },
  { token: /\bprocess\.env\b/g, label: 'process.env' },
  { token: /\bprocess\.(exit|cwd|chdir|platform|argv)\b/g, label: 'process.{exit,cwd,...}' },
  { token: /\bWebSocket\b/g, label: 'WebSocket' },
  { token: /\bXMLHttpRequest\b/g, label: 'XMLHttpRequest' },
  { token: /\b(?:child_process|cluster|dgram)\b/g, label: 'child_process/cluster/dgram' },
];

interface IoViolation {
  file: string;
  label: string;
}

/** 递归收集 kernel 下全部 .ts 文件（含子目录）。 */
function kernelTsFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.ts')) {
        out.push(full);
      }
    }
  };
  walk(KERNEL_SRC);
  return out;
}

/** 依赖单向 + 装配完整：契约密封 + runtime 闭包覆盖。 */
function verify_contracts(): string[] {
  const errors: string[] = [];
  const contracts = ALL_MECHANISM_CONTRACTS as readonly MechanismContract[];
  const ids = new Set(contracts.map((c) => c.id));

  // 1) effects 只引用已登记端口（装配完整的前置：端口词汇统一）
  for (const c of contracts) {
    for (const effect of c.contract.effects) {
      if (!MECHANISM_PORT_IDS.includes(effect)) {
        errors.push(`[effects] ${c.id} 声明未登记端口: ${effect}`);
      }
    }
  }

  // 2) 密封：id 唯一 / depends 在册 / 自环 / 循环（依赖单向 fail-closed）
  const violations = validate_mechanism_registry(contracts as never);
  if (violations.length > 0) {
    for (const v of violations) {
      errors.push(`[依赖单向] ${v.rule}: ${v.message}`);
    }
  }

  // 3) 装配完整：runtime depends 闭包 ∪ 自足叶子机制（depends=[] 且
  //    effects=[]，宿主/UI 直用原语如 round_steps——不经 runtime 装配）须覆盖
  //    全量机制；其余机制须在 runtime 闭包内（漏装配/孤儿即失败）
  const reachable = new Set<string>(runtime_contract.depends);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of contracts) {
      if (reachable.has(c.id)) {
        for (const dep of c.depends) {
          if (ids.has(dep) && !reachable.has(dep)) {
            reachable.add(dep);
            grew = true;
          }
        }
      }
    }
  }
  for (const c of contracts) {
    if (c.id === 'runtime') continue;
    const selfSuff = c.depends.length === 0 && c.contract.effects.length === 0;
    if (!reachable.has(c.id) && !selfSuff) {
      errors.push(`[装配完整] ${c.id} 不在 runtime depends 闭包内且非自足叶子（漏装配/孤儿机制）`);
    }
  }

  if (errors.length === 0) {
    const order = topo_order(contracts as never);
    if (order.length !== contracts.length) {
      errors.push(`[装配完整] 拓扑装配序未覆盖全量机制 (${order.length}/${contracts.length})`);
    }
  }
  return errors;
}

/** 0-IO：kernel 机制层禁 node 内置/第三方/IO 全局原语。 */
function verify_zero_io(): string[] {
  const errors: string[] = [];
  const files = kernelTsFiles();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const rel = file.slice(ENGINE.length + 1).replace(/\\/g, '/');

    // node: 内置模块 import（白名单放行）；只认 import 语句行（注释/文档
    // 里的 node:crypto 字样不扫）
    for (const line of text.split('\n')) {
      const spec = line.match(/(?:from\s+|import\s*\(?\s*)['"]((?:node:)[^'"]+)['"]/)?.[1]
        ?? line.match(/import\s*['"]((?:node:)[^'"]+)['"]/)?.[1];
      if (!spec) continue;
      if (!CORE_ALLOWED_NODE.has(spec)) {
        errors.push(`[0-IO] ${rel} import 未白名单 node 内置: ${spec}`);
      }
    }

    // 裸第三方 import（`from 'pkg'` / `import 'pkg'`）
    for (const line of text.split('\n')) {
      const from = line.match(/from\s+['"]([^'"]+)['"]/)?.[1]
        ?? line.match(/import\s+['"]([^'"]+)['"]/)?.[1];
      if (from && BARE_PACKAGE_RE.test(from) && !from.startsWith('node:')) {
        errors.push(`[0-IO] ${rel} 裸第三方 import: ${from}`);
      }
    }

    // IO 全局原语 token（排除注释行：以 // 或 * 开头的行不扫）
    for (const { token, label } of IO_GLOBAL_TOKENS) {
      for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
        if (token.test(line)) {
          errors.push(`[0-IO] ${rel} IO 原语: ${label}`);
        }
      }
    }
  }
  return errors;
}

/** 汇总三键校验并输出 PASS/违规清单（违规 = 非零退出）。 */
function run(): number {
  const failures: string[] = [];
  failures.push(...verify_contracts());
  failures.push(...verify_zero_io());

  if (failures.length === 0) {
    console.log(
      `verify:mechanisms PASS —— 契约 ${ALL_MECHANISM_CONTRACTS.length} 项密封/闭包完整，kernel 机制层零自持 IO`,
    );
    return 0;
  }
  console.log('verify:mechanisms FAIL ——');
  for (const err of failures) console.log(`  ${err}`);
  return 1;
}

process.exit(run());
