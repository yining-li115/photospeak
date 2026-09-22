// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    // Keep CI focused on source we own. Expo, TypeScript and the local
    // Whisper environment all contain generated or third-party JavaScript
    // that must never be linted as application code.
    ignores: [
      'dist/**',
      'backend/dist/**',
      '.expo/**',
      'backend/.expo/**',
      '.venv/**',
    ],
  },
  {
    files: ['backend/**/*.cjs'],
    languageOptions: {
      globals: {
        __dirname: 'readonly',
      },
    },
  },
]);
