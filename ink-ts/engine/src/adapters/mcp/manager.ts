/**
 * MCP 连接管理器：会话生命周期 + 工具导入 + 分发执行器注册（镜像 Python
 * mcp_client.py 的 McpClientManager / register_mcp_executor）。
 *
 * 会话按 server_id 路由：connect 打开并登记；dispatch（声明式工具执行体）
 * 按定义中的 server_id 反查会话后转发调用；会话缺失 = fail-closed 拒绝
 * （未挂载的 server 不可被调用）。导入工具经 vetting 闸门过滤，被拒工具
 * 不进入工具表。
 *
 * 观察模式接线（E-P4/ENG6-3）：提供 vetting 且工具 VERIFIED 后并入
 * shadow_run——影子执行探针（写虚拟化 + 快照 diff，结果恒标记 untrusted）
 * + 观察证据累积（shadow_evidence 可查）。探针参数只取带默认值的可选
 * 字段（绝不臆造必填参数）；探针失败只记证据不阻断导入。shadow_workdir
 * 提供 = 以真实工作目录为影子模板；缺省 = 空探针模板（远端调用无本地
 * 写面，仅记录调用成败证据）。
 */
import { GraphDefinitionError } from '../../core/errors.js';
import { EndpointType } from '../../core/declarative_tools/endpoint_types.js';
import type { DeclarativeToolSpec } from '../../core/declarative_tools/declarative_spec.js';
import type { DeclarativeToolExecutors } from '../../core/declarative_tools/executors.js';
import {
  ShadowRunResult,
  ToolSource,
  VettingVerdict,
  type ShadowExecutor,
} from '../../core/tool_vetting/tool_vetting.js';
import { McpToolImportError } from './_errors.js';
import { create_node_fs_seam } from './_fs_seam.js';
import { build_mcp_manifest, convert_mcp_tool, probe_args_from_schema } from './convert.js';
import { BUILTIN_MCP_SERVERS, builtin_mcp_server_config } from './registry.js';
import { SdkSession, type McpSessionHandle } from './session.js';
import { AsyncLock, SupervisedStdioSession, type SessionOpener } from './supervised.js';
import type { McpServerConfig } from './config.js';

/** vetting 闸门的调用面（真实 ToolVetting 或测试桩均满足）。 */
export interface McpVettingLike {
  vet(manifest: unknown): Promise<{ verdict: string; reason?: string }>;
  shadow_run(
    executor: ShadowExecutor,
    args: Record<string, unknown>,
    opts: { workdir: string },
  ): Promise<ShadowRunResult>;
}

interface ImportToolsOptions {
  source?: string;
  vetting?: McpVettingLike | null;
  signature?: string | null;
  shadow_workdir?: string | null;
}

/** MCP 连接管理器（会话生命周期 + 工具导入 + 分发执行器注册）。 */
export class McpClientManager {
  _sessions: Map<string, McpSessionHandle> = new Map();
  _signatures: Map<string, string | null> = new Map();
  _imported: Map<string, Set<string>> = new Map();
  // 观察证据累积（E-P4）：工具名 → 影子运行观察结果（untrusted 行为证据，
  // 信任进阶的输入；key = "<server_id>:<tool_name>"）
  _shadow_evidence: Record<string, Record<string, unknown>> = {};
  private readonly _lock = new AsyncLock();

  /** 会话打开 seam（默认 SdkSession.open；测试注入假打开器）。 */
  _sdk_open: SessionOpener = async (config: McpServerConfig) =>
    await SdkSession.open(config);

  /** 观察模式影子模板的 fs seam（node:fs 后端；写虚拟化的宿主注入面）。 */
  readonly _fs = create_node_fs_seam();

  /**
   * 观察证据查询（影子运行结果：untrusted 行为证据，不作信任依据）。
   * server_id 缺省 = 全量；指定 = 该 server 的工具观察结果。
   */
  shadow_evidence(server_id?: string | null): Record<string, Record<string, unknown>> {
    if (server_id === null || server_id === undefined) {
      return { ...this._shadow_evidence };
    }
    const prefix = `${server_id}:`;
    const out: Record<string, Record<string, unknown>> = {};
    for (const [key, value] of Object.entries(this._shadow_evidence)) {
      if (key.startsWith(prefix)) out[key] = value;
    }
    return out;
  }

  /** 已连接 server 标识清单（会话路由密钥，只读查询免内部状态外露）。 */
  list_servers(): string[] {
    return [...this._sessions.keys()];
  }

  /** 某 server 最近一次导入的工具名集合（卸载清理与重挂载差量的依据）。 */
  imported_tools(server_id: string): Set<string> {
    return new Set(this._imported.get(server_id) ?? []);
  }

  /** 登记已就绪会话（测试桩/宿主预建会话均可注入；已有活动会话显式拒绝）。 */
  register_session(server_id: string, handle: McpSessionHandle): void {
    if (this._sessions.has(server_id)) {
      throw new McpToolImportError(
        `MCP server 已有活动会话: ${server_id}（须先断开再登记）`,
      );
    }
    this._sessions.set(server_id, handle);
  }

  /** 按配置打开会话并登记（重复连接关闭旧会话后重建；stdio 自动包监督）。 */
  async connect(config: McpServerConfig): Promise<McpSessionHandle> {
    const handle = await this._serialized(async () => {
      const old = this._sessions.get(config.id);
      if (old !== undefined) {
        await old.aclose();
        this._sessions.delete(config.id);
      }
      try {
        let session = await this._sdk_open(config);
        if (config.transport === 'stdio') {
          // stdio 传输 = 进程生命周期绑定：包一层进程监督（崩溃探测 + 拉起；
          // 拉起打开器复用本管理器 seam，测试可整体替换）
          session = new SupervisedStdioSession(config, {
            initial: session,
            opener: this._sdk_open,
          });
        }
        this._sessions.set(config.id, session);
        return session;
      } catch (exc) {
        this._sessions.delete(config.id);
        throw exc;
      }
    });
    this._signatures.set(config.id, config.signature);
    return handle;
  }

  /** 按内置注册表连接（宿主只传环境连接位；未定义 server_id fail-closed）。 */
  async connect_builtin(
    server_id: string,
    overrides: Record<string, unknown> = {},
  ): Promise<McpSessionHandle> {
    const config = builtin_mcp_server_config(server_id, overrides);
    if (config === null) {
      throw new McpToolImportError(
        `内置 MCP server 未定义: ${server_id}（注册表仅含 ${Object.keys(
          BUILTIN_MCP_SERVERS,
        ).sort().join(', ')}）`,
      );
    }
    return await this.connect(config);
  }

  /** 关闭并注销会话（缺省返回 False，不抛错）。 */
  async disconnect(server_id: string): Promise<boolean> {
    let handle: McpSessionHandle | undefined;
    await this._serialized(async () => {
      handle = this._sessions.get(server_id);
      this._sessions.delete(server_id);
      this._signatures.delete(server_id);
    });
    if (handle === undefined) return false;
    await handle.aclose();
    return true;
  }

  /** 关闭全部会话（宿主优雅退出前调用，幂等；单个关闭失败不阻断其余）。 */
  async close_all(): Promise<void> {
    const handles: McpSessionHandle[] = await this._serialized(async () => {
      const snapshot = [...this._sessions.values()];
      this._sessions.clear();
      this._signatures.clear();
      return snapshot;
    });
    for (const handle of handles) {
      try {
        await handle.aclose();
      } catch {
        // 单会话关闭失败不阻断其余
      }
    }
  }

  /**
   * 列出并转换 server 工具为声明式定义（必经 vetting 闸门过滤）。vetting
   * 为 null = 跳过审查（挂载审批已在提案流程完成）；提供时逐工具生成清单
   * 并 vet，仅 VERIFIED 通过——REVIEW（静态审查命中，语义 = 需人工确认，
   * 不自动放行）与 REJECTED 同样不进入工具表（fail-closed）。
   */
  async import_tools(
    server_id: string,
    opts: ImportToolsOptions = {},
  ): Promise<DeclarativeToolSpec[]> {
    const vetting = opts.vetting ?? null;
    const source = opts.source ?? ToolSource.UNKNOWN;
    const handle = this._sessions.get(server_id);
    if (handle === undefined) {
      throw new McpToolImportError(`MCP server 未连接: ${server_id}`);
    }
    let signature = opts.signature;
    if (signature === null || signature === undefined) {
      signature = this._signatures.get(server_id) ?? null;
    }
    const rawTools = await handle.list_tools();
    const specs: DeclarativeToolSpec[] = [];
    let shadowTemplate: string | null = null;
    try {
      if (vetting !== null && (opts.shadow_workdir ?? null) === null) {
        // 无本地工作目录语义：空探针模板（拷贝开销可忽略，探针只记录
        // 远端调用成败行为证据）
        shadowTemplate = this._fs.mkdtemp('forge-shadow-probe-');
      }
      const probeWorkdir =
        (opts.shadow_workdir ?? null) !== null
          ? (opts.shadow_workdir as string)
          : shadowTemplate;
      for (const raw of rawTools) {
        let spec: DeclarativeToolSpec;
        try {
          spec = convert_mcp_tool(server_id, raw);
        } catch {
          // 协议违规工具（缺 name）逐项跳过并保留合法项，不击穿整次导入
          continue;
        }
        if (vetting !== null) {
          const verdict = await vetting.vet(
            build_mcp_manifest(server_id, raw, {
              source,
              signature,
            }),
          );
          if (verdict.verdict !== VettingVerdict.VERIFIED) {
            // 未放行不导入（REVIEW 语义 = 需人工确认，不自动放行）
            continue;
          }
          await this._observe_shadow(vetting, handle, spec, {
            workdir: probeWorkdir,
          });
        }
        specs.push(spec);
      }
    } finally {
      if (shadowTemplate !== null) {
        this._fs.rmtree(shadowTemplate, true);
      }
    }
    this._imported.set(server_id, new Set(specs.map((spec) => spec.name)));
    return specs;
  }

  /** 观察模式探针：影子执行（写虚拟化 + untrusted）→ 证据累积。 */
  private async _observe_shadow(
    vetting: McpVettingLike,
    handle: McpSessionHandle,
    spec: DeclarativeToolSpec,
    opts: { workdir: string | null },
  ): Promise<void> {
    const serverId = spec.endpoint_config['server_id'];
    const probeArgs = probe_args_from_schema(spec.parameters);

    const probeExecutor: ShadowExecutor = async () => {
      return await handle.call_tool(spec.name, probeArgs);
    };

    let evidence: Record<string, unknown>;
    try {
      let observation: ShadowRunResult;
      if (opts.workdir === null) {
        observation = new ShadowRunResult({
          ok: false,
          error: '影子工作区未提供（探针跳过）',
        });
      } else {
        observation = await vetting.shadow_run(probeExecutor, probeArgs, {
          workdir: opts.workdir,
        });
      }
      evidence = {
        ok: observation.ok,
        writes: observation.writes.map((write) => ({
          path: write.path,
          operation: write.operation,
          size: write.size,
        })),
        error: observation.error,
        untrusted: observation.untrusted,
        output_preview: observation.output.slice(0, 500),
      };
    } catch (exc) {
      evidence = {
        ok: false,
        error: exc instanceof Error ? exc.message : String(exc),
        untrusted: true,
      };
    }
    this._shadow_evidence[`${serverId}:${spec.name}`] = evidence;
  }

  /** 声明式工具执行体（端点 = MCP）：按 server_id 路由会话转发调用。 */
  async dispatch(
    ctx: unknown,
    definition: DeclarativeToolSpec,
    args: Record<string, unknown>,
    approval: unknown = null,
  ): Promise<string> {
    const serverId = definition.endpoint_config['server_id'];
    if (typeof serverId !== 'string' || serverId === '') {
      throw new GraphDefinitionError(
        `工具 ${definition.name} 的 MCP 端点缺 server_id`,
      );
    }
    const handle = this._sessions.get(serverId);
    if (handle === undefined) {
      throw new GraphDefinitionError(
        `MCP server 未连接，调用被拒: ${serverId}（工具 ${definition.name}）`,
      );
    }
    return await handle.call_tool(definition.name, args ?? {});
  }

  /** 会话表操作的互斥化（连接/断开/全关共享状态串行）。 */
  private async _serialized<T>(fn: () => Promise<T>): Promise<T> {
    return await this._lock.acquire_run<T>(fn);
  }
}

/** 把 MCP 分发执行器注册进声明式执行体注册表（宿主装配时调用一次）。 */
export function register_mcp_executor(
  executors: DeclarativeToolExecutors,
  manager: McpClientManager,
): void {
  executors.register(
    EndpointType.MCP,
    (ctx, definition, args, approval) =>
      manager.dispatch(ctx, definition, args, approval),
  );
}
