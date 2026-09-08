import { createLiveArchitectureBackend } from '@app/views/architecture/mockBackend';
import type { ArchitectureBackend } from '@app/views/architecture/backend';
import type { BackendAdapter } from '@/shared/backend/backendAdapter';
import { ArchitectureView } from './ArchitectureView';

/**
 * settings_architecture ui 面入口：架构只读投影。spec faces.ui.access
 * store:["backend"]——壳装配层按声明切片注入共享 BackendAdapter，本入口
 * 以其构建 live ArchitectureBackend；缺注入（壳外直接挂载）= 组件缺省
 * 回落自建（dev 夹具兜底）。
 */
export default function ArchitectureAdapter(props: Record<string, unknown>) {
  const adapter = props.backend as BackendAdapter | undefined;
  const backend: ArchitectureBackend | undefined = adapter ? createLiveArchitectureBackend(adapter) : undefined;
  return <ArchitectureView backend={backend} />;
}
