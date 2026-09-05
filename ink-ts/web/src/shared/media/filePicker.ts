/**
 * 文件选择抽象（可注入）：输入框「选择文件」入口的拾取接口。
 *
 * 默认实现走 DOM input[type=file]（浏览器/桌面壳通用）；测试/桌面壳
 * 可注入自定义拾取器（集成期宿主侧原生对话框）。拾取结果交给媒体
 * 策略分发（图片/视频/文档/其它），组件不感知拾取介质。
 */

export interface PickedFile {
  name: string;
  mime?: string;
  size?: number;
  path?: string;
}

export interface FilePicker {
  pick(): Promise<PickedFile[]>;
}

/** 浏览器默认拾取器（input[type=file] 多选）。 */
export function createDomFilePicker(): FilePicker {
  return {
    pick(): Promise<PickedFile[]> {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.style.display = 'none';
        const cleanup = (): void => {
          input.remove();
        };
        input.onchange = (): void => {
          const files = Array.from(input.files ?? []).map((file) => ({
            name: file.name,
            mime: file.type || undefined,
            size: file.size,
            path: (file as File & { path?: string }).path,
          }));
          cleanup();
          resolve(files);
        };
        document.body.appendChild(input);
        input.click();
      });
    },
  };
}

/** 测试/可注入占位：固定返回一组文件。 */
export function createStubFilePicker(files: PickedFile[]): FilePicker {
  return {
    async pick(): Promise<PickedFile[]> {
      return files;
    },
  };
}

/** 浏览器默认目录拾取器（input[webkitdirectory]；桌面壳下 file.path 带绝对路径）。 */
export function createDomDirectoryPicker(): FilePicker {
  return {
    pick(): Promise<PickedFile[]> {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        // 非标准属性，setAttribute 才能生效（目录多选）
        input.setAttribute('webkitdirectory', '');
        input.setAttribute('directory', '');
        input.style.display = 'none';
        const cleanup = (): void => {
          input.remove();
        };
        input.onchange = (): void => {
          const files = Array.from(input.files ?? []).map((file) => ({
            name: file.name,
            size: file.size,
            path:
              (file as File & { path?: string }).path ??
              (file as File & { webkitRelativePath?: string }).webkitRelativePath,
          }));
          cleanup();
          resolve(files);
        };
        document.body.appendChild(input);
        input.click();
      });
    },
  };
}
