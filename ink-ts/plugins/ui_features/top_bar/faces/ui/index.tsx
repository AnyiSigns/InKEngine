import { useEffect, useRef, useState, type ComponentType } from 'react';

import type { ProductShellChrome } from '@/app/shell/productView';
import { TopBar } from './TopBar';

const noop = (): void => undefined;

/**
 * top_bar ui 面入口（阶段 7b）：悬停触发带 + 磨砂覆盖层 + TopBar。
 * 装配期经 pluginFaces.generated.ts 注册。宿主 chrome → TopBar props 映射。
 */
const TopBarAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const product = (props.product as ProductShellChrome | null | undefined) ?? {};
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
          title={product.title ?? ''}
          tab={product.tab ?? 'chat'}
          onTabChange={product.onTabChange ?? noop}
          onTitleChange={product.onTitleChange ?? noop}
          hasTodo={product.hasTodo}
          todoPending={product.todoPending}
        />
      </div>
    </>
  );
};

export default TopBarAdapter;
