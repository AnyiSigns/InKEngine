/**
 * Forge 壳层：模型引导（未配置 → 引导页）→ 对话面板（消息流 + 输入框）。
 *
 * 面板状态（消息/回合/流式）全部收敛在 agentStore；回合流经
 * useForgeSession 收发。设置页签复用模型三挡配置组件，保存后返回
 * 面板继续对话。
 */

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Settings, Sparkles } from 'lucide-react';

import { MessageList } from './components/agent/MessageList';
import { AgentInput } from './components/agent/AgentInput';
import { useAgentStore } from './features/agent/agentStore';
import { useForgeSession } from './features/agent/useForgeSession';
import { ModelsPane } from './settings/ModelsPane';
import { fetchJson } from './shared/api';
import type { ModelsState } from './types/models';

function isModelConfigured(models: ModelsState): boolean {
  const main = models?.main;
  return Boolean(main?.base_url && main?.model_id);
}

export default function App() {
  const [modelsReady, setModelsReady] = useState<boolean | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const messages = useAgentStore((s) => s.messages);
  const streaming = useAgentStore((s) => s.streaming);
  const { sendMessage, abort } = useForgeSession();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void fetchJson<ModelsState>('/api/settings/models')
      .then((data) => setModelsReady(isModelConfigured(data)))
      .catch(() => setModelsReady(true)); // 后端不可达也进入面板，发送时提示
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
          onClick={() => setShowSettings(true)}
          title="模型设置"
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/40 cursor-pointer transition-colors"
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
      <AgentInput streaming={streaming} onSend={(text) => void sendMessage(text)} onAbort={abort} />
    </div>
  );
}
