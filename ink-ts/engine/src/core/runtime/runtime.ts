/**
 * 运行时（Runtime）：装配产物持有者 + 生命周期状态机（进程级）——叶类。
 *
 * 装配（boot）幂等；生命周期转换带守卫（非法转换显式报错）；stop 幂等
 * 且按序关停。装配决策全部来自配方数据，Runtime 只做「读配方并执行装配」
 * ——装配动作是机制，不可被补丁链修改（与补丁链不能补丁自己同族的自指
 * 终止）。
 *
 * 分层实现（≤350 行/文件纪律，与 executor 同构）：字段基座（_runtime_base）
 * → 生命周期/回合登记（_runtime_state/_runtime_runs）→ 工具标签与常驻必带
 * 集（_runtime_specs/_runtime_ui）→ 自指上下文/装配源/引擎重建/集状态恢复
 * （_runtime_contexts/_runtime_engine）→ 装配（_runtime_assemble）→ 本叶类。
 */

import { RuntimeAssemble } from './_runtime_assemble.js';

/** 运行时叶类（完整公开形态 = 分层链全量方法）。 */
export class Runtime extends RuntimeAssemble {}
