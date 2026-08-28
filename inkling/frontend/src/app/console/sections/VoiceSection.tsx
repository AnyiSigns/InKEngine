import { useEffect, useState } from 'react';
import { Mic, MicOff } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { invokeOp } from '../../shared/invokeOp';

export interface VoiceStatus {
  available: boolean;
  recording: boolean;
  devices: Array<{ id: string; name: string }>;
  active_device: string | null;
}

export function VoiceSection() {
  const [status, setStatus] = useState<VoiceStatus | null>(null);

  useEffect(() => {
    void load();
  }, []);

  const load = async () => {
    const result = await invokeOp<VoiceStatus>('voice_status', {});
    setStatus(result ?? { available: false, recording: false, devices: [], active_device: null });
  };

  const handleRecord = async () => {
    await invokeOp('voice_record', {});
    await load();
  };

  const handleTranscribe = async () => {
    await invokeOp('voice_transcribe', {});
    await load();
  };

  return (
    <div data-ui="voice_section" className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Mic size={14} strokeWidth={1.6} className="text-[var(--ink-text-muted)]" />
        <h3 className="text-[13px] font-medium text-[var(--ink-text-base)]">语音</h3>
      </div>

      <div className="flex flex-col gap-2 rounded border border-[var(--ink-border)] p-3">
        <div className="flex items-center gap-2">
          {status?.available ? (
            <Mic size={12} strokeWidth={1.6} className="text-emerald-500" />
          ) : (
            <MicOff size={12} strokeWidth={1.6} className="text-[var(--ink-text-faint)]" />
          )}
          <span className="text-[11px] text-[var(--ink-text-base)]">
            {status?.available ? '语音可用' : '语音不可用'}
          </span>
        </div>

        {status?.recording && (
          <div className="text-[10px] text-[var(--ink-accent-approval)]">录音中...</div>
        )}

        {status?.devices && status.devices.length > 0 && (
          <div className="flex flex-col gap-1">
            <div className="text-[10px] text-[var(--ink-text-muted)]">设备列表</div>
            {status.devices.map((d) => (
              <div key={d.id} className="text-[10px] text-[var(--ink-text-faint)]">
                {d.name} {d.id === status.active_device && '（当前）'}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <Button size="sm" variant="secondary" onClick={() => handleRecord()}>
          <Mic size={12} strokeWidth={1.6} />
          {status?.recording ? '停止录音' : '开始录音'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => handleTranscribe()}>
          转写
        </Button>
      </div>
    </div>
  );
}
