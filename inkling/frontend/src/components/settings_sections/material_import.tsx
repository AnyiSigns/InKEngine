/**
 * 设置「成长状态」节（配合自学习管线状态展示）：既有资料批量导入
 * （搬进 InKEngine 第一步）。
 *
 * 交互沿用附件管线的「选择 → 进度 → 结果」三段：选目录 → 扫描预览（归一清单）
 * → 入料（经样例闸门/知识集入料链），逐文件回显入料状态。
 */

import { useState } from 'react';

import { Button } from '@/shared/ui/Button';
import { Field, TextInput } from '@/shared/ui/Field';

import { createDomDirectoryPicker } from '@/shared/media/filePicker';
import type {
  BackendAdapter,
  MaterialImportResult,
  MaterialScanResult,
} from '@/shared/backend/backendAdapter';

export interface MaterialImportProps {
  materialImport?: BackendAdapter;
}

function dir_of(picked?: string): string {
  if (!picked) return '';
  const idx = Math.max(picked.lastIndexOf('/'), picked.lastIndexOf('\\'));
  return idx > 0 ? picked.slice(0, idx) : picked;
}

export function MaterialImportPanel({ materialImport }: MaterialImportProps) {
  const [path, setPath] = useState('');
  const [recursive, setRecursive] = useState(false);
  const [scan, setScan] = useState<MaterialScanResult | null>(null);
  const [result, setResult] = useState<MaterialImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!materialImport) {
    return (
      <div className="ink-elevated px-3.5 py-3 text-[11px] ink-text-faint" data-ui="material_import_unavailable">
        导入操作面不可用（需桌面壳宿主）
      </div>
    );
  }
  const mi = materialImport;

  const browse = async (): Promise<void> => {
    const files = await createDomDirectoryPicker().pick();
    if (files.length > 0) setPath(dir_of(files[0].path ?? files[0].name));
  };

  const scan_dir = async (): Promise<void> => {
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      setScan(await mi.materialScan(path, recursive));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setScan(null);
    } finally {
      setBusy(false);
    }
  };

  const ingest = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      setResult(await mi.materialIngest(path, recursive));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ink-elevated space-y-2.5 px-3.5 py-3">
      <div className="text-[11px] font-medium tracking-wide ink-text-muted">
        既有资料批量导入
      </div>
      <Field label="目录路径" hint="须落在用户主目录域内（~/ 及工作区/附件）；只读扫描，不改动原文件。">
        <div className="flex items-center gap-2">
          <TextInput
            className="flex-1"
            value={path}
            aria-label="导入目录路径"
            data-ui="material_import_path"
            onChange={(e) => setPath(e.target.value)}
          />
          <Button size="sm" variant="secondary" data-ui="material_import_browse" onClick={browse}>
            浏览目录
          </Button>
        </div>
      </Field>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          className="ink-check"
          checked={recursive}
          data-ui="material_import_recursive"
          onChange={(e) => setRecursive(e.target.checked)}
        />
        <span className="text-[11px]">递归子目录</span>
      </label>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" data-ui="material_import_scan" disabled={busy || !path} onClick={scan_dir}>
          扫描预览
        </Button>
        <Button size="sm" variant="primary" data-ui="material_import_ingest" disabled={busy || !path} onClick={ingest}>
          导入入库
        </Button>
      </div>
      {error && <div className="text-[11px] ink-text-danger" data-ui="material_import_error">{error}</div>}
      {scan && (
        <div className="space-y-1.5" data-ui="material_import_scan_result">
          <div className="text-[11px]">
            扫描 {scan.scanned} 件 · 可归一 {scan.files.length} 件 · 跳过 {scan.skipped.length} 件
          </div>
          <ul className="max-h-40 overflow-auto text-[10px] ink-text-faint">
            {scan.files.map((file) => (
              <li key={file.path}>
                [{file.format}] {file.path}
              </li>
            ))}
          </ul>
          {scan.skipped.length > 0 && (
            <ul className="max-h-24 overflow-auto text-[10px] ink-text-danger">
              {scan.skipped.map((skip) => (
                <li key={skip.path}>
                  跳过 {skip.path}：{skip.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {result && (
        <div className="space-y-1.5" data-ui="material_import_result">
          <div className="text-[11px]">
            入料完成 · 已入 {result.ingested} 件 · 拒绝 {result.rejected} 件
          </div>
          <ul className="max-h-40 overflow-auto text-[10px]">
            {result.files.map((item) => (
              <li key={item.path} className={item.status === 'rejected' ? 'ink-text-danger' : 'ink-text-muted'}>
                {item.status === 'ingested' ? '入集' : '拒绝'} {item.path}
                {item.reason ? `（${item.reason}）` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
