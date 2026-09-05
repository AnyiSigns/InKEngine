/**
 * @ink-ts/engine 公共面自证：
 * - engine/src/index.ts 各分组关键符号存在（typeof/类型引用检查）；
 * - 经包自引用 ``import ... from '@ink-ts/engine'`` 验证 package.json
 *   "exports"（→ ./src/index.ts）映射在 tsx/vitest 下可解析。
 */
import { describe, expect, it } from 'vitest';

import * as engine from '@ink-ts/engine';

describe('engine 公共面分组导出', () => {
  it('1. 运行时装配：Runtime/RuntimeConfig 等', () => {
    expect(engine.Runtime).toBeTypeOf('function');
    expect(engine.AssemblyRecipe).toBeTypeOf('function');
    expect(engine.RuntimeState).toBeTypeOf('object');
    expect(engine.set_runtime_clock).toBeTypeOf('function');
    const cfg: engine.RuntimeConfigInit | null = null;
    expect(cfg).toBeNull();
  });

  it('2.1 图/补丁/执行器/运行结果', () => {
    expect(engine.Graph).toBeTypeOf('function');
    expect(engine.CompiledGraph).toBeTypeOf('function');
    expect(engine.Edge).toBeTypeOf('function');
    expect(engine.PatchChain).toBeTypeOf('function');
    expect(engine.Engine).toBeTypeOf('function');
    expect(engine.run_subgraph).toBeTypeOf('function');
    expect(engine.RunOptions).toBeTypeOf('function');
    expect(engine.RunResult).toBeTypeOf('function');
  });

  it('2.2 事件/状态/审批/自指应用', () => {
    expect(engine.EngineEvent).toBeTypeOf('function');
    expect(engine.CollectorTransport).toBeTypeOf('function');
    expect(engine.StateSchema).toBeTypeOf('function');
    expect(engine.REDUCER_REGISTRY).toBeTypeOf('object');
    expect(engine.approve_before_execute).toBeTypeOf('function');
    expect(engine.SelfApplicationPipeline).toBeTypeOf('function');
    expect(engine.GuardedStorage).toBeTypeOf('function');
    expect(engine.SetPatchChain).toBeTypeOf('function');
    expect(engine.DEFAULT_APPROVAL_LEVELS).toBeTypeOf('object');
  });

  it('2.3 存储 seam/LLM 契约', () => {
    expect(engine.validate_chain).toBeTypeOf('function');
    expect(engine.CheckpointRecord).toBeTypeOf('function');
    expect(engine.AsyncLLM).toBeTypeOf('function');
    expect(engine.ModelChain).toBeTypeOf('function');
    expect(engine.CachingLLM).toBeTypeOf('function');
    const fn = (engine.Message as unknown) ?? null;
    expect(fn).not.toBeNull();
  });

  it('2.4 声明式工具/编排/环境/schema/ui', () => {
    expect(engine.endpoint_registry).toBeTypeOf('object');
    expect(engine.EndpointTypeSpec).toBeTypeOf('function');
    expect(engine.DeclarativeToolSpec).toBeTypeOf('function');
    expect(engine.build_declarative_pipeline).toBeTypeOf('function');
    expect(engine.ToolSelector).toBeTypeOf('function');
    expect(engine.ToolVectorIndex).toBeTypeOf('function');
    expect(engine.EnvironmentSpec).toBeTypeOf('function');
    expect(engine.SchemaValidator).toBeTypeOf('function');
    expect(engine.UISchemaValidator).toBeTypeOf('function');
    expect(engine.VALID_KINDS).toBeTypeOf('object');
  });

  it('2.5 权限沙箱安全类型/链接校验/事件类型/恢复中断预算/结点契约', () => {
    expect(engine.PermissionGate).toBeTypeOf('function');
    expect(engine.NetworkPolicySandbox).toBeTypeOf('function');
    expect(engine.FileSandbox).toBeTypeOf('function');
    expect(engine.ProcessSandbox).toBeTypeOf('function');
    expect(engine.validate_link).toBeTypeOf('function');
    expect(engine.EventTypeRegistry).toBeTypeOf('function');
    expect(engine.resolve_resume).toBeTypeOf('function');
    expect(engine.InterruptCoordinator).toBeTypeOf('function');
    expect(engine.BudgetManager).toBeTypeOf('function');
    expect(engine.NodeContract).toBeTypeOf('function');
  });

  it('2.6 引擎错误类型族', () => {
    expect(engine.EngineError).toBeTypeOf('function');
    expect(engine.GraphDefinitionError).toBeTypeOf('function');
    expect(engine.SandboxViolation).toBeTypeOf('function');
    expect(engine.BudgetExceededError).toBeTypeOf('function');
  });

  it('3. adapters 工厂面（存储/LLM 注册/MCP）', () => {
    expect(engine.create_storage).toBeTypeOf('function');
    expect(engine.MemoryStorage).toBeTypeOf('function');
    expect(engine.register_adapter).toBeTypeOf('function');
    expect(engine.create_llm).toBeTypeOf('function');
    expect(engine.McpClientManager).toBeTypeOf('function');
    expect(engine.StdioMcpTransport).toBeTypeOf('function');
    const seam: engine.McpSpawnSeam | null = null;
    expect(seam).toBeNull();
  });
});
