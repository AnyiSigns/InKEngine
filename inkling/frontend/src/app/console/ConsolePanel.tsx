import { useState } from 'react';
import { Activity, BookOpen, Database, Eye, Info, LifeBuoy, Lock, Mic, Palette, Settings, ShieldCheck } from 'lucide-react';

import { cn } from '@/shared/cn';
import { InsightSection } from '../insights/InsightSection';
import { MemoryView } from '../memory/MemoryView';
import { AuditSection } from './sections/AuditSection';
import { BackupSection } from './sections/BackupSection';
import { LifecycleSection } from './sections/LifecycleSection';
import { LedgerSection } from './sections/LedgerSection';
import { RegistrySection } from './sections/RegistrySection';
import { TaskSection } from './sections/TaskSection';
import { VoiceSection } from './sections/VoiceSection';
import { AppearanceSection } from './sections/AppearanceSection';
import { AboutSection } from './sections/AboutSection';
import { CONSOLE_SECTIONS, type ConsoleSectionId } from './types';

const SECTION_ICONS: Record<ConsoleSectionId, typeof Settings> = {
  registry: Settings,
  tasks: Activity,
  ledger: BookOpen,
  memory: Database,
  backup: ShieldCheck,
  audit: Lock,
  lifecycle: LifeBuoy,
  insights: Eye,
  voice: Mic,
  appearance: Palette,
  about: Info,
};

export function ConsolePanel() {
  const [active, setActive] = useState<ConsoleSectionId>('registry');

  return (
    <div data-ui="console_panel" className="flex h-full w-full">
      <nav className="flex w-40 flex-col gap-0.5 border-r border-[var(--ink-border)] p-2">
        {CONSOLE_SECTIONS.map((section) => {
          const Icon = SECTION_ICONS[section.id];
          return (
            <button
              key={section.id}
              type="button"
              data-ui={`console_nav_${section.id}`}
              onClick={() => setActive(section.id)}
              className={cn(
                'flex items-center gap-2 rounded px-2 py-1.5 text-[11px] cursor-pointer transition-colors',
                active === section.id
                  ? 'bg-[var(--ink-bg-elevated)] text-[var(--ink-text-base)]'
                  : 'text-[var(--ink-text-muted)] hover:text-[var(--ink-text-base)]',
              )}
            >
              <Icon size={14} strokeWidth={1.6} />
              {section.label}
            </button>
          );
        })}
      </nav>

      <div className="flex-1 overflow-y-auto">
        {active === 'registry' && <RegistrySection />}
        {active === 'tasks' && <TaskSection />}
        {active === 'ledger' && <LedgerSection />}
        {active === 'memory' && <MemoryView />}
        {active === 'backup' && <BackupSection />}
        {active === 'audit' && <AuditSection />}
        {active === 'lifecycle' && <LifecycleSection />}
        {active === 'insights' && <InsightSection />}
        {active === 'voice' && <VoiceSection />}
        {active === 'appearance' && <AppearanceSection />}
        {active === 'about' && <AboutSection />}
      </div>
    </div>
  );
}
