/**
 * 脉冲状态行（A' 区）：消息流尾纯文字 faint + 呼吸脉冲点，无卡片容器。
 */

import { useState, useEffect } from 'react';

export interface PulseLineProps {
  text: string;
  color?: 'default' | 'approval' | 'warn';
}

export function PulseLine({ text, color = 'default' }: PulseLineProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const t = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(t);
  }, []);

  const dotColor = color === 'approval' ? 'text-[var(--ink-accent-approval)]' : color === 'warn' ? 'text-[var(--ink-status-warn)]' : 'text-[var(--ink-text-muted)]';

  return (
    <div className={`flex items-center gap-2 text-xs ink-text-faint transition-opacity duration-150 ${visible ? 'opacity-100' : 'opacity-0'} ${dotColor}`}>
      <span className="relative flex h-2 w-2">
        <span className="absolute inset-0 rounded-full bg-current opacity-75" />
        <span className="absolute inset-0 rounded-full bg-current animate-ping opacity-50" />
      </span>
      <span>{text}</span>
    </div>
  );
}
