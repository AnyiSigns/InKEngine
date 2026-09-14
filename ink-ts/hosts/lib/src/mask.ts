/**
 * host 侧掩码工具（模型配置 api_key 视图掩码；纯函数，host 视图关注点）。
 *
 * S4 随检索域下沉时留宿主：model_config_runtime/model_providers 的 api_key
 * 掩码化是宿主视图面（models.config.* 的 masked 回显 ），不属检索域实现位。
 * 检索域（plugins/domains/search）的 SearchKeysStore.masked 亦复用它——
 * 插件经 @ink-ts/host 取用本纯工具（host → 插件的反方向不成立）。
 */

/** 密钥掩码（仅回显前 4 字符 + 掩码尾缀，防泄露完整密钥）。 */
export function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****`;
}