import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./global-setup.ts"],
    include: ["**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
