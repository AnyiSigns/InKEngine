import type { ComponentType } from 'react';

import type { ReviewResolution } from '@app/shell/shellContracts';
import type { ProductShellChrome } from '@app/shell/productView';
import { ReviewCard } from './review_card';

const noop = (): void => undefined;

/**
 * review_card ui 面入口（阶段 7b）：审批卡覆盖层（events.review_card 绑定）。
 * 装配期经 pluginFaces.generated.ts 注册；决议续跑经宿主 product chrome。
 */
const ReviewCardAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const product = (props.product as ProductShellChrome | null | undefined) ?? {};
  const bindEvent = props.bindValue as { payload?: Record<string, unknown> } | undefined;
  return (
    <ReviewCard
      bindValue={props.bindValue}
      onResolve={(resolution: ReviewResolution, editedContent?: string) =>
        (product.onResolveReview ?? noop)(resolution, editedContent, bindEvent?.payload)
      }
    />
  );
};

export default ReviewCardAdapter;
