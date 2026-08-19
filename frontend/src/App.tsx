/**
 * Forge 壳层：模型引导（未配置 → 引导页）→ 对话面板（消息流 + 输入框）。
 *
 * 面板状态（消息/回合/流式）全部收敛在 agentStore；回合流经
 * useForgeSession 收发。设置页签复用模型三挡配置组件，保存后返回
 * 面板继续对话。布局预览（右上角图标）展示当前界面描述经 boot
 * 渲染器渲染的结果——布局 JSON 即产品形态。
 *
 * boot 壳固定机制（不属于布局数据，不随演化消失）：
 * - 唤起协议：Cmd+K → 聚焦对话输入框；
 * - ui_context 上报：位置快照 + 交互事件自动上报（渲染器机制契约）。
 */

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, FlaskConical, FolderOpen, LayoutGrid, Settings, Sparkles, X } from 'lucide-react';

// 仅取头部组件；文件面板本体经渲染器按布局引用渲染（模块加载即注册）
import { FilesPanelHeader } from './components/files/FilesPanel';
import { IncubatorPanel } from './components/incubator/IncubatorPanel';
import { MessageList } from './components/agent/MessageList';
import { AgentInput } from './components/agent/AgentInput';
import { useAgentStore } from './features/agent/agentStore';
import { useForgeSession } from './features/agent/useForgeSession';
import { useUiContext, useUiInteractionReport } from './features/ui/useUiContext';
// 内建组件注册（副作用：模块加载即注册进动态组件表）
import './renderer/boundComponents';
import './renderer/iframeBridge';
import { BootRenderer } from './renderer/bootRenderer';
import type { UISpec } from './renderer/bootRenderer';
import { ModelsPane } from './settings/ModelsPane';
import { fetchJson } from './shared/api';
import type { ModelsState } from './types/models';

function isModelConfigured(models: ModelsState): boolean {
  const main = models?.main;
  return Boolean(main?.base_url && main?.model_id);
}

/** 文件面板的布局描述（与对话面板同走 boot 渲染器；组件已注册白名单内） */
const FILES_UI_SPEC: UISpec = {
  name: 'boot.files',
  version: 1,
  root: {
    kind: 'container',
    type: 'column',
    children: [{ kind: 'component', type: 'files_panel' }],
  },
};

/** 状态通道（bind 数据源）：agentStore 快照 + 订阅 */
const agentStateChannel = {
  getSnapshot: () => useAgentStore.getState(),
  subscribe: useAgentStore.subscribe,
};

export default function App() {
  const [modelsReady, setModelsReady] = useState<boolean | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showLayout, setShowLayout] = useState(false);
  const [showIncubator, setShowIncubator] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [uiSpec, setUiSpec] = useState<UISpec | null>(null);
  const messages = useAgentStore((s) => s.messages);
  const streaming = useAgentStore((s) => s.streaming);
  const { sendMessage, abort } = useForgeSession();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // boot 壳固定机制：ui_context 上报（位置快照 + 交互事件）
  useUiContext({ layoutName: uiSpec?.name ?? null });
  useUiInteractionReport();

  useEffect(() => {
    void fetchJson<ModelsState>('/api/settings/models')
      .then((data) => setModelsReady(isModelConfigured(data)))
      .catch(() => setModelsReady(true)); // 后端不可达也进入面板，发送时提示
  }, []);

  // 唤起协议：Cmd+K / Ctrl+K 全局聚焦对话输入框
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // 挂载时取一次界面描述（布局名供 ui_context 上报与预览复用）
  useEffect(() => {
    void fetchJson<{ ui_spec: UISpec | null }>('/api/self/ui')
      .then((data) => setUiSpec(data.ui_spec))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streaming]);

  const backToPanel = () => {
    setShowSettings(false);
    void fetchJson<ModelsState>('/api/settings/models')
      .then((data) => setModelsReady(isModelConfigured(data)))
      .catch(() => undefined);
  };

  const openLayoutPreview = () => {
    setShowLayout(true);
    // 取当前界面描述（深拷贝快照）：渲染器消费布局 JSON 即时重渲
    void fetchJson<{ ui_spec: UISpec | null }>('/api/self/ui')
      .then((data) => setUiSpec(data.ui_spec))
      .catch(() => setUiSpec(null));
  };

  if (modelsReady === null) {
    return (
      <div className="flex h-screen items-center justify-center text-xs text-muted-foreground">
        正在加载…
      </div>
    );
  }

  if (!modelsReady || showSettings) {
    return (
      <div className="flex h-screen flex-col">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-4">
          <button
            onClick={backToPanel}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/40 cursor-pointer transition-colors"
          >
            <ArrowLeft size={12} strokeWidth={1.6} />
            返回对话
          </button>
          <span className="text-xs font-medium">模型设置</span>
        </header>
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl px-4 py-6">
            <ModelsPane />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-4">
        <Sparkles size={13} strokeWidth={1.8} className="text-amber-500/80" />
        <span className="text-xs font-semibold tracking-wide">Forge</span>
        <span className="text-[10px] text-muted-foreground/60">
          站在 AI 上的 AI · 先观察，再回答
        </span>
        <button
          onClick={openLayoutPreview}
          data-ui="btn_layout"
          title="布局预览（界面描述渲染）"
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/40 cursor-pointer transition-colors"
        >
          <LayoutGrid size={12} strokeWidth={1.6} />
        </button>
        <button
          onClick={() => setShowFiles((v) => !v)}
          data-ui="btn_files"
          title="文件授权面板"
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/40 cursor-pointer transition-colors"
        >
          <FolderOpen size={12} strokeWidth={1.6} />
        </button>
        <button
          onClick={() => setShowIncubator((v) => !v)}
          data-ui="btn_incubator"
          title="知识孵化面板"
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/40 cursor-pointer transition-colors"
        >
          <FlaskConical size={12} strokeWidth={1.6} />
        </button>
        <button
          onClick={() => setShowSettings(true)}
          data-ui="btn_settings"
          title="模型设置"
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/40 cursor-pointer transition-colors"
        >
          <Settings size={12} strokeWidth={1.6} />
        </button>
      </header>
      <MessageList
        messages={messages}
        agentStreaming={streaming}
        onReviewAction={() => undefined}
        onSendMessage={(msg) => void sendMessage(msg)}
        onPickSuggestion={(s) => void sendMessage(s)}
        onCopy={(text) => void navigator.clipboard?.writeText(text)}
        onInlineEditSend={(text) => void sendMessage(text)}
        onUnlockAndRetry={(msg) => void sendMessage(msg)}
        messagesEndRef={messagesEndRef}
      />
      <AgentInput
        streaming={streaming}
        onSend={(text) => void sendMessage(text)}
        onAbort={abort}
        inputRef={inputRef}
      />
      {showLayout && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="w-[420px] max-h-[80vh] overflow-y-auto rounded-lg border border-border bg-background shadow-xl p-3">
            <div className="mb-2 flex items-center">
              <span className="text-[11px] font-medium text-foreground/60">界面描述渲染</span>
              <button
                onClick={() => setShowLayout(false)}
                className="ml-auto flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted/40 cursor-pointer"
                title="关闭预览"
              >
                <X size={11} strokeWidth={1.6} />
              </button>
            </div>
            <BootRenderer
              spec={uiSpec}
              channel={agentStateChannel}
            />
          </div>
        </div>
      )}
      {showFiles && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="w-[460px] max-h-[80vh] overflow-y-auto rounded-lg border border-border bg-background shadow-xl p-3">
            <FilesPanelHeader onClose={() => setShowFiles(false)} />
            <BootRenderer spec={FILES_UI_SPEC} channel={agentStateChannel} />
          </div>
        </div>
      )}
      {showIncubator && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="w-[440px] max-h-[80vh] overflow-y-auto rounded-lg border border-border bg-background shadow-xl p-3">
            <div className="mb-2 flex items-center">
              <span className="text-[11px] font-medium text-foreground/60">知识孵化</span>
              <button
                onClick={() => setShowIncubator(false)}
                className="ml-auto flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted/40 cursor-pointer"
                title="关闭面板"
              >
                <X size={11} strokeWidth={1.6} />
              </button>
            </div>
            <IncubatorPanel />
          </div>
        </div>
      )}
    </div>
  );
}
