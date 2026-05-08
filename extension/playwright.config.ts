import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  fullyParallel: false, // extension tests share a userDataDir, run serial
  workers: 1,
  reporter: [["list"]],
  use: {
    actionTimeout: 5_000,
  },
});
