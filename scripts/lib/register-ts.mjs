// Usage: node --import ./scripts/lib/register-ts.mjs <script>
//
// Lets Node's built-in type stripping load the TypeScript sources of `@ilabs/vision`, whose relative imports are
// written with a `.js` suffix (`./spec.js` stands for `./spec.ts`): a relative `.js` import from a `.ts` file is
// redirected to the `.ts` file when it exists. Dev-time tooling only; nothing here ships.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.endsWith(".ts")) {
      const ts = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(ts))) return nextResolve(ts.href, context);
    }
    return nextResolve(specifier, context);
  },
});
