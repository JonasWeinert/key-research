import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({
  // As in the renderer build: the reader's shared UI (ui/dismiss …) with one React.
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: { "@key-reader": resolve(__dirname, "../../../key/src") },
  },
  test: { include: ["src/**/*.test.{ts,tsx}"], environment: "node" },
});
