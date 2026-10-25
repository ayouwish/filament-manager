export interface Spool {
  id: string;
  name: string;
  brand?: string;
  type: string;
  colorHex: string;
  colorName?: string;
  totalGrams: number;
  remainingGrams: number;
  photo?: string;
  productPhoto?: string;
  productPhotoSource?: string;
  note?: string;
  opened?: boolean;
}

export interface JobItem {
  spoolId: string;
  spoolName?: string;
  colorHex?: string;
  grams: number;
}

export interface Job {
  id: string;
  title: string;
  totalGrams: number;
  createdAt: string;
  items: JobItem[];
}

export interface VisionSettings {
  provider: string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
}

export interface SettingsInfo {
  match?: Object;
  vision?: VisionSettings;
}

export interface AppState {
  spools: Spool[];
  jobs: Job[];
  settings: SettingsInfo;
}

export interface RecognizeItem {
  name?: string;
  brand?: string;
  material?: string;
  colorName?: string;
  colorHex?: string;
  sku?: string;
  productLine?: string;
  spoolWeightG?: number;
  count?: number;
  confidence?: number;
  hexSource?: string;
  labelText?: string;
}

export interface RecognizeResult {
  ok: boolean;
  provider?: string;
  model?: string;
  items: RecognizeItem[];
  summary?: string;
  warnings?: string[];
  message?: string;
  reason?: string;
}

export interface VisionStatus {
  ready: boolean;
  provider: string;
  model: string;
  reason?: string;
  availableModels?: string[];
}
