package es.sebas1705.ilabs.guardrails

import es.sebas1705.ilabs.providers.CompletionRequest
import es.sebas1705.ilabs.providers.CompletionResponse
import es.sebas1705.ilabs.providers.Message
import es.sebas1705.ilabs.providers.Provider
import es.sebas1705.ilabs.providers.Role

/** The text a [GuardedProvider] returns for a blocked call unless told otherwise. */
const val DEFAULT_BLOCKED_TEXT: String = "Request blocked by guardrails."

enum class GuardedStatus(val wire: String) {
    OK("ok"),
    BLOCKED_INPUT("blocked_input"),
    BLOCKED_OUTPUT("blocked_output"),
}

/**
 * The result of [guardedComplete]. [text] is set only for `ok`; [sent] and [output] are absent for `blocked_input`
 * (no provider call). [input] holds one list of findings per non-system message. [mapping] is the final input mapping;
 * [outputMapping] the placeholders created for the reply (never restored).
 */
data class GuardedResult(
    val status: GuardedStatus,
    val text: String?,
    val sent: List<Message>?,
    val input: List<List<CheckFinding>>,
    val output: List<CheckFinding>?,
    val calls: Int,
    val mapping: Mapping,
    val outputMapping: Mapping,
)

/**
 * Runs [request] through [policy] around [provider]. Every non-system message is checked (one shared mapping, no short
 * circuit); a blocked input makes no provider call; otherwise exactly one call with the redacted messages (system
 * messages untouched), the raw reply is checked and redacted with NEW placeholders, and only input placeholders are
 * restored. Provider and classifier failures propagate unchanged. A classifier check without a [classifier] anywhere in
 * the policy fails with `no_classifier` before anything else.
 */
suspend fun guardedComplete(provider: Provider, request: CompletionRequest, policy: Policy, classifier: Classifier? = null): GuardedResult {
    validatePolicy(policy)
    if (classifier == null && (hasClassifierCheck(policy.input) || hasClassifierCheck(policy.output))) {
        throw GuardrailException(GuardrailErrorKind.NO_CLASSIFIER)
    }
    var mapping: Mapping = emptyList()
    var blocked = false
    val input = ArrayList<List<CheckFinding>>()
    val redactedContent = HashMap<Int, String>()
    request.messages.forEachIndexed { i, message ->
        if (message.role == Role.SYSTEM) return@forEachIndexed
        val r = checkText(message.content, policy.input, mapping, classifier)
        mapping = r.mapping
        input += r.findings
        redactedContent[i] = r.text
        if (r.verdict == CheckVerdict.BLOCK) blocked = true
    }
    if (blocked) {
        return GuardedResult(GuardedStatus.BLOCKED_INPUT, null, null, input.toList(), null, 0, mapping, emptyList())
    }
    val sent = request.messages.mapIndexed { i, m -> if (m.role == Role.SYSTEM) m else Message(m.role, redactedContent.getValue(i)) }
    val response = provider.complete(CompletionRequest(sent, request.maxTokens))
    val reply = response.text
    val output = evaluateChecks(reply, policy.output, classifier)
    val verdict = verdictOf(output)
    val toRedact = redactionFindings(output, reply)
    val entries = ArrayList(mapping)
    val redactedReply = if (toRedact == null) reply else redactInto(reply, toRedact, entries, mapping.size)
    val outputMapping = entries.drop(mapping.size)
    if (verdict == CheckVerdict.BLOCK) {
        return GuardedResult(GuardedStatus.BLOCKED_OUTPUT, null, sent, input.toList(), output, 1, mapping, outputMapping)
    }
    return GuardedResult(GuardedStatus.OK, restore(redactedReply, mapping), sent, input.toList(), output, 1, mapping, outputMapping)
}

/**
 * A [Provider] that applies [policy] around [provider]: its [id] is the wrapped one, a blocked call answers
 * [blockedText], errors propagate unchanged, and [lastReport] holds the result of the last call that returned.
 */
class GuardedProvider(
    private val provider: Provider,
    private val policy: Policy,
    private val classifier: Classifier? = null,
    private val blockedText: String = DEFAULT_BLOCKED_TEXT,
) : Provider {
    init {
        validatePolicy(policy) // a hand-built policy that is invalid fails at construction with `invalid_policy`
    }

    override val id: String get() = provider.id

    var lastReport: GuardedResult? = null
        private set

    override suspend fun complete(req: CompletionRequest): CompletionResponse {
        val result = guardedComplete(provider, req, policy, classifier)
        lastReport = result
        return CompletionResponse(if (result.status == GuardedStatus.OK) requireNotNull(result.text) else blockedText, provider.id)
    }
}
