/** 后端错误解析：提取友好文案与状态码。 */

export interface ApiErrorInfo {
  message: string;
  status?: number;
}

export class ApiError extends Error {
  status?: number;

  constructor(info: ApiErrorInfo) {
    super(info.message);
    this.name = 'ApiError';
    this.status = info.status;
  }
}

async function parseError(response: Response): Promise<ApiError> {
  let message = `请求失败（${response.status}）`;
  try {
    const data = (await response.json()) as { detail?: unknown };
    if (typeof data.detail === 'string') {
      message = data.detail;
    }
  } catch {
    // 非 JSON 响应，保留默认文案
  }
  return new ApiError({ message, status: response.status });
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  if (!response.ok) {
    throw await parseError(response);
  }
  return (await response.json()) as T;
}
