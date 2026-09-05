import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { cn } from '../cn';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'accent';
  size?: 'xs' | 'sm' | 'md';
  children: ReactNode;
}

/** 按钮：variant 全部经语义类取色（primary/secondary/ghost/accent），无硬编码颜色。 */
export function Button({ variant = 'secondary', size = 'sm', className, children, ...rest }: ButtonProps) {
  const variants = {
    primary: 'ink-btn-primary border border-transparent font-medium',
    secondary: 'ink-btn-secondary font-medium',
    ghost: 'border border-transparent ink-text-muted hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)]',
    // accent 语义槽只出现在审批/决策点（朱砂跟随主题 token）
    accent: 'ink-btn-accent font-medium',
  } as const;
  const sizes = {
    xs: 'h-6 px-2 text-[11px]',
    sm: 'h-7 px-2.5 text-[11px]',
    md: 'h-8 px-3.5 text-xs',
  } as const;
  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-lg transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
