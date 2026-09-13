// gate: test-exempt - P7-2 codec seam 装配注册（测试侧 setup 新增，src 同批改动分居 P6/P7-2 两波）
// 本文件 = test-support helper，非产品面；仅供 engine/test 侧 import 装配。
// P7-2 动作 B5：测试面补丁链 codec 注册 helper——engine/test 中直接构造
// PatchChain 并流经 model/storage（sensitive/storage_records）的纯函数用例
// 不经 Runtime 装配（_runtime_boot 首步注册），须在文件加载期注册与装配
// 同一实现（逐字对齐），恢复真实链分支行为；各文件仅需 import + 调用一行。
import { PatchChain, type PatchChainSerialized } from '../../src/gate/patch/patchChain.js';
import { register_chain_codec } from '../../src/model/storage/chain_codec.js';

/** 注册与 loop/runtime 装配首步同一实现的补丁链 codec（幂等，重复调用覆盖同值）。 */
export function register_test_chain_codec(): void {
  register_chain_codec({
    isChain: (v) => v instanceof PatchChain,
    baseOf: (c) => (c as PatchChain).base,
    patchesOf: (c) => (c as PatchChain).patches,
    fromDict: (d) => PatchChain.from_dict(d as Partial<PatchChainSerialized>),
    toDict: (c) => (c as PatchChain).to_dict(),
    makeChain: (b, p) =>
      new PatchChain(
        b as ConstructorParameters<typeof PatchChain>[0],
        p as ConstructorParameters<typeof PatchChain>[1],
      ),
  });
}