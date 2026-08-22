import type { ReactNode } from 'react';

import { cn } from '../cn';

/** 表单字段：标签 + 控件（设置页表单统一形态）。 */
export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn('block space-y-1', className)}>
      <span className="block text-[11px] ink-text-muted">{label}</span>
      {children}
      {hint ? <span className="block text-[10px] ink-text-faint">{hint}</span> : null}
    </label>
  );
}

/** 表单控件统一样式（语义类取色，禁硬编码颜色）。 */
export const inputCls =
  'h-7 w-full rounded-md border px-2 text-xs bg-[var(--ink-bg-base)] focus:outline-none focus:border-[var(--ink-border-strong)]';

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className, ...rest } = props;
  return <input {...rest} className={cn(inputCls, className)} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const { className, children, ...rest } = props;
  return (
    <select {...rest} className={cn(inputCls, className)}>
      {children}
    </select>
  );
}
