import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    globalSetup: ["./vitest.global-setup.ts"],
    // Integration tests (startSession, persistence, API, CLI smoke) exceed 15s under parallel load on Windows.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Cap fork count on Windows — full CPU saturation was pushing integration tests past 30s.
    ...(process.platform === "win32" ? { maxWorkers: 4 } : {}),
    include: ["tests/**/*.test.ts"],
    coverage: {
      reporter: ["text", "lcov"]
    }
  }
});
