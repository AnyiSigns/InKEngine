/**
 * 边证据域时间 seam（确定性：未冻结 = 实时 epoch 秒；冻结 = 注入确定值）。
 *
 * D19 时钟收敛：edge_score/intervention 直取 Date.now 处改经本 seam
 * （沿 settle/_time now/set_now 同形态）——测试可经 set_now 冻结时间，
 * 避免直取实时钟破坏确定性；缺省实时钟行为与旧实现一致。
 */

let _frozen: number | null = null;

/** 当前 epoch 秒（冻结值存在 = 返回冻结值，否则取实时钟）。 */
export function now(): number {
  return _frozen !== null ? _frozen : Date.now() / 1000;
}

/** 冻结/解冻时钟（null = 解冻回实时钟；供确定性测试注入）。 */
export function set_now(value: number | null): void {
  _frozen = value;
}
