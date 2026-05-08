import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify("0.0.0-test"),
    "import.meta.env.VITE_POSTHOG_KEY": JSON.stringify("PLACEHOLDER"),
    "import.meta.env.VITE_POSTHOG_HOST": JSON.stringify("https://us.i.posthog.com"),
    "import.meta.env.VITE_SENTRY_DSN": JSON.stringify("PLACEHOLDER"),
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.{test,spec}.{ts,tsx}", "src/__tests__/**", "src/main.tsx", "src/vite-env.d.ts"],
    },
  },
});
