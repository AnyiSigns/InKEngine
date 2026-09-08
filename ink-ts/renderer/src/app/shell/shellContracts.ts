/**
 * 产品壳契约类型（跨叶共享的显示面数据形状，阶段 7b 从叶子组件抽离）。
 *
 * 归属规则：被多个 ui 面插件/宿主共享的类型住这里（renderer 侧单一真源），
 * 各插件 faces/ui 代码经 `@/app/shell/shellContracts` 引用（外部分发插件走包
 * 出口）；不再由某个叶子组件导出——避免共享代码反向 import 插件目录。
 */

/** 主区页签（顶栏切换）。 */
export type MainTab = 'chat' | 'evolution' | 'ledger' | 'trajectory' | 'todo';

/** 会话行展示面（右栏消费真实字段：thread_id/title/updated_at）。 */
export interface RailSession {
  thread_id: string;
  title: string;
  updated_at: number;
}
