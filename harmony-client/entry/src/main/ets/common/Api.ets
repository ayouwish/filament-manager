import { http } from '@kit.NetworkKit';
import { AppState, RecognizeResult, VisionStatus } from '../model/Types';
import { loadConfig } from './Config';

async function baseUrl(): Promise<string> {
  const cfg = await loadConfig();
  const url = cfg.serverUrl.trim().replace(/\/+$/, '');
  if (url.length === 0) {
    throw new Error('请先在「设置」里填写 NAS 服务器地址');
  }
  return url;
}

async function request<T>(path: string, method: http.RequestMethod, body?: Object): Promise<T> {
  const cfg = await loadConfig();
  const url = `${await baseUrl()}${path}`;
  const req = http.createHttp();
  try {
    const header: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cfg.token.length > 0) {
      header['x-fm-token'] = cfg.token;
    }
    const res = await req.request(url, {
      method: method,
      header: header,
      extraData: body !== undefined ? JSON.stringify(body) : undefined,
      connectTimeout: 10000,
      readTimeout: 180000,
    });
    const text: string = typeof res.result === 'string' ? res.result : '';
    if (res.responseCode !== 200 && res.responseCode !== 201) {
      let message: string = `HTTP ${res.responseCode}`;
      try {
        const parsed = JSON.parse(text) as Record<string, string>;
        message = parsed.error !== undefined ? parsed.error : (parsed.message !== undefined ? parsed.message : message);
      } catch (err) {
        // 保留默认错误信息
      }
      throw new Error(message);
    }
    if (text.length === 0) {
      return {} as T;
    }
    return JSON.parse(text) as T;
  } finally {
    req.destroy();
  }
}

export function getState(): Promise<AppState> {
  return request<AppState>('/api/state', http.RequestMethod.GET);
}

export function health(): Promise<Object> {
  return request<Object>('/api/health', http.RequestMethod.GET);
}

export function visionStatus(): Promise<VisionStatus> {
  return request<VisionStatus>('/api/vision/status', http.RequestMethod.GET);
}

export function consumeSpool(id: string, grams: number): Promise<Object> {
  return request<Object>(`/api/spools/${id}/consume`, http.RequestMethod.POST, { grams: grams });
}

export function deleteSpool(id: string): Promise<Object> {
  return request<Object>(`/api/spools/${id}`, http.RequestMethod.DELETE);
}

export function createSpool(payload: Object): Promise<Object> {
  return request<Object>('/api/spools', http.RequestMethod.POST, payload);
}

export function bulkCreate(items: Object[], photoDataUrl: string): Promise<Object> {
  return request<Object>('/api/spools/bulk', http.RequestMethod.POST, {
    items: items,
    photoDataUrl: photoDataUrl,
  });
}

export function recognize(base64: string, mimeType: string): Promise<RecognizeResult> {
  return request<RecognizeResult>('/api/recognize', http.RequestMethod.POST, {
    base64: base64,
    mimeType: mimeType,
  });
}
