/**
 * 图执行协议结构接口面（S1-c2：引擎留结构接口）。
 *
 * 引擎执行面（executor/harness/loop）经本面消费图结构：NodeLike/EdgeLike/
 * GraphLike/CompiledGraphLike 为执行协议最小结构面——Graph 是 model/graph 的
 * 受控自进化运行时对象（同一张持续进化的图，装配已是旧时代产物），具体类
 * implements 结构接口、同住 model/graph（model 零出边约束：不引外层接口）；
 * 图文档 DSL（NodeBinding 声明式绑定 + 序列化 + 指纹）同住 model/graph 随
 * Graph 留引擎。插件侧供给节点类型声明（graph_node kind）经装配通道注册进
 * 引擎池，图执行时按 type 名经 NodeTypeRegistryLike 解析出执行体。
 *
 * 本面只 re-export + 协议别名，不实现；行为由 model/graph 类实现与
 * graph/executor 执行链守护。
 */

export type { NodeFn, EdgeCondition, EdgeKind } from '../model/graph/graph_types.js';
export type {
  CompiledGraphLike,
  EdgeLike,
  GraphLike,
  NodeBindingLike,
  NodeContextLike,
  NodeTypeRegistryLike,
  EdgeConditionRegistryLike,
  SchemaSerializable,
} from '../model/graph/graph_types.js';
export type { GraphInit } from '../model/graph/graph.js';

/** 节点执行体结构面（NodeFn 的执行协议别名：节点 = 图的执行单元）。 */
export type NodeLike = import('../model/graph/graph_types.js').NodeFn;
