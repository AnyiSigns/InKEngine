/**
 * 测试共用：rounds 回合入口双路开关（W7-A 主线切换；组装回退 flag）。
 *
 * 组装回退路（INK_ROUNDS_ASSEMBLY_FALLBACK）为内部 flag 分支；既有「组装回合」
 * 语义专项测试（骨架草稿/组装图 config/链叶分支/纯 stub 回合/无模型冒烟等）
 * 显式打开回退保持绿——默认态 = execution 执行主线（新语义见
 * bridge/rounds_mainline.test.ts）。
 */

const ASSEMBLY_FALLBACK_ENV = 'INK_ROUNDS_ASSEMBLY_FALLBACK';

/** 打开组装回退（= send/resume 走旧组装路径；与实现读取的 truthy 词汇一致）。 */
export function enableAssemblyFallback(): void {
  process.env[ASSEMBLY_FALLBACK_ENV] = '1';
}

/** 关闭组装回退（恢复 execution 主线默认）。 */
export function disableAssemblyFallback(): void {
  delete process.env[ASSEMBLY_FALLBACK_ENV];
}
