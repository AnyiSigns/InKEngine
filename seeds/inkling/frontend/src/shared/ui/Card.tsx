import type { ReactNode } from 'react';

import { cn } from '../cn';

/** 面板容器：语义类取色（ink-panel），禁硬编码颜色。 */
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('ink-panel rounded-md p-3', className)}>{children}</div>;
}
