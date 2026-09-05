/**
 * host doc 域（文档解析执行体消费面）数据形态。
 *
 * 机械执行在 exec 原生件（op=doc，file 端点）；host 只做「根内路径裁决 +
 * 结果归一」，不做文档格式判断之外的策略。解析失败一律结构化返回
 * （{ok:false, code}），由消费方决定降级语义（round 文本注入 vs 跳过）。
 */

/** 解析成功（text 为 exec 截断后的文档文本；truncated 带截断标记）。 */
export interface DocParseSuccess {
  ok: true;
  format: string;
  text: string;
  page_count: number | null;
  truncated: boolean;
}

/** 解析失败（code 供归类：exec_unavailable / 越根 / 非法格式等）。 */
export interface DocParseFailure {
  ok: false;
  code: string;
  message: string;
}

export type DocParseResult = DocParseSuccess | DocParseFailure;

/** 文档解析执行体接口（rounds/material 注入点；测试可桩）。 */
export interface DocParser {
  /**
   * 解析根目录内的文档文件为文本。
   *
   * @param path  文档绝对路径（须在 root 内；越根 fail-closed）。
   * @param root  授权根（host 裁决的挂载根，如附件目录）。
   * @param maxChars 输出文本截断上限（覆盖构造缺省）。
   */
  parseDocument(path: string, root: string, maxChars?: number): Promise<DocParseResult>;
}
