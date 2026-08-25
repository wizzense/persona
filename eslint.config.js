import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // dist.abandoned-src-build and .orphaned-session-work-* are local session
    // junk (old trees left by a 2026-08-24 session); they never exist in CI
    // but dominated the local lint output (4,2xx of 4,272 errors).
    ignores: [
      'dist/**',
      'release/**',
      'node_modules/**',
      'dist.abandoned-src-build/**',
      '.orphaned-session-work-*/**',
      '__pycache__/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-hooks/set-state-in-effect': 'off',
      // The three.js scene is deliberately imperative: "latest value" refs
      // written during render (transformRef.current = transform) are the
      // measured de-jank mechanism — a per-pointermove setState was the
      // "janky as fuck" stutter the owner reported. Handlers read these refs
      // only after commit, so the concurrent-render hazard the rule guards
      // does not apply here. rules-of-hooks stays ON — it caught a real
      // conditional-hook bug in App.tsx (2026-08-25).
      'react-hooks/refs': 'off',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    files: ['electron/**/*.cjs', 'scripts/**/*.cjs'],
    languageOptions: {
      globals: globals.node,
      sourceType: 'commonjs',
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // ESM siblings get node globals WITHOUT the commonjs wrapper — declaring
    // `const __dirname = ...` is correct runtime code in a real .mjs and must
    // not be reported as a redeclare of a builtin.
    files: ['electron/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // The preload bridges run in the renderer with contextIsolation, so they
    // legitimately reach DOM globals the electron/node scope omits.
    files: ['electron/preload.cjs', 'electron/living-desktop-preload.cjs'],
    languageOptions: {
      globals: {
        ...globals.node,
        window: 'readonly',
        Element: 'readonly',
      },
    },
  },
  {
    files: ['vite.config.ts', 'vitest.config.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },
);
