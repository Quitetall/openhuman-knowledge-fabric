import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      // The browser tests' own production builds, present only while one runs.
      '**/.next-e2e-*/**',
      '**/coverage/**',
      // generated/ is compiler output. Reviewing it is the ontology compiler's job,
      // not the linter's — and drift is caught by the generated-vs-committed CI check.
      'generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain Node scripts outside the TypeScript projects. TypeScript files get their Node
    // globals from the @types/node each package declares.
    files: ['**/*.mjs', '**/*.cjs', '**/scripts/**/*.js'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly', URL: 'readonly' },
    },
  },
  {
    // Recorded evidence: the scripts that ran for a dated report, kept byte-for-byte so the
    // report can be re-read against them. They cannot take the `/* global fetch */` comment the
    // maintained fixtures use without ceasing to be what ran, so the Node 24 globals they call
    // are declared here, for these paths only (the int-07 runs call fetch and setTimeout).
    files: ['fixtures/**/evidence/**/*.mjs'],
    languageOptions: {
      globals: { fetch: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly' },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      // A controlled record must never be silently coerced. `any` is how that happens.
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // KF-SAS-RQ-018: a known gap lives somewhere enumerable (SAS §100, an ADR, a pack
      // known_gaps entry, a named checker warning), never only in a comment. 'anywhere', not the
      // default 'start', because a marker after a prefix is still a marker. Files
      // ESLint does not read (sql, sh, conf, yaml) are scanned by
      // tests/conformance/no-inline-markers.test.ts.
      'no-warning-comments': [
        'error',
        { terms: ['todo', 'fixme', 'xxx', 'hack'], location: 'anywhere' },
      ],
    },
  },
  prettier,
);
