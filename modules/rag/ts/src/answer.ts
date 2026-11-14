import type { Provider } from "@ilabs/providers";
import { extractCitations } from "./citations.js";
import { checkMaxTokens, composeContext } from "./compose.js";
import { invalidOptions } from "./errors.js";
import { resolveSearchOptions, searchResolved } from "./search.js";
import type { Citations, Hit, Mode, RagIndex, Source } from "./types.js";

export interface AnswerOptions {
  mode: Mode;
  topK?: number;
  candidates?: number;
  maxTokens: number;
}

export interface AnswerResult {
  answer: string;
  sources: Source[];
  citations: Citations;
  hits: Hit[];
}

/**
 * Validates every option first, then searches, composes and makes exactly ONE `provider.complete` call with
 * `[system: composed context, user: query]` and no other field. Any error (a `RagError` before the call, a provider
 * error or anything else from the call) propagates unchanged; there are no retries.
 */
export async function answerWithSources(provider: Provider, index: RagIndex, query: string, options: AnswerOptions): Promise<AnswerResult> {
  if (typeof options !== "object" || options === null) invalidOptions("options must be an object");
  const resolved = resolveSearchOptions(options);
  checkMaxTokens(options.maxTokens);
  const hits = await searchResolved(index, query, resolved);
  const composed = composeContext(hits, index, { maxTokens: options.maxTokens });
  const reply = await provider.complete({
    messages: [
      { role: "system", content: composed.message.content },
      { role: "user", content: query },
    ],
  });
  return { answer: reply.text, sources: composed.sources, citations: extractCitations(reply.text, composed.sources), hits };
}
