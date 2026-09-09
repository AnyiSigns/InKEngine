/**
 * 设置节图标映射（派生清单 settings_section.icon 字符串 → lucide 组件）。
 *
 * 图标名真源 = 各面板插件 spec data.settings_section.icon；未登记名回落为
 * 「标签前两字」文字 chip（与模型节既有形态一致，避免图裂留空）。
 */

import type { ReactNode } from 'react';
import {
  BookOpen,
  Database,
  Eye,
  FileClock,
  Network,
  Package,
  PencilRuler,
  PlugZap,
  Server,
  Settings2,
  Shield,
  ShieldCheck,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  settings2: Settings2,
  plug_zap: PlugZap,
  book_open: BookOpen,
  network: Network,
  server: Server,
  wrench: Wrench,
  shield: Shield,
  shield_check: ShieldCheck,
  pencil_ruler: PencilRuler,
  database: Database,
  eye: Eye,
  file_clock: FileClock,
  package: Package,
};

export function sectionIcon(icon: string | undefined, label: string): ReactNode {
  if (!icon) return <span className="text-[11px] font-medium leading-none">{label.slice(0, 2)}</span>;
  const Icon = ICONS[icon];
  if (!Icon) return <span className="text-[11px] font-medium leading-none">{label.slice(0, 2)}</span>;
  return <Icon size={16} strokeWidth={1.6} aria-hidden />;
}
