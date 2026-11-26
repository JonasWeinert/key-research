import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@key-reader": resolve(__dirname, "../../../key/src") } },
  test: { include: ["src/**/*.test.{ts,tsx}"], environment: "node" },
});
