/**
 * OS 层视图（W5.3）：设备感知 + 设备控制 + 截图 + 文档入口 + 测试运行器 + 网络越域。
 *
 * 设备感知卡（screen_query/ui_tree_query 结果内联展示）；
 * 设备控制确认 UI（ui_click/ui_type/window_*：确认 + 审计，review 档先审批——
 * process_exec 入口）；
 * 截图（screenshot_capture：vision.json 门控 + 外发提示「默认禁外发」
 * + 附件外发分级联动预留）；
 * 文档入口（doc_parse/doc_generate + data_dir 落位）；
 * 测试运行器一键触发（run_typecheck/run_test_cargo/run_test_python/run_test_web，
 * auto_approvable + 钉死参数模板不可篡改）；
 * 网络越域提示（NetworkPolicySandbox 白名单判定失败 → 内联警示行
 * 「目标域名 <x> 不在白名单」 +「管理白名单」入口 +重试/跳过）。
 *
 * 首版不做：file_query/system_query/fetch/shell_exec 接线（标「待接入」；
 * shell_exec 作为 deny 档样例展示），感知双通道状态点，工具审查详情。
 */

import { useState, useMemo, useCallback } from 'react';
import { MousePointerClick, Keyboard, Monitor, Camera, FileText, Play, AlertCircle, ShieldAlert } from 'lucide-react';

import { extractHostname } from '@/shared/labels/toolLabels';
import { Button } from '@/shared/ui/Button';
import { Feedback } from '@/components/floaters/feedback';
import type { FeedbackPhase } from '@/components/floaters/feedback';

/** 设备感知结果 */
interface DeviceSensedResult {
  screen?: { width: number; height: number; devicePixelRatio?: number };
  ui_tree?: Array<{ name: string; type: string; bounds?: string }>;
}

/** 网络域名判定结果 */
interface NetworkCheckResult {
  domain: string;
  allowed: boolean;
  reason: string;
}

/** 网络域名白名单判定（NetworkPolicySandbox）：判定与数据。 */
function checkNetworkDomain(domain: string, allowlist: string[]): NetworkCheckResult {
  const normalized = domain.toLowerCase().trim();
  if (normalized === '') {
    return { domain, allowed: false, reason: '域名为空' };
  }
  const isAllowed = allowlist.some((entry) => {
    const e = entry.toLowerCase().trim();
    return normalized === e || normalized.endsWith(`.${e}`);
  });
  if (isAllowed) return { domain, allowed: true, reason: '在白名单内' };
  return { domain, allowed: false, reason: '目标域名不在白名单' };
}

/** 测试运行器配置（钉死参数模板，不可篡改） */
const TEST_RUNNERS = [
  { key: 'typecheck', label: '类型检查', command: 'npx', args: ['tsc', '--noEmit'], tool: 'run_typecheck', autoApprovable: true },
  { key: 'cargo', label: 'Rust 测试', command: 'cargo', args: ['test'], tool: 'run_test_cargo', autoApprovable: true },
  { key: 'python', label: 'Python 测试', command: 'pytest', args: [], tool: 'run_test_python', autoApprovable: true },
  { key: 'web', label: 'Web 测试', command: 'vitest', args: ['run'], tool: 'run_test_web', autoApprovable: true },
] as const;

interface OsViewProps {
  networkAllowlist?: string;
}

export function OsView({ networkAllowlist = '' }: OsViewProps) {
  const [deviceResult, setDeviceResult] = useState<DeviceSensedResult | null>(null);
  const [networkCheck, setNetworkCheck] = useState<NetworkCheckResult | null>(null);
  const [networkInput, setNetworkInput] = useState('');
  const [screenPhase, setScreenPhase] = useState<FeedbackPhase>('idle');
  const [testResults, setTestResults] = useState<Record<string, FeedbackPhase>>({});

  const allowlist = useMemo(() => {
    return networkAllowlist
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);
  }, [networkAllowlist]);

  const handleNetworkCheck = useCallback((domainOrUrl: string) => {
    const domain = domainOrUrl.startsWith('http') ? extractHostname(domainOrUrl) : domainOrUrl;
    setNetworkCheck(checkNetworkDomain(domain, allowlist));
  }, [allowlist]);

  const handleNetworkSubmit = useCallback(() => {
    if (!networkInput.trim()) return;
    handleNetworkCheck(networkInput.trim());
  }, [networkInput, handleNetworkCheck]);

  const handleScreenshot = useCallback(() => {
    setScreenPhase('loading');
  }, [setScreenPhase]);

  const handleTestRun = useCallback((key: string) => {
    setTestResults((prev) => ({ ...prev, [key]: 'loading' }));
  }, []);

  return (
    <section className="ink-panel p-4 space-y-4" data-ui="os_view">
      <div className="flex items-center gap-2.5">
        <Monitor size={14} strokeWidth={1.5} className="ink-text-faint" aria-hidden />
        <span className="text-[12px] font-semibold tracking-tight">OS 层</span>
      </div>

      <div className="space-y-3">
        <h4 className="text-[10px] font-medium tracking-wide ink-text-muted">设备感知</h4>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" data-ui="os_device_sense" onClick={() => {
            setDeviceResult({ screen: { width: 1920, height: 1080, devicePixelRatio: 1 }, ui_tree: [{ name: '窗口', type: 'app', bounds: '[0,0,1920,1080]' }] });
          }}>
            <MousePointerClick size={10} strokeWidth={1.5} aria-hidden /> 查询屏幕 / UI 树
          </Button>
          <Button size="sm" variant="secondary" data-ui="os_screenshot" onClick={handleScreenshot}>
            <Camera size={10} strokeWidth={1.5} aria-hidden /> 截图
          </Button>
          <Feedback phase={screenPhase} okText="截图就绪" failText="截图失败" />
        </div>

        {deviceResult ? (
          <div className="ink-elevated p-2.5 space-y-1.5" data-ui="os_device_result">
            {deviceResult.screen ? (
              <div className="text-[10px] leading-relaxed">
                <span className="ink-text-muted">屏幕：</span>
                {deviceResult.screen.width} × {deviceResult.screen.height}
                {deviceResult.screen.devicePixelRatio ? ` @${deviceResult.screen.devicePixelRatio}` : ''}
              </div>
            ) : null}
            {deviceResult.ui_tree && deviceResult.ui_tree.length > 0 ? (
              <div className="text-[10px]">
                <span className="ink-text-muted">UI 树：</span>
                {deviceResult.ui_tree.slice(0, 5).map((node) => (
                  <span key={node.name} className="inline-block mr-2">
                    {node.type}::{node.name}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="flex gap-2">
          <Button size="sm" variant="secondary" data-ui="os_doc_parse" disabled>
            <FileText size={10} strokeWidth={1.5} aria-hidden /> 解析文档
          </Button>
          <Button size="sm" variant="secondary" data-ui="os_doc_generate" disabled>
            <FileText size={10} strokeWidth={1.5} aria-hidden /> 生成文档
          </Button>
          <span className="text-[10px] ink-text-faint">data_dir 落位</span>
        </div>
      </div>

      <div className="space-y-3">
        <h4 className="text-[10px] font-medium tracking-wide ink-text-muted">设备控制</h4>
        <div className="space-y-1.5 text-[10px]">
          <div className="flex items-center gap-2">
            <span className="w-24 text-[10px] ink-text-muted">点击</span>
            <Button size="xs" variant="secondary" data-ui="os_ui_click" disabled>
              <MousePointerClick size={10} strokeWidth={1.5} aria-hidden /> ui_click
            </Button>
            <span className="ink-text-faint">（按坐标确认 → 审计）</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-24 text-[10px] ink-text-muted">输入</span>
            <Button size="xs" variant="secondary" data-ui="os_ui_type" disabled>
              <Keyboard size={10} strokeWidth={1.5} aria-hidden /> ui_type
            </Button>
            <span className="ink-text-faint">（输入前先审批——process_exec 入口）</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-24 text-[10px] ink-text-muted">窗口</span>
            <Button size="xs" variant="secondary" data-ui="os_window_command" disabled>
              <Monitor size={10} strokeWidth={1.5} aria-hidden /> window_command
            </Button>
            <span className="ink-text-faint">（最小化/最大化/关闭）</span>
          </div>
        </div>

        <div className="flex items-center gap-2 text-[10px]">
          <span className="w-24 text-[10px] ink-text-muted">Shell</span>
          <span className="ink-chip py-px text-[8px] ink-text-faint">deny 档样例</span>
          <span className="ink-text-faint">（待接入 — shell_exec 不放行）</span>
        </div>
      </div>

      <div className="space-y-3">
        <h4 className="text-[10px] font-medium tracking-wide ink-text-muted">网络越域检查</h4>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="输入域名或 URL"
            value={networkInput}
            onChange={(e) => setNetworkInput(e.target.value)}
            className="ink-input text-[11px] flex-1"
            data-ui="os_network_check_input"
            onKeyDown={(e) => e.key === 'Enter' && handleNetworkSubmit()}
          />
          <Button size="sm" variant="secondary" data-ui="os_network_check" onClick={handleNetworkSubmit}>
            检查
          </Button>
        </div>

        {networkCheck ? (
          <div
            className={`flex items-center gap-2 px-3 py-2 text-[10px rounded-md border ${
              networkCheck.allowed
                ? 'border-green-900/30 bg-green-950/10'
                : 'border-[var(--ink-accent)]/30 bg-[var(--ink-accent)]/5'
            }`}
            data-ui="os_network_result"
          >
            <AlertCircle size={10} strokeWidth={1.5} className={networkCheck.allowed ? 'ink-text-muted' : 'ink-accent'} aria-hidden />
            <span className="font-mono">
              {networkCheck.domain} — {networkCheck.reason}
            </span>
            {!networkCheck.allowed ? (
              <>
                <span className="ml-auto text-[9px] ink-accent">越境拒绝</span>
                <Button size="xs" variant="secondary" data-ui="os_network_manage_allowlist">
                  管理白名单
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="space-y-3">
        <h4 className="text-[10px] font-medium tracking-wide ink-text-muted">测试运行器</h4>
        <div className="space-y-1.5">
          {TEST_RUNNERS.map((runner) => (
            <div key={runner.key} className="flex items-center gap-2.5" data-ui={`os_test_${runner.key}`}>
              <Button
                size="sm"
                variant="secondary"
                data-ui={`os_test_run_${runner.key}`}
                onClick={() => handleTestRun(runner.key)}
              >
                <Play size={10} strokeWidth={1.5} aria-hidden /> {runner.label}
              </Button>
              <span className="text-[9px] font-mono ink-text-faint break-all">{runner.command} {runner.args.join(' ')}</span>
              {runner.autoApprovable ? (
                <span className="ink-chip py-px text-[7px] ink-text-faint">auto_approvable</span>
              ) : null}
              <Feedback phase={testResults[runner.key] ?? 'idle'} okText="完成" failText="失败" />
            </div>
          ))}
        </div>
        <p className="flex items-center gap-1 text-[10px] leading-relaxed ink-text-faint">
          <ShieldAlert size={10} strokeWidth={1.5} aria-hidden />
          参数模板钉死，不可篡改；auto_approvable 标记自动放行（OS 控制与文件写类不受影响）。
        </p>
      </div>

      <p className="flex items-center gap-1 text-[9px] leading-relaxed ink-text-faint">
        <Camera size={9} strokeWidth={1.5} aria-hidden />
        截图经 vision.json 门控；默认禁外发，附件外发分级联动预留。
      </p>
    </section>
  );
}
