import { createRoot, type Root } from 'react-dom/client';
import React from 'react';

import { ConsolePanel } from './ConsolePanel';

export function activateConsole(target: HTMLElement): { unmount: () => void } {
  const root: Root = createRoot(target);
  root.render(React.createElement(ConsolePanel));
  return {
    unmount: () => root.unmount(),
  };
}

export { ConsolePanel } from './ConsolePanel';
export { RegistrySection } from './sections/RegistrySection';
export { TaskSection } from './sections/TaskSection';
export { LedgerSection } from './sections/LedgerSection';
export { BackupSection } from './sections/BackupSection';
export { AuditSection } from './sections/AuditSection';
export { LifecycleSection } from './sections/LifecycleSection';
export { VoiceSection } from './sections/VoiceSection';
export { AppearanceSection } from './sections/AppearanceSection';
export { AboutSection } from './sections/AboutSection';
export type { ConsoleSectionId, ConsoleSectionDef } from './types';
