import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests share one Postgres database, so run files one at a time.
    fileParallelism: false,
    globalSetup: ["./test/global-setup.ts"],
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
