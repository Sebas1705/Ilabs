import type { CompletionRequest, CompletionResponse, Message, Provider } from "@ilabs/providers";
import { parseMessages } from "./canary.js";
import { evaluateChecks, parseClassifier, redactionFindings, requireClassifierFor } from "./check.js";
import { invalidOptions } from "./errors.js";
import { parseMapping, redactCore, restore } from "./placeholders.js";
import { parsePolicy } from "./policy.js";
import { isObject, toCodePoints } from "./scan.js";
import type { Classifier, GuardedResult, Mapping, Policy } from "./types.js";

/** The text `GuardedProvider` returns for a blocked call unless `blockedText` is given. */
export const DEFAULT_BLOCKED_TEXT = "Request blocked by guardrails.";

function requireProvider(provider: unknown): Provider {
  if (!isObject(provider) || typeof provider["complete"] !== "function") invalidOptions("provider must have a complete function");
  return provider as unknown as Provider;
}

function parseGuardedOptions(options: unknown): { classifier: Classifier | undefined; blockedText?: string } {
  if (options !== undefined && !isObject(options)) invalidOptions("options must be an object");
  const classifier = parseClassifier(options?.["classifier"]);
  const blockedText = options?.["blockedText"];
  if (blockedText === undefined) return { classifier };
  if (typeof blockedText !== "string") invalidOptions("blockedText must be a string");
  return { classifier, blockedText };
}

const copyMapping = (m: Mapping): Mapping => m.map(([p, o]) => [p, o]);

/**
 * Checks the input messages, calls the provider once (never when the input blocks), checks the raw reply and
 * restores the input placeholders in the final text. Errors of the provider and of the classifier propagate unchanged.
 */
export async function guardedComplete(
  provider: Provider,
  request: CompletionRequest,
  policy: Policy,
  options?: { classifier?: Classifier },
): Promise<GuardedResult> {
  const p = requireProvider(provider);
  const parsed = parsePolicy(policy);
  const { classifier } = parseGuardedOptions(options);
  if (!isObject(request)) invalidOptions("request must be an object");
  const messages = parseMessages(request["messages"]);
  const maxTokens = request["maxTokens"];
  requireClassifierFor([...parsed.input, ...parsed.output], classifier);

  let mapping: Mapping = [];
  let blocked = false;
  const input: GuardedResult["input"] = [];
  const redacted: Message[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      redacted.push({ role: m.role, content: m.content });
      continue;
    }
    const { verdict, findings } = await evaluateChecks(m.content, parsed.input, classifier);
    const resolved = redactionFindings(findings);
    let content = m.content;
    if (resolved !== null) {
      const r = redactCore(toCodePoints(m.content), resolved, mapping, true);
      content = r.text;
      mapping = [...mapping, ...r.created];
    }
    input.push(findings);
    redacted.push({ role: m.role, content });
    if (verdict === "block") blocked = true;
  }
  if (blocked) return { status: "blocked_input", input, calls: 0, mapping, outputMapping: [] };

  const sentRequest: CompletionRequest = { messages: redacted };
  if (maxTokens !== undefined) sentRequest.maxTokens = maxTokens as number;
  const response = await p.complete(sentRequest);
  const reply = response.text;
  const { verdict, findings: output } = await evaluateChecks(reply, parsed.output, classifier);
  const resolved = redactionFindings(output);
  let redactedReply = reply;
  let outputMapping: Mapping = [];
  if (resolved !== null) {
    const r = redactCore(toCodePoints(reply), resolved, mapping, false);
    redactedReply = r.text;
    outputMapping = r.created;
  }
  if (verdict === "block") {
    return { status: "blocked_output", sent: redacted.map((m) => ({ role: m.role, content: m.content })), input, output, calls: 1, mapping: copyMapping(mapping), outputMapping };
  }
  return { status: "ok", text: restore(redactedReply, mapping), sent: redacted.map((m) => ({ role: m.role, content: m.content })), input, output, calls: 1, mapping: copyMapping(mapping), outputMapping };
}

/** A `Provider` that runs every call through `guardedComplete`; blocked calls return `blockedText`. */
export class GuardedProvider implements Provider {
  /** The result of the last call that returned (unchanged by a call that throws). */
  lastReport: GuardedResult | undefined;
  private readonly inner: Provider;
  private readonly policy: Policy;
  private readonly classifier: Classifier | undefined;
  private readonly blockedText: string;

  constructor(provider: Provider, policy: Policy, options?: { classifier?: Classifier; blockedText?: string }) {
    this.inner = requireProvider(provider);
    this.policy = parsePolicy(policy);
    const o = parseGuardedOptions(options);
    this.classifier = o.classifier;
    this.blockedText = o.blockedText ?? DEFAULT_BLOCKED_TEXT;
  }

  get id(): string {
    return this.inner.id;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const result = await guardedComplete(this.inner, request, this.policy, { classifier: this.classifier });
    this.lastReport = result;
    return { text: result.status === "ok" ? result.text! : this.blockedText, provider: this.inner.id };
  }
}
