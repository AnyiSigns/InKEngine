/**
 * 图注册表域的类型形态（core/registry.py 移植的注册面）。
 *
 * 注册表存「工厂/判定函数」（seam/回调），是宿主/领域包向声明式图定义
 * 供给执行体的插口。类型名/条件名对注册表是不透明字符串，注册表不解释
 * 任何含义——名字如何构造执行/判定函数完全由注册方决定，本文件只钉住
 * 函数签名的形状。执行体签名与 Graph.add_node/条件边一致，NodeContext
 * 等图模块形态待 graph 移植后收敛，此处先按注册表面最小对齐。
 */

/** 节点执行上下文（建图/运行期注入；graph 移植前保持不透明）。 */
export type NodeContext = unknown;

/**
 * 节点执行函数：与 Graph.add_node 同签名——async (ctx) -> 增量 dict | None。
 * 增量结果与原状态浅合并（reduce），None = 本轮无输出（原样保留）。
 */
export type NodeFn = (
  ctx: NodeContext,
) => Record<string, unknown> | Promise<Record<string, unknown> | null> | null;

/**
 * 节点工厂签名：节点配置（声明式规格中的 config 字段透传）→ 节点执行函数。
 * 生命周期契约：工厂禁止捕获装配期可变状态快照，须用实时引用
 * （以 registry 实例为键的持有者现取）——类型注册一次、跨引擎重建存活。
 */
export type NodeFactory = (config: Record<string, unknown>) => NodeFn;

/** 条件边判定函数：async (ctx) -> bool（图定义数据里的边引用）。 */
export type EdgeCondition = (ctx: NodeContext) => boolean | Promise<boolean>;

/**
 * 结点契约（登记面镜像 core.contracts.NodeContract 的数据形态）。
 *
 * 契约是数据：注册表随类型登记后原样保存/返回，只读 version 供链接校验的
 * 版本存在性判定，其余字段不解释含义。完整契约类（frozen dataclass、字段
 * 校验、SchemaSpec 形态）随 contracts 模块移植后收敛为同一类型，此处接口
 * 保持最小的数据形状镜像。
 */
export interface NodeContract {
  /** 契约版本（结点行为变更 = 契约升版；注册表据此判定版本是否存在）。 */
  readonly version: number;
  /** 安全档 0/1/2（默认 0 最严；随契约数据登记，注册表不解释）。 */
  readonly safety_tier: number;
  /** 输入 schema 声明（None = 不消费字段；随契约数据登记）。 */
  readonly input_schema?: unknown;
  /** 输出 schema 声明（None = 不产出字段；随契约数据登记）。 */
  readonly output_schema?: unknown;
}
