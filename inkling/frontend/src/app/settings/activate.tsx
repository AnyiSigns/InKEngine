/**
 * 设置页激活入口（对外固定签名：activate(): void）。
 *
 * 内含 registerSettingsSections：注册 9 节（模型/应用能力/生长治理/
 * 安全信任/连接/环境容器/语音/外观/关于）；集成 agent 接线激活点。
 */

import { Info, Paintbrush, PlugZap, ShieldCheck, Sparkles, Volume2 } from 'lucide-react';

import { ModelSection } from './sections/model_section';
import { CapabilitySection } from './sections/capability_section';
import { GrowthSection } from './sections/growth_section';
import { SecuritySection } from './sections/security_section';
import { ConnectSection } from './sections/connect_section';
import { EnvironmentSection } from './sections/environment_section';
import { VoiceSection } from './sections/voice_section';
import { AppearanceSection } from './sections/appearance_section';
import { AboutSection } from './sections/about_section';
import { registerSettingsSection } from './registry';

export function registerSettingsSections(): void {
  registerSettingsSection({
    key: 'model',
    label: '模型',
    icon: <span className="ink-icon-chip h-7 w-7 shrink-0 inline-flex items-center justify-center rounded-lg text-[11px] font-medium">模型</span>,
    order: 1,
    render: () => <ModelSection />,
  });

  registerSettingsSection({
    key: 'capability',
    label: '应用能力',
    icon: <span className="ink-icon-chip h-7 w-7 shrink-0 inline-flex items-center justify-center rounded-lg text-[11px] font-medium">能力</span>,
    order: 2,
    render: () => <CapabilitySection />,
  });

  registerSettingsSection({
    key: 'growth',
    label: '生长治理',
    icon: <Sparkles size={16} strokeWidth={1.6} aria-hidden />,
    order: 3,
    render: () => <GrowthSection />,
  });

  registerSettingsSection({
    key: 'security',
    label: '安全信任',
    icon: <ShieldCheck size={16} strokeWidth={1.6} aria-hidden />,
    order: 4,
    render: () => <SecuritySection />,
  });

  registerSettingsSection({
    key: 'connect',
    label: '连接',
    icon: <PlugZap size={16} strokeWidth={1.6} aria-hidden />,
    order: 5,
    render: () => <ConnectSection />,
  });

  registerSettingsSection({
    key: 'environment',
    label: '环境容器',
    icon: <span className="ink-icon-chip h-7 w-7 shrink-0 inline-flex items-center justify-center rounded-lg text-[11px] font-medium">环境</span>,
    order: 6,
    render: () => <EnvironmentSection />,
  });

  registerSettingsSection({
    key: 'voice',
    label: '语音',
    icon: <Volume2 size={16} strokeWidth={1.6} aria-hidden />,
    order: 7,
    render: () => <VoiceSection />,
  });

  registerSettingsSection({
    key: 'appearance',
    label: '外观',
    icon: <Paintbrush size={16} strokeWidth={1.6} aria-hidden />,
    order: 8,
    render: () => <AppearanceSection />,
  });

  registerSettingsSection({
    key: 'about',
    label: '关于',
    icon: <Info size={16} strokeWidth={1.6} aria-hidden />,
    order: 9,
    render: () => <AboutSection />,
  });
}

export function activate(): void {
  registerSettingsSections();
}
