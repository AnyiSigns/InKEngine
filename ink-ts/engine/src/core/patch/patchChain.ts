/**
 * 内容型补丁链（Event Sourcing 核心原语）：状态 = base + 补丁链（append-only），
 * 取用 = assemble（纯函数），压缩 = rebase，编辑重放 = truncate + 新分支。
 *
 * - append：列表追加 / 字符串拼接（路径不存在时自动创建容器）；
 * - replace：路径指向的值整体替换（路径不存在时新建）；
 * - delete：删除路径指向的值（路径不存在时静默成功，幂等）。
 *
 * 补丁 value 一律深拷贝入产物/分支（组装是纯函数，防外部修改污染链）。
 * version 随内容变更单调递增；on_change 在每次变更后触发，观察方以此为
 * 失效信号。钩子异常不打断链演化（副作用路径，链演化已完成）。
 */

import type { Json, Patch, PatchOp, Path } from './types.js';
import { ASSEMBLE_MODE_VALUES } from './types.js';

export type AssembleMode = (typeof ASSEMBLE_MODE_VALUES)[number];
export type { Json, Patch, PatchOp, Path };

/** 补丁链的序列化形态（to_dict/from_dict 的类型面，链持久化格式）。 */
export interface PatchChainSerialized {
  base: { [key: string]: Json };
  patches: { op: PatchOp; path: (string | number)[]; value: Json }[];
}

function deepCopy(value: Json): Json {
  if (Array.isArray(value)) return value.map(deepCopy);
  if (value !== null && typeof value === 'object') {
    const out: { [key: string]: Json } = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepCopy(v);
    return out;
  }
  return value;
}

function deepCopyRecord(value: { [key: string]: Json }): { [key: string]: Json } {
  return deepCopy(value) as unknown as { [key: string]: Json };
}

function isRecord(value: unknown): value is { [key: string]: Json } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function typeName(value: unknown): string {
  if (value === null) return 'NoneType';
  if (Array.isArray(value)) return 'list';
  if (isRecord(value)) return 'dict';
  if (typeof value === 'string') return 'str';
  if (typeof value === 'number') return 'int';
  return typeof value;
}

function resolve(doc: Json, path: Path): Json | undefined {
  let current: Json = doc;
  for (const seg of path) {
    if (isRecord(current)) {
      if (!(seg in current)) return undefined;
      current = current[seg as keyof typeof current] as Json;
    } else if (Array.isArray(current) && typeof seg === 'number' && seg >= 0 && seg < current.length) {
      current = current[seg] as Json;
    } else {
      return undefined;
    }
  }
  return current;
}

function setValue(doc: { [key: string]: Json }, path: Path, value: Json): void {
  let node: unknown = doc;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    let child: unknown;
    if (Array.isArray(node)) {
      while (node.length <= (seg as number)) node.push(null);
      child = node[seg as number];
      if (child === null) {
        child = typeof path[i + 1] === 'number' ? [] : {};
        node[seg as number] = child as Json;
      }
    } else if (isRecord(node)) {
      child = node[seg as keyof typeof node];
      if (child === undefined || child === null) {
        child = typeof path[i + 1] === 'number' ? [] : {};
        node[seg as keyof typeof node] = child as Json;
      }
    } else {
      throw new TypeError(`setValue: 路径中段非容器: ${path}`);
    }
    node = child;
  }
  const last = path[path.length - 1];
  if (Array.isArray(node) && typeof last === 'number') {
    while (node.length <= last) node.push(null);
    node[last] = value;
  } else if (isRecord(node)) {
    node[last as keyof typeof node] = value;
  } else {
    throw new TypeError(`setValue: 叶子父级非容器: ${path}`);
  }
}

function toStrish(value: Json | undefined): string {
  if (!value) return '';
  return typeof value === 'string' ? value : String(value);
}

function applyOne(doc: { [key: string]: Json }, patch: Patch): void {
  if (patch.op === 'append') {
    const current = resolve(doc, patch.path);
    if (current === undefined) {
      setValue(doc, patch.path, patch.value !== undefined && patch.value !== null ? [deepCopy(patch.value)] : []);
    } else if (Array.isArray(current)) {
      current.push(deepCopy(patch.value as Json));
    } else if (typeof current === 'string') {
      setValue(doc, patch.path, current + toStrish(patch.value));
    } else {
      throw new TypeError(
        `append 目标必须是 list/str，实际 ${typeName(current)}: ${JSON.stringify(patch.path)}`,
      );
    }
  } else if (patch.op === 'replace') {
    setValue(doc, patch.path, deepCopy(patch.value as Json));
  } else if (patch.op === 'delete') {
    let node: unknown = doc;
    for (const seg of patch.path.slice(0, -1)) {
      if (!isRecord(node) || !(seg in node)) return; // 幂等：中间路径缺失即视为已删除
      node = node[seg as keyof typeof node];
    }
    const last = patch.path[patch.path.length - 1];
    if (isRecord(node)) {
      delete node[last as keyof typeof node];
    } else if (Array.isArray(node) && typeof last === 'number' && last >= 0 && last < node.length) {
      node.splice(last, 1);
    }
  }
}

export class PatchChain {
  base: { [key: string]: Json };
  patches: Patch[];
  on_change?: () => void;
  #version: number;

  constructor(base?: { [key: string]: Json }, patches?: Patch[], onChange?: () => void) {
    this.base = deepCopyRecord(base ?? {});
    this.patches = patches ? patches.map((p) => ({ ...p, path: [...p.path], value: deepCopy(p.value as Json) })) : [];
    this.on_change = onChange;
    this.#version = 0;
  }

  get version(): number {
    return this.#version;
  }

  get length(): number {
    return this.patches.length;
  }

  apply(patch: Patch): void {
    this.patches.push(patch);
    this.#bump();
  }

  apply_many(patches: Patch[]): void {
    for (const p of patches) this.patches.push(p);
    this.#bump();
  }

  truncate(keep: number): void {
    if (keep < 0) throw new RangeError(`截断数量不能为负: ${keep}`);
    this.patches.splice(keep);
    this.#bump();
  }

  #bump(): void {
    this.#version += 1;
    if (this.on_change) {
      try {
        this.on_change();
      } catch {
        // 失效钩子是观察方副作用路径：链内容变更已完成，钩子失败不阻断演化
      }
    }
  }

  assemble(mode: AssembleMode = 'full', start = 0, end?: number): { [key: string]: Json } {
    if (mode === 'base_only') return deepCopyRecord(this.base);
    const patches = mode === 'partial' ? this.patches.slice(start, end ?? this.patches.length) : this.patches;
    const doc = deepCopyRecord(this.base);
    for (const patch of patches) applyOne(doc, patch);
    return doc;
  }

  rebase(): PatchChain {
    return new PatchChain(this.assemble());
  }

  branch(at?: number): PatchChain {
    const cut = at ?? this.patches.length;
    return new PatchChain(this.base, this.patches.slice(0, cut));
  }

  to_dict(): PatchChainSerialized {
    return {
      base: deepCopyRecord(this.base),
      patches: this.patches.map((p) => ({
        op: p.op,
        path: [...p.path],
        value: deepCopy(p.value as Json),
      })),
    };
  }

  static from_dict(data: Partial<PatchChainSerialized>): PatchChain {
    const patches = (data.patches ?? []).map((p) => ({
      op: p.op,
      path: [...p.path] as Path,
      value: deepCopy(p.value),
    }));
    return new PatchChain((data.base as { [key: string]: Json }) ?? {}, patches);
  }
}

/**
 * 消息压缩补丁链：delete 旧消息段（从后向前防索引漂移）+ 摘要 replace 链首。
 * 组装结果 = 摘要 + 保留段；链即删除证据（回放可精确还原删了什么）。
 */
export function buildMessageCompressPatches(
  messages: readonly Json[],
  cutoff: number,
  summary: Json,
): PatchChain {
  if (cutoff < 1 || cutoff > messages.length) {
    throw new RangeError(`裁剪点越界: cutoff=${cutoff}, messages=${messages.length}（须为 1..N）`);
  }
  const chain = new PatchChain({ messages: deepCopy([...messages]) as Json[] });
  for (let index = cutoff - 1; index > 0; index--) {
    chain.apply({ op: 'delete', path: ['messages', index] });
  }
  chain.apply({ op: 'replace', path: ['messages', 0], value: summary });
  return chain;
}
