// Reads the model cards of demos/vision-assets/models.json (needs `--import ./scripts/lib/register-ts.mjs`).
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseModelSpec } from "./vision.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ASSETS = join(ROOT, "demos", "vision-assets");

export function loadCards() {
  return JSON.parse(readFileSync(join(ASSETS, "models.json"), "utf8")).models;
}

/** The labels of a labels file: one per line, in the order of the class ids (CRLF checkouts are fine). */
export function readLabels(relativePath) {
  const lines = readFileSync(join(ASSETS, relativePath), "utf8").split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The `ModelSpec` of a model card with its labels attached, validated by `parseModelSpec`. */
export function specWithLabels(card) {
  const spec = structuredClone(card.spec);
  if (card.labels) spec.labels = readLabels(card.labels);
  return parseModelSpec(spec);
}
