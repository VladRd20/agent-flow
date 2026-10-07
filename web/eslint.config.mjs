// Minimal ESLint config scoped to web/. The monorepo has no root-level
// ESLint setup (extension/ is audited/linted separately); this config only
// applies within this package (run `pnpm --filter agent-flow-web run lint`).
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  {
    ignores: ['.next/**', 'node_modules/**', 'dist/**', 'next-env.d.ts'],
  },
  ...tseslint.configs.recommended,
  {
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      // Only the long-stable hook rules (correctness of hook call order, and
      // effect/callback dependency arrays). NOT eslint-plugin-react-hooks's
      // full v7 "recommended" set — that also includes newer React-Compiler-
      // oriented rules (react-hooks/refs, react-hooks/set-state-in-effect)
      // that flag this codebase's established ref-during-render pattern
      // (animateRef.current = animate, etc., used deliberately to avoid
      // stale closures in the rAF loop — see hooks/use-agent-simulation.ts).
      // Enabling those here would just be ~60 false-positive-shaped errors
      // against an intentional, already-audited pattern, not real findings.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Useful for catching dead code without being overly strict about
      // intentionally-unused function args (common in event handler shapes).
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
)
