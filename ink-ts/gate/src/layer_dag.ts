/**
 * layer-dag 层向门禁（计划 §5.1.1 + §2 依赖目标）：引擎六层
 * `engine/src/{model,loop,graph,gate,evolve,dock}` 的 import 方向矩阵
 * （S2 适配器下沉：`adapters` 层随目录移出引擎，实现落 plugins/ports）。
 * 目录不存在即跳过（与 scan.ts 行为一致；未搬迁波次自然静默）。
 *
 * 矩阵（白名单前缀写死于本实现，不做模糊匹配）：
 * - model：零依赖（禁 import 其余任何层）；
 * - loop|graph|gate|evolve → model：放行；
 * - 四件 → dock：仅放行前缀 `dock/ports(.ts|/*)` 与 `dock/registry(.ts|/*)`；
 *   其余 `dock/**` 禁入；
 * - dock → 四件：放行口径 = R-a + R-b + 既有 re-export contract 规则：
 *   R-a = 死集 `{index,caps,calls,view}` 仅 export 形态且目标形状达标（去层后
 *   ≤3 段、段名非 `_` 前缀，见 targetShapeOk）；R-b = `dock/registry/**` 值
 *   import 各机制 contract.ts 放行；其余 dock 文件仍仅允许 re-export contract.ts；
 * - dock → model：放行（§2 model 被所有层引，矩阵允许边）；
 * - 四件间允许边：loop→graph、loop→gate（骨架边：回合执行过闸）、
 *   evolve→gate、loop/runtime/**→evolve（装配位：boot 注入）；其余互引先查
 *   过渡边常量 TRANSITION_EDGES（P7-3 预登记，命中放行），仍不中才违规；
 * - 过渡边 TRANSITION_EDGES：shrink-only 常量（非 layerDagWhitelist，白名单
 *   保持空），键为 layer-pair（如 `loop→evolve`），值 = 消解波注记（S6/P8/S2），
 *   S6/P8/S2 消除对应边后须删除条目（gate.test.ts 断言只减不增）；
 * - 未定义的层间边一律违规（矩阵闭合，防漂移）。
 * 目标层判定只认上述六层目录；engine/src 下其余旧区（core/kernel 等）过渡期
 * 不参与层向判定（其纪律由 core-import/core-token/private-seam 现规则执法）。
 *
 * 红线（机制层 loop/graph/gate/evolve 文件，§2.1/§2.2）：禁相对 import 命中
 * 旧组装模块（path_assembler/thread_skeleton/fingerprint_cache/core/assembly），
 * 禁 token（组装路径/出厂图/默认拓扑/每回合拼图）——防旧组装借重排回潮。
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { GateConfig } from './config.js';
import type { Violation } from './rules.js';

/** 层向清单（S2 后六层；导出供 gate.test 断言 adapters 层消亡）。 */
export const LAYERS = ['model', 'loop', 'graph', 'gate', 'evolve', 'dock'] as const;
type Layer = (typeof LAYERS)[number];
const FOUR: readonly string[] = ['loop', 'graph', 'gate', 'evolve'];
const SRC_PREFIX = 'engine/src/';
/** 四件 → dock 仅放行这两个声明面前缀（§5.1 精确口径，写死不模糊）。 */
const DOCK_ALLOWED_PREFIXES: readonly string[] = ['dock/ports', 'dock/registry'];
/** 机制层红线：旧组装模块子串（相对 import 说明符命中即违规）。 */
const REDLINE_REL_SUBSTRINGS: readonly string[] = ['path_assembler', 'thread_skeleton', 'fingerprint_cache', 'core/assembly'];
/** 机制层红线：组装语义 token（文件文本命中即违规）。 */
const REDLINE_TOKENS: readonly string[] = ['组装路径', '出厂图', '默认拓扑', '每回合拼图'];
/**
 * 过渡边预登记（P7-3 基线 7 条，shrink-only）：非 layerDagWhitelist——白名单保持
 * 空、单调收缩纪律不变；本常量把「已知将随消解波拆除」的层间边预登记为放行，
 * 键 = `<导入层>→<目标层>`，值 = 消解波注记（仅作文档用途，判定向只查键存在）。
 * S6/P8 消除对应边后必须删除条目（S2 已消解 adapters→loop，边随 adapters 层
 * 消亡而移除），gate.test.ts 断言条目数只减不增（≤6）。
 */
export const TRANSITION_EDGES: Readonly<Record<string, string>> = {
  'loop→evolve': 'S6 事件化（turn_settle/execution_runtime 类型面改事件写入；trial_runner 采纳闸随 S6 评估）',
  'graph→loop': 'P8 消亡（executor 机制符号 + _engine_spawn/_simulate/_plan/_parallel 删除件）',
  'evolve→loop': 'S6 legacy 反向消解',
  'evolve→graph': 'S6 legacy 反向消解',
  'graph→evolve': 'S6 消解（graph/nodes 节点族移出插件）',
  'gate→loop': 'S6 消解（gate/sandbox/process_sandbox 端口化）',
};
/** dock 死集（inSrc 相对形式）：R-a 放行仅覆盖这四个随波消亡的文件。 */
const DOCK_DEAD_SET: readonly string[] = ['dock/index.ts', 'dock/caps.ts', 'dock/calls.ts', 'dock/view.ts'];

const IMPORT_FROM_RE = /(import|export)(?:\s+[\w*{},\s$]*?)?\s*from\s*['"](\.\/[^'"]+|\.\.\/[^'"]+)['"]/g;
const BARE_REL_IMPORT_RE = /import\s*['"](\.[^'"]+)['"]/g;

async function collectTs(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      await collectTs(full, out);
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
}

function layerOf(rel: string): Layer | null {
  if (!rel.startsWith(SRC_PREFIX)) return null;
  const head = rel.slice(SRC_PREFIX.length).split('/')[0] ?? '';
  return (LAYERS as readonly string[]).includes(head) ? (head as Layer) : null;
}

/** NodeNext 风格说明符解析：`.js` → `.ts`。返回 root 相对 posix 路径（engine/src 内）。 */
function resolveSpec(root: string, importerRel: string, spec: string): string | null {
  const dir = importerRel.slice(0, importerRel.lastIndexOf('/'));
  let abs = resolve(root, dir, spec);
  if (abs.endsWith('.js')) abs = `${abs.slice(0, -3)}.ts`;
  if (!abs.startsWith(root)) return null;
  const rel = abs
    .slice(root.length + 1)
    .split('\\')
    .join('/');
  return rel.startsWith(SRC_PREFIX) ? rel : null;
}

/** 前缀放行：`p` 恰为 `dock/ports`/`dock/registry` 时，仅 `.ts` 文件或 `/` 子目录。 */
function matchesAllowedPrefix(targetRel: string, prefixes: readonly string[]): boolean {
  const inSrc = targetRel.slice(SRC_PREFIX.length);
  return prefixes.some((p) => inSrc === `${p}.ts` || inSrc.startsWith(`${p}/`));
}

/**
 * R-a 目标形状约束（dock 死集 re-export 的放行前提）：目标去层后段数（含文件名）
 * ≤3，且层目录之后的每一段均不以 `_` 开头（私有面不得经死集 barrel 外泄）。
 */
function targetShapeOk(targetRel: string): boolean {
  const inSrc = targetRel.slice(SRC_PREFIX.length);
  const parts = inSrc.split('/');
  if (parts.length - 1 > 3) return false;
  return parts.slice(1).every((seg) => !seg.startsWith('_'));
}

interface EdgeVerdict {
  message: string | null;
}

/** 判定一条层间 import 边（importerLayer 与 targetRel 均属七层且不同层）。 */
function classifyEdge(importerRel: string, importerLayer: Layer, targetRel: string, targetLayer: Layer, isReExport: boolean): EdgeVerdict {
  if (importerLayer === targetLayer) return { message: null };
  if (importerLayer === 'model') {
    return { message: `model 零依赖：禁 import 其余层（命中 ${targetLayer}）` };
  }
  if (FOUR.includes(importerLayer)) {
    if (targetLayer === 'model') return { message: null };
    if (FOUR.includes(targetLayer)) {
      const allowed =
        (importerLayer === 'loop' && targetLayer === 'graph') ||
        (importerLayer === 'evolve' && targetLayer === 'gate') ||
        (importerLayer === 'loop' && targetLayer === 'gate') || // 骨架边：回合执行过闸
        (importerLayer === 'loop' && targetLayer === 'evolve' && importerRel.slice(SRC_PREFIX.length).startsWith('loop/runtime/')); // 装配位：boot 注入
      if (allowed) return { message: null };
      // 预登记过渡边（S6/P8 消解波负责拆除）命中即放行，不扩大白名单
      if (TRANSITION_EDGES[`${importerLayer}→${targetLayer}`] !== undefined) return { message: null };
      return { message: `四件间仅允许 loop→graph、loop→gate、evolve→gate、loop/runtime/**→evolve（发现 ${importerLayer}→${targetLayer}）` };
    }
    if (targetLayer === 'dock') {
      return matchesAllowedPrefix(targetRel, DOCK_ALLOWED_PREFIXES)
        ? { message: null }
        : { message: `四件→dock 仅放行 dock/ports(.ts|/*)、dock/registry(.ts|/*)（命中 ${targetRel.slice(SRC_PREFIX.length)}）` };
    }
    return { message: `${importerLayer} 禁 import ${targetLayer}` };
  }
  if (importerLayer === 'dock') {
    if (targetLayer === 'model') return { message: null };
    if (FOUR.includes(targetLayer)) {
      const inSrc = targetRel.slice(SRC_PREFIX.length);
      const importerInSrc = importerRel.slice(SRC_PREFIX.length);
      const isContract = /^[^/]+\/[^/]+\/contract\.ts$/.test(inSrc);
      // 各机制 contract.ts 含嵌套组路径（如 evolve/legacy/<id>/contract.ts、
      // loop/tools/tool_pipeline/contract.ts，P7-3 基线 28 条 registry 命中占 12 条）；
      // R-b 的「各机制 contract.ts」按层下任意深度 contract.ts 口径定向。
      const isAnyContract = /^[^/]+\/(?:[^/]+\/)+contract\.ts$/.test(inSrc);
      // R-b：registry 声明面值 import 各机制 contract.ts 放行（值 import 形态不构成层穿透）
      if (importerInSrc.startsWith('dock/registry/') && isAnyContract) return { message: null };
      // R-a：死集四文件（随波消亡）export 形态 + 目标形状达标放行
      if (DOCK_DEAD_SET.includes(importerInSrc) && isReExport && targetShapeOk(targetRel)) return { message: null };
      if (isContract && isReExport) return { message: null };
      return { message: `dock→四件只允许 re-export 各机制 contract.ts（命中 ${inSrc}${isContract ? '，非 re-export' : ''}）` };
    }
    return { message: `dock 层禁 import ${targetLayer}（dock 允许边：model 直引 + 四件 contract.ts re-export）` };
  }
  return { message: `层 ${importerLayer} 禁 import ${targetLayer}（矩阵外，S2 后引擎仅六层）` };
}

/** 全仓层向扫描：返回违规清单（whitelist 条目 `<file>:<spec|token:词>` 精确豁免）。 */
export async function scanLayerDag(root: string, cfg: GateConfig): Promise<Violation[]> {
  const whitelist = new Set(cfg.layerDagWhitelist);
  const violations: Violation[] = [];
  for (const layer of LAYERS) {
    const dir = join(root, SRC_PREFIX.slice(0, -1), layer);
    const files: string[] = [];
    try {
      await collectTs(dir, files);
    } catch {
      continue; // 目录不存在（尚未搬到该层）→ 跳过
    }
    for (const file of files) {
      const rel = file.slice(root.length + 1).split('\\').join('/');
      const content = await readFile(file, 'utf8');
      const owner = layerOf(rel);
      if (owner === null) continue;
      // 红线：机制层禁旧组装模块 import 与组装 token
      if (FOUR.includes(owner)) {
        for (const spec of [
          ...[...content.matchAll(IMPORT_FROM_RE)].map((m) => m[2] ?? ''),
          ...[...content.matchAll(BARE_REL_IMPORT_RE)].map((m) => m[1] ?? ''),
        ]) {
          const hit = REDLINE_REL_SUBSTRINGS.find((sub) => spec.includes(sub));
          if (hit !== undefined) {
            const key = `${rel}:${spec}`;
            if (!whitelist.has(key)) {
              violations.push({ path: rel, rule: 'layer-dag', message: `机制层红线：禁 import 旧组装模块（命中 ${hit}）：${spec}` });
            }
          }
        }
        for (const token of REDLINE_TOKENS) {
          if (content.includes(token)) {
            const key = `${rel}:token:${token}`;
            if (!whitelist.has(key)) {
              violations.push({ path: rel, rule: 'layer-dag', message: `机制层红线：禁组装语义 token「${token}」（§2.1 拓扑只能是数据/路由）` });
            }
          }
        }
      }
      // 层间边
      for (const m of content.matchAll(IMPORT_FROM_RE)) {
        const keyword = m[1] ?? '';
        const spec = m[2] ?? '';
        const targetRel = resolveSpec(root, rel, spec);
        if (targetRel === null) continue;
        const targetLayer = layerOf(targetRel);
        if (targetLayer === null) continue; // 旧区（core/kernel 等）不参与层向判定
        const verdict = classifyEdge(rel, owner, targetRel, targetLayer, keyword === 'export');
        if (verdict.message === null) continue;
        const key = `${rel}:${spec}`;
        if (whitelist.has(key)) continue;
        violations.push({ path: rel, rule: 'layer-dag', message: verdict.message });
      }
    }
  }
  return violations;
}
