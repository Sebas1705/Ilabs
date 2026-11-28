package es.sebas1705.ilabs.demo

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.CreationExtras
import es.sebas1705.ilabs.providers.HttpTransport
import es.sebas1705.ilabs.providers.Message
import es.sebas1705.ilabs.providers.Role
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class ChatRole { USER, ASSISTANT, BLOCKED }

/**
 * One line of the chat. A [ChatRole.BLOCKED] entry has no text: the screen shows the translated blocked notice.
 * Only entries with [inHistory] are sent as context on later turns (a blocked message or a pending one is not).
 */
data class ChatEntry(val role: ChatRole, val text: String = "", val inHistory: Boolean = true) {
    internal fun encode(): String = "${role.name[0]}${if (inHistory) '1' else '0'}$text"

    internal companion object {
        fun decode(raw: String): ChatEntry? {
            if (raw.length < 2) return null
            val role = ChatRole.entries.firstOrNull { it.name[0] == raw[0] } ?: return null
            return ChatEntry(role, raw.substring(2), inHistory = raw[1] == '1')
        }
    }
}

/** Why the last turn gave no answer: a provider error wire name, [TurnResult.KIND_BUDGET], and for the budget the smallest one that works. */
data class AssistantError(val kind: String, val required: Int? = null)

/** The evals panel. [waitingMs] is the pause the run is in right now (0 when it is not pausing). */
data class AssistantEvalsState(
    val running: Boolean = false,
    val done: Int = 0,
    val total: Int = AssistantEvals.suite.cases.size,
    val waitingMs: Long = 0,
    val rows: List<AssistantEvalRow> = emptyList(),
    val cancelled: Boolean = false,
    val failed: Boolean = false,
)

/**
 * What the screen renders. The key lives here and in nothing that is saved: [apiKey] hides itself in `toString`, and the
 * view model never writes it to the saved state.
 */
data class AssistantUiState(
    val backend: AssistantBackend = AssistantBackend.MOCK,
    val endpoint: String = "",
    val apiKey: SecretText = SecretText(),
    val budget: Int = AssistantEngine.DEFAULT_BUDGET,
    val redact: Boolean = true,
    val entries: List<ChatEntry> = emptyList(),
    val draft: String = "",
    val sending: Boolean = false,
    val error: AssistantError? = null,
    val trace: List<TraceEvent> = emptyList(),
    val evals: AssistantEvalsState = AssistantEvalsState(),
) {
    val endpointCheck: EndpointCheck get() = AssistantEndpoint.check(endpoint)

    /** The Worker and My key choices need an allowed endpoint. */
    val gatewayReady: Boolean get() = endpointCheck is EndpointCheck.Ok

    /** My key needs a key to send. */
    val keyMissing: Boolean get() = backend == AssistantBackend.MY_KEY && apiKey.isBlank

    val backendReady: Boolean get() = (backend == AssistantBackend.MOCK || gatewayReady) && !keyMissing

    /** A chat turn and the evals never run together: both spend the same free-tier budget on a gateway. */
    val canSend: Boolean get() = backendReady && !sending && !evals.running && draft.isNotBlank()
}

class AssistantViewModel(
    private val savedState: SavedStateHandle,
    private val transport: HttpTransport,
    /** The mock replies as the screen shows them now; the screen hands over new ones with [setReplies] when the language changes. */
    initialReplies: List<String>,
    private val sleep: suspend (Long) -> Unit = { delay(it) },
    /** Where a turn runs: off the main thread in the app, a test dispatcher in tests. */
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
) : ViewModel() {
    /** Read by the engine on every turn. It holds strings, never an Activity or a Context. */
    @Volatile
    private var replies: List<String> = initialReplies
    private val engine = AssistantEngine(transport, { replies }, sleep, savedState.get<Int>(KEY_MOCK_CALLS)?.coerceAtLeast(0) ?: 0)
    private val _uiState = MutableStateFlow(restore())
    val uiState: StateFlow<AssistantUiState> = _uiState.asStateFlow()

    /** Grows whenever a running turn stops being the current one (new conversation, other backend), so its result is dropped. */
    private var turnToken = 0
    private var turnJob: Job? = null
    private var evalsToken = 0
    private var evalsJob: Job? = null

    private fun restore(): AssistantUiState {
        val backend = savedState.get<String>(KEY_BACKEND)?.let { n -> AssistantBackend.entries.firstOrNull { it.name == n } }
        val endpoint = savedState.get<String>(KEY_ENDPOINT).orEmpty().take(MAX_ENDPOINT)
        val ready = AssistantEndpoint.check(endpoint) is EndpointCheck.Ok
        return AssistantUiState(
            // A saved gateway choice is only kept while its endpoint is still allowed.
            backend = backend?.takeIf { it == AssistantBackend.MOCK || ready } ?: AssistantBackend.MOCK,
            endpoint = endpoint,
            budget = (savedState.get<Int>(KEY_BUDGET) ?: AssistantEngine.DEFAULT_BUDGET).let(::clampBudget),
            redact = savedState.get<Boolean>(KEY_REDACT) ?: true,
            entries = savedState.get<ArrayList<String>>(KEY_ENTRIES).orEmpty().mapNotNull(ChatEntry::decode).map { it.copy(text = capReply(it.text)) },
            draft = savedState.get<String>(KEY_DRAFT).orEmpty().take(MAX_INPUT),
            trace = savedState.get<ArrayList<String>>(KEY_TRACE).orEmpty().mapNotNull(TraceEvent::decode),
        )
    }

    // ---- settings ----

    /** The mock replies in the language the screen has now; takes effect on the next turn. A list that is too short is ignored. */
    fun setReplies(list: List<String>) {
        if (list.size >= AssistantEngine.MIN_REPLIES) replies = list.toList()
    }

    fun setBackend(backend: AssistantBackend) {
        val s = _uiState.value
        if (backend == s.backend) return
        if (backend != AssistantBackend.MOCK && !s.gatewayReady) return
        targetChanged()
        // The key is only held while My key is selected.
        _uiState.update { it.copy(backend = backend, apiKey = if (backend == AssistantBackend.MY_KEY) it.apiKey else SecretText()) }
        persist()
    }

    /** Sets the endpoint as typed. A choice that needs an endpoint falls back to the mock as soon as it is not allowed any more. */
    fun setEndpoint(text: String) {
        val value = text.take(MAX_ENDPOINT)
        val s = _uiState.value
        if (value == s.endpoint) return
        if (s.backend != AssistantBackend.MOCK) targetChanged()
        _uiState.update {
            val next = it.copy(endpoint = value)
            if (next.backend != AssistantBackend.MOCK && !next.gatewayReady) next.copy(backend = AssistantBackend.MOCK, apiKey = SecretText()) else next
        }
        persist()
    }

    /** Holds the key in memory. It is not written to the saved state and not shown anywhere but in its own field. */
    fun setApiKey(key: String) {
        _uiState.update { it.copy(apiKey = SecretText(key.take(MAX_KEY))) }
    }

    fun setBudget(tokens: Int) {
        val value = clampBudget(tokens)
        _uiState.update { it.copy(budget = value) }
        persist()
    }

    fun setRedact(on: Boolean) {
        _uiState.update { it.copy(redact = on) }
        persist()
    }

    fun setDraft(text: String) {
        _uiState.update { it.copy(draft = text.take(MAX_INPUT), error = null) }
        persist()
    }

    // ---- conversation ----

    fun send() {
        val s = _uiState.value
        if (!s.canSend) return
        val text = s.draft
        val history = s.entries.filter { it.inHistory }.map { Message(if (it.role == ChatRole.USER) Role.USER else Role.ASSISTANT, it.text) }
        val settings = TurnSettings(s.backend, (s.endpointCheck as? EndpointCheck.Ok)?.url.orEmpty(), s.apiKey, s.budget, s.redact)
        val token = ++turnToken
        // The message is pending until it is answered: a pending message is not context for any other turn.
        _uiState.update {
            it.copy(entries = (it.entries + ChatEntry(ChatRole.USER, text, inHistory = false)).takeLast(MAX_ENTRIES), draft = "", sending = true, error = null)
        }
        persist()
        turnJob = viewModelScope.launch(dispatcher) {
            val result = engine.turn(history, text, settings)
            if (token != turnToken) return@launch
            apply(result, text)
        }
    }

    private fun apply(result: TurnResult, text: String) {
        _uiState.update { s ->
            val pending = s.entries.dropLast(1)
            val trace = (s.trace + result.trace).takeLast(TraceEvent.MAX_EVENTS)
            when (result) {
                is TurnResult.Reply -> s.copy(
                    entries = (pending + ChatEntry(ChatRole.USER, text) + ChatEntry(ChatRole.ASSISTANT, capReply(result.text))).takeLast(MAX_ENTRIES),
                    trace = trace, sending = false,
                )
                is TurnResult.Blocked -> s.copy(
                    entries = (pending + ChatEntry(ChatRole.USER, text, inHistory = false) + ChatEntry(ChatRole.BLOCKED, inHistory = false)).takeLast(MAX_ENTRIES),
                    trace = trace, sending = false,
                )
                // The message was not answered: it goes back to the field so it can be sent again.
                is TurnResult.Failure -> s.copy(
                    entries = pending, draft = s.draft.ifEmpty { text }, trace = trace, sending = false,
                    error = AssistantError(result.kind, result.required),
                )
            }
        }
        persist()
    }

    /** Starts over: no messages, no trace, the mock script from its start. Anything still running is dropped. */
    fun newConversation() {
        turnToken++
        turnJob?.cancel()
        engine.resetMock()
        _uiState.update { it.copy(entries = emptyList(), trace = emptyList(), draft = "", sending = false, error = null) }
        persist()
    }

    /** The backend changed under a running turn: its answer is dropped and its message goes back to the field. */
    private fun targetChanged() {
        cancelEvals(clear = true)
        if (!_uiState.value.sending) return
        turnToken++
        turnJob?.cancel()
        _uiState.update { s ->
            val pending = s.entries.lastOrNull()
            s.copy(
                entries = if (pending != null && !pending.inHistory) s.entries.dropLast(1) else s.entries,
                draft = s.draft.ifEmpty { pending?.text.orEmpty() },
                sending = false,
            )
        }
    }

    // ---- evals ----

    fun runEvals() {
        val s = _uiState.value
        if (s.evals.running || s.sending || !s.backendReady) return
        val settings = TurnSettings(s.backend, (s.endpointCheck as? EndpointCheck.Ok)?.url.orEmpty(), s.apiKey, s.budget, s.redact)
        val token = ++evalsToken
        _uiState.update { it.copy(evals = AssistantEvalsState(running = true)) }
        evalsJob = viewModelScope.launch(dispatcher) {
            fun current(change: (AssistantEvalsState) -> AssistantEvalsState) =
                _uiState.update { if (token == evalsToken) it.copy(evals = change(it.evals)) else it }
            try {
                val rows = AssistantEvals.run(
                    settings, transport, { replies }, sleep,
                    onWaiting = { ms -> current { it.copy(waitingMs = ms) } },
                    onRow = { row -> current { it.copy(rows = it.rows + row) } },
                    onProgress = { done -> current { it.copy(done = done) } },
                )
                current { it.copy(running = false, rows = rows, done = rows.size, waitingMs = 0) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                current { it.copy(running = false, failed = true, waitingMs = 0) }
            }
        }
    }

    /** Stops a running suite and keeps the rows finished so far; with [clear] the results go too (the backend they belong to changed). */
    fun cancelEvals(clear: Boolean = false) {
        val s = _uiState.value.evals
        if (!s.running && !clear) return
        evalsToken++
        evalsJob?.cancel()
        _uiState.update {
            it.copy(evals = if (clear) AssistantEvalsState() else AssistantEvalsState(done = it.evals.rows.size, rows = it.evals.rows, cancelled = true))
        }
    }

    // ---- saved state ----

    /** Writes everything except the key. */
    private fun persist() {
        val s = _uiState.value
        savedState[KEY_BACKEND] = s.backend.name
        savedState[KEY_ENDPOINT] = s.endpoint
        savedState[KEY_BUDGET] = s.budget
        savedState[KEY_REDACT] = s.redact
        savedState[KEY_ENTRIES] = ArrayList(s.entries.map { it.encode() })
        savedState[KEY_DRAFT] = s.draft
        savedState[KEY_TRACE] = ArrayList(s.trace.map { it.encode() })
        savedState[KEY_MOCK_CALLS] = engine.mockCalls
    }

    companion object {
        const val MAX_INPUT = 1_500
        const val MAX_ENTRIES = 40
        const val MAX_ENDPOINT = 2_048
        const val MAX_KEY = 512

        /**
         * The most characters of one reply that are kept and shown. A reply is capped before it is saved: a Parcel costs two
         * bytes a character and the whole saved state of the app has to fit in about 1 MB.
         */
        const val MAX_REPLY_CHARS = 8_000

        /** [text] cut to [MAX_REPLY_CHARS] with an ellipsis, never in the middle of a surrogate pair. */
        fun capReply(text: String): String {
            if (text.length <= MAX_REPLY_CHARS) return text
            val cut = if (text[MAX_REPLY_CHARS - 1].isHighSurrogate()) MAX_REPLY_CHARS - 1 else MAX_REPLY_CHARS
            return text.substring(0, cut) + "…"
        }

        private const val KEY_BACKEND = "backend"
        private const val KEY_ENDPOINT = "endpoint"
        private const val KEY_BUDGET = "budget"
        private const val KEY_REDACT = "redact"
        private const val KEY_ENTRIES = "entries"
        private const val KEY_DRAFT = "draft"
        private const val KEY_TRACE = "trace"
        private const val KEY_MOCK_CALLS = "mockCalls"

        /** Keeps a budget inside the control's range and on its step. */
        fun clampBudget(value: Int): Int {
            val clamped = value.coerceIn(AssistantEngine.MIN_BUDGET, AssistantEngine.MAX_BUDGET)
            val steps = Math.round((clamped - AssistantEngine.MIN_BUDGET).toDouble() / AssistantEngine.BUDGET_STEP).toInt()
            return AssistantEngine.MIN_BUDGET + steps * AssistantEngine.BUDGET_STEP
        }

        /** [replies] are plain strings: nothing here may keep the Activity that read them. */
        fun factory(replies: List<String>, transport: HttpTransport = UrlConnectionTransport()): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>, extras: CreationExtras): T =
                    AssistantViewModel(extras.createSavedStateHandle(), transport, replies) as T
            }
    }
}
