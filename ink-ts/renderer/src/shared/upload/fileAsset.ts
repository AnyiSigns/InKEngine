/**
 * 文件资产读取工具（附件链路面）：
 * - fileToDataUrl：FileReader.readAsDataURL → data:image/...（图片直发
 *   载荷；对齐引擎 Attachment image_url 段——远端端点不支持多模态时由
 *   上层降级文本引用，此层只负责把本地文件读成可直发的 data URL）。
 * - uploadThenAsset：选文件先经 serve /upload 通道上传，回填可解析的
 *   url/path 入附件载荷（通道不可用 = 返回 null，调用方走既有占位/夹具）。
 */

/** FileReader.readAsDataURL → data URL（图片直发载荷面）。 */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (result === '') reject(new Error('FileReader 结果为空'));
      else resolve(result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader 读取失败'));
    reader.readAsDataURL(file);
  });
}

/** 上传回执（serve /upload 落盘产物；path 供宿主 doc.parse 取用）。 */
export interface UploadAsset {
  path: string;
  url: string;
  name: string;
  size: number;
  mime: string;
}

/**
 * 附件上传：经 serve 通道 /upload 落白名单目录并回填 path/url。
 * 返回 null 表示通道不可用（web 无 serve URL 时保持既有占位/夹具路径）。
 */
export async function uploadThenAsset(file: File): Promise<UploadAsset | null> {
  const { uploadAttachment } = await import('@/shared/backend/transport');
  const receipt = await uploadAttachment(file);
  if (receipt === null) return null;
  return { path: receipt.path, url: receipt.url, name: receipt.name, size: receipt.size, mime: receipt.mime };
}
