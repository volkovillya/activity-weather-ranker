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
  },
  { ...tseslint.configs.disableTypeChecked, files: ['**/*.js', '**/*.mjs'] },
  { files: ['**/*.js'], languageOptions: { sourceType: 'commonjs' } },
  prettier,
);
