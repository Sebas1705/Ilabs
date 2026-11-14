package es.sebas1705.ilabs.demo

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.CreationExtras
import es.sebas1705.ilabs.context.defaultCounter
import es.sebas1705.ilabs.rag.Chunk
import es.sebas1705.ilabs.rag.Chunking
import es.sebas1705.ilabs.rag.Citations
import es.sebas1705.ilabs.rag.Document
import es.sebas1705.ilabs.rag.Hit
import es.sebas1705.ilabs.rag.Level
import es.sebas1705.ilabs.rag.Mode
import es.sebas1705.ilabs.rag.RagException
import es.sebas1705.ilabs.rag.RetrievalMetrics
import es.sebas1705.ilabs.rag.Source
import es.sebas1705.ilabs.rag.buildIndex
import es.sebas1705.ilabs.rag.composeContext
import es.sebas1705.ilabs.rag.contract.Fixture
import es.sebas1705.ilabs.rag.contract.parseFixture
import es.sebas1705.ilabs.rag.contract.runFixture
import es.sebas1705.ilabs.rag.extractCitations
import es.sebas1705.ilabs.rag.hashEmbedder
import es.sebas1705.ilabs.rag.retrievalMetrics
import es.sebas1705.ilabs.rag.search
import es.sebas1705.ilabs.rag.tokenize
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/** Fixture groups of the picker, in display order; the group comes from the start of the fixture name. */
enum class RagGroup(val prefixes: List<String>) {
    SEARCH(listOf("bm25-", "dense-", "hybrid-")),
    CONTEXT(listOf("context-")),
    ANSWERS(listOf("answer-")),
    EVALUATION(listOf("eval-")),
    ;

    companion object {
        /** The group of a fixture name, or null for fixtures the demo does not offer (`invalid-*`, `chunk-*`, ...). */
        fun of(name: String): RagGroup? = entries.firstOrNull { g -> g.prefixes.any(name::startsWith) }
    }
}

/** A labelled question of an `eval` fixture: the relevant ids are chunk ids or document ids, per [level]. */
data class Labelled(val query: String, val relevant: List<String>, val level: Level)

/** What the runner is asked: the fixture and the three controls. [readOnly] shows the recorded fixture run instead. */
data class RagRequest(val fixture: Fixture, val question: String, val mode: Mode, val topK: Int, val readOnly: Boolean)

/** One row of the hit table: the library hit as returned (ranks of both sides in hybrid mode, one fused score). */
data class HitRow(val hit: Hit)

/** The composed context: the message exactly as returned, its sources and the budget numbers. */
data class RagContextView(
    val content: String,
    val sources: List<Source>,
    /** Straight from the library; null when the recorded run does not carry it (answer fixtures). */
    val droppedCount: Int?,
    val usedTokens: Int,
    val maxTokens: Int,
)

/** The scripted reply of an `answer` fixture and its citation check against the composed sources. */
data class CitationView(val reply: String, val citations: Citations)

/** Metrics of one mode for the labelled question, with the hits they were computed on. */
data class ModeMetrics(val mode: Mode, val metrics: RetrievalMetrics, val hits: List<Hit>)

/** A failure the library (or the scripted provider) reported: [kind] is its wire name, [detail] the library's reason. */
data class RagFailure(val kind: String, val required: Int? = null, val detail: String? = null)

/**
 * Everything a run produced. [failure] with `budget_too_small` leaves [rows] and [chunks] in place (the search worked,
 * only the composition did not); any other failure leaves just the chunks that could be built.
 */
data class RagRun(
    val chunks: List<Chunk>,
    val mode: Mode,
    val rows: List<HitRow>,
    /** True when the question has no searchable word (the library's tokenizer finds no token). */
    val emptyQuery: Boolean,
    val context: RagContextView? = null,
    val citations: CitationView? = null,
    val metrics: List<ModeMetrics>? = null,
    val failure: RagFailure? = null,
)

/**
 * What the screen renders. [readOnly] fixtures show the recorded run and ignore the three controls. [questionRevision]
 * grows whenever the question is set by the program (picking a fixture or a labelled question, restoring), never while
 * typing, so the text field only re-reads the state then. [runKey] names the controls the shown [run] belongs to.
 */
data class RagUiState(
    val names: List<String> = emptyList(),
    val selected: String? = null,
    val fixture: Fixture? = null,
    val kind: String = "",
    val readOnly: Boolean = false,
    val question: String = "",
    val questionRevision: Int = 0,
    val mode: Mode = Mode.HYBRID,
    val topK: Int = RagViewModel.DEFAULT_TOP_K,
    val labelled: List<Labelled> = emptyList(),
    val labelledIndex: Int? = null,
    /** The fixture's token budget (`context` and `answer` fixtures). */
    val maxTokens: Int? = null,
    val run: RagRun? = null,
    val runKey: String? = null,
    /** Set when some or all fixture documents could not be loaded; the valid ones are still listed. */
    val loadError: String? = null,
    /** Set when running the selected fixture failed. */
    val runError: String? = null,
) {
    /** Names grouped by prefix, in group order, empty groups left out. */
    val groups: List<Pair<RagGroup, List<String>>>
        get() = names.mapNotNull { n -> RagGroup.of(n)?.let { it to n } }
            .groupBy({ it.first }, { it.second }).toList().sortedBy { it.first.ordinal }

    val isEval: Boolean get() = kind == "eval"
    val hasContext: Boolean get() = maxTokens != null
}

// ---- reading the fixture ---------------------------------------------------------------------------------------------

private fun JsonElement?.string(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun JsonElement?.int(): Int? = (this as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
    ?.takeIf { it % 1.0 == 0.0 && kotlin.math.abs(it) <= Int.MAX_VALUE }?.toInt()

private fun JsonElement?.obj(): JsonObject? = this as? JsonObject

/** The parts of a fixture's setup the demo needs, read once when the fixture is picked. */
internal class RagSetup(
    val kind: String,
    val documents: List<Document>,
    val chunking: Chunking,
    val query: String,
    val mode: Mode?,
    val topK: Int?,
    val candidates: Int?,
    val maxTokens: Int?,
    /** The `dim` of a `hash` embedder when the fixture sets one (the demo's live embedder follows it). */
    val hashDim: Int?,
    /** The first scripted reply of an `answer` fixture. */
    val reply: String?,
    val labelled: List<Labelled>,
)

internal fun ragSetupOf(fixture: Fixture): RagSetup {
    val setup = fixture.root["setup"].obj() ?: error("invalid fixture: setup must be an object")
    val documents = (setup["documents"] as? JsonArray).orEmpty().map { d ->
        val o = d.obj() ?: error("invalid fixture: a document must be an object")
        Document(o["id"].string() ?: "", o["text"].string() ?: "")
    }
    val chunkingObject = setup["chunking"].obj() ?: error("invalid fixture: setup.chunking must be an object")
    val chunking = when (chunkingObject["type"].string()) {
        "fixed" -> Chunking.Fixed(chunkingObject["size"].int() ?: 0, chunkingObject["overlap"].int() ?: 0)
        "paragraph" -> Chunking.Paragraph(chunkingObject["maxSize"].int() ?: 0)
        else -> error("invalid fixture: unknown chunking type")
    }
    val embedder = setup["embedder"].obj()
    val script = setup["provider"].obj()?.get("script") as? JsonArray
    val labelled = (setup["questions"] as? JsonArray).orEmpty().mapNotNull { q ->
        val o = q.obj() ?: return@mapNotNull null
        val level = Level.entries.firstOrNull { it.wire == o["level"].string() } ?: Level.CHUNK
        Labelled(o["query"].string() ?: "", (o["relevant"] as? JsonArray).orEmpty().mapNotNull { it.string() }, level)
    }
    return RagSetup(
        kind = setup["kind"].string() ?: "",
        documents = documents,
        chunking = chunking,
        query = setup["query"].string() ?: "",
        mode = Mode.entries.firstOrNull { it.wire == setup["mode"].string() },
        topK = setup["topK"].int(),
        candidates = setup["candidates"].int(),
        maxTokens = setup["maxTokens"].int(),
        hashDim = if (embedder?.get("type").string() == "hash") embedder?.get("dim").int() else null,
        reply = script?.firstOrNull()?.obj()?.get("response").string(),
        labelled = labelled,
    )
}

/** Read-only fixtures: a scripted embedder (the demo's hashing embedder cannot reproduce it) or an expected error. */
internal fun isReadOnly(fixture: Fixture): Boolean =
    hasScriptedEmbedder(fixture) || fixture.root["expect"].obj()?.containsKey("error") == true

private fun hasScriptedEmbedder(fixture: Fixture): Boolean =
    fixture.root["setup"].obj()?.get("embedder").obj()?.get("type").string() == "script"

// ---- running ---------------------------------------------------------------------------------------------------------

private val EVAL_MODES = listOf(Mode.BM25, Mode.DENSE, Mode.HYBRID)


/**
 * Runs the request through the real library: nothing here scores, ranks or validates. Live runs index the fixture's
 * documents with its chunking and the built-in hashing embedder, then `search`, `composeContext` and, for `answer`
 * fixtures, `extractCitations` on the scripted reply; read-only runs show the fixture run as written.
 */
suspend fun runRag(request: RagRequest): RagRun {
    val setup = ragSetupOf(request.fixture)
    return if (request.readOnly) runRecorded(request, setup) else runLive(request, setup)
}

private suspend fun runLive(request: RagRequest, setup: RagSetup): RagRun {
    val question = request.question
    val emptyQuery = tokenize(question).isEmpty()
    var chunks: List<Chunk> = emptyList()
    var rows: List<HitRow> = emptyList()
    var context: RagContextView? = null
    var citations: CitationView? = null
    var metrics: List<ModeMetrics>? = null
    var failure: RagFailure? = null
    try {
        val index = buildIndex(setup.documents, setup.chunking, hashEmbedder(setup.hashDim ?: DEFAULT_DIM))
        chunks = index.chunks
        // The fixture's `candidates` goes to `search` as written (the library ignores it outside hybrid and rejects a topK above it).
        val hits = search(index, question, request.mode, request.topK, setup.candidates)
        rows = hits.map { HitRow(it) }
        if (setup.kind == "eval") {
            metrics = setup.labelled.firstOrNull { it.query == question }?.let { q ->
                EVAL_MODES.map { mode ->
                    val modeHits = search(index, question, mode, request.topK, setup.candidates)
                    ModeMetrics(mode, retrievalMetrics(modeHits, q.relevant, q.level), modeHits)
                }
            }
        }
        val maxTokens = setup.maxTokens
        if (maxTokens != null) {
            val composed = composeContext(hits, index, maxTokens)
            context = RagContextView(composed.message.content, composed.sources, composed.droppedCount, defaultCounter(composed.message), maxTokens)
            val reply = setup.reply
            if (setup.kind == "answer" && reply != null) citations = CitationView(reply, extractCitations(reply, composed.sources))
        }
    } catch (e: RagException) {
        failure = RagFailure(e.kind.wire, e.required, e.message)
    }
    return RagRun(chunks, request.mode, rows, emptyQuery, context, citations, metrics, failure)
}

private const val DEFAULT_DIM = 256

private suspend fun runRecorded(request: RagRequest, setup: RagSetup): RagRun {
    val outcome = runFixture(request.fixture)
    val chunks = outcome.chunks ?: try {
        buildIndex(setup.documents, setup.chunking, null).chunks
    } catch (e: RagException) {
        emptyList()
    }
    val error = outcome.error
    var rows = outcome.hits.orEmpty().map { HitRow(it) }
    if (error?.kind == "budget_too_small" && !hasScriptedEmbedder(request.fixture)) {
        // The search worked and only the composition failed, so the hits are shown (searched again through the library).
        // Not for a scripted embedder: the hashing embedder cannot reproduce its ranking.
        rows = try {
            val index = buildIndex(setup.documents, setup.chunking, hashEmbedder(setup.hashDim ?: DEFAULT_DIM))
            val candidates = setup.candidates
            search(index, request.question, request.mode, request.topK, candidates).map { HitRow(it) }
        } catch (e: RagException) {
            rows
        }
    }
    var context: RagContextView? = null
    var citations: CitationView? = null
    outcome.context?.let {
        context = RagContextView(it.message.content, it.sources, it.droppedCount, defaultCounter(it.message), setup.maxTokens ?: 0)
    }
    outcome.answer?.let { answer ->
        val system = outcome.requests.firstOrNull()?.messages?.firstOrNull()
        if (system != null) {
            context = RagContextView(system.content, answer.sources, null, defaultCounter(system), setup.maxTokens ?: 0)
        }
        citations = CitationView(answer.answer, answer.citations)
    }
    val metrics = outcome.questions?.firstOrNull { it.query == request.question }?.modes?.map { ModeMetrics(it.mode, it.metrics, it.hits) }
    return RagRun(
        chunks, request.mode, rows, tokenize(request.question).isEmpty(), context, citations, metrics,
        error?.let { RagFailure(it.kind, it.required) },
    )
}

// ---- view model ------------------------------------------------------------------------------------------------------

class RagViewModel(
    loader: FixtureLoader,
    private val savedState: SavedStateHandle,
    private val runner: suspend (RagRequest) -> RagRun = ::runRag,
) : ViewModel() {
    private val fixtures: Map<String, Fixture>
    private val _uiState = MutableStateFlow(RagUiState())
    val uiState: StateFlow<RagUiState> = _uiState.asStateFlow()
    private var runJob: Job? = null

    init {
        val problems = mutableListOf<String>()
        val parsed = try {
            loader.load().mapIndexedNotNull { index, doc ->
                try {
                    parseFixture(doc).also { check(it.name.isNotEmpty()) { "invalid fixture: missing name" } }
                } catch (e: Exception) {
                    problems += "${describe(index, doc)}: ${e.message ?: e::class.simpleName}"
                    null
                }
            }.filter { it.kind in DEMO_KINDS && RagGroup.of(it.name) != null }.sortedBy { it.name }
        } catch (e: Exception) {
            problems += e.message ?: e::class.simpleName.orEmpty()
            emptyList()
        }
        fixtures = parsed.associateBy { it.name }
        _uiState.value = RagUiState(
            names = parsed.map(Fixture::name),
            loadError = problems.takeIf { it.isNotEmpty() }?.joinToString("; "),
        )
        if (parsed.isNotEmpty()) {
            val saved = savedState.get<String>(KEY_SELECTED)
            val default = DEFAULT_FIXTURE.takeIf(fixtures::containsKey) ?: parsed.first().name
            val name = saved?.takeIf(fixtures::containsKey) ?: default
            // Saved edits belong to the saved selection only; after a fallback the fixture's defaults apply.
            open(name, restore = name == saved)
        }
    }

    /** Picks a fixture; its question, mode and topK start from the fixture's own values. */
    fun select(name: String) {
        if (name in fixtures) open(name, restore = false)
    }

    fun setQuestion(text: String) {
        val state = _uiState.value
        if (state.readOnly || state.selected == null || text == state.question) return
        _uiState.update { it.copy(question = text, labelledIndex = it.labelled.indexOfFirst { q -> q.query == text }.takeIf { i -> i >= 0 }) }
        persist()
        refresh()
    }

    fun setMode(mode: Mode) {
        val state = _uiState.value
        if (state.readOnly || state.selected == null || mode == state.mode) return
        _uiState.update { it.copy(mode = mode) }
        persist()
        refresh()
    }

    /** Sets topK as given: the library validates it (a value below 1 is its invalid_options). */
    fun setTopK(value: Int) {
        val state = _uiState.value
        if (state.readOnly || state.selected == null || value == state.topK) return
        _uiState.update { it.copy(topK = value) }
        persist()
        refresh()
    }

    /** Picks a labelled question of an `eval` fixture: it becomes the question. */
    fun selectLabelled(index: Int) {
        val state = _uiState.value
        val picked = state.labelled.getOrNull(index) ?: return
        if (state.readOnly) return
        _uiState.update { it.copy(question = picked.query, labelledIndex = index, questionRevision = it.questionRevision + 1) }
        persist()
        refresh()
    }

    private fun open(name: String, restore: Boolean) {
        val fixture = fixtures.getValue(name)
        val setup = try {
            ragSetupOf(fixture)
        } catch (e: Exception) {
            runJob?.cancel()
            savedState[KEY_SELECTED] = name
            _uiState.update {
                it.copy(selected = name, fixture = fixture, run = null, runKey = null, runError = "$name: ${e.message ?: e::class.simpleName}")
            }
            return
        }
        val defaultQuestion = if (setup.kind == "eval") setup.labelled.firstOrNull()?.query ?: "" else setup.query
        val defaultMode = setup.mode ?: Mode.HYBRID
        val defaultTopK = setup.topK ?: DEFAULT_TOP_K
        val question = (if (restore) savedState.get<String>(KEY_QUESTION) else null) ?: defaultQuestion
        val mode = (if (restore) Mode.entries.firstOrNull { it.wire == savedState.get<String>(KEY_MODE) } else null) ?: defaultMode
        val topK = (if (restore) savedState.get<Int>(KEY_TOP_K) else null) ?: defaultTopK
        val savedLabelled = if (restore) savedState.get<Int>(KEY_LABELLED) else null
        val labelledIndex = savedLabelled?.takeIf { setup.labelled.getOrNull(it)?.query == question }
            ?: setup.labelled.indexOfFirst { it.query == question }.takeIf { it >= 0 }
        _uiState.update {
            it.copy(
                selected = name, fixture = fixture, kind = setup.kind, readOnly = isReadOnly(fixture),
                question = question, questionRevision = it.questionRevision + 1, mode = mode, topK = topK,
                labelled = setup.labelled, labelledIndex = labelledIndex, maxTokens = setup.maxTokens, run = null, runKey = null, runError = null,
            )
        }
        persist()
        refresh()
    }

    private fun persist() {
        val s = _uiState.value
        savedState[KEY_SELECTED] = s.selected
        savedState[KEY_QUESTION] = s.question
        savedState[KEY_MODE] = s.mode.wire
        savedState[KEY_TOP_K] = s.topK
        savedState[KEY_LABELLED] = s.labelledIndex ?: -1
    }

    private fun keyOf(s: RagUiState) = "${s.selected}\u0000${s.question}\u0000${s.mode.wire}\u0000${s.topK}"

    /** Runs the current controls. The previous job is cancelled; a result is applied only while its key is still current. */
    private fun refresh() {
        val state = _uiState.value
        val fixture = state.fixture ?: return
        val key = keyOf(state)
        val request = RagRequest(fixture, state.question, state.mode, state.topK, state.readOnly)
        runJob?.cancel()
        runJob = viewModelScope.launch {
            try {
                val run = runner(request)
                _uiState.update { if (keyOf(it) != key) it else it.copy(run = run, runKey = key, runError = null) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val message = "${state.selected}: ${e.message ?: e::class.simpleName}"
                _uiState.update { if (keyOf(it) != key) it else it.copy(run = null, runKey = null, runError = message) }
            }
        }
    }

    /** Names a malformed document: its "name" field when one can be read, else its position (1-based). */
    private fun describe(index: Int, doc: String): String {
        val name = NAME_FIELD.find(doc)?.groupValues?.get(1)
        return if (name != null) "$name (#${index + 1})" else "#${index + 1}"
    }

    companion object {
        const val MIN_TOP_K = 1
        const val DEFAULT_TOP_K = 5
        private val DEMO_KINDS = setOf("search", "context", "answer", "eval")
        private const val KEY_SELECTED = "selected"
        private const val KEY_QUESTION = "question"
        private const val KEY_MODE = "mode"
        private const val KEY_TOP_K = "topK"
        private const val KEY_LABELLED = "labelled"
        private const val DEFAULT_FIXTURE = "hybrid-fusion-order"
        private val NAME_FIELD = Regex("\"name\"\\s*:\\s*\"([^\"]+)\"")

        fun factory(loader: FixtureLoader): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>, extras: CreationExtras): T =
                RagViewModel(loader, extras.createSavedStateHandle()) as T
        }
    }
}
