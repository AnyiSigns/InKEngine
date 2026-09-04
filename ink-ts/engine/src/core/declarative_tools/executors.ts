/**
 * 声明式工具执行体注册表（declarative_tools.py :762-844 移植）。
 *
 * 端点类型 → 执行体（宿主注入分发）：注册 = 插拔 U 盘——新增端点类型 =
 * 注册新执行体，声明式工具零改动；未注册端点类型 = 分发处显式拒绝
 * （fail-closed，不静默失败）。同名重复注册 = 覆盖（宿主启动按配置
 * 装配，配置驱动）。声明式定义登记表（工具名 → 定义）是执行体分发
 * 反查端点类型的来源（spec.name 反查定义）。
 *
 * 受控取回 url 档：按声明 retrieval 标记查受控执行体（注册键 =
 * meta.retrieval，声明驱动非按名写死）；file/text 档回落端点执行体。
 */
import { GraphDefinitionError } from '../errors.js';
import { ToolSpec } from '../llm/tools.js';
import { isAwaitable } from '../tool_pipeline/_types.js';
import { DeclarativeToolSpec } from './declarative_spec.js';
import { RETRIEVAL_CONTROLLED_FETCH } from './operations.js';

/**
 * 执行体签名：async (ctx, definition, args, approval) -> str。
 *
 * 第二参为声明式定义（DeclarativeToolSpec，非 ToolSpec）——dispatch 经
 * spec.name 反查定义后按定义端点/受控取回标记分发；approval 为审批
 * 决议（门禁/沙箱通过后的执行透传）。
 */
export type DeclarativeExecutor = (
  ctx: unknown,
  definition: DeclarativeToolSpec,
  args: Record<string, unknown>,
  approval: unknown,
) => string | Promise<string>;

/** 声明式工具执行体注册表（宿主注入分发）。 */
export class DeclarativeToolExecutors {
  readonly _executors: Map<string, DeclarativeExecutor> = new Map();
  /** 声明式定义登记表（工具名 → 定义）：执行体分发反查端点类型的来源。 */
  readonly _definitions: Map<string, DeclarativeToolSpec> = new Map();

  /** 注册端点执行体（同名重复注册 = 覆盖，配置驱动装配）。 */
  register(endpoint: string, executor: DeclarativeExecutor): void {
    if (typeof executor !== 'function') {
      throw new GraphDefinitionError(`执行体须为可调用对象: ${endpoint}`);
    }
    this._executors.set(String(endpoint), executor);
  }

  /** 按端点类型取执行体（未注册 = undefined）。 */
  get(endpoint: string): DeclarativeExecutor | undefined {
    return this._executors.get(String(endpoint));
  }

  /** 端点类型是否已注册执行体。 */
  has(endpoint: string): boolean {
    return this._executors.has(String(endpoint));
  }

  /**
   * 按端点类型分发执行（spec 须携带端点信息——声明式工具经
   * DeclarativeToolSpec 定义，执行体按 spec.name 反查定义后分发）。
   *
   * @param ctx 节点上下文（ToolPipeline.execute 透传）。
   * @param spec 引擎工具描述（name 反查声明式定义）。
   * @param args 调用参数。
   * @param approval 审批决议（门禁/沙箱通过后的执行透传）。
   * @throws GraphDefinitionError 未注册端点类型或工具无声明式定义——
   *   显式拒绝而非静默失败。
   */
  async dispatch(
    ctx: unknown,
    spec: ToolSpec,
    args: Record<string, unknown>,
    approval: unknown = null,
  ): Promise<string> {
    const definition = this._definitions.get(spec.name);
    if (definition === undefined) {
      throw new GraphDefinitionError(`工具 ${spec.name} 无声明式定义（未登记）`);
    }
    // 受控取回 url 档：按声明 retrieval 标记查受控执行体（注册键 =
    // meta.retrieval，声明驱动非按名写死）；file/text 档回落端点执行体
    const retrieval = definition.meta['retrieval'];
    const endpoint_key = definition.endpoint;
    let executor: DeclarativeExecutor | undefined;
    if (
      retrieval === RETRIEVAL_CONTROLLED_FETCH &&
      typeof args['url'] === 'string' &&
      Boolean(args['url'])
    ) {
      executor = this._executors.get(RETRIEVAL_CONTROLLED_FETCH);
      if (executor === undefined) {
        throw new GraphDefinitionError(
          `工具 ${spec.name} 的受控取回执行体未注册: ${RETRIEVAL_CONTROLLED_FETCH}（url 档不得回落端点执行体）`,
        );
      }
    } else {
      executor = this._executors.get(endpoint_key);
    }
    if (executor === undefined) {
      throw new GraphDefinitionError(`工具 ${spec.name} 的端点类型未注册执行体: ${endpoint_key}`);
    }
    const result = executor(ctx, definition, args, approval);
    const resolved = isAwaitable(result) ? await result : result;
    return String(resolved);
  }

  /** 登记声明式定义（执行体分发反查的注册来源）。 */
  register_definition(definition: DeclarativeToolSpec): void {
    this._definitions.set(definition.name, definition);
  }

  /** 注销声明式定义（卸载挂载工具/清理失效条目用；缺失静默）。 */
  unregister_definition(name: string): void {
    this._definitions.delete(name);
  }

  /** 声明式定义登记表快照（工具名 → 定义；镜像 Python 的 dict 拷贝）。 */
  get definitions(): Record<string, DeclarativeToolSpec> {
    return Object.fromEntries(this._definitions);
  }
}
