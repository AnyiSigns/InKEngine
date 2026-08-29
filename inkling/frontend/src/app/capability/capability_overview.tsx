/**
 * 能力总览一屏（W2.4）：embedding 源 / vision / 语音 / Ollama 状态。
 *
 * embedding 源 = granite-97m 状态/远端/关键词基线降级（offline_detect 复用）；
 * vision = 模型档案 multimodal；语音 = voice_status；Ollama = offline_detect；
 * 缺 = 显式标注降级。
 */

import { useEffect, useMemo, useState } from 'react';

import { Cpu, Eye, Mic, WifiOff } from 'lucide-react';

import { createBackend } from '@/shared/backend/backendAdapter';

interface OfflineDetect {
  ollama: { reachable: boolean; url: string | null; models: string[] };
  local_embedding: { available: boolean; source: string };
  local_memory: { available: boolean };
}

interface VoiceStatus {
  mic: boolean;
  stt: boolean;
  tts: boolean;
  note: string | null;
}

function CapabilityChip({ on, label }: { on: boolean; label: string }): JSX.Element {
  return (
    <span className={['ink-chip', on ? 'ink-text-accent' : 'ink-text-faint'].join(' ')}>
      {on ? '可用' : '降级'} · {label}
    </span>
  );
}

export function CapabilityOverview(): JSX.Element {
  const backend = useMemo(() => createBackend(), []);
  const [offline, setOffline] = useState<OfflineDetect | null>(null);
  const [voice, setVoice] = useState<VoiceStatus | null>(null);
  const [multimodal, setMultimodal] = useState(false);

  useEffect(() => {
    if (!backend.available) return;
    void (async () => {
      try {
        const o = (await backend.offlineDetect()) as unknown as OfflineDetect;
        setOffline(o);
      } catch {
        setOffline(null);
      }
      try {
        const v = (await backend.voiceStatus()) as unknown as VoiceStatus;
        setVoice(v);
      } catch {
        setVoice(null);
      }
      try {
        const m = (await backend.modelArchiveSnapshot()) as unknown as { archives?: Array<{ multimodal?: boolean | null }> };
        const profiles = m.archives ?? [];
        setMultimodal(profiles.some((p) => p.multimodal === true));
      } catch {
        setMultimodal(false);
      }
    })();
  }, [backend]);

  return (
    <div className="space-y-4">
      <div className="ink-elevated space-y-3 px-3.5 py-3">
        <div className="flex items-center gap-2">
          <Cpu size={14} strokeWidth={1.6} aria-hidden />
          <span className="text-[11px] font-medium">能力总览</span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="ink-elevated space-y-1.5 px-3 py-2.5">
            <div className="flex items-center gap-1.5">
              <Eye size={12} strokeWidth={1.6} aria-hidden />
              <span className="text-[11px]">视觉</span>
            </div>
            <CapabilityChip on={multimodal} label={multimodal ? '多模态已启用' : '关键词基线'} />
          </div>
          <div className="ink-elevated space-y-1.5 px-3 py-2.5">
            <div className="flex items-center gap-1.5">
              <Mic size={12} strokeWidth={1.6} aria-hidden />
              <span className="text-[11px]">语音</span>
            </div>
            <CapabilityChip on={(voice?.stt ?? false) || (voice?.tts ?? false)} label="STT/TTS" />
          </div>
          <div className="ink-elevated space-y-1.5 px-3 py-2.5">
            <div className="flex items-center gap-1.5">
              <WifiOff size={12} strokeWidth={1.6} aria-hidden />
              <span className="text-[11px]">Ollama</span>
            </div>
            <CapabilityChip on={offline?.ollama.reachable ?? false} label={offline?.ollama.url ?? '本地'} />
          </div>
          <div className="ink-elevated space-y-1.5 px-3 py-2.5">
            <div className="flex items-center gap-1.5">
              <Cpu size={12} strokeWidth={1.6} aria-hidden />
              <span className="text-[11px]">嵌入</span>
            </div>
            <CapabilityChip on={offline?.local_embedding.available ?? false} label={offline?.local_embedding.source ?? 'granite-97m'} />
          </div>
        </div>
        {!offline && !voice && (
          <p className="text-[10px] ink-text-faint">宿主不可用，能力状态显示降级。</p>
        )}
      </div>
    </div>
  );
}
