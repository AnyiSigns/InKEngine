/**
 * Runtime LLM 链刷新 + 集状态恢复。
 *
 * 引擎 = 无常驻静态 Engine（无静态引擎态 = 常态）：rebuild_engine 不再产出
 * 常驻静态引擎，只负责刷新已解析宿主 LLM 链——宿主关停旧链/重解析后经
 * rebuild_engine 记录新链并显式关闭换下的旧链（模型变更旧连接池不悬置），
 * stop 时统一关停。回合执行面归 execution_runtime（执行主线按 run 装配独立
 * 执行引擎，不经本层构建）。
 *
 * _restore_set_state：链是权威记录——界面描述/harness/动态工具/事件类型/
 * 知识按最新组装形态重建运行时视图；恢复失败只跳过不击穿启动（回落基线）。
 */

import { DeclarativeToolSpec } from '../../core/declarative_tools/index.js';
import { EventTypeSpec } from '../../core/event_types/eventTypeSpec.js';
import { EntitySpec } from '../../core/entities/entities.js';
import { HarnessDefinition } from '../../core/harness/index.js';
import { KnowledgeSet } from '../../core/knowledge_set/index.js';
import type { AsyncLLM } from '../llm/_guard_types.js';
import { UISchemaValidator } from '../../core/ui_schema/uiSchema.js';
import type { AssemblyRecipe } from './_types.js';
import { RuntimeMechanisms } from './_runtime_mechanisms.js';

/** 引擎重建/集状态恢复基座。 */
export abstract class RuntimeRebuild extends RuntimeMechanisms {
  /** 刷新已解析宿主 LLM 链（无常驻静态引擎；llm 缺省 = 宿主解析）。
   *  换入新链时显式关闭旧链（模型变更后旧连接池不悬置；失败只跳过）。 */
  async rebuild_engine(llm?: AsyncLLM | null): Promise<void> {
    if (this._host === null || this._recipe === null) {
      throw new Error('运行时未装配（rebuild_engine 须在 boot 之后）');
    }
    const resolvedLlm = llm ?? (await this._host.resolve_llm());
    if (this.engine_llm !== null && this.engine_llm !== resolvedLlm) {
      try {
        await this.engine_llm.aclose();
      } catch {
        // 旧 LLM 链关闭失败（继续记录新链）
      }
    }
    this.engine_llm = resolvedLlm;
  }

  /** 从集补丁链组装恢复活跃态（重启/回退后集状态一致；链损坏回落基线）。
   *  各段恢复失败只跳过不击穿启动；失败原因逐段汇总到 _restore_diag
   *  （可观测：回落基线是显式降级而非静默吞错）。 */
  async _restore_set_state(recipe: AssemblyRecipe): Promise<void> {
    const diag: string[] = [...this._restore_diag];
    const chain = this.self_pipeline?.chain ?? null;
    if (chain === null) {
      this._restore_diag = [...diag, '集补丁链未装配（自指管线缺链），集状态恢复跳过'];
      return;
    }
    let state: Record<string, unknown>;
    try {
      state = (await chain.assemble()) as Record<string, unknown>;
    } catch (exc) {
      this._restore_diag = [...diag, `集状态组装失败（回落基线）: ${String(exc)}`];
      return;
    }
    const uiState = state['ui'];
    if (uiState && typeof uiState === 'object' && !Array.isArray(uiState)) {
      const ui = uiState as Record<string, unknown>;
      const spec = ui['boot.panel'] ?? ui[Object.keys(ui)[0] ?? ''];
      if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
        try {
          const violations = new UISchemaValidator().validate(spec, {
            allowed_components: recipe.ui_allowed_components,
            allowed_channels: recipe.ui_allowed_channels,
            allowed_theme_tokens: recipe.ui_allowed_theme_tokens,
          });
          if (violations.length === 0) {
            (this.introspection_service as unknown as { _sources: { ui_spec: Record<string, unknown> | null } })._sources.ui_spec = spec as Record<string, unknown>;
          } else {
            diag.push(`界面恢复未通过白名单校验（${violations.length} 项违规，回落基线）`);
          }
        } catch (exc) {
          diag.push(`界面恢复校验失败（跳过）: ${String(exc)}`);
        }
      }
    }
    const harnessState = state['harness'];
    if (harnessState && typeof harnessState === 'object') {
      const registry = this.harness_registry;
      if (registry === null) {
        diag.push('harness 段存在但注册表未装配（跳过恢复）');
      } else {
        for (const [name, data] of Object.entries(
          harnessState as Record<string, unknown>,
        )) {
          if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
          try {
            const parsed = HarnessDefinition.from_dict(data as never);
            registry.register(parsed);
          } catch (exc) {
            diag.push(`harness 恢复失败（跳过）: ${name} ${String(exc)}`);
          }
        }
      }
    }
    const toolsState = state['tools'];
    if (toolsState && typeof toolsState === 'object') {
      const registry = this.harness_registry;
      if (registry === null) {
        diag.push('工具段存在但 harness 注册表未装配（跳过恢复）');
      } else {
        for (const [name, toolData] of Object.entries(
          toolsState as Record<string, unknown>,
        )) {
          if (!toolData || typeof toolData !== 'object' || Array.isArray(toolData)) continue;
          try {
            const declarative = DeclarativeToolSpec.from_dict(toolData as never);
            registry.declarative.register_definition(declarative);
            this.tool_registry[name] = declarative.to_spec();
          } catch (exc) {
            diag.push(`工具恢复失败（跳过）: ${name} ${String(exc)}`);
          }
        }
      }
    }
    const eventState = state['event_types'];
    if (eventState && typeof eventState === 'object') {
      const registry = this.event_type_registry;
      if (registry === null) {
        diag.push('事件类型段存在但注册表未装配（跳过恢复）');
      } else {
        const existing = new Set(registry.names());
        for (const [name, specData] of Object.entries(
          eventState as Record<string, unknown>,
        )) {
          if (!specData || typeof specData !== 'object' || Array.isArray(specData)) continue;
          if (existing.has(name)) continue;
          try {
            registry.register(EventTypeSpec.from_dict(specData as never));
          } catch (exc) {
            diag.push(`事件类型恢复失败（跳过）: ${name} ${String(exc)}`);
          }
        }
      }
    }
    const entityState = state['entities'];
    if (entityState && typeof entityState === 'object') {
      const registry = this.entity_registry;
      if (registry === null) {
        diag.push('实体段存在但实体注册表未装配（跳过恢复）');
      } else {
        const existing = new Set(registry.names());
        for (const [entity_id, specData] of Object.entries(
          entityState as Record<string, unknown>,
        )) {
          if (!specData || typeof specData !== 'object' || Array.isArray(specData)) continue;
          let spec: EntitySpec | null = null;
          try {
            spec = EntitySpec.from_dict(specData as never);
          } catch (exc) {
            diag.push(`实体反序列化失败（跳过）: ${entity_id} ${String(exc)}`);
            continue;
          }
          try {
            if (existing.has(entity_id)) registry.replace(spec);
            else registry.register(spec);
          } catch (exc) {
            diag.push(`实体恢复失败（跳过）: ${entity_id} ${String(exc)}`);
          }
        }
      }
    }
    const knowledgeState = state['knowledge'];
    if (
      knowledgeState
      && typeof knowledgeState === 'object'
      && !Array.isArray(knowledgeState)
      && Object.keys(knowledgeState).length > 0
    ) {
      try {
        // 知识集内存链按集状态重建（权威 = 集补丁链）
        const rebuilt = KnowledgeSet.from_export(
          recipe.set_id,
          { base: { entries: knowledgeState }, patches: [] },
          { storage: this.storage as never },
        );
        // 变更钩子重挂：from_export 新建实例不带 on_mutation
        if (this._knowledge_mutation_hook !== null) {
          (rebuilt as unknown as { on_mutation: (() => void) | null }).on_mutation =
            this._knowledge_mutation_hook;
        }
        this.knowledge_set = rebuilt;
        // 内省视图同步指向恢复后的集实例
        if (this.introspection_service !== null) {
          (this.introspection_service as unknown as { _sources: { knowledge_set: KnowledgeSet } })._sources.knowledge_set = rebuilt;
        }
      } catch (exc) {
        diag.push(`知识集恢复失败（跳过）: ${String(exc)}`);
      }
    }
    this._restore_diag = diag;
  }
}