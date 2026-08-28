/**
 * 设置「语音」节：voice_status 只读基础位（完整接线归波 5 扩展）。
 *
 * 麦克风/STT/TTS 可用性芯片 + 合成自检按钮。
 */

import { useEffect, useState } from 'react';

import { Volume2 } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { createTauriInvoker } from '@/shared/backend/tauriBridge';

interface VoiceStatus {
  mic: boolean;
  stt: boolean;
  tts: boolean;
  stt_model_dir: string | null;
  note: string | null;
}

function Chip({ on, label }: { on: boolean; label: string }): JSX.Element {
  return (
    <span className={['ink-chip', on ? 'ink-text-accent' : 'ink-text-faint'].join(' ')}>
      {on ? '可用' : '不可用'} · {label}
    </span>
  );
}

export function VoiceSection(): JSX.Element {
  const tauri = createTauriInvoker();
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [speakTest, setSpeakTest] = useState<string | null>(null);

  useEffect(() => {
    if (!tauri) return;
    void (async () => {
      try {
        const s = (await tauri.invoke('voice_status', {})) as VoiceStatus;
        setStatus(s);
      } catch {
        setStatus(null);
      }
    })();
  }, [tauri]);

  const testSpeak = (): void => {
    setSpeakTest(null);
    if (!tauri) return;
    void tauri
      .invoke('voice_synthesize', { text: '语音合成链路自检' })
      .then(() => setSpeakTest('已朗读'))
      .catch(() => setSpeakTest('失败'));
  };

  return (
    <div className="space-y-3">
      <div className="ink-elevated divide-y divide-[var(--ink-border)] overflow-hidden">
        <div className="flex items-center gap-3 px-3.5 py-2.5">
          <span className="min-w-0 flex-1 text-[11px]">麦克风采集</span>
          <Chip on={status?.mic ?? false} label="mic" />
        </div>
        <div className="flex items-center gap-3 px-3.5 py-2.5">
          <span className="min-w-0 flex-1 text-[11px]">语音识别（STT）</span>
          <Chip on={status?.stt ?? false} label="stt" />
        </div>
        <div className="flex items-center gap-3 px-3.5 py-2.5">
          <span className="min-w-0 flex-1 text-[11px]">语音合成（TTS）</span>
          <Chip on={status?.tts ?? false} label="tts" />
        </div>
      </div>
      {status?.note && (
        <p className="text-[10px] leading-relaxed ink-text-faint">{status.note}</p>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" variant="secondary" onClick={testSpeak}>
          <Volume2 size={11} strokeWidth={1.6} /> 合成自检
        </Button>
        {speakTest && <span className="text-[10px] ink-text-faint">{speakTest}</span>}
      </div>
      <p className="text-[10px] ink-text-faint">完整语音接线归波 5 扩展，此处为基础位。</p>
    </div>
  );
}
