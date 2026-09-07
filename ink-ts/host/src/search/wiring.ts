/**
 * host 装配面：web_search 执行体注册 + seed 定义 + 密钥域共享。
 *
 * 引擎侧 web_search 端点类型/提取器已就位（registry + hooks），host 只补
 * 两件：① 执行体注册（DeclarativeToolExecutors.register('web_search')）；
 * ② seed 定义登记（register_definition，供引擎 dispatch 反查端点）。
 * allow_domains 过滤在执行体内（host 常量表 + 注入覆写），引擎无第二套。
 */

import {
  DeclarativeToolSpec,
  EndpointType,
  type DeclarativeToolExecutors,
} from '@ink-ts/engine';

import { makeWebSearchExecutor, type WebSearchExecutorDeps } from './executor.js';
import { SearchKeysStore } from './keys.js';

/** web_search seed 定义（与 plugins 源 web_search 声明对齐）。 */
export function webSearchSeedDefinition(): DeclarativeToolSpec {
  return new DeclarativeToolSpec({
    name: 'web_search',
    description: '联网检索：按查询词经已配置 provider 抓取网页结果文本。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索查询词' },
        provider: {
          type: 'string',
          description: '检索服务商（bing/bocha/exa；缺省 bing）',
        },
      },
      required: ['query'],
    },
    permissions: ['network:search:*'],
    endpoint: EndpointType.WEB_SEARCH,
    endpoint_config: {},
    meta: { executor: 'host:web_search' },
  });
}

/** host 检索接线产物（密钥域 + 执行体注册）。 */
export interface HostSearch {
  keys: SearchKeysStore;
  /** 注册执行体与 seed 定义（装配后调用一次）。 */
  register(declarative: DeclarativeToolExecutors): void;
}

/** 构建 host 检索接线（密钥域与执行体共享同一内存 store）。 */
export function buildHostSearch(
  deps: Omit<WebSearchExecutorDeps, 'keys'> = {},
): HostSearch {
  const keys = new SearchKeysStore();
  const executorDeps: WebSearchExecutorDeps = { ...deps, keys };
  return {
    keys,
    register(declarative: DeclarativeToolExecutors): void {
      declarative.register('web_search', makeWebSearchExecutor(executorDeps));
      declarative.register_definition(webSearchSeedDefinition());
    },
  };
}
