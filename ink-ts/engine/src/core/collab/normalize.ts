/**
 * 协作数据面文本规范化（纯函数）：去重/收敛判据共用的最小文本语义。
 *
 * 规范化规则（设计稿 §7.4.4 ① 去重口径）：NFKC 统一全半角 + 去除全部空白
 * （含全角空格 U+3000，\s 已覆盖）。不做大小写折叠/标点删除——只落规格写明的
 * 「去空白/全半角统一」，避免超范围语义。
 *
 * 纯数据面（JSON 进 JSON 出、零 IO、零宿主词）。
 */

/** 规范化意见文本：NFKC 统一全半角后去除全部空白。 */
export function normalize_opinion_text(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, '');
}

/**
 * 两段规范化文本是否「相同或包含」（§7.4.4 ① 合并口径）。
 * 包含关系要求两侧非空（空串对任何文本平凡包含，不作包含判定；
 * 全等判定不受此限——两条全空意见视作重复）。
 */
export function texts_related(a: string, b: string): boolean {
  if (a === b) return true;
  if (a === '' || b === '') return false;
  return a.includes(b) || b.includes(a);
}
