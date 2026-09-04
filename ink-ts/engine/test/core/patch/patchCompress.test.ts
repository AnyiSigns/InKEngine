import { describe, expect, it } from 'vitest';

import { buildMessageCompressPatches, PatchChain } from '../../../src/core/patch/patchChain.js';

function messages(n: number): { id: string }[] {
  return Array.from({ length: n }, (_, i) => ({ id: `m${i}` }));
}

describe('消息压缩补丁链', () => {
  it('组装结果 = 摘要 + 保留段', () => {
    const msgs = messages(5);
    const chain = buildMessageCompressPatches(msgs, 3, { id: 'summary', content: '摘要' });
    const assembled = chain.assemble().messages as { id: string }[];
    expect(assembled[0]).toEqual({ id: 'summary', content: '摘要' });
    expect(assembled.slice(1)).toEqual(msgs.slice(3));
  });

  it('delete 操作即删除证据（从后向前）', () => {
    const msgs = messages(5);
    const chain = buildMessageCompressPatches(msgs, 3, { id: 's' });
    const deletes = chain.patches.filter((p) => p.op === 'delete');
    expect(deletes.length).toBe(2);
    expect(deletes.map((p) => [...p.path])).toEqual([
      ['messages', 2],
      ['messages', 1],
    ]);
  });

  it('cutoff=1 仅摘要替换链首，无删除', () => {
    const msgs = messages(3);
    const chain = buildMessageCompressPatches(msgs, 1, { id: 's' });
    expect(chain.patches.length).toBe(1);
    expect(chain.assemble().messages).toEqual([{ id: 's' }, ...msgs.slice(1)]);
  });

  it('cutoff=全长则仅剩摘要', () => {
    const msgs = messages(3);
    const chain = buildMessageCompressPatches(msgs, 3, { id: 's' });
    expect(chain.assemble().messages).toEqual([{ id: 's' }]);
  });

  it('cutoff 越界抛错', () => {
    const msgs = messages(3);
    expect(() => buildMessageCompressPatches(msgs, 0, {})).toThrow(RangeError);
    expect(() => buildMessageCompressPatches(msgs, -1, {})).toThrow(RangeError);
    expect(() => buildMessageCompressPatches(msgs, 4, {})).toThrow(RangeError);
  });

  it('rebase 压扁链长收敛且组装结果不变', () => {
    const msgs = messages(5);
    const chain = buildMessageCompressPatches(msgs, 3, { id: 's' });
    const flat = chain.rebase();
    expect(flat.patches).toEqual([]);
    expect(flat.assemble().messages).toEqual(chain.assemble().messages);
  });

  it('序列化往返保留压缩链', () => {
    const msgs = messages(4);
    const chain = buildMessageCompressPatches(msgs, 2, { id: 's', content: '摘要' });
    const restored = PatchChain.from_dict(chain.to_dict());
    expect(restored.assemble().messages).toEqual(chain.assemble().messages);
    expect(restored.patches.filter((p) => p.op === 'delete').length).toBe(1);
  });
});
