import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

const packageInfo = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const buildId = process.env.GITHUB_SHA?.slice(0, 7) || "local";

export default defineConfig({
  plugins: [react()],
  base: "/food-compliance-checker/",
  define: {
    __APP_VERSION__: JSON.stringify(packageInfo.version),
    __BUILD_ID__: JSON.stringify(buildId),
  },
});
