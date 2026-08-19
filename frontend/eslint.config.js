// eslint 扁平配置（eslint 9）：TypeScript 解析 + 基础规则从宽起步。
// 规则面随代码库收敛逐步收紧；当前目标 = lint 可运行、可发现明显
// 未定义引用与遗留调试语句。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
);
