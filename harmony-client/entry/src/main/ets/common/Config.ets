import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';

const STORE_NAME: string = 'filament_config';
let appContext: common.Context | null = null;

export interface AppConfig {
  serverUrl: string;
  token: string;
}

export function initConfig(context: common.Context): void {
  appContext = context;
}

async function store(): Promise<preferences.Preferences> {
  if (appContext === null) {
    throw new Error('配置未初始化');
  }
  return await preferences.getPreferences(appContext, STORE_NAME);
}

export async function loadConfig(): Promise<AppConfig> {
  const p = await store();
  const serverUrl = await p.get('serverUrl', 'http://192.168.1.10:4174');
  const token = await p.get('token', '');
  return { serverUrl: String(serverUrl), token: String(token) };
}

export async function saveConfig(cfg: AppConfig): Promise<void> {
  const p = await store();
  await p.put('serverUrl', cfg.serverUrl);
  await p.put('token', cfg.token);
  await p.flush();
}
