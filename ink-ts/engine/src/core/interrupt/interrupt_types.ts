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

import { isRecord } from '../json.js';

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

/** Python 布尔口径：空容器/零/空串/None 皆假值（from_dict 缺省回落依据）。 */
function isFalsy(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'boolean') return !value;
  if (typeof value === 'number') return value === 0;
  if (typeof value === 'string') return value === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/**
 * 中断点状态（随 checkpoint 持久化，重入定位锚点）。
 *
 * key：中断点标识（review_key，如 "gate" / "design_session"；gate 审批
 *   第二次起带 ``#N`` 调用级唯一指纹）；
 * payload：挂起负载（审批卡内容等）；
 * node：中断节点（重入起点）；
 * graph_path：嵌套图路径（重入定位）。
 *
 * frozen 语义对齐 Python frozen dataclass：构造即冻结实例（字段只读在运行
 * 时同样成立）；payload 为引用透传（与 Python 一致，内容可变）。graph_path
 * 对齐 tuple 的不可变语义做防御拷贝。
 */
export class InterruptState {
  readonly key: string;
  readonly payload: { [key: string]: unknown };
  readonly node: string | null;
  readonly graph_path: readonly string[];

  constructor(
    key: string,
    payload: { [key: string]: unknown },
    node: string | null = null,
    graph_path: readonly string[] = [],
  ) {
    this.key = key;
    this.payload = payload;
    this.node = node;
    this.graph_path = [...graph_path];
    Object.freeze(this);
  }

  /** 序列化为 JSON 形态（graph_path 元组 → 数组；payload/node 原样透传）。 */
  to_dict(): Record<string, unknown> {
    return {
      key: this.key,
      payload: this.payload,
      node: this.node,
      graph_path: [...this.graph_path],
    };
  }

  /** 从存储记录还原（schema 增量演进兼容）：缺省字段回落默认值（payload={}
   *  node=null / graph_path=[]），与 Python ``dict.get(...) or 缺省`` 同口径。 */
  static from_dict(data: unknown): InterruptState {
    if (!isRecord(data)) {
      throw new TypeError('中断点状态须为字典');
    }
    const rawKey = data['key'];
    if (rawKey === undefined || rawKey === null) {
      throw new Error('中断点状态缺 key 字段');
    }
    const rawPayload = data['payload'];
    const payload = isFalsy(rawPayload)
      ? {}
      : (rawPayload as { [key: string]: unknown });
    const rawNode = data['node'];
    const node = rawNode === undefined || rawNode === null ? null : (rawNode as string);
    const rawPath = data['graph_path'];
    let graph_path: string[];
    if (isFalsy(rawPath)) {
      graph_path = [];
    } else if (Array.isArray(rawPath)) {
      graph_path = rawPath as string[];
    } else if (typeof rawPath === 'string') {
      graph_path = Array.from(rawPath);
    } else {
      throw new Error('graph_path 需可迭代');
    }
    return new InterruptState(rawKey as string, payload, node, graph_path);
  }
}
