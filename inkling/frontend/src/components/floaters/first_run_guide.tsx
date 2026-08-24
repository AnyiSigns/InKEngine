/**
 * 首启引导（首次启动的全屏引导浮层）：数据目录 / 模型配置 / 权限默认档。
 *
 * 展示条件 = 后端状态 first_run（宿主侧首启标记未落位）；关闭 = 宿主
 * 落标记（firstRunDismiss），此后不再展示。内容只做「三点说明 + 入口
 * 指向」，不承载复杂交互——复杂配置仍走既有设置页各节。
 */

import { CheckCircle2, Database, KeyRound, ShieldCheck } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import type { BackendAdapter } from '@/shared/backend/backendAdapter';

interface FirstRunGuideProps {
  backend: BackendAdapter | null;
  onDismissed: () => void;
}

/** 引导三点（数据目录/模型配置/权限默认档的落点说明）。 */
const GUIDE_POINTS: Array<{ icon: typeof Database; title: string; body: string }> = [
  {
    icon: Database,
    title: '数据全部在本地',
    body: '会话、知识、记忆与补丁链保存在本机数据目录；一键导出（管理台 → 备份）是唯一的保险，磁盘故障可随时恢复。',
  },
  {
    icon: KeyRound,
    title: '模型由你配置',
    body: '设置页「应用能力」接入你自己的模型端点（本地 Ollama 或自带服务）；未配置时先以离线形态使用，配置后即恢复完整能力。',
  },
  {
    icon: ShieldCheck,
    title: '权限默认克制',
    body: '文件/网络/系统操作出厂按最小必要档位放行，高风险动作走审批卡；权限档可在设置页「安全信任」随时调整。',
  },
];

export function FirstRunGuide({ backend, onDismissed }: FirstRunGuideProps) {
  const dismiss = (): void => {
    if (backend?.available) {
      void backend
        .firstRunDismiss()
        .then(onDismissed)
        .catch(() => onDismissed());
    } else {
      onDismissed();
    }
  };

  return (
    <div className="first-run-guide" role="dialog" aria-label="首次启动引导">
      <div className="first-run-guide__card">
        <div className="first-run-guide__head">
          <h1 className="first-run-guide__title">欢迎使用 InKling</h1>
          <p className="first-run-guide__subtitle">
            你用得越多，它越懂你的领域。三个要点先交代清楚：
          </p>
        </div>
        <div className="first-run-guide__points">
          {GUIDE_POINTS.map(({ icon: Icon, title, body }) => (
            <div className="first-run-guide__point" key={title}>
              <Icon className="first-run-guide__point-icon" size={20} aria-hidden />
              <div className="first-run-guide__point-text">
                <div className="first-run-guide__point-title">{title}</div>
                <div className="first-run-guide__point-body">{body}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="first-run-guide__actions">
          <Button variant="primary" onClick={dismiss}>
            <CheckCircle2 size={16} aria-hidden />
            开始使用
          </Button>
        </div>
      </div>
    </div>
  );
}
