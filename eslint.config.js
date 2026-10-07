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
      // The backend is an independent Node package with its own dependency
      // installation and verification job. Linting it from the Expo package
      // makes a clean CI checkout report false unresolved-import errors.
      'backend/**',
      '.expo/**',
      '.venv/**',
    ],
  },
]);
