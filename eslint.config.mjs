import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // `const { dropped, ...rest } = row` is the idiomatic way to omit a field.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  { ...tseslint.configs.disableTypeChecked, files: ['**/*.js', '**/*.mjs'] },
  { files: ['**/*.js'], languageOptions: { sourceType: 'commonjs' } },
  prettier,
);
