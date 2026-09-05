/**
 * 产品身份单一事实源（构建期读取真实 manifest.json）。
 *
 * 身份文案只在 `inkling/manifest.json` 维护（schema 门禁以定稿常量核对
 * `positioning`/`name` 原文，recipe 测试钉同源）；前端一律经本模块取用，
 * 不再硬编码产品名 / 定位语 / 版本——改定位只改 manifest 一处。
 * 双项目并存期身份 manifest 真源仍在旧侧 inkling/；旧侧停用后统一收口
 * 身份单一事实源到 ink-ts 数据面。
 */
import manifest from '../../../../inkling/manifest.json';

interface ManifestIdentity {
  name?: string;
  positioning?: string;
  version?: string;
}

const identity = manifest as ManifestIdentity;

export const PRODUCT_NAME = identity.name || 'InKling';
/** 完整定位语（manifest.positioning 原文）。 */
export const PRODUCT_POSITIONING = identity.positioning || '';
/** 定位语「：」前的短名（如「受控自进化智能体」）。 */
export const PRODUCT_TAGLINE = PRODUCT_POSITIONING.split('：')[0] || PRODUCT_NAME;
export const PRODUCT_VERSION = identity.version || '0.1.0';
