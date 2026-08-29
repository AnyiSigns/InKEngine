/**
 * 设置「安全信任」节：安全流水线安装态 + 已记住域名（联网审批的域名级
 * 记忆）+ 权限矩阵入口（详细归波 4）。
 *
 * 展示「安全流水线已安装/未安装」；未安装 = 提示 + 说明「沙箱守卫不生效」；
 * 已记住域名 = 审批卡「记住此域名」的产物，命中域名出网免弹卡；
 * 权限矩阵/自动审批编辑归波 4 经 registry 扩展位，此处留注入口。
 */

import { useEffect, useState } from 'react';

import { ShieldCheck, ShieldAlert, Plus, X } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { TextInput } from '@/shared/ui/Field';
import { Feedback } from '@/components/floaters/feedback';
import type { FeedbackPhase } from '@/components/floaters/feedback';
import { createTauriInvoker } from '@/shared/backend/tauriBridge';

export interface SecuritySectionValue {
  pipelineInstalled: boolean;
}

export function SecuritySection(): JSX.Element {
  const tauri = createTauriInvoker();
  const [pipeline, setPipeline] = useState<boolean>(false);
  const [phase, setPhase] = useState<FeedbackPhase>('idle');
  const [domains, setDomains] = useState<string[]>([]);
  const [domainDraft, setDomainDraft] = useState('');
  const [domainsPhase, setDomainsPhase] = useState<FeedbackPhase>('idle');

  useEffect(() => {
    if (!tauri) return;
    void (async () => {
      try {
        const result = (await tauri.invoke('pipeline_security_status')) as { installed?: boolean };
        setPipeline(Boolean(result?.installed));
      } catch {
        setPipeline(false);
      }
      try {
        const result = (await tauri.invoke('security_remembered_domains_get')) as { domains?: string[] };
        setDomains(result?.domains ?? []);
      } catch {
        setDomains([]);
      }
    })();
  }, [tauri]);

  const toggle = async (): Promise<void> => {
    setPhase('loading');
    try {
      if (tauri) {
        await tauri.invoke('pipeline_install_security_pipeline', { install: !pipeline });
      }
      setPipeline((prev) => !prev);
      setPhase('success');
      setTimeout(() => setPhase('idle'), 1200);
    } catch {
      setPhase('fail');
      setTimeout(() => setPhase('idle'), 2000);
    }
  };

  const commitDomains = async (next: string[]): Promise<void> => {
    setDomainsPhase('loading');
    try {
      if (tauri) {
        await tauri.invoke('security_remembered_domains_set', { domains: next });
      }
      setDomains(next);
      setDomainsPhase('success');
      setTimeout(() => setDomainsPhase('idle'), 1200);
    } catch {
      setDomainsPhase('fail');
      setTimeout(() => setDomainsPhase('idle'), 2000);
    }
  };

  const addDomain = async (): Promise<void> => {
    const domain = domainDraft.trim().toLowerCase();
    if (!domain || domains.includes(domain)) {
      setDomainDraft('');
      return;
    }
    await commitDomains([...domains, domain]);
    setDomainDraft('');
  };

  const removeDomain = async (domain: string): Promise<void> => {
    await commitDomains(domains.filter((d) => d !== domain));
  };

  return (
    <div className="space-y-4">
      <div className="ink-elevated space-y-3 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">安全流水线</div>
        <div className="flex items-center gap-3">
          <span className="ink-icon-chip h-8 w-8 inline-flex items-center justify-center rounded-lg">
            {pipeline ? (
              <ShieldCheck size={16} strokeWidth={1.6} className="ink-text-accent" aria-hidden />
            ) : (
              <ShieldAlert size={16} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
            )}
          </span>
          <div className="min-w-0">
            <div className="text-[11px] font-medium">{pipeline ? '安全流水线已安装' : '安全流水线未安装'}</div>
            <div className="text-[10px] ink-text-faint">
              {pipeline ? '沙箱守卫已生效' : '沙箱守卫不生效，建议立即安装'}
            </div>
          </div>
          <div className="ml-auto">
            <Button size="xs" variant={pipeline ? 'secondary' : 'accent'} onClick={toggle} data-ui="pipeline_toggle">
              {pipeline ? '卸载' : '安装'}
            </Button>
          </div>
        </div>
        <Feedback phase={phase} okText="操作成功" failText="操作失败" />
      </div>

      <div className="ink-elevated space-y-3 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">已记住域名</div>
        <p className="text-[10px] ink-text-faint">
          联网工具（http_fetch）出网走审批弹卡；在审批卡上勾选「记住此域名」后，
          该域（后缀匹配，含子域）后续出网免弹卡直接放行。此处可查看/删除。
        </p>
        <div className="flex items-center gap-2">
          <TextInput
            value={domainDraft}
            onChange={(e) => setDomainDraft(e.target.value)}
            placeholder="example.com"
            aria-label="记住域名输入"
            className="font-mono text-[10px]"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addDomain();
            }}
          />
          <Button size="sm" variant="secondary" onClick={() => void addDomain()} data-ui="remembered_domain_add">
            <Plus size={11} strokeWidth={1.6} /> 添加
          </Button>
          <Feedback phase={domainsPhase} okText="已记住" failText="操作失败" />
        </div>
        {domains.length > 0 ? (
          <ul className="divide-y divide-[var(--ink-border)] overflow-hidden rounded">
            {domains.map((domain) => (
              <li key={domain} className="flex items-center justify-between gap-2 px-1 py-1.5">
                <span className="truncate font-mono text-[10px] ink-text-muted">{domain}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  data-ui={`remembered_domain_remove_${domain}`}
                  onClick={() => void removeDomain(domain)}
                >
                  <X size={10} strokeWidth={1.6} /> 删除
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[10px] ink-text-faint">暂无已记住域名（全部联网请求走审批弹卡）。</p>
        )}
      </div>

      <div className="ink-elevated space-y-3 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">权限矩阵</div>
        <p className="text-[10px] ink-text-faint">
          详细权限矩阵编辑（allow/review/deny 三档 + 自动审批工具集勾选）归波 4 经 registry 扩展位实现，此处留注入口。
        </p>
        <Button size="sm" variant="secondary" disabled data-ui="permission_matrix_entry">
          权限矩阵（待接线）
        </Button>
      </div>
    </div>
  );
}
