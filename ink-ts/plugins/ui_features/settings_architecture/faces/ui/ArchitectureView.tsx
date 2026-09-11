import { useState } from 'react';

import { createLiveArchitectureBackend } from '@app/views/architecture/mockBackend';
import type { ArchitectureBackend } from '@app/views/architecture/backend';
import { EdgeEvidenceTab } from './tabs/EdgeEvidenceTab';
import styles from './architecture.module.css';

/** 架构视图容器：边证据（只读投影；结点池 tab 已随 pool_governance 退役）。 */
export function ArchitectureView({
  backend = createLiveArchitectureBackend(),
}: {
  backend?: ArchitectureBackend;
}) {
  // 稳定后端实例：默认参数每次渲染新建对象，直接传给子 tab 会使其
  // useEffect[backend] 每次渲染重跑（无限重渲循环）。
  const [instance] = useState(() => backend);

  return (
    <div className={styles.root} data-view="architecture">
      <div className={styles.body}>
        <EdgeEvidenceTab backend={instance} />
      </div>
    </div>
  );
}