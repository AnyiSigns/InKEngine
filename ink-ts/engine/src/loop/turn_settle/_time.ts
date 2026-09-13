/**
 * 沉淀模块时间 seam（确定性：未冻结 = 实时 epoch 秒；冻结 = 注入确定值）。
 *
 * Python 侧直接调 time.time()；TS core 零 IO / 可复现纪律要求时钟可注入
 * （沿 pool_governance「时间戳为副作用，构造注入时钟」先例）。本 seam 以
 * 模块级冻结值承载：测试 set_now 注入确定时间戳，钩子全部经 now() 取时。
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
