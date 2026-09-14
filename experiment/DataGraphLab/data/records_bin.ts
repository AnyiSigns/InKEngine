/**
 * `records.bin` 二进制派生缓存的唯一字节契约（F.2 派生层，v2）。
 *
 * 这里是「TS 写、Python 训练器读」两份实现里的唯一一份：Python 侧照下面的字段布局
 * 解析，禁止再维护第二套格式。派生缓存不进版本、可随时从 `records.jsonl` 重建，
 * 所以格式变更加版本号即可、不必迁移旧 bin。稀疏编码只落在这层——原始 obs 存紧凑
 * JSONL，稠密 ~867 维特征一旦进 JSONL，30k 轨迹会涨到 GB 级，故 `obs` 以 {idx,val}
 * 存、每行非零项远小于总维度。
 *
 * v2 契约缺口修复（对齐 F.2「候选特征由 node id 确定、不重复存」）：动作特征是节点
 * id 的纯函数（featurizeAction(GRAPH, nid) → 83 维，同 id 处处相同），v1 行内却只存
 * 低位计数掩码，Python 侧读 bin 无从重建每个候选的 a_i，而 F.3 又禁训练器复刻特征，
 * 两头堵死。v2 因此把 22 个 ROUTING 节点的动作特征表按序一次性写进 header（不重复
 * 存），行内 candMask 改为 22 位全局位掩码：位 j = ROUTING[j] 在该步候选内。Python
 * 由置位下标升序即得候选 i 对应的全局节点 j，再查 header 表重建 a_i——既合 F.2 原意，
 * 又不需要第二份特征实现（F.3 不破）。
 *
 * 字节布局（全 little-endian）：
 *   Header: 4B magic `DGLB` · u32 version(=2) · u32 nrows · u32 obsDim · u32 actDim ·
 *           u32 nAct，随后 nAct 个动作特征稀疏块（按 ROUTING 序，基础世界 nAct=22）：
 *           u32 nIdx · nIdx × u16 idx · nIdx × f32 val
 *   Row:    u8 style · u8 family · u32 taskHashLen + taskHashLen UTF-8 字节 ·
 *           u32 stepIndex · u32 nIdx · nIdx × u16 idx · nIdx × f32 val ·
 *           u32 candMask · i32 targetIdx · f32 progressLabel · u32 progressWeight
 *
 * targetIdx 仍是候选列表的本地下标：第 i 个置位（升序）↔ 该步第 i 个候选（F.2 原口径）。
 *
 * 读侧外部边界 fail-fast：magic/version 不符即抛（bin 可随时重生成，跨版本加载只会
 * 产出静默错位权重，比拒读坏得多，故 version≠2 直接提示重跑 featurize）；任何一处越过
 * 文件尾都判截断抛错，不按 nrows 之外的「半行」凑数；读回再扫一遍 NaN/Inf——写侧闸门
 * 挡正常管线，读侧扫描挡手工/损坏文件（G.7 数值入口判 NaN/Inf）；style/family 两个
 * u8 裸字节读侧校验枚举值域，越域即抛，不带着坏标签进训练。
 * 写侧先全量扫 NaN/Inf 再落盘：二进制里存进非法浮点会被 Python 无声读成垃圾，故在
 * 唯一写入口挡死。
 */

import { readFileSync, writeFileSync } from 'node:fs';

/** 派生缓存单行：稀疏 obs + 候选全局位掩码 + 本地 target 下标 + 分组进度标签。 */
export interface BinRow {
  readonly style: 0 | 1; // 0=follow 1=goal
  readonly family: 0 | 1 | 2 | 3; // value/verify/goal/goal_verify 序
  readonly taskHash: string; // meta.task_hash（诊断/分组用）
  readonly stepIndex: number;
  readonly idx: Uint16Array; // 非零特征下标，升序
  readonly val: Float32Array; // 与 idx 等长
  readonly candMask: number; // u32 位掩码：位 j ↔ ROUTING[j] 在该步候选内（基础 22 位）
  readonly targetIdx: number; // target 在 candidates 的本地下标（第 i 个置位 ↔ 候选 i）
  readonly progressLabel: number; // (末步步数 − 本步) / MAX_STEPS，进度 critic 辅助头标签
  readonly progressWeight: 0 | 1; // 完整轨迹（组内含 EXIT 终行）为 1，否则 0
}

/** 读回的派生缓存：header 三元组 + ROUTING 序动作特征表 + 行数组。 */
export interface BinFile {
  readonly obsDim: number;
  readonly actDim: number;
  readonly actFeats: readonly Float32Array[]; // 下标即 ROUTING 位序，每个长 actDim
  readonly rows: BinRow[];
}

const MAGIC = 'DGLB';
const VERSION = 2;
const HEADER_BYTES = 4 + 4 + 4 + 4 + 4 + 4;
const MAX_BITSET = 32; // candMask 是 u32：动作表宽度越界即拒（变长 bitset 另立版本，I.2）

/** 稠密动作向量 → 稀疏块字节数（u32 nIdx + u16 下标段 + f32 值段）。 */
function sparseBlockBytes(dense: ArrayLike<number>): number {
  let n = 0;
  for (let i = 0; i < dense.length; i++) if (dense[i] !== 0) n++;
  return 4 + n * 2 + n * 4;
}

function rowBytes(row: BinRow, hashBuf: Buffer): number {
  // 每条 taskHash 以 UTF-8 变长内联，长度前先算，供一次性 alloc（避免边推边扩缓冲）。
  return (
    1 + 1 + 4 + hashBuf.length + 4 + 4 + row.idx.length * 2 + row.val.length * 4 + 4 + 4 + 4 + 4
  );
}

/** 写盘/读回共用数值闸：任一非法浮点即抛，绝不落进 bin 或让下游静默读垃圾。 */
function assertFinite(label: string, vals: ArrayLike<number>): void {
  for (let k = 0; k < vals.length; k++) {
    if (!Number.isFinite(vals[k]!)) {
      throw new Error(`records.bin: ${label} 值[${String(k)}] 非有限数（NaN/Inf）`);
    }
  }
}

/**
 * 按上面的字节契约一次性预分配落盘：header → ROUTING 序动作特征表 → 行数组。
 * 先全量校验再写，写失败让异常直抛（不吞不降级）。动作特征不逐行重复存——它是
 * 节点 id 的纯函数，表在 header 存一份，行内只留 22 位掩码指回表序。
 */
export function writeRecordsBin(
  path: string,
  rows: readonly BinRow[],
  obsDim: number,
  actFeats: readonly Float32Array[],
): void {
  if (actFeats.length === 0 || actFeats.length > MAX_BITSET) {
    throw new Error(`records.bin: 动作特征表宽度 ${String(actFeats.length)} 须在 [1, ${String(MAX_BITSET)}]（candMask 是 u32）`);
  }
  const actDim = actFeats[0]!.length;
  let total = HEADER_BYTES;
  for (let j = 0; j < actFeats.length; j++) {
    const a = actFeats[j]!;
    if (a.length !== actDim) throw new Error(`records.bin: 动作表[${String(j)}] 宽度 ${String(a.length)} ≠ ${String(actDim)}`);
    assertFinite(`动作表[${String(j)}]`, a);
    total += sparseBlockBytes(a);
  }
  const hashes = rows.map((r) => Buffer.from(r.taskHash, 'utf8'));
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    assertFinite(`行 ${String(i)} 稀疏值`, row.val);
    if (row.idx.length !== row.val.length) {
      throw new Error(`records.bin: 行 ${String(i)} idx/val 长度不等，拒写`);
    }
    if (!Number.isFinite(row.progressLabel)) {
      throw new Error(`records.bin: 行 ${String(i)} progressLabel 非有限数，拒写`);
    }
    total += rowBytes(row, hashes[i]!);
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
    // 动作表块与行内 obs 同一种稀疏编码：非零项 (u16 下标, f32 值) 两段。
    const nzIdx: number[] = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== 0) nzIdx.push(i);
    buf.writeUInt32LE(nzIdx.length, o);
    o += 4;
    for (const k of nzIdx) {
      buf.writeUInt16LE(k, o);
      o += 2;
    }
    for (const k of nzIdx) {
      buf.writeFloatLE(a[k]!, o);
      o += 4;
    }
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const hashBuf = hashes[i]!;
    buf.writeUInt8(row.style, o);
    o += 1;
    buf.writeUInt8(row.family, o);
    o += 1;
    buf.writeUInt32LE(hashBuf.length, o);
    o += 4;
    hashBuf.copy(buf, o);
    o += hashBuf.length;
    buf.writeUInt32LE(row.stepIndex, o);
    o += 4;
    buf.writeUInt32LE(row.idx.length, o);
    o += 4;
    for (let k = 0; k < row.idx.length; k++, o += 2) buf.writeUInt16LE(row.idx[k]!, o);
    for (let k = 0; k < row.val.length; k++, o += 4) buf.writeFloatLE(row.val[k]!, o);
    buf.writeUInt32LE(row.candMask >>> 0, o);
    o += 4;
    buf.writeInt32LE(row.targetIdx, o);
    o += 4;
    buf.writeFloatLE(row.progressLabel, o);
    o += 4;
    buf.writeUInt32LE(row.progressWeight >>> 0, o);
    o += 4;
  }
  if (o !== total) throw new Error(`records.bin: 写入游标 ${String(o)} 与预留 ${String(total)} 不符`);
  writeFileSync(path, buf);
}

/** 游标越界即判截断：外部边界不静默补零、不用半行凑满 nrows。 */
class Reader {
  private o;
  constructor(private readonly buf: Buffer, start = HEADER_BYTES) {
    this.o = start;
  }
  private need(n: number): void {
    if (this.o + n > this.buf.length) {
      throw new Error(`records.bin: 文件截断（偏移 ${String(this.o)} 需 ${String(n)} 字节）`);
    }
  }
  u8(): number {
    this.need(1);
    const v = this.buf.readUInt8(this.o);
    this.o += 1;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32LE(this.o);
    this.o += 4;
    return v;
  }
  i32(): number {
    this.need(4);
    const v = this.buf.readInt32LE(this.o);
    this.o += 4;
    return v;
  }
  f32(): number {
    this.need(4);
    const v = this.buf.readFloatLE(this.o);
    this.o += 4;
    return v;
  }
  str(len: number): string {
    this.need(len);
    const v = this.buf.toString('utf8', this.o, this.o + len);
    this.o += len;
    return v;
  }
  u16Arr(n: number): Uint16Array {
    // 整段一次性检查，再逐元素读：越界由 need 挡，不让半个数组写进结果。
    this.need(n * 2);
    const out = new Uint16Array(n);
    for (let k = 0; k < n; k++, this.o += 2) out[k] = this.buf.readUInt16LE(this.o);
    return out;
  }
  f32Arr(n: number): Float32Array {
    this.need(n * 4);
    const out = new Float32Array(n);
    for (let k = 0; k < n; k++, this.o += 4) out[k] = this.buf.readFloatLE(this.o);
    return out;
  }
}

/** 读回派生缓存：magic/version 校验 fail-fast，obsDim/actDim/actFeats 随 header 返回。 */
export function readRecordsBin(path: string): BinFile {
  const buf = readFileSync(path);
  if (buf.length < HEADER_BYTES) throw new Error('records.bin: 文件短于 header，无法解析');
  if (buf.toString('ascii', 0, 4) !== MAGIC) {
    throw new Error(`records.bin: magic 非 ${MAGIC}（读到 ${JSON.stringify(buf.toString('ascii', 0, 4))}），非本格式`);
  }
  const version = buf.readUInt32LE(4);
  if (version !== VERSION) {
    throw new Error(
      `records.bin: version=${String(version)} 与本实现 pin ${String(VERSION)} 不符——bin 版本已升级，请重跑 featurize（禁跨版本加载）`,
    );
  }
  const nrows = buf.readUInt32LE(8);
  const obsDim = buf.readUInt32LE(12);
  const actDim = buf.readUInt32LE(16);
  const nAct = buf.readUInt32LE(20);
  if (actDim === 0 || nAct === 0 || nAct > MAX_BITSET) {
    throw new Error(`records.bin: header actDim=${String(actDim)} nAct=${String(nAct)} 非法（动作表须在 [1, ${String(MAX_BITSET)}] 宽）`);
  }
  const rd = new Reader(buf);
  const actFeats: Float32Array[] = [];
  let actFlat: number[] = [];
  for (let j = 0; j < nAct; j++) {
    const nIdx = rd.u32();
    const idx = rd.u16Arr(nIdx);
    const val = rd.f32Arr(nIdx);
    const a = new Float32Array(actDim);
    for (let k = 0; k < nIdx; k++) {
      if (idx[k]! >= actDim) throw new Error(`records.bin: 动作表[${String(j)}] 下标越 actDim=${String(actDim)} 界`);
      a[idx[k]!] = val[k]!;
    }
    actFeats.push(a);
    actFlat = actFlat.concat(Array.from(val));
  }
  assertFinite('读回动作表', actFlat);
  const rows: BinRow[] = [];
  for (let i = 0; i < nrows; i++) {
    const style = rd.u8();
    const family = rd.u8();
    const hashLen = rd.u32();
    const taskHash = rd.str(hashLen);
    const stepIndex = rd.u32();
    const nIdx = rd.u32();
    const idx = rd.u16Arr(nIdx);
    const val = rd.f32Arr(nIdx);
    const candMask = rd.u32();
    const targetIdx = rd.i32();
    const progressLabel = rd.f32();
    const progressWeight = rd.u32();
    for (let k = 0; k < nIdx; k++) {
      if (idx[k]! >= obsDim) throw new Error(`records.bin: 行 ${String(i)} 稀疏下标越 obsDim=${String(obsDim)} 界`);
    }
    assertFinite(`读回行 ${String(i)} 稀疏值`, val);
    if (candMask >> nAct !== 0) {
      throw new Error(`records.bin: 行 ${String(i)} candMask 置位越过动作表宽 ${String(nAct)}`);
    }
    // style/family 是 u8 裸字节：读侧同样按枚举值域 fail-fast（契约上只有
    // 0/1 与 0..3 合法），坏字节转成下游静默错组/错家族标签比拒读坏得多。
    if (style !== 0 && style !== 1) {
      throw new Error(`records.bin: 行 ${String(i)} style=${String(style)} 不在 {0=follow,1=goal}`);
    }
    if (family > 3) {
      throw new Error(`records.bin: 行 ${String(i)} family=${String(family)} 不在 {0,1,2,3}（value/verify/goal/goal_verify 序）`);
    }
    rows.push({
      style: style as 0 | 1,
      family: family as 0 | 1 | 2 | 3,
      taskHash,
      stepIndex,
      idx,
      val,
      candMask,
      targetIdx,
      progressLabel,
      progressWeight: progressWeight as 0 | 1,
    });
  }
  for (let i = 0; i < rows.length; i++) {
    if (!Number.isFinite(rows[i]!.progressLabel)) {
      throw new Error(`records.bin: 读回行 ${String(i)} progressLabel 非有限数（NaN/Inf），拒用`);
    }
  }
  return { obsDim, actDim, actFeats, rows };
}
