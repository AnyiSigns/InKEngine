import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { cn } from '../cn';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'xs' | 'sm' | 'md';
  children: ReactNode;
}

const VARIANTS = {
  primary: 'bg-primary text-primary-foreground hover:opacity-90',
  secondary: 'border border-border text-foreground hover:bg-muted/50',
  ghost: 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
} as const;

const SIZES = {
  xs: 'h-7 px-2.5 text-xs rounded-md',
  sm: 'h-8 px-3 text-[13px] rounded-md',
  md: 'h-9 px-4 text-sm rounded-lg',
} as const;

export function Button({
  variant = 'secondary',
  size = 'sm',
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center justify-center gap-1.5 font-medium transition-all duration-150 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
