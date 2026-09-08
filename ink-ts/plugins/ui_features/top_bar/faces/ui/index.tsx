import { useEffect, useRef, useState, type ComponentType } from 'react';

import type { MainTab } from '@app/shell/shellContracts';
import { TopBar } from './TopBar';

const noop = (): void => undefined;

/**
 * top_bar ui 面入口：悬停触发带 + 磨砂覆盖层 + TopBar。
 * spec faces.ui.access store ["title","tab","hasTodo","todoPending"] + inject
 * ["onTabChange","onTitleChange"]——壳装配层 accessAwareFace 按声明切片注入
 * （顶层消费，无全量 product）。装配期经 pluginFaces.generated.ts 注册。
 */
const TopBarAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);
  const show = (): void => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setOpen(true);
  };
  const hide = (): void => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(false), 240);
  };
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  return (
    <>
      <div className="ink-topbar-trigger" onMouseEnter={show} />
      <div className="ink-topbar-veil" data-open={open ? 'true' : undefined} onMouseEnter={show} onMouseLeave={hide}>
        <TopBar
          title={(props.title as string | undefined) ?? ''}
          tab={(props.tab as MainTab | undefined) ?? 'chat'}
          onTabChange={(props.onTabChange as ((t: MainTab) => void) | undefined) ?? noop}
          onTitleChange={(props.onTitleChange as ((t: string) => void) | undefined) ?? noop}
          hasTodo={props.hasTodo === true}
          todoPending={(props.todoPending as number | undefined) ?? 0}
        />
      </div>
    </>
  );
};

export default TopBarAdapter;
