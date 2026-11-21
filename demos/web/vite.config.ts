import { createReadStream, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vitest/config";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const modelsDir = join(repoRoot, "demos", "vision-assets", "models");

/**
 * Dev and preview only: serves the git-ignored model files of `demos/vision-assets/models/` at `/vision-models/`.
 * A file that is not there answers 404 (never the index page), so the page can tell that the model is missing.
 * Nothing is copied into the build; a deployed page reads the models from `VITE_VISION_MODELS_BASE` instead.
 */
function visionModels(): Plugin {
  const serve = (req: { url?: string; method?: string }, res: import("node:http").ServerResponse, next: () => void) => {
    const url = (req.url ?? "").split("?")[0] ?? "";
    if (!url.startsWith("/vision-models/")) return next();
    let size = -1;
    let file = "";
    try {
      // A malformed percent escape throws here and answers 404, like any other name that is not a model file.
      const name = decodeURIComponent(url.slice("/vision-models/".length));
      file = normalize(join(modelsDir, name));
      if (file.startsWith(modelsDir + sep) && !name.includes("..")) {
        const st = statSync(file);
        if (st.isFile()) size = st.size;
      }
    } catch {
      /* malformed or missing */
    }
    if (size < 0) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(size));
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  };
  return {
    name: "ilabs-vision-models",
    configureServer(server) {
      server.middlewares.use(serve);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serve);
    },
  };
}

export default defineConfig({
  plugins: [react(), visionModels()],
  server: { fs: { allow: [repoRoot] } },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
});
