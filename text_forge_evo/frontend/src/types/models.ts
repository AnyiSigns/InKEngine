export interface ModelTierConfig {
  adapter: string;
  base_url: string;
  model_id: string;
  api_key: string;
  temperature: number;
  max_tokens: number | null;
  request_timeout: number;
}

export interface ModelsState {
  main: ModelTierConfig;
  router: ModelTierConfig | null;
}

export const ADAPTERS = [
  'openai_compat',
  'deepseek',
  'openai',
  'zhipu',
  'moonshot',
  'ollama',
] as const;

export interface TierMeta {
  key: keyof ModelsState;
  label: string;
  desc: string;
}
