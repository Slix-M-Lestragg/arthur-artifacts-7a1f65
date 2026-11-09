import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // The obsidian package ships type definitions with an empty "main" field,
      // so vitest cannot resolve it directly. Point runtime imports at a stub.
      obsidian: path.resolve('src/__mocks__/obsidian.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
