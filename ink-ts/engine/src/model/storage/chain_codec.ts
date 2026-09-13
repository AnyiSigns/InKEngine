// P7-2 codec seam（引擎重排计划 §6 P7 动作 B）：PatchChain 编解码接缝——
// model 零依赖纪律禁止 model/storage/* 直引 gate/patch，补丁链的识别、拆包
// 与重建经本 seam 注入；codec 实现由 loop/runtime 装配首步注册（见
// _runtime_boot.ts「装配首步注册」注释，loop→gate 骨架边合法）。未注册时
// 消费方以 has_chain_codec() 判定跳过链分支按普通 dict 处理——装配正确时
// 行为零变，独立无链场景不炸。
/** 补丁链编解码接缝（与 gate/patch/patchChain.ts 的 PatchChain 形态同构）。 */
export interface ChainCodec {
  /** 值是否补丁链实例（替代 instanceof PatchChain）。 */
  isChain(value: unknown): boolean;
  /** 拆链基座（链的 base 字典）。 */
  baseOf(chain: unknown): { [key: string]: unknown };
  /** 拆链补丁清单（op/path/value 三元组；delete 补丁可缺 value，对齐 Patch.value?）。 */
  patchesOf(chain: unknown): readonly { op: string; path: readonly (string | number)[]; value?: unknown }[];
  /** 序列化 dict → 链实例（≈ PatchChain.from_dict）。 */
  fromDict(data: unknown): unknown;
  /** 链实例 → 序列化 dict（≈ chain.to_dict）。 */
  toDict(chain: unknown): unknown;
  /** 由基座与补丁清单构造新链（≈ new PatchChain(base, patches)）。 */
  makeChain(base: unknown, patches: unknown[]): unknown;
}

let _codec: ChainCodec | null = null;

/** 注册补丁链 codec（装配首步调用；重复注册为覆盖语义，测试 setup 与装配可共存）。 */
export function register_chain_codec(codec: ChainCodec): void {
  _codec = codec;
}

/** codec 是否已注册（未注册时链分支跳过按普通 dict 处理）。 */
export function has_chain_codec(): boolean {
  return _codec !== null;
}

/** 取已注册 codec；未注册 fail-fast（消息指明装配首步义务）。 */
export function chain_codec(): ChainCodec {
  if (_codec === null) {
    throw new Error(
      'register_chain_codec 未注册：装配首步须注册补丁链 codec（gate/patch 侧注入）',
    );
  }
  return _codec;
}