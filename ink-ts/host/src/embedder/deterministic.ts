/**
 * 确定性保底向量（与 infer Rust embedder deterministic_vector 同算法）。
 *
 * FNV-1a（u64）+ sin 散射 + L2 归一，输出与真实嵌入同形态（单位球面上
 * 可比余弦）。TS 侧只复刻这一保底算法（非 tokenizer/ONNX 推理逻辑——
 * 推理只在 infer 内）；进程级 parity 由集成测试用保底路径对拍验证。
 */

/** FNV-1a 偏移基值（Rust u64 字面量同值）。 */
const FNV_OFFSET: bigint = 0x811c9dc5n;
/** FNV-1a 质数。 */
const FNV_PRIME: bigint = 0x0100_0193n;
/** sin 散射常量（Rust 同值）。 */
const SIN_SCATTER = 12.9898;
const SIN_AMP = 43758.5453;

/** Rust f64::fract 语义：小数部分 = self - self.trunc()（向零截断，符号随自身）。 */
function fract(value: number): number {
  return value - Math.trunc(value);
}

/** L2 归一（零向量原样保留，防除零）。 */
export function l2Normalize(vector: number[]): void {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm > 1e-12) {
    for (let i = 0; i < vector.length; i += 1) vector[i] = vector[i]! / norm;
  }
}

/** 确定性向量（FNV-1a 种子 + sin 散射，经 L2 归一）。 */
export function deterministicVector(text: string, dim: number): number[] {
  let state = FNV_OFFSET;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.codePointAt(i);
    if (code === undefined) continue;
    for (const byte of bytesOfCodePoint(code)) {
      state ^= BigInt(byte);
      state = BigInt.asUintN(64, state * FNV_PRIME);
    }
    if (code > 0xffff) i += 1; // 代理对已按码点处理，跳过低代理位
  }
  const seed = Number(state);
  const vector: number[] = new Array(dim);
  for (let i = 0; i < dim; i += 1) {
    const x = seed + i * SIN_SCATTER;
    vector[i] = fract(Math.sin(x) * SIN_AMP);
  }
  l2Normalize(vector);
  return vector;
}

/** Unicode 码点 → UTF-8 字节序列（Rust text.bytes() 同语义）。 */
function bytesOfCodePoint(code: number): number[] {
  if (code < 0x80) return [code];
  if (code < 0x800) {
    return [0xc0 | (code >> 6), 0x80 | (code & 0x3f)];
  }
  if (code < 0x10000) {
    return [0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)];
  }
  return [
    0xf0 | (code >> 18),
    0x80 | ((code >> 12) & 0x3f),
    0x80 | ((code >> 6) & 0x3f),
    0x80 | (code & 0x3f),
  ];
}
