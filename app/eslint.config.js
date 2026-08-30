// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', 'check-globals.mjs'],
    rules: {
      // The rule that matters here. `guard` was called and never defined, which
      // is a synchronous throw in a tap handler -- a hard crash on Hermes, and
      // invisible to every web build and export. Never let this be a warning.
      'no-undef': 'error',

      // The React Compiler's experimental purity rules flag long-standing
      // patterns (syncing state from props in an effect) that work correctly
      // here. Kept visible, but not blocking, so a real `no-undef` is never
      // buried in noise.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
    },
  },
]);
