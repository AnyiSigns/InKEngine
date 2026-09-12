// P6 归位薄壳（引擎重排计划 §6 P6 动作 C）：strip_sensitive 族本体已下移
// model/storage/sensitive.ts；本文件保留公共面路径，原样 re-export，
// 全部既有消费者（gate 内测试与非 adapter 消费者）不改。
export {
  SENSITIVE_KEYS,
  is_sensitive_key,
  strip_sensitive,
  strip_sensitive_text,
} from '../../model/storage/sensitive.js';