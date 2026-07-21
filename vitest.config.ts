import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Creates the per-run temp root and removes it when the run ends (#117).
    globalSetup: ["./test/helpers/global-setup.ts"],
  },
});
