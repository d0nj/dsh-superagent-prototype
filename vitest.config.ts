import { defineConfig } from 'vitest/config'
// Share one React instance across DSH client packages and tests.
// A test that starts processes or the runtime takes longer on Windows than the default 5s, especially beside other files.
export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  test: { include: ['tests/**/*.spec.{ts,tsx}'], testTimeout: 15_000 },
})
