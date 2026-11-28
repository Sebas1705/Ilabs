package es.sebas1705.ilabs.demo

import es.sebas1705.ilabs.context.BudgetTooSmallException
import es.sebas1705.ilabs.context.WindowOptions
import es.sebas1705.ilabs.context.slidingWindow
import es.sebas1705.ilabs.guardrails.Action
import es.sebas1705.ilabs.guardrails.Check
import es.sebas1705.ilabs.guardrails.CheckDetails
import es.sebas1705.ilabs.guardrails.CheckKind
import es.sebas1705.ilabs.guardrails.GuardedStatus
import es.sebas1705.ilabs.guardrails.PiiKind
import es.sebas1705.ilabs.guardrails.Policy
import es.sebas1705.ilabs.guardrails.CheckFinding
import es.sebas1705.ilabs.guardrails.checkText
import es.sebas1705.ilabs.guardrails.guardedComplete
import es.sebas1705.ilabs.providers.CompletionRequest
import es.sebas1705.ilabs.providers.CompletionResponse
import es.sebas1705.ilabs.providers.ErrorKind
import es.sebas1705.ilabs.providers.FallbackProvider
import es.sebas1705.ilabs.providers.HttpProvider
import es.sebas1705.ilabs.providers.HttpTransport
import es.sebas1705.ilabs.providers.Message
import es.sebas1705.ilabs.providers.MockProvider
import es.sebas1705.ilabs.providers.Provider
import es.sebas1705.ilabs.providers.ProviderException
import es.sebas1705.ilabs.providers.RetryOptions
import es.sebas1705.ilabs.providers.RetryingProvider
import es.sebas1705.ilabs.providers.Role
import es.sebas1705.ilabs.providers.ScriptEntry
import es.sebas1705.ilabs.providers.ScriptError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

/** Where a turn is answered. The order is the order of the choices on the screen. */
enum class AssistantBackend { MOCK, WORKER, MY_KEY }

/** Text that must never be shown, logged or saved: its `toString` hides it, and nothing here reads it except the transport. */
class SecretText(val value: String = "") {
    val isBlank: Boolean get() = value.isBlank()

    override fun equals(other: Any?): Boolean = other is SecretText && other.value == value

    override fun hashCode(): Int = value.hashCode()

    override fun toString(): String = "SecretText(***)"
}

/** What one turn needs besides the conversation. [apiKey] is sent only by [AssistantBackend.MY_KEY]. */
data class TurnSettings(
    val backend: AssistantBackend,
    val endpoint: String,
    val apiKey: SecretText,
    val budget: Int,
    val redact: Boolean,
)

/** How a turn ended. [trace] is what the engine saw, in order, whatever the outcome. */
sealed interface TurnResult {
    val trace: List<TraceEvent>

    /** [text] is the reply with the user's own values put back; [provider] is the id that answered. */
    data class Reply(val text: String, val provider: String, override val trace: List<TraceEvent>) : TurnResult

    /** The input policy said `block`: no provider was called. */
    data class Blocked(override val trace: List<TraceEvent>) : TurnResult

    /** [kind] is a provider error wire name or [KIND_BUDGET]; [required] is the smallest budget that would work. */
    data class Failure(val kind: String, val required: Int?, override val trace: List<TraceEvent>) : TurnResult

    companion object {
        const val KIND_BUDGET = "budget"
        const val KIND_BLOCKED = "blocked"
    }
}

/**
 * Composes the libraries for one assistant turn and nothing else: `context` keeps the conversation inside the budget,
 * `guardrails` redacts the user's text and can block it, `providers` retries and falls back. This class holds wiring and
 * the trace; there is no retry, redaction, windowing or HTTP mapping logic here.
 *
 * A turn runs: window, then the guarded call, whose provider is `Retrying(mock)` for [AssistantBackend.MOCK] and
 * `Fallback([Retrying(HttpProvider), mock])` for the other two. The mock of the conversation keeps its place in the script
 * ([mockCalls]), so a new engine can continue where a saved conversation was.
 */
class AssistantEngine(
    private val transport: HttpTransport,
    private val replies: () -> List<String>,
    private val sleep: suspend (Long) -> Unit = { delay(it) },
    mockCalls: Int = 0,
) {
    init {
        require(replies().size >= MIN_REPLIES) { "needs at least $MIN_REPLIES mock replies" }
    }

    private var chatCalls = mockCalls

    // The script is built from the replies as they are now, so a change of language shows in the next turn (the view model hands over the current ones).
    // One mock serves the chat and the fallback alike, so its scripted rate limit lands on the same call as on the web twin.
    private fun chatMock(): Provider = Counting(MockProvider(MOCK_ID, chatScript(replies()).drop(chatCalls))) { chatCalls++ }

    /** How many calls the mock of the chat has served: save it and pass it back to continue the script. */
    val mockCalls: Int get() = chatCalls

    /** The messages the last turn handed to the provider chain (after window and redaction), for tests. */
    var lastSent: List<Message>? = null
        private set

    /** The `retryAfterMs` of the last `rate_limit` the chain saw, or null if none yet. */
    var lastRetryAfterMs: Long? = null
        private set

    /** Starts the script of the mock again (a new conversation). */
    fun resetMock() {
        chatCalls = 0
        lastRetryAfterMs = null
    }

    suspend fun turn(history: List<Message>, text: String, settings: TurnSettings): TurnResult {
        lastSent = null
        // Only the wait the gateway asked for in this turn counts: an old one must not stretch the pauses of the evals.
        lastRetryAfterMs = null
        val sink = TraceSink()
        val all = listOf(Message(Role.SYSTEM, PERSONA)) + history + Message(Role.USER, text)
        val window = try {
            slidingWindow(all, WindowOptions(settings.budget))
        } catch (e: BudgetTooSmallException) {
            return TurnResult.Failure(TurnResult.KIND_BUDGET, e.required, sink.events())
        }
        val kept = window.messages.count { it.role != Role.SYSTEM }
        sink.add(TraceKind.WINDOW, kept.toString(), window.droppedCount.toString(), window.tokensAfter.toString(), settings.budget.toString())

        // The personal data of the newest message, as the policy sees it: the trace shows it before the call, as it happens.
        val policy = policy(settings.redact)
        if (settings.redact) {
            sink.add(TraceKind.REDACTIONS, *(redactionArgs(checkText(text, policy.input).findings) ?: emptyList()).toTypedArray())
        } else {
            sink.add(TraceKind.REDACTIONS, REDACTION_OFF)
        }

        val state = ChainState()
        val outer = recording(chain(settings, sink, state), { lastSent = it.messages }, { state.answeredBy = it })
        val result = try {
            guardedComplete(outer, CompletionRequest(window.messages, MAX_TOKENS), policy)
        } catch (e: ProviderException) {
            return TurnResult.Failure(e.kind.wire, null, sink.events())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return TurnResult.Failure(ErrorKind.UNAVAILABLE.wire, null, sink.events())
        }

        if (result.status != GuardedStatus.OK) {
            sink.add(TraceKind.BLOCKED)
            return TurnResult.Blocked(sink.events())
        }
        val provider = state.answeredBy ?: MOCK_ID
        val fell = state.fellBackFrom
        if (fell == null) sink.add(TraceKind.ANSWERED, provider) else sink.add(TraceKind.ANSWERED, provider, fell)
        return TurnResult.Reply(requireNotNull(result.text), provider, sink.events())
    }

    /** What the providers write while a turn runs. */
    private class ChainState {
        var lastKind: String = ErrorKind.RATE_LIMIT.wire
        var lastFailedLabel: String? = null
        var fellBackFrom: String? = null
        var answeredBy: String? = null
        val attempts = HashMap<String, Int>()
    }

    private fun chain(settings: TurnSettings, sink: TraceSink, state: ChainState): Provider {
        fun retrying(label: String, inner: Provider): Provider = RetryingProvider(
            Tracing(label, inner, sink, state) { lastRetryAfterMs = it },
            RetryOptions(ATTEMPTS, BASE_DELAY_MS, MAX_DELAY_MS) { ms ->
                sink.add(TraceKind.WAIT, ms.toString(), state.lastKind)
                sleep(ms)
            },
        )
        val mock = retrying(MOCK_ID, chatMock())
        if (settings.backend == AssistantBackend.MOCK) return mock
        // The library default timeout (25 s) is kept on purpose: the client outlives the Worker's own 20 s upstream timeout.
        val http = HttpProvider(
            id = GATEWAY_ID,
            endpoint = settings.endpoint,
            transport = transport,
            apiKey = if (settings.backend == AssistantBackend.MY_KEY) settings.apiKey.value else null,
        )
        return FallbackProvider(listOf(retrying(GATEWAY_ID, http), mock))
    }

    /** Runs [onCall] at the start of each call a provider serves. */
    private class Counting(private val inner: Provider, private val onCall: () -> Unit) : Provider {
        override val id: String get() = inner.id

        override suspend fun complete(req: CompletionRequest): CompletionResponse {
            onCall()
            return inner.complete(req)
        }
    }

    /**
     * One leaf of the chain, as the trace shows it: a `FALLBACK` line when this leaf starts after another one failed, an
     * `ATTEMPT` line (numbered per leaf) before each call and a `FAILURE` line for each error.
     */
    private class Tracing(
        private val label: String,
        private val inner: Provider,
        private val sink: TraceSink,
        private val state: ChainState,
        private val onRetryAfter: (Long) -> Unit,
    ) : Provider {
        override val id: String get() = inner.id

        override suspend fun complete(req: CompletionRequest): CompletionResponse {
            val failed = state.lastFailedLabel
            if (failed != null && failed != label && state.fellBackFrom == null) {
                state.fellBackFrom = state.lastKind
                sink.add(TraceKind.FALLBACK, state.lastKind)
            }
            sink.add(TraceKind.ATTEMPT, label, state.attempts.merge(label, 1, Int::plus).toString())
            try {
                return inner.complete(req)
            } catch (e: ProviderException) {
                state.lastKind = e.kind.wire
                state.lastFailedLabel = label
                sink.add(TraceKind.FAILURE, label, e.kind.wire)
                if (e.kind == ErrorKind.RATE_LIMIT) e.retryAfterMs?.let(onRetryAfter)
                throw e
            }
        }
    }

    /** Hands the request that leaves the guardrails, and the provider id of the answer, to the engine. */
    private fun recording(inner: Provider, record: (CompletionRequest) -> Unit, answered: (String) -> Unit): Provider =
        object : Provider {
            override val id: String get() = inner.id

            override suspend fun complete(req: CompletionRequest): CompletionResponse {
                record(req)
                return inner.complete(req).also { answered(it.provider) }
            }
        }

    companion object {
        const val MOCK_ID = "mock"
        const val GATEWAY_ID = "gateway"

        /** The fixed persona, always the first message of a conversation. */
        const val PERSONA = "You are a friendly, concise assistant. Answer in the language of the user, in at most three short sentences."

        /** The single argument of a `REDACTIONS` trace line when redaction is disabled. */
        const val REDACTION_OFF = "off"

        const val MAX_TOKENS = 256
        const val DEFAULT_BUDGET = 600
        const val MIN_BUDGET = 100
        const val MAX_BUDGET = 2000
        const val BUDGET_STEP = 50

        /** The input injection score from which the policy blocks the message (`ignore the previous instructions` scores 50). */
        const val INJECTION_BLOCK_THRESHOLD = 50

        /** The number of scripted mock replies the engine needs: two, the one after the scripted rate limit, and one more. */
        const val MIN_REPLIES = 4

        /** The scripted `rate_limit` of the mock lands on its third call, and asks to wait this long. */
        const val RATE_LIMIT_CALL = 3
        const val RATE_LIMIT_RETRY_AFTER_MS = 1_500L

        /** How many calls one scripted mock can serve before it runs dry (the same as the web twin). */
        private const val SCRIPT_LENGTH = 500

        // Same retry settings as the web twin (2 attempts, base 500 ms, max 8 s) for the mock and the gateway.
        private const val ATTEMPTS = 2
        private const val BASE_DELAY_MS = 500L
        private const val MAX_DELAY_MS = 8_000L

        /** The replies cycling, with a `rate_limit` (retry after 1500 ms) as the third call: the retry shows in the trace. */
        internal fun chatScript(replies: List<String>): List<ScriptEntry> {
            var reply = 0
            return List(SCRIPT_LENGTH) { index ->
                if (index + 1 == RATE_LIMIT_CALL) ScriptEntry(error = ScriptError(ErrorKind.RATE_LIMIT, RATE_LIMIT_RETRY_AFTER_MS))
                else ScriptEntry(response = replies[reply++ % replies.size])
            }
        }

        /** The policy of every turn: redact personal data when asked, and block an injection attempt. */
        internal fun policy(redact: Boolean) = Policy(
            input = buildList {
                if (redact) add(Check.Pii(Action.REDACT))
                add(Check.Injection(Action.BLOCK, INJECTION_BLOCK_THRESHOLD))
            },
            output = emptyList(),
        )

        /** `kind, count, kind, count...` for the personal data found in one message, or null when none. */
        internal fun redactionArgs(findings: List<CheckFinding>): List<String>? {
            val found = findings.filter { it.kind == CheckKind.PII && it.action == Action.REDACT && it.fired }
                .flatMap { (it.details as CheckDetails.PiiDetails).findings }
            if (found.isEmpty()) return null
            val counts = PiiKind.entries.map { kind -> kind to found.count { it.kind == kind } }.filter { it.second > 0 }
            return counts.flatMap { listOf(it.first.wire, it.second.toString()) }
        }
    }
}
