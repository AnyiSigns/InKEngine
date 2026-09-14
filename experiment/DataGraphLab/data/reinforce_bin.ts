/**
 * `reinforce.bin` 二进制契约（REINFORCE 对照臂的离线批量数据，v1）。
 *
 * 与 `records.bin` 同法不同契约：header 仍按 ROUTING 序一次性存 22 节点动作特征表
 * （「候选特征由 node id 确定、不重复存」，F.2），行内仍是稀疏 obs + 22 位全局候选
 * 掩码，由置位下标升序即得候选本地下标。区别只在标签列——BC 行存 oracle 的
 * `targetIdx` 与进度标签，REINFORCE 行存**采样动作本地下标** `actionIdx` 与该步所属
 * rollout 的**优势** `advantage`（TS 侧按滑动均值 baseline 算好）与终局 `reward`
 * （诊断用）。梯度更新在 Python（`train.py --loss reinforce`），本模块只负责字节契约，
 * 不与 `records.bin` 共用幻数/版本，避免两种语义在同一格式里打架。
 *
 * 行的 (obs, candMask, actionIdx) 由 `data/records.featurizeRecord` 同一口径产出——
 * 特征唯一源不变；本模块只做「再挂两个 f32 标量」的字节封装。风格/家族单字节编码与
 * records 一致。读侧 magic/version 不符即 fail-fast，越界即判截断，写侧先扫 NaN/Inf。
 *
 * 字节布局（全 little-endian）：
 *   Header: 4B magic `DGLR` · u32 version(=1) · u32 nrows · u32 obsDim · u32 actDim ·
 *           u32 nAct，随后 nAct 个动作特征稀疏块（ROUTING 序）：u32 nIdx · nIdx×u16 · nIdx×f32
 *   Row:    u8 style · u8 family · u32 hashLen + hash UTF-8 · u32 stepIndex ·
 *           u32 nIdx · nIdx×u16 idx · nIdx×f32 val · u32 candMask · u32 actionIdx ·
 *           f32 advantage · f32 reward
 */

import { readFileSync, writeFileSync } from 'node:fs';

/** REINFORCE 单行：观测稀疏向量 + 候选全局掩码 + 采样动作本地下标 + 优势/奖励。 */
export interface ReinforceRow {
  readonly style: 0 | 1;
  readonly family: 0 | 1 | 2 | 3;
  readonly taskHash: string;
  readonly stepIndex: number;
  readonly idx: Uint16Array;
  readonly val: Float32Array;
  readonly candMask: number;
  readonly actionIdx: number;
  readonly advantage: number;
  readonly reward: number;
}

export interface ReinforceFile {
  readonly obsDim: number;
  readonly actDim: number;
  readonly actFeats: readonly Float32Array[];
  readonly rows: ReinforceRow[];
}

const MAGIC = 'DGLR';
const VERSION = 1;
const HEADER_BYTES = 24;
const MAX_BITSET = 32;

function assertFinite(label: string, vals: ArrayLike<number>): void {
  for (let k = 0; k < vals.length; k++) {
    if (!Number.isFinite(vals[k]!)) {
      throw new Error(`reinforce.bin: ${label} 值[${String(k)}] 非有限数（NaN/Inf）`);
    }
  }
}

function sparseBlockBytes(dense: ArrayLike<number>): number {
  let n = 0;
  for (let i = 0; i < dense.length; i++) if (dense[i] !== 0) n++;
  return 4 + n * 2 + n * 4;
}

export function writeReinforceBin(
  path: string,
  rows: readonly ReinforceRow[],
  obsDim: number,
  actFeats: readonly Float32Array[],
): void {
  if (actFeats.length === 0 || actFeats.length > MAX_BITSET) {
    throw new Error(`reinforce.bin: 动作特征表宽度 ${String(actFeats.length)} 须在 [1, ${String(MAX_BITSET)}]`);
  }
  const actDim = actFeats[0]!.length;
  let total = HEADER_BYTES;
  for (let j = 0; j < actFeats.length; j++) {
    const a = actFeats[j]!;
    if (a.length !== actDim) throw new Error(`reinforce.bin: 动作表[${String(j)}] 宽度 ${String(a.length)} ≠ ${String(actDim)}`);
    assertFinite(`动作表[${String(j)}]`, a);
    total += sparseBlockBytes(a);
  }
  const hashes = rows.map((r) => Buffer.from(r.taskHash, 'utf8'));
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    assertFinite(`行 ${String(i)} 稀疏值`, r.val);
    assertFinite(`行 ${String(i)} 优势/奖励`, [r.advantage, r.reward]);
    if (r.idx.length !== r.val.length) throw new Error(`reinforce.bin: 行 ${String(i)} idx/val 长度不等`);
    total += 1 + 1 + 4 + hashes[i]!.length + 4 + 4 + r.idx.length * 2 + r.val.length * 4 + 4 + 4 + 4 + 4;
  }
  const buf = Buffer.alloc(total);
  let o = 0;
  buf.write(MAGIC, o, 'ascii');
  o += 4;
  buf.writeUInt32LE(VERSION, o);
  o += 4;
  buf.writeUInt32LE(rows.length, o);
  o += 4;
  buf.writeUInt32LE(obsDim, o);
  o += 4;
  buf.writeUInt32LE(actDim, o);
  o += 4;
  buf.writeUInt32LE(actFeats.length, o);
  o += 4;
  for (const a of actFeats) {
    const nz: number[] = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== 0) nz.push(i);
    buf.writeUInt32LE(nz.length, o);
    o += 4;
    for (const k of nz) { buf.writeUInt16LE(k, o); o += 2; }
    for (const k of nz) { buf.writeFloatLE(a[k]!, o); o += 4; }
  }
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const hb = hashes[i]!;
    buf.writeUInt8(r.style, o); o += 1;
    buf.writeUInt8(r.family, o); o += 1;
    buf.writeUInt32LE(hb.length, o); o += 4;
    hb.copy(buf, o); o += hb.length;
    buf.writeUInt32LE(r.stepIndex, o); o += 4;
    buf.writeUInt32LE(r.idx.length, o); o += 4;
    for (let k = 0; k < r.idx.length; k++, o += 2) buf.writeUInt16LE(r.idx[k]!, o);
    for (let k = 0; k < r.val.length; k++, o += 4) buf.writeFloatLE(r.val[k]!, o);
    buf.writeUInt32LE(r.candMask >>> 0, o); o += 4;
    buf.writeUInt32LE(r.actionIdx >>> 0, o); o += 4;
    buf.writeFloatLE(r.advantage, o); o += 4;
    buf.writeFloatLE(r.reward, o); o += 4;
  }
  if (o !== total) throw new Error(`reinforce.bin: 写入游标 ${String(o)} 与预留 ${String(total)} 不符`);
  writeFileSync(path, buf);
}

class Reader {
  private o = HEADER_BYTES;
  constructor(private readonly buf: Buffer) {}
  private need(n: number): void {
    if (this.o + n > this.buf.length) {
      throw new Error(`reinforce.bin: 文件截断（偏移 ${String(this.o)} 需 ${String(n)} 字节）`);
    }
  }
  u8(): number { this.need(1); const v = this.buf.readUInt8(this.o); this.o += 1; return v; }
  u16Arr(n: number): Uint16Array {
    this.need(n * 2);
    const out = new Uint16Array(n);
    for (let k = 0; k < n; k++, this.o += 2) out[k] = this.buf.readUInt16LE(this.o);
    return out;
  }
  u32(): number { this.need(4); const v = this.buf.readUInt32LE(this.o); this.o += 4; return v; }
  f32(): number { this.need(4); const v = this.buf.readFloatLE(this.o); this.o += 4; return v; }
  f32Arr(n: number): Float32Array {
    this.need(n * 4);
    const out = new Float32Array(n);
    for (let k = 0; k < n; k++, this.o += 4) out[k] = this.buf.readFloatLE(this.o);
    return out;
  }
  str(n: number): string { this.need(n); const v = this.buf.toString('utf8', this.o, this.o + n); this.o += n; return v; }
}

export function readReinforceBin(path: string): ReinforceFile {
  const buf = readFileSync(path);
  if (buf.length < HEADER_BYTES) throw new Error('reinforce.bin: 文件短于 header');
  if (buf.toString('ascii', 0, 4) !== MAGIC) throw new Error('reinforce.bin: magic 不符，非本格式');
  const version = buf.readUInt32LE(4);
  if (version !== VERSION) throw new Error(`reinforce.bin: version=${String(version)} 与本实现 pin ${String(VERSION)} 不符`);
  const nrows = buf.readUInt32LE(8);
  const obsDim = buf.readUInt32LE(12);
  const actDim = buf.readUInt32LE(16);
  const nAct = buf.readUInt32LE(20);
  if (actDim === 0 || nAct === 0 || nAct > MAX_BITSET) {
    throw new Error(`reinforce.bin: header actDim=${String(actDim)} nAct=${String(nAct)} 非法`);
  }
  const rd = new Reader(buf);
  const actFeats: Float32Array[] = [];
  for (let j = 0; j < nAct; j++) {
    const nIdx = rd.u32();
    const idx = rd.u16Arr(nIdx);
    const val = rd.f32Arr(nIdx);
    const a = new Float32Array(actDim);
    for (let k = 0; k < nIdx; k++) {
      if (idx[k]! >= actDim) throw new Error(`reinforce.bin: 动作表[${String(j)}] 下标越界`);
      a[idx[k]!] = val[k]!;
    }
    assertFinite('读回动作表', val);
    actFeats.push(a);
  }
  const rows: ReinforceRow[] = [];
  for (let i = 0; i < nrows; i++) {
    const style = rd.u8();
    const family = rd.u8();
    const taskHash = rd.str(rd.u32());
    const stepIndex = rd.u32();
    const nIdx = rd.u32();
    const idx = rd.u16Arr(nIdx);
    const val = rd.f32Arr(nIdx);
    const candMask = rd.u32();
    const actionIdx = rd.u32();
    const advantage = rd.f32();
    const reward = rd.f32();
    assertFinite(`读回行 ${String(i)}`, val);
    if (!Number.isFinite(advantage) || !Number.isFinite(reward)) {
      throw new Error(`reinforce.bin: 行 ${String(i)} 优势/奖励非有限数`);
    }
    // 外部边界 fail-fast（与 records.bin 读侧同口径）：枚举字节、稀疏下标与本地动作
    // 下标都不许越过 header/掩码声明的宽度，越界即按损坏文件拒读，不进策略梯度算垃圾梯度。
    for (let k = 0; k < nIdx; k++) {
      if (idx[k]! >= obsDim) throw new Error(`reinforce.bin: 行 ${String(i)} 稀疏下标 ${String(idx[k])} 越 obsDim=${String(obsDim)} 界`);
    }
    if (style !== 0 && style !== 1) {
      throw new Error(`reinforce.bin: 行 ${String(i)} style=${String(style)} 不在 {0=follow,1=goal}`);
    }
    if (family > 3) {
      throw new Error(`reinforce.bin: 行 ${String(i)} family=${String(family)} 不在 {0,1,2,3}（value/verify/goal/goal_verify 序）`);
    }
    if (candMask >> nAct !== 0) throw new Error(`reinforce.bin: 行 ${String(i)} candMask 越宽`);
    let nCand = 0;
    for (let m = candMask; m !== 0; m >>>= 1) nCand += m & 1;
    if (actionIdx >= nCand) {
      throw new Error(`reinforce.bin: 行 ${String(i)} actionIdx=${String(actionIdx)} 越当步候选宽度 ${String(nCand)} 界（u32 动作下标须在候选内置位内）`);
    }
    rows.push({
      style: style as 0 | 1,
      family: family as 0 | 1 | 2 | 3,
      taskHash,
      stepIndex,
      idx,
      val,
      candMask,
      actionIdx,
      advantage,
      reward,
    });
  }
  return { obsDim, actDim, actFeats, rows };
}
