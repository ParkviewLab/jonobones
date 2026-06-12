import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'coverage/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // The anti-corruption layer: src/joplin/ is the ONLY place allowed to
    // import @joplin/* (the lib has no stable API and no main entry; every
    // deep import is a liability that must stay quarantined in one place).
    files: ['src/**/*.ts'],
    ignores: ['src/joplin/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@joplin/*'],
              message: 'Only src/joplin/ (the anti-corruption layer) may import @joplin packages.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
