/**
 * L3 之上的可选人工审核层（knowledge_gate.py HumanReviewer/ReviewCardPolicy
 * 段移植）。
 *
 * 审核者协议 = 引擎规定契约（新知识过 L1/L2/L3 后是否还需人工确认：True =
 * 人工通过，False = 拒绝落库），实现由宿主注入（接入审核卡 UI 时按产品形态
 * 实现）；默认策略本类只表达「默认弹卡、可关」的机制语义——引擎不代用户
 * 批准，任何知识落库前须经人工确认（review 返回 False 直到宿主确认放行）。
 */

import type { KnowledgeEntry } from '../knowledge_set/knowledge_entry.js';
import type { GateL3Result } from './_results.js';

/** 人工审核者协议（Python HumanReviewer Protocol 的 TS 结构形态）。 */
export interface HumanReviewer {
  review(entry: KnowledgeEntry, l3: GateL3Result): Promise<boolean>;
}

/** 默认人工审核策略：默认弹卡（需人工确认才放行），可关。 */
export class ReviewCardPolicy {
  readonly enabled: boolean;

  constructor(options?: { enabled?: boolean }) {
    this.enabled = options?.enabled ?? true;
    Object.freeze(this);
  }

  async review(_entry: KnowledgeEntry, _l3: GateL3Result): Promise<boolean> {
    // 弹卡语义：需要人工确认——未确认前不放行（确定性基线，宿主 UI
    // 审核流接管后返回真实裁决）；enabled=False = 关闭人工层
    return !this.enabled;
  }
}
