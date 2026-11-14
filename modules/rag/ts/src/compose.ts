import { defaultCounter, type TokenCounter } from "@ilabs/context";
import type { Message } from "@ilabs/providers";
import { invalidOptions, isIntAtLeast, RagError } from "./errors.js";
import { stateOf } from "./index-build.js";
import type { Hit, RagIndex, Source } from "./types.js";

/** The pinned instruction that opens every composed context (141 code points, ASCII; copied verbatim from the contract). */
export const RAG_INSTRUCTION =
  "Answer the question using only the numbered sources below. Cite the sources you use as [n]. If the sources do not contain the answer, say so.";

export interface ComposedContext {
  message: Message;
  sources: Source[];
  droppedCount: number;
}

/** Validates `maxTokens` (an integer `>= 1`). */
export function checkMaxTokens(maxTokens: number): void {
  if (!isIntAtLeast(maxTokens, 1)) invalidOptions("maxTokens must be an integer >= 1");
}

/**
 * Composes ONE system message: `RAG_INSTRUCTION`, then `\n\n[n] text` per kept hit. Walks the hits in ARRAY order
 * (never reads `rank`); the first hit whose message would not fit stops the walk. `budget_too_small` (with the cost
 * of the message with the first source, or of the instruction alone for empty hits) when nothing fits.
 */
export function composeContext(hits: Hit[], index: RagIndex, options: { maxTokens: number; counter?: TokenCounter }): ComposedContext {
  if (typeof options !== "object" || options === null) invalidOptions("options must be an object");
  checkMaxTokens(options.maxTokens);
  const { maxTokens } = options;
  const counter = options.counter ?? defaultCounter;
  const state = stateOf(index);
  const cost = (content: string): number => counter({ role: "system", content });

  // Resolve every hit first: an unknown chunkId is a programmer error, reported before any budget error.
  const chunks = hits.map((hit) => {
    const chunk = state.byId.get(hit.chunkId);
    if (chunk === undefined) throw new RangeError(`hit ${hit.chunkId} is not a chunk of this index`);
    return chunk;
  });

  let content = RAG_INSTRUCTION;
  const sources: Source[] = [];
  if (hits.length === 0) {
    const required = cost(content);
    if (required > maxTokens) throw new RagError("budget_too_small", { required });
  }
  for (let k = 1; k <= chunks.length; k++) {
    const chunk = chunks[k - 1]!;
    const candidate = `${content}\n\n[${k}] ${chunk.text}`;
    const c = cost(candidate);
    if (c > maxTokens) {
      if (k === 1) throw new RagError("budget_too_small", { required: c });
      break;
    }
    content = candidate;
    sources.push({ n: k, chunkId: chunk.id, docId: chunk.docId });
  }
  return { message: { role: "system", content }, sources, droppedCount: hits.length - sources.length };
}
