/**
 * web_search 密钥存取（宿主内存运行时态；不落盘）。
 *
 * 密钥只存在 host 进程内（config/env/运行时内存），不写数据目录/审计；
 * 对外只回显掩码（前 4 字符 + '***'）。web 侧 connect_section 读写本面。
 */

/** 密钥掩码（仅回显前 4 字符 + 掩码尾缀，防泄露完整密钥）。 */
export function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****`;
}

export class SearchKeysStore {
  private readonly keys = new Map<string, string>();

  /** 写入（provider 非空、密钥非空；覆盖 = 幂等）。 */
  set(provider: string, apiKey: string): void {
    const p = provider.trim();
    const k = apiKey.trim();
    if (p === '' || k === '') throw new Error('search key: provider 与 api_key 均不能为空');
    this.keys.set(p, k);
  }

  /** 取明文（内部执行体用；不对外暴露）。 */
  raw(provider: string): string | null {
    return this.keys.get(provider.trim()) ?? null;
  }

  /** 掩码清单（web 回显面；无明文泄露）。 */
  masked(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [provider, key] of this.keys) {
      out[provider] = maskKey(key);
    }
    return out;
  }

  /** 是否已配置某 provider。 */
  has(provider: string): boolean {
    return this.keys.has(provider.trim());
  }

  count(): number {
    return this.keys.size;
  }
}
