import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    // Files share one seeded database and assert on stock deltas.
    fileParallelism: false,
    // Shuffle file order so cross-file state dependencies surface; tests within a file stay ordered.
    sequence: { shuffle: { files: true, tests: false } },
  },
});
