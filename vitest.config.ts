import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // Keep the HTTP entry point from binding a port when imported by tests.
    env: { COZI_MCP_HTTP_NO_LISTEN: '1' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/bin.ts'],
      reporter: ['text', 'html'],
    },
  },
});
