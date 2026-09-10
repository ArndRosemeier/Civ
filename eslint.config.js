import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/.cache/**'] },
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Determinism guard: the engine must not read ambient time or use
    // non-reproducible / runtime-varying math. See PLAN.md section 5.3.
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use the seeded RNG carried in GameState.' },
        { object: 'Date', property: 'now', message: 'Engine must be deterministic: no ambient time.' },
        { object: 'performance', property: 'now', message: 'Engine must be deterministic: no ambient time.' },
        { object: 'Math', property: 'pow', message: 'Determinism: transcendentals vary across runtimes.' },
        { object: 'Math', property: 'sin', message: 'Determinism: transcendentals vary across runtimes.' },
        { object: 'Math', property: 'cos', message: 'Determinism: transcendentals vary across runtimes.' },
        { object: 'Math', property: 'log', message: 'Determinism: transcendentals vary across runtimes.' },
      ],
    },
  },
  {
    files: ['**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
