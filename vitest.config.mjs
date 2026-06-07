import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./test/setup.mjs"],
    include: ["test/**/*.test.mjs", "test/**/*.test.js"],
    coverage: {
      include: ["app.js", "lib/**/*.js"],
      exclude: ["test/**", "node_modules/**"],
    },
  },
});
