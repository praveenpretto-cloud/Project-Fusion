import js from '@eslint/js';
import globals from 'globals';

export default [
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.jest,
            },
            ecmaVersion: 2022,
            sourceType: 'commonjs',
        },
        rules: {
            'no-unused-vars': 'warn',
            'no-console': 'off',
            'no-undef': 'error',
            'no-empty': ['error', { allowEmptyCatch: true }],
        },
    },
    {
        ignores: ['coverage/', 'node_modules/', 'dist/', 'client/', '.next/', 'build/', '*.min.js'],
    },
];
