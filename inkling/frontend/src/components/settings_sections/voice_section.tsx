/**
 * 设置「语音与离线」节：本地语音能力（麦克风 / STT / TTS）+ 离线支持级
 * （Ollama / 本地嵌入 / 本地记忆 / settings 档）。
 *
 * 复用设置面板交互形态：能力芯片 + 开关 + 下拉，调用宿主 voice 与
 * offline 命令（经 tauriBridge 直调，缺宿主回落禁用态）。
 */

import { useEffect, useState } from 'react';

import { Mic, Volume2, WifiOff } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { createBackend, type BackendAdapter } from '@/shared/backend/backendAdapter';
import { logger } from '@/shared/logger';

interface VoiceStatus {
  mic: boolean;
  stt: boolean;
  tts: boolean;
  stt_model_dir: string;
  note: string | null;
}

interface OfflineDetect {
  ollama: { reachable: boolean; url: string | null; models: string[] };
  local_embedding: { available: boolean; source: string };
  local_memory: { available: boolean };
}

interface OfflineSettings {
  enabled: boolean;
  mode: 'auto' | 'local' | 'cloud';
  ollama_url: string;
  use_local_embedding: boolean;
  use_local_memory: boolean;
}

const DEFAULT_OFFLINE: OfflineSettings = {
  enabled: false,
  mode: 'auto',
  ollama_url: '',
  use_local_embedding: true,
  use_local_memory: true,
};

export interface VoiceSectionProps {
  /** 宿主可用时注入 backend；缺省则组件内自取（测试可注入 mock）。 */
  backend?: BackendAdapter;
}

function Chip({ on, label }: { on: boolean; label: string }): JSX.Element {
  return (
    <span
      className={`ink-chip ${on ? 'ink-text-accent' : 'ink-text-faint'}`}
      data-ui={`voice_cap_${label}`}
    >
      {on ? '可用' : '不可用'} · {label}
    </span>
  );
}

export function VoiceSection({ backend: backendProp }: VoiceSectionProps) {
  const backend = backendProp ?? createBackend();
  const available = backend.available;

  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [offline, setOffline] = useState<OfflineDetect | null>(null);
  const [settings, setSettings] = useState<OfflineSettings>(DEFAULT_OFFLINE);
  const [speakTest, setSpeakTest] = useState<string | null>(null);

  useEffect(() => {
    if (!backend.available) return;
    void (async () => {
      try {
        const s = (await backend.voiceStatus()) as unknown as VoiceStatus;
        setStatus(s);
      } catch {
        setStatus(null);
      }
      try {
        const o = (await backend.offlineDetect()) as unknown as OfflineDetect;
        setOffline(o);
      } catch {
        setOffline(null);
      }
      try {
        const cfg = (await backend.offlineSettingsGet()) as Partial<OfflineSettings>;
        setSettings({ ...DEFAULT_OFFLINE, ...cfg });
      } catch {
        setSettings(DEFAULT_OFFLINE);
      }
    })();
  }, [backend]);

  const saveSettings = (next: OfflineSettings): void => {
    setSettings(next);
    if (backend.available) {
      void backend.offlineSettingsPut(next as unknown as Record<string, unknown>).catch(() => undefined);
    }
  };

  const testSpeak = (): void => {
    setSpeakTest(null);
    if (!backend.available) return;
    void backend
      .voiceSynthesize('语音合成链路自检')
      .then(() => setSpeakTest('已朗读'))
      .catch((e: unknown) => {
        logger.error('voice', '语音合成自检失败', { err: String(e) });
        setSpeakTest('自检失败');
      });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Mic size={13} strokeWidth={1.6} aria-hidden />
        <span className="text-[11px] font-medium">本地语音能力</span>
        {!available && <span className="ink-chip ink-text-faint">宿主不可用</span>}
      </div>
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
        <p className="text-[10px] leading-relaxed ink-text-faint" data-ui="voice_stt_note">
          {status.note}（模型由 CI/用户放置，缺失即降级）
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" variant="secondary" data-ui="voice_speak_test" onClick={testSpeak}>
          <Volume2 size={11} strokeWidth={1.6} /> 合成自检
        </Button>
        {speakTest && <span className="text-[10px] ink-text-faint" data-ui="voice_speak_result">{speakTest}</span>}
      </div>

      <div className="flex items-center gap-2 pt-1">
        <WifiOff size={13} strokeWidth={1.6} aria-hidden />
        <span className="text-[11px] font-medium">离线支持级</span>
        {offline?.ollama.reachable && (
          <span className="ink-chip ink-text-accent">Ollama 已探测：{offline.ollama.url}</span>
        )}
      </div>
      <div className="ink-elevated divide-y divide-[var(--ink-border)] overflow-hidden">
        <div className="flex items-center gap-3 px-3.5 py-2.5">
          <span className="min-w-0 flex-1 text-[11px]">本地嵌入（granite-97m 随包）</span>
          <Chip on={offline?.local_embedding.available ?? false} label="embed" />
        </div>
        <div className="flex items-center gap-3 px-3.5 py-2.5">
          <span className="min-w-0 flex-1 text-[11px]">本地记忆 / 技能</span>
          <Chip on={offline?.local_memory.available ?? false} label="memory" />
        </div>
      </div>

      <div className="flex items-center justify-between rounded-md ink-elevated px-3.5 py-2.5">
        <span className="text-[11px]">离线模式</span>
        <select
          className="ink-input text-[11px]"
          data-ui="offline_mode"
          value={settings.mode}
          onChange={(e) => saveSettings({ ...settings, mode: e.target.value as OfflineSettings['mode'] })}
        >
          <option value="auto">自动（有本地模型走本地）</option>
          <option value="local">强制本地</option>
          <option value="cloud">强制云端</option>
        </select>
      </div>
      <div className="flex items-center justify-between rounded-md ink-elevated px-3.5 py-2.5">
        <span className="text-[11px]">启用离线档</span>
        <input
          type="checkbox"
          className="ink-checkbox"
          data-ui="offline_enabled"
          checked={settings.enabled}
          onChange={(e) => saveSettings({ ...settings, enabled: e.target.checked })}
          aria-label="启用离线档"
        />
      </div>
    </div>
  );
}
