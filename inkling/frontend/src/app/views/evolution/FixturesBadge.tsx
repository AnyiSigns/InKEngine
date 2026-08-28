import { TestTube2 } from 'lucide-react';

import type { FixturesStatus } from './backend';

/** 样例闸门回归状态徽标（fixtures_all_green 全绿=通过 / 失败=警示+条数）。 */
export function FixturesBadge({ status }: { status: FixturesStatus }) {
  return (
    <span
      className={`w3-badge ${status.allGreen ? 'w3-badge--ok' : 'w3-badge--warn'}`}
      data-testid="fixtures-badge"
      data-all-green={status.allGreen}
    >
      <TestTube2 size={14} strokeWidth={1.5} />
      {status.allGreen ? '样例全绿' : `样例失败 ${status.failedCount} 条`}
    </span>
  );
}
