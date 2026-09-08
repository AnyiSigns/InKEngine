import type { ComponentType } from 'react';

import type { BackendAdapter } from '@/shared/backend/backendAdapter';
import type { ProductShellChrome } from '@/app/shell/productView';
import { LedgerView } from './LedgerView';

/** 宿主缺省只读禁用后端（available:false；账本视图空态不崩）。 */
const disabledBackend = { available: false } as unknown as BackendAdapter;

/**
 * ledger_view ui 面入口（阶段 7b）：宿主 product chrome → LedgerView props
 * 映射。装配期经 pluginFaces.generated.ts 注册；后端不可用 = 空态。
 */
const LedgerViewAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const product = (props.product as ProductShellChrome | null | undefined) ?? {};
  const backend = (product.backend as BackendAdapter | undefined) ?? disabledBackend;
  return <LedgerView backend={backend} threadId={product.activeSessionId ?? ''} />;
};

export default LedgerViewAdapter;
