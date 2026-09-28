import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: {
        window: 'readonly', document: 'readonly', console: 'readonly',
        fetch: 'readonly', alert: 'readonly', confirm: 'readonly', location: 'readonly',
        indexedDB: 'readonly', localStorage: 'readonly', sessionStorage: 'readonly', setTimeout: 'readonly',
        URL: 'readonly', Blob: 'readonly', FileReader: 'readonly',
        atob: 'readonly', btoa: 'readonly', clearTimeout: 'readonly', setTimeout: 'readonly', unescape: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
        encodeURIComponent: 'readonly', Uint8Array: 'readonly', ArrayBuffer: 'readonly',
        TextEncoder: 'readonly', TextDecoder: 'readonly',
        CompressionStream: 'readonly', DecompressionStream: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
