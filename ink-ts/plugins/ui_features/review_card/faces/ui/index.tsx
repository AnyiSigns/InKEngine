import type { ComponentType } from 'react';

import type { ReviewResolution } from '@app/shell/shellContracts';
import type { ProductShellActions } from '@app/shell/productView';
import { ReviewCard } from './review_card';

const noop = (): void => undefined;

/**
 * review_card ui 面入口：审批卡覆盖层（events.review_card 绑定）；
 * spec faces.ui.access inject ["onResolveReview"]——壳按声明切片注入（顶层
 * onResolveReview），bind 事件载荷 bindValue 原样经绑定通道进入。装配期经
 * pluginFaces.generated.ts 注册。
 */
const ReviewCardAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const bindEvent = props.bindValue as { payload?: Record<string, unknown> } | undefined;
  const onResolveReview = (props.onResolveReview as ProductShellActions['onResolveReview'] | undefined) ?? noop;
  return (
    <ReviewCard
      bindValue={props.bindValue}
      onResolve={(resolution: ReviewResolution, editedContent?: string) =>
        onResolveReview(resolution, editedContent, bindEvent?.payload)
      }
    />
  );
};

export default ReviewCardAdapter;
