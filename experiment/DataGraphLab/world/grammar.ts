/**
 * 文法门面（D 表要求的公开符号收口）。
 *
 * 实现分散在 `lexicon.ts`（词表数据）、`tokenize.ts`（分词/命中）、`render.ts`
 * （渲染/解析）；本文件只 re-export，不实现。同时给出算法规格里 snake_case 的
 * 别名（`render_recipe`/`render_goal`/`mention_stats`），避免两套命名各写一份。
 */

export {
  LEXICON,
  GOAL_LEX,
  GOAL_TEMPLATES,
  GOAL_CONNECTORS,
  RECIPE_PREFIXES,
  RECIPE_CONNECTORS,
} from './lexicon.js';
export { tokens, senseTokens, findSequence, mentionStats } from './tokenize.js';
export type { MentionStats } from './tokenize.js';
export { renderRecipe, renderGoal, parseRecipe } from './render.js';
export { LEX_OPS_BASE } from './operators.js';
export { goalOk } from './goal.js';
export type { Goal } from './goal.js';

export { renderRecipe as render_recipe, renderGoal as render_goal } from './render.js';
export { mentionStats as mention_stats } from './tokenize.js';
