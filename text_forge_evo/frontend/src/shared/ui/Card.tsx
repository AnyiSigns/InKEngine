import { cn } from '../cn';

interface CardProps {
  className?: string;
  children: React.ReactNode;
}

/** 卡片容器：统一圆角/边框/底色。 */
export function Card({ className, children }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-[var(--radius)] border border-border bg-card text-card-foreground',
        className,
      )}
    >
      {children}
    </div>
  );
}
