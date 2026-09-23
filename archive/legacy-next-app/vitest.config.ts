import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      "server-only": path.resolve(__dirname, "tests/shims/server-only.ts"),
      "next/cache": path.resolve(__dirname, "tests/shims/next-cache.ts"),
      "next/navigation": path.resolve(__dirname, "tests/shims/next-navigation.ts"),
      "next/headers": path.resolve(__dirname, "tests/shims/next-headers.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
