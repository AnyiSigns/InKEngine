/**
 * 节点类型 / 边条件注册表（core/registry.py 移植）：按名解析的声明式图定义来源。
 *
 * 图节点可以不经注册表直接以函数形式挂载（Graph.add_node），注册表面向
 * 「声明式规格驱动实例化」的场景：画布/清单里的节点只携带类型名与配置，
 * 建图时按类型解析工厂、把配置透传给工厂生成节点执行函数——同一类型
 * 不同配置实例化出互不干扰的节点；条件边同理，判定函数按条件名解析。
 *
 * 语义边界：类型名/条件名是不透明字符串，注册表不解释任何含义；哪些
 * 名字存在、如何构造执行/判定函数，全部由注册方（宿主/领域包）决定。
 * 重复注册视为编程错误（覆盖会静默替换既有语义），建图期显式拒绝。
 *
 * 生命周期契约（跨引擎重建的实时性）：类型只注册一次（重复登记拒绝），
 * 工厂与其产出的节点执行函数可跨引擎重建存活——工厂禁止捕获装配期
 * 可变状态快照（工具表/流水线/装配源等随挂载/补丁演化而变化的装配
 * 产物）。正确形态 = 实时引用：以 registry 实例为键持有最新装配源，
 * 节点执行时现取，重建后新装配源对既有节点立即可见。快照闭包 = 重建后
 * 节点读到过期装配源（见 runtime GraphRecipeContext 契约）。
 */

import { GraphDefinitionError } from '../errors.js';
import type {
  EdgeCondition,
  NodeContract,
  NodeFactory,
  NodeFn,
} from './registry_types.js';

export type { EdgeCondition, NodeContract, NodeFactory, NodeFn };

/**
 * 节点类型注册表（进程内单表，注册方在建图前完成登记）。
 *
 * 并发说明：注册通常发生在启动装配期（单线程），解析发生在建图期
 * （可并发）；解析只读表无写冲突，无需加锁。注册表支持多个实例
 * （宿主可为不同图域各自建表，互不干扰），模块级单例只是惯例用法。
 *
 * 契约登记：类型可随注册携带结点契约（可选参数，旧调用形态不变）；
 * 契约是数据（随类型登记，供契约查询与链接校验的版本存在性判定），
 * 不参与节点实例化——无契约类型 = 无契约结点（不参与组装，仅可被
 * 手绘图引用，旧行为零破坏）。
 */
export class NodeTypeRegistry {
  private _factories: Map<string, NodeFactory> = new Map();
  private _contracts: Map<string, NodeContract> = new Map();

  /**
   * 登记类型 → 工厂（重复登记抛 GraphDefinitionError，防静默覆盖）。
   *
   * @param type_name 类型名（不透明字符串，注册表不解释含义）。
   * @param factory 节点工厂（配置 → 节点执行函数）。
   * @param contract 结点契约（可选；缺省 = 无契约结点，不参与组装，
   *   仅可被手绘图引用——旧调用形态完全不变）。
   */
  register(type_name: string, factory: NodeFactory, contract?: NodeContract): void {
    if (this._factories.has(type_name)) {
      throw new GraphDefinitionError(`节点类型重复注册: ${type_name}`);
    }
    this._factories.set(type_name, factory);
    if (contract !== undefined) {
      this._contracts.set(type_name, contract);
    }
  }

  /**
   * 按类型名实例化节点执行函数（未知类型抛 GraphDefinitionError）。
   *
   * 配置经浅拷贝透传工厂：同一工厂被多个节点引用时，节点内对配置的
   * 就地改写不会互相污染（建图期一次性调用，拷贝开销可忽略）。
   * 契约不参与实例化——契约是数据，执行体仍是工厂产出的函数。
   */
  create(type_name: string, config?: Record<string, unknown>): NodeFn {
    const factory = this._factories.get(type_name);
    if (factory === undefined) {
      throw new GraphDefinitionError(`未知节点类型: ${type_name}`);
    }
    return factory({ ...(config ?? {}) });
  }

  /**
   * 按类型名取已登记契约（未登记契约/未知类型 = undefined）。
   *
   * 契约随类型登记（register 的 contract 参数）；查询供组装期候选收集
   * 与链接校验使用。契约与工厂同表同生命周期——类型是唯一集，契约是
   * 类型声明的数据部分。
   */
  contract_for(type_name: string): NodeContract | undefined {
    return this._contracts.get(type_name);
  }

  /**
   * 该类型已登记的契约版本集（无契约/未知类型 = 空集）。
   *
   * 供链接校验的契约版本存在性判定（引用的契约版本须已登记——旧图定义
   * 可解析）；当前登记形态只保留最新契约版本，补丁链版本快照接入后由
   * 调用方合并历史版本集传入校验器。
   */
  contract_versions(type_name: string): ReadonlySet<number> {
    const contract = this._contracts.get(type_name);
    if (contract === undefined) return new Set();
    return new Set([contract.version]);
  }

  /** 该类型是否登记了契约（数据部分随类型登记）。 */
  has_contract(type_name: string): boolean {
    return this._contracts.has(type_name);
  }

  /** 该类型名是否已登记工厂。 */
  has(type_name: string): boolean {
    return this._factories.has(type_name);
  }

  /** 已注册类型名（插入序，供校验/展示；内容不解释）。 */
  types(): readonly string[] {
    return [...this._factories.keys()];
  }

  /** 已注册类型数（镜像 Python __len__）。 */
  get size(): number {
    return this._factories.size;
  }
}

/**
 * 条件边注册表：条件名 → 判定函数（声明式图定义的边引用）。
 *
 * 与 NodeTypeRegistry 同构：图定义数据里的条件边只携带条件名，建图/重放
 * 时按名解析判定函数（async (ctx) -> bool）。未注册的条件名在建图期拒绝
 * （GraphDefinitionError），不等到运行时判定才暴露。
 */
export class EdgeConditionRegistry {
  private _conditions: Map<string, EdgeCondition> = new Map();

  /** 登记条件名 → 判定函数（重复登记抛错，防静默覆盖语义）。 */
  register(name: string, condition: EdgeCondition): void {
    if (this._conditions.has(name)) {
      throw new GraphDefinitionError(`条件名重复注册: ${name}`);
    }
    this._conditions.set(name, condition);
  }

  /** 按条件名取判定函数（未知条件抛 GraphDefinitionError）。 */
  create(name: string): EdgeCondition {
    const condition = this._conditions.get(name);
    if (condition === undefined) {
      throw new GraphDefinitionError(`未知条件: ${name}`);
    }
    return condition;
  }

  /** 该条件名是否已登记。 */
  has(name: string): boolean {
    return this._conditions.has(name);
  }

  /** 已注册条件名（插入序，供校验/展示）。 */
  names(): readonly string[] {
    return [...this._conditions.keys()];
  }

  /** 已注册条件数（镜像 Python __len__）。 */
  get size(): number {
    return this._conditions.size;
  }
}

/**
 * 建图注册表捆绑（引擎级依赖注入）。
 *
 * 图定义数据（spawn 子图/计划条件/harness 图）的解析需要节点类型与边条件
 * 两套注册表，捆绑注入避免分散传递、保证两表同源；缺省各自建空表（每次
 * 构造均新建独立表，调用方按需填充）。
 */
export class GraphRegistries {
  readonly nodes: NodeTypeRegistry;
  readonly edges: EdgeConditionRegistry;

  constructor(
    nodes: NodeTypeRegistry = new NodeTypeRegistry(),
    edges: EdgeConditionRegistry = new EdgeConditionRegistry(),
  ) {
    this.nodes = nodes;
    this.edges = edges;
  }
}
