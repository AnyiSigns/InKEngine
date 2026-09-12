/**
 * interrupt 挂起/注入重入机制的数据面（interrupt.py 移植）。
 *
 * 中断即一等控制流：节点内 interrupt() 声明中断点，首次执行时引擎捕获
 * InterruptSignal 并随 checkpoint 持久化挂起卡（键 + 负载 + 中断节点定位）；
 * 外部注入决议后从该节点重入，同一调用返回注入值，节点按状态通道分支执行
 * 剩余逻辑。本文件承担被多方消费的数据形态（信号、中断态、键常量）；键指纹
 * 运算与注入协调状态机见 interrupt.ts。
 *
 * gate 审批键的调用级唯一指纹：``gate:<tool>`` 中断键为工具名粒度——同轮
 * 同工具第二次触发审批（如首次拒绝后再次升级）若复用同一键，前端 pending
 * 卡/决议按键去重会丢第二张卡、续跑命中旧中断。协调器按 (thread, base) 对
 * gate 命名空间的发卡单调计数：首次保持原键（兼容既有续跑/断言），后续掺入
 * ``#<序号>`` 后缀——同一工具的第二次审批产生新键新卡，决议只命中对应中断；
 * 注入消费与挂起负载读取按 ``base`` / ``base#N`` 宽容匹配（后缀只作卡身份，
 * 基底键仍是判定面）。
 *
 * Python 差异：源模块实际常量是私有 ``_FINGERPRINT_SEP``，但 __all__ 声明
 * 导出名为 ``FINGERPRINT_SEP``（import * 会因缺名抛 AttributeError）——本
 * 移植以 __all__ 的声明意图为准导出 FINGERPRINT_SEP。
 */

import { InterruptState } from '../../model/storage/interrupt_state.js';

/** gate 审批键前缀（唯一指纹作用域）：工具门禁审批统一经 approve_before_execute
 *  以 ``gate:<tool>`` 挂卡。其余中断键（宿主自备唯一键/批处理合并卡/补丁
 *  审批）本身已是调用级或同类合并语义，不掺指纹，零行为变化。 */
export const GATE_KEY_PREFIX = 'gate:';

/** 指纹分隔符：``gate:<tool>#<序号>``。基底键判定（has_inject/注入消费/
 *  挂起负载读取）对 ``base`` 与 ``base#N`` 宽容匹配——序号是卡身份不是
 *  新语义。 */
export const FINGERPRINT_SEP = '#';

/**
 * 控制流信号：节点内 interrupt() 抛出的挂起标记（非错误，不记日志）。
 *
 * key 为挂起键（gate 审批第二次起由协调器掺入 ``#N`` 指纹）；payload 为
 * 挂起负载（审批卡内容等），随信号交引擎持久化。Python 侧继承
 * BaseException（引擎按控制流捕获，不属于节点执行错误）；TS core 无
 * BaseException 层级，以 Error 子类承载同一信号角色——消息与名称保持
 * ``interrupt[<key>]`` 形态，供跨语言诊断对账。
 */
export class InterruptSignal extends Error {
  readonly key: string;
  readonly payload: { [key: string]: unknown };

  constructor(key: string, payload: { [key: string]: unknown }) {
    super(`interrupt[${key}]`);
    this.name = 'InterruptSignal';
    this.key = key;
    this.payload = payload;
  }
}

// P6 归位（动作 E）：InterruptState（含私有 isFalsy 回落助手）已下移
// model/storage/interrupt_state.ts（checkpoint 数据形态），本处 re-export 保链。
export { InterruptState };
