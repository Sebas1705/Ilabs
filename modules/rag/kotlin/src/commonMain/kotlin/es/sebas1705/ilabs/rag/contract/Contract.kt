package es.sebas1705.ilabs.rag.contract

import es.sebas1705.ilabs.providers.CompletionRequest
import es.sebas1705.ilabs.providers.CompletionResponse
import es.sebas1705.ilabs.providers.ErrorKind
import es.sebas1705.ilabs.providers.Message
import es.sebas1705.ilabs.providers.MockProvider
import es.sebas1705.ilabs.providers.Provider
import es.sebas1705.ilabs.providers.ProviderException
import es.sebas1705.ilabs.providers.Role
import es.sebas1705.ilabs.providers.ScriptEntry
import es.sebas1705.ilabs.providers.ScriptError
import es.sebas1705.ilabs.rag.Answer
import es.sebas1705.ilabs.rag.Chunk
import es.sebas1705.ilabs.rag.Citations
import es.sebas1705.ilabs.rag.ComposedContext
import es.sebas1705.ilabs.rag.Document
import es.sebas1705.ilabs.rag.Embedder
import es.sebas1705.ilabs.rag.Hit
import es.sebas1705.ilabs.rag.Level
import es.sebas1705.ilabs.rag.Mode
import es.sebas1705.ilabs.rag.RagException
import es.sebas1705.ilabs.rag.RagIndex
import es.sebas1705.ilabs.rag.RetrievalMetrics
import es.sebas1705.ilabs.rag.Source
import es.sebas1705.ilabs.rag.answerWithSources
import es.sebas1705.ilabs.rag.buildIndex
import es.sebas1705.ilabs.rag.composeContext
import es.sebas1705.ilabs.rag.extractCitations
import es.sebas1705.ilabs.rag.hashEmbed
import es.sebas1705.ilabs.rag.hashEmbedder
import es.sebas1705.ilabs.rag.parseChunking
import es.sebas1705.ilabs.rag.parseIntOption
import es.sebas1705.ilabs.rag.parseLevel
import es.sebas1705.ilabs.rag.parseMode
import es.sebas1705.ilabs.rag.retrievalMetrics
import es.sebas1705.ilabs.rag.search
import es.sebas1705.ilabs.rag.tokenize
import es.sebas1705.ilabs.rag.validateSearchOptions
import es.sebas1705.ilabs.structured.parseStrict
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlin.math.abs

/** A contract fixture as raw JSON: it is checked against the format rules by [runFixture] and [checkOutcome]. */
class Fixture(val root: JsonObject) {
    val name: String get() = root["name"].str() ?: ""

    /** `setup.kind`, or "" when absent. */
    val kind: String get() = (root["setup"] as? JsonObject)?.get("kind").str() ?: ""
}

/** An error a run reported: a `rag` error kind, or a provider error kind in `answer` fixtures. */
data class FixtureError(val kind: String, val required: Int? = null)

/** One mode of one `eval` question: the hits of `search` and their metrics. */
data class EvalModeRun(val mode: Mode, val hits: List<Hit>, val metrics: RetrievalMetrics)

/** One `eval` question: its runs for `bm25`, `dense` and `hybrid`, in that order. */
data class EvalQuestionRun(val query: String, val modes: List<EvalModeRun>)

/**
 * What a run produced. [error] is set when the library (or the provider of an `answer` fixture) failed; otherwise the
 * fields of the fixture's kind are set. [chunks] holds the index chunks whenever an index was built. [calls] and
 * [requests] are what the harness recorded on the provider of an `answer` fixture (also when the run failed).
 */
data class FixtureOutcome(
    val kind: String,
    val error: FixtureError? = null,
    val tokens: List<String>? = null,
    val chunks: List<Chunk>? = null,
    val embedding: List<Double>? = null,
    val hits: List<Hit>? = null,
    val context: ComposedContext? = null,
    val citations: Citations? = null,
    val metrics: RetrievalMetrics? = null,
    val questions: List<EvalQuestionRun>? = null,
    val answer: Answer? = null,
    val calls: Int = 0,
    val requests: List<CompletionRequest> = emptyList(),
)

private fun invalid(reason: String): Nothing = throw IllegalStateException("invalid fixture: $reason")

/** Parses a fixture file with the strict JSON parser; anything that is not one strict JSON object is malformed. */
fun parseFixture(json: String): Fixture {
    val el = parseStrict(json) ?: invalid("not valid strict JSON")
    return Fixture(el as? JsonObject ?: invalid("a fixture must be a JSON object"))
}

// ---- raw JSON accessors ---------------------------------------------------------------------------------------------

private fun JsonElement?.str(): String? = (this as? JsonPrimitive)?.takeIf { it !is JsonNull && it.isString }?.content

private fun JsonElement?.number(): Double? = (this as? JsonPrimitive)?.takeIf { it !is JsonNull && !it.isString }?.doubleOrNull

/** An integer by VALUE (`1` and `1.0` alike), or null. */
private fun JsonElement?.integer(): Int? = number()?.takeIf { it % 1.0 == 0.0 && abs(it) <= Int.MAX_VALUE.toDouble() }?.toInt()

private fun JsonElement?.bool(): Boolean? = when ((this as? JsonPrimitive)?.takeIf { it !is JsonNull && !it.isString }?.content) {
    "true" -> true
    "false" -> false
    else -> null
}

private fun keys(where: String, o: JsonObject, allowed: Set<String>, required: Set<String> = emptySet()) {
    val unknown = o.keys.firstOrNull { it !in allowed }
    if (unknown != null) invalid("unknown key \"$unknown\" in $where")
    val missing = required.firstOrNull { it !in o }
    if (missing != null) invalid("missing key \"$missing\" in $where")
}

private fun obj(where: String, el: JsonElement?): JsonObject = el as? JsonObject ?: invalid("$where must be an object")

private fun arr(where: String, el: JsonElement?): JsonArray = el as? JsonArray ?: invalid("$where must be an array")

private fun string(where: String, el: JsonElement?): String = el.str() ?: invalid("$where must be a string")

private fun num(where: String, el: JsonElement?): Double = el.number() ?: invalid("$where must be a number")

private fun strings(where: String, el: JsonElement?): List<String> = arr(where, el).map { string("$where entry", it) }

/** An option number: a JSON number, or JSON `null` (the library's `invalid_options`); any other type is malformed. */
private fun optionNumber(where: String, el: JsonElement?) {
    if (el !is JsonNull) num(where, el)
}

/** An option string (`mode`, `level`, chunking `type`): a JSON string, or JSON `null` (the library's `invalid_options`). */
private fun optionString(where: String, el: JsonElement?) {
    if (el !is JsonNull) string(where, el)
}

/** A citation source `n`: an integer by value, else a malformed fixture. */
private fun sourceNumber(el: JsonElement?): Int = el.integer() ?: invalid("a citation source must be an integer")

/** The value of an integer option present in [o]: JSON `null` and non-integers fail in the library parse function. */
private fun intOption(o: JsonObject, key: String): Int = parseIntOption(o[key].number())

// ---- format ---------------------------------------------------------------------------------------------------------

private val TOP_LEVEL_KEYS = setOf("name", "setup", "expect")

private class KindKeys(val required: Set<String>, val optional: Set<String> = emptySet()) {
    val all: Set<String> get() = required + optional
}

private val SEARCH_REQUIRED = setOf("kind", "documents", "chunking", "query", "mode")
private val SEARCH_OPTIONAL = setOf("embedder", "topK", "candidates")

private val SETUP_KEYS: Map<String, KindKeys> = mapOf(
    "tokens" to KindKeys(setOf("kind", "text")),
    "chunk" to KindKeys(setOf("kind", "documents", "chunking")),
    "embed" to KindKeys(setOf("kind", "text"), setOf("dim")),
    "search" to KindKeys(SEARCH_REQUIRED, SEARCH_OPTIONAL),
    "context" to KindKeys(SEARCH_REQUIRED + "maxTokens", SEARCH_OPTIONAL),
    "citations" to KindKeys(setOf("kind", "sources", "answer")),
    "metrics" to KindKeys(setOf("kind", "hits", "relevant"), setOf("level")),
    "eval" to KindKeys(setOf("kind", "documents", "chunking", "embedder", "topK", "questions")),
    "answer" to KindKeys(SEARCH_REQUIRED + setOf("maxTokens", "provider"), SEARCH_OPTIONAL),
)

private val EXPECT_KEYS: Map<String, KindKeys> = mapOf(
    "tokens" to KindKeys(setOf("tokens")),
    "chunk" to KindKeys(setOf("chunks")),
    "embed" to KindKeys(setOf("nonZero")),
    "search" to KindKeys(setOf("hits")),
    "context" to KindKeys(setOf("message", "sources", "droppedCount")),
    "citations" to KindKeys(setOf("cited", "unknown")),
    "metrics" to KindKeys(setOf("recallAtK", "precisionAtK", "reciprocalRank", "hit")),
    "eval" to KindKeys(setOf("questions")),
    "answer" to KindKeys(setOf("answer", "sources", "citations", "hitIds", "calls"), setOf("request")),
)

private val HIT_KEYS = setOf("chunkId", "docId", "rank", "score", "bm25Rank", "denseRank")
private val CHUNK_KEYS = setOf("id", "docId", "index", "text", "start", "end")
private val SOURCE_KEYS = setOf("n", "chunkId", "docId")
private val METRIC_KEYS = setOf("recallAtK", "precisionAtK", "reciprocalRank", "hit")
private val MODE_NAMES = listOf("bm25", "dense", "hybrid")

/** A fixture whose format has been checked: [setup] and [expect] follow the rules of their kind. */
private class Checked(val kind: String, val setup: JsonObject, val expect: JsonObject, val expectsError: Boolean)

private fun checkDocuments(el: JsonElement?) {
    arr("setup.documents", el).forEach { d ->
        val o = obj("a document", d)
        keys("a document", o, setOf("id", "text"), setOf("id", "text"))
        string("a document id", o["id"])
        string("a document text", o["text"])
    }
}

private fun checkChunking(el: JsonElement?) {
    val o = obj("setup.chunking", el)
    if ("type" !in o) invalid("missing key \"type\" in setup.chunking")
    // a type that is not a string (null included) is malformed; an unknown string is the library's invalid_options
    val type = string("setup.chunking.type", o["type"])
    when (type) {
        "fixed" -> keys("a fixed chunking", o, setOf("type", "size", "overlap"), setOf("type", "size", "overlap"))
        "paragraph" -> keys("a paragraph chunking", o, setOf("type", "maxSize"), setOf("type", "maxSize"))
        else -> Unit
    }
    if (type == "fixed" || type == "paragraph") for ((k, v) in o) if (k != "type") optionNumber("setup.chunking.$k", v)
}

private fun parseResponses(el: JsonElement?): List<List<DoubleArray>> =
    arr("script embedder responses", el).mapIndexed { i, response ->
        val vectors = response as? JsonArray ?: invalid("script embedder response ${i + 1} is not an array of arrays of numbers")
        vectors.map { v ->
            val numbers = v as? JsonArray ?: invalid("script embedder response ${i + 1} is not an array of arrays of numbers")
            DoubleArray(numbers.size) { k -> numbers[k].number() ?: invalid("script embedder response ${i + 1} is not an array of arrays of numbers") }
        }
    }

private fun checkEmbedder(el: JsonElement?) {
    val o = obj("setup.embedder", el)
    when (string("setup.embedder.type", o["type"])) {
        "hash" -> {
            keys("a hash embedder", o, setOf("type", "dim"), setOf("type"))
            if ("dim" in o) optionNumber("setup.embedder.dim", o["dim"])
        }
        "script" -> {
            keys("a script embedder", o, setOf("type", "responses"), setOf("type", "responses"))
            parseResponses(o["responses"])
        }
        else -> invalid("unknown embedder type ${o["type"].str()}")
    }
}

private const val PROVIDER_ID = "mock"

private fun parseScript(el: JsonElement?): List<ScriptEntry> {
    val provider = obj("setup.provider", el)
    keys("setup.provider", provider, setOf("script"), setOf("script"))
    return arr("setup.provider.script", provider["script"]).mapIndexed { i, entry ->
        val n = i + 1
        val o = obj("script entry $n of provider $PROVIDER_ID", entry)
        val response = o["response"]
        val error = o["error"]
        // the `neither` message comes first: an entry {"text": "b"} has neither response nor error
        if (response == null && error == null) invalid("script entry $n of provider $PROVIDER_ID has neither response nor error")
        keys("script entry $n of provider $PROVIDER_ID", o, setOf("response", "error"))
        if (response != null && response.str() == null) invalid("script entry $n of provider $PROVIDER_ID has a non-string response")
        val scriptError = error?.let {
            val eo = obj("the error of script entry $n of provider $PROVIDER_ID", it)
            keys("the error of script entry $n of provider $PROVIDER_ID", eo, setOf("kind", "retryAfterMs"), setOf("kind"))
            val kind = ErrorKind.entries.firstOrNull { k -> k.wire == eo["kind"].str() }
                ?: invalid("script entry $n of provider $PROVIDER_ID has an unknown error kind")
            ScriptError(kind, null)
        }
        ScriptEntry(response.str(), scriptError)
    }
}

private fun checkSetup(kind: String, setup: JsonObject) {
    val spec = SETUP_KEYS[kind] ?: invalid("unknown setup kind: $kind")
    keys("setup", setup, spec.all, spec.required)
    for (k in listOf("text", "query", "answer")) if (k in setup) string("setup.$k", setup[k])
    for (k in listOf("mode", "level")) if (k in setup) optionString("setup.$k", setup[k])
    for (k in listOf("dim", "topK", "candidates", "maxTokens")) if (k in setup) optionNumber("setup.$k", setup[k])
    if ("documents" in setup) checkDocuments(setup["documents"])
    if ("chunking" in setup) checkChunking(setup["chunking"])
    if ("embedder" in setup) checkEmbedder(setup["embedder"])
    if ("provider" in setup) parseScript(setup["provider"])
    // sources are not options: a non-numeric or non-integer entry is a malformed fixture
    if ("sources" in setup) arr("setup.sources", setup["sources"]).forEach { sourceNumber(it) }
    if ("relevant" in setup) strings("setup.relevant", setup["relevant"])
    if ("hits" in setup) {
        arr("setup.hits", setup["hits"]).forEach { h ->
            val o = obj("a metrics hit", h)
            keys("a metrics hit", o, setOf("chunkId", "docId"), setOf("chunkId", "docId"))
            string("a metrics hit chunkId", o["chunkId"])
            string("a metrics hit docId", o["docId"])
        }
    }
    if ("questions" in setup) {
        arr("setup.questions", setup["questions"]).forEach { q ->
            val o = obj("a question", q)
            keys("a question", o, setOf("query", "relevant", "level"), setOf("query", "relevant"))
            string("a question query", o["query"])
            strings("a question relevant", o["relevant"])
            if ("level" in o) optionString("a question level", o["level"])
        }
    }
}

private fun checkExpect(kind: String, expect: JsonObject): Boolean {
    val spec = EXPECT_KEYS.getValue(kind)
    if ("error" in expect) {
        val allowed = if (kind == "answer") setOf("error", "calls", "request") else setOf("error")
        keys("expect", expect, allowed, if (kind == "answer") setOf("error", "calls") else setOf("error"))
        val error = obj("expect.error", expect["error"])
        keys("expect.error", error, setOf("kind", "required"), setOf("kind"))
        string("expect.error.kind", error["kind"])
        if ("required" in error) num("expect.error.required", error["required"])
    } else {
        if (!spec.required.all { it in expect }) invalid("expect has neither the keys of a $kind fixture nor error")
        keys("expect", expect, spec.all, spec.required)
    }
    // nested expected shapes
    expect["hits"]?.let { h -> arr("expect.hits", h).forEach { keys("an expected hit", obj("an expected hit", it), HIT_KEYS, setOf("chunkId", "docId", "rank", "score")) } }
    expect["chunks"]?.let { c -> arr("expect.chunks", c).forEach { keys("an expected chunk", obj("an expected chunk", it), CHUNK_KEYS, CHUNK_KEYS) } }
    expect["sources"]?.let { s -> arr("expect.sources", s).forEach { keys("an expected source", obj("an expected source", it), SOURCE_KEYS, SOURCE_KEYS) } }
    expect["message"]?.let { keys("expect.message", obj("expect.message", it), setOf("role", "content"), setOf("role", "content")) }
    expect["citations"]?.let { keys("expect.citations", obj("expect.citations", it), setOf("cited", "unknown"), setOf("cited", "unknown")) }
    expect["request"]?.let { keys("expect.request", obj("expect.request", it), setOf("system", "user"), setOf("system", "user")) }
    expect["questions"]?.let { qs ->
        arr("expect.questions", qs).forEach { q ->
            val qo = obj("an expected question", q)
            keys("an expected question", qo, setOf("modes"), setOf("modes"))
            val modes = obj("expected modes", qo["modes"])
            keys("expected modes", modes, MODE_NAMES.toSet(), MODE_NAMES.toSet())
            for (m in MODE_NAMES) keys("expected mode $m", obj("expected mode $m", modes[m]), METRIC_KEYS + "hitIds", METRIC_KEYS + "hitIds")
        }
    }
    return "error" in expect
}

private fun checkFixture(fixture: Fixture): Checked {
    val root = fixture.root
    keys("the fixture", root, TOP_LEVEL_KEYS, TOP_LEVEL_KEYS)
    string("name", root["name"])
    val setup = obj("setup", root["setup"])
    val kind = string("setup.kind", setup["kind"])
    checkSetup(kind, setup)
    val expect = obj("expect", root["expect"])
    val expectsError = checkExpect(kind, expect)
    return Checked(kind, setup, expect, expectsError)
}

// ---- run ------------------------------------------------------------------------------------------------------------

/** The fixture `script` embedder: call N returns `responses[N-1]` verbatim (copied), whatever the input. */
private class ScriptEmbedder(private val responses: List<List<DoubleArray>>) : Embedder {
    private var calls = 0
    override suspend fun embed(texts: List<String>): List<DoubleArray> {
        val response = responses.getOrNull(calls++) ?: invalid("script embedder called more often than it has responses")
        return response.map { it.copyOf() }
    }
}

private class Recorder(private val inner: Provider) : Provider {
    val requests = mutableListOf<CompletionRequest>()
    override val id: String get() = inner.id
    override suspend fun complete(req: CompletionRequest): CompletionResponse {
        requests += req
        return inner.complete(req)
    }
}

private fun documents(setup: JsonObject): List<Document> =
    (setup["documents"] as JsonArray).map { val o = it as JsonObject; Document(o["id"].str()!!, o["text"].str()!!) }

private fun chunkingOf(setup: JsonObject) = (setup["chunking"] as JsonObject).let { o ->
    parseChunking(string("setup.chunking.type", o["type"]), o["size"].number(), o["overlap"].number(), o["maxSize"].number())
}

private fun embedderOf(setup: JsonObject): Embedder? {
    val o = setup["embedder"] as? JsonObject ?: return null
    return when (o["type"].str()) {
        "hash" -> hashEmbedder(if ("dim" in o) intOption(o, "dim") else 256)
        else -> ScriptEmbedder(parseResponses(o["responses"]))
    }
}

private class SearchOptions(val mode: Mode, val topK: Int, val candidates: Int?)

/**
 * `mode` and `topK` through the library parse; `candidates` is parsed in hybrid mode only (ignored entirely otherwise,
 * whatever its value, JSON `null` included).
 */
private fun searchOptionsOf(setup: JsonObject): SearchOptions {
    val mode = parseMode(setup["mode"].str())
    val topK = if ("topK" in setup) intOption(setup, "topK") else 5
    val candidates = if (mode == Mode.HYBRID && "candidates" in setup) intOption(setup, "candidates") else null
    return SearchOptions(mode, topK, candidates)
}

private fun levelOf(o: JsonObject): Level = if ("level" in o) parseLevel(o["level"].str()) else Level.CHUNK

private suspend fun buildFrom(setup: JsonObject): RagIndex {
    val embedder = embedderOf(setup) // built first: a bad hash dim fails at construction, before buildIndex
    return buildIndex(documents(setup), chunkingOf(setup), embedder)
}

private suspend fun runSetup(kind: String, setup: JsonObject, recorder: Recorder?): FixtureOutcome = when (kind) {
    "tokens" -> FixtureOutcome(kind, tokens = tokenize(setup["text"].str()!!))
    "embed" -> {
        val dim = if ("dim" in setup) intOption(setup, "dim") else 256
        FixtureOutcome(kind, embedding = hashEmbed(setup["text"].str()!!, dim).toList())
    }
    "chunk" -> FixtureOutcome(kind, chunks = buildFrom(setup).chunks)
    "search" -> {
        val index = buildFrom(setup)
        val o = searchOptionsOf(setup)
        FixtureOutcome(kind, chunks = index.chunks, hits = search(index, setup["query"].str()!!, o.mode, o.topK, o.candidates))
    }
    "context" -> {
        val index = buildFrom(setup)
        val o = searchOptionsOf(setup)
        val hits = search(index, setup["query"].str()!!, o.mode, o.topK, o.candidates)
        val maxTokens = intOption(setup, "maxTokens")
        FixtureOutcome(kind, chunks = index.chunks, hits = hits, context = composeContext(hits, index, maxTokens))
    }
    "citations" -> {
        val sources = (setup["sources"] as JsonArray).map { Source(sourceNumber(it), "", "") }
        FixtureOutcome(kind, citations = extractCitations(setup["answer"].str()!!, sources))
    }
    "metrics" -> {
        val hits = (setup["hits"] as JsonArray).mapIndexed { i, h ->
            val o = h as JsonObject
            Hit(o["chunkId"].str()!!, o["docId"].str()!!, i + 1, 0.0)
        }
        val level = levelOf(setup)
        val relevant = (setup["relevant"] as JsonArray).map { it.str()!! }
        FixtureOutcome(kind, metrics = retrievalMetrics(hits, relevant, level))
    }
    "eval" -> {
        val index = buildFrom(setup)
        val topK = intOption(setup, "topK")
        // validated ONCE, before the question loop, with the library's own search-option check, so a bad topK is
        // `invalid_options` even when there are no questions (topK is the same for every mode)
        validateSearchOptions(Mode.BM25, topK, null)
        val questions = (setup["questions"] as JsonArray).map { q ->
            val o = q as JsonObject
            val query = o["query"].str()!!
            val relevant = (o["relevant"] as JsonArray).map { it.str()!! }
            val modes = listOf(Mode.BM25, Mode.DENSE, Mode.HYBRID).map { mode ->
                val hits = search(index, query, mode, topK)
                val level = levelOf(o)
                EvalModeRun(mode, hits, retrievalMetrics(hits, relevant, level))
            }
            EvalQuestionRun(query, modes)
        }
        FixtureOutcome(kind, chunks = index.chunks, questions = questions)
    }
    else -> { // answer
        val index = buildFrom(setup)
        val o = searchOptionsOf(setup)
        val maxTokens = intOption(setup, "maxTokens")
        val answer = answerWithSources(requireNotNull(recorder), index, setup["query"].str()!!, o.mode, o.topK, o.candidates, maxTokens)
        FixtureOutcome(kind, chunks = index.chunks, hits = answer.hits, answer = answer)
    }
}

/**
 * Runs a contract fixture against `rag`: checks its format (`invalid fixture: <reason>` as an IllegalStateException),
 * builds what the setup describes and calls the library, converting values a typed API cannot represent (unknown
 * mode, level or chunking type, non-integer numbers) through the library parse functions. A `RagException` (and, in
 * `answer` fixtures, a `ProviderException`) is reported as [FixtureOutcome.error]; nothing else is caught.
 * Common code: no java.* (usable from the Android demo).
 */
suspend fun runFixture(fixture: Fixture): FixtureOutcome {
    val checked = checkFixture(fixture)
    val kind = checked.kind
    val recorder = if (kind == "answer") Recorder(MockProvider(PROVIDER_ID, parseScript(checked.setup["provider"]))) else null

    fun failed(error: FixtureError) = FixtureOutcome(
        kind,
        error = error,
        calls = recorder?.requests?.size ?: 0,
        requests = recorder?.requests?.toList() ?: emptyList(),
    )

    return try {
        val outcome = runSetup(kind, checked.setup, recorder)
        if (recorder == null) outcome else outcome.copy(calls = recorder.requests.size, requests = recorder.requests.toList())
    } catch (e: RagException) {
        failed(FixtureError(e.kind.wire, e.required))
    } catch (e: ProviderException) {
        if (recorder == null) throw e
        failed(FixtureError(e.kind.wire))
    }
}

// ---- checks ---------------------------------------------------------------------------------------------------------

private const val SCORE_TOLERANCE = 1e-9

private fun wire(role: Role): String = when (role) {
    Role.SYSTEM -> "system"
    Role.USER -> "user"
    Role.ASSISTANT -> "assistant"
}

private fun expectedSources(el: JsonElement?): List<Source> =
    (el as JsonArray).map { val o = it as JsonObject; Source(o["n"].integer() ?: -1, o["chunkId"].str() ?: "", o["docId"].str() ?: "") }

private fun expectedInts(el: JsonElement?): List<Int?> = (el as? JsonArray)?.map { it.integer() } ?: emptyList()

private fun expectedStrings(el: JsonElement?): List<String?> = (el as? JsonArray)?.map { it.str() } ?: emptyList()

private fun checkHits(at: String, want: JsonArray, got: List<Hit>, out: MutableList<String>) {
    if (want.size != got.size) {
        out += "$at: expected ${want.size} hits but was ${got.size}: ${got.map { it.chunkId }}"
        return
    }
    want.forEachIndexed { i, w ->
        val o = w as JsonObject
        val g = got[i]
        val where = "$at[$i]"
        if (o["chunkId"].str() != g.chunkId) out += "$where: chunkId: expected <${o["chunkId"].str()}> but was <${g.chunkId}>"
        if (o["docId"].str() != g.docId) out += "$where: docId: expected <${o["docId"].str()}> but was <${g.docId}>"
        if (o["rank"].integer() != g.rank) out += "$where: rank: expected <${o["rank"].integer()}> but was <${g.rank}>"
        val score = o["score"].number()
        if (score == null || !(abs(score - g.score) <= SCORE_TOLERANCE)) out += "$where: score: expected <$score> but was <${g.score}>"
        for ((key, actual) in listOf("bm25Rank" to g.bm25Rank, "denseRank" to g.denseRank)) {
            val expected = if (key in o) o[key].integer() else null
            if (key in o && expected == null) out += "$where: $key: malformed expectation"
            if (expected != actual) out += "$where: $key: expected <$expected> but was <$actual>"
        }
    }
}

private fun checkMetrics(at: String, want: JsonObject, got: RetrievalMetrics, out: MutableList<String>) {
    // IEEE-754 double VALUES compared exactly: `1` and `1.0` are equal.
    for ((key, actual) in listOf("recallAtK" to got.recallAtK, "precisionAtK" to got.precisionAtK, "reciprocalRank" to got.reciprocalRank)) {
        val expected = want[key].number()
        if (expected == null || expected != actual) out += "$at$key: expected <$expected> but was <$actual>"
    }
    if (want["hit"].bool() != got.hit) out += "${at}hit: expected <${want["hit"].bool()}> but was <${got.hit}>"
}

private fun checkRequest(expect: JsonObject, outcome: FixtureOutcome, out: MutableList<String>) {
    val calls = expect["calls"].integer()
    if (calls != outcome.calls) out += "calls: expected <$calls> but was <${outcome.calls}>"
    val request = expect["request"] as? JsonObject
    if (request == null) {
        if (outcome.requests.isNotEmpty()) out += "request: none expected but ${outcome.requests.size} recorded"
        return
    }
    if (outcome.requests.size != 1) {
        out += "request: expected exactly one but ${outcome.requests.size} recorded"
        return
    }
    val want = CompletionRequest(
        listOf(Message(Role.SYSTEM, request["system"].str() ?: ""), Message(Role.USER, request["user"].str() ?: "")),
    )
    if (outcome.requests[0] != want) out += "request: expected <$want> but was <${outcome.requests[0]}>"
}

/**
 * Compares an outcome with the fixture's expectation per the contract's comparison rules. Returns every failing check;
 * an empty list means the fixture passed. A malformed fixture fails with `invalid fixture: <reason>`.
 */
fun checkOutcome(fixture: Fixture, outcome: FixtureOutcome): List<String> {
    val checked = checkFixture(fixture)
    val expect = checked.expect
    val out = mutableListOf<String>()

    if (checked.expectsError) {
        val want = expect["error"] as JsonObject
        val got = outcome.error
        if (got == null) {
            out += "expected error <${want["kind"].str()}> but the run succeeded"
        } else {
            if (want["kind"].str() != got.kind) out += "error kind: expected <${want["kind"].str()}> but was <${got.kind}>"
            val required = if ("required" in want) want["required"].integer() else null
            if (required != got.required) out += "error required: expected <$required> but was <${got.required}>"
        }
        if (checked.kind == "answer") checkRequest(expect, outcome, out)
        return out
    }
    val error = outcome.error
    if (error != null) {
        out += "unexpected error <${error.kind}>" + (error.required?.let { " (required $it)" } ?: "")
        if (checked.kind == "answer") checkRequest(expect, outcome, out)
        return out
    }

    when (checked.kind) {
        "tokens" -> {
            val want = expectedStrings(expect["tokens"])
            if (want != outcome.tokens) out += "tokens: expected <$want> but was <${outcome.tokens}>"
        }
        "chunk" -> {
            val want = (expect["chunks"] as JsonArray).map {
                val o = it as JsonObject
                Chunk(o["id"].str() ?: "", o["docId"].str() ?: "", o["index"].integer() ?: -1, o["text"].str() ?: "", o["start"].integer() ?: -1, o["end"].integer() ?: -1)
            }
            if (want != outcome.chunks) out += "chunks: expected <$want> but was <${outcome.chunks}>"
        }
        "embed" -> {
            val want = (expect["nonZero"] as JsonArray).map { (it as? JsonArray)?.let { p -> p.getOrNull(0).integer() to p.getOrNull(1).number() } }
            val got = outcome.embedding.orEmpty().withIndex().filter { it.value != 0.0 }.map { it.index to it.value }
            if (want.size != got.size) {
                out += "nonZero: expected ${want.size} entries but was ${got.size}: $got"
            } else {
                want.forEachIndexed { i, w ->
                    val g = got[i]
                    val value = w?.second
                    if (w?.first != g.first) out += "nonZero[$i]: bucket: expected <${w?.first}> but was <${g.first}>"
                    if (value == null || !(abs(value - g.second) <= SCORE_TOLERANCE)) out += "nonZero[$i]: value: expected <$value> but was <${g.second}>"
                }
            }
        }
        "search" -> checkHits("hits", expect["hits"] as JsonArray, outcome.hits.orEmpty(), out)
        "context" -> {
            val got = outcome.context
            if (got == null) {
                out += "context: no result"
            } else {
                val message = expect["message"] as JsonObject
                if (message["role"].str() != wire(got.message.role)) out += "message role: expected <${message["role"].str()}> but was <${wire(got.message.role)}>"
                if (message["content"].str() != got.message.content) out += "message content: expected <${message["content"].str()}> but was <${got.message.content}>"
                val sources = expectedSources(expect["sources"])
                if (sources != got.sources) out += "sources: expected <$sources> but was <${got.sources}>"
                val dropped = expect["droppedCount"].integer()
                if (dropped != got.droppedCount) out += "droppedCount: expected <$dropped> but was <${got.droppedCount}>"
            }
        }
        "citations" -> {
            val got = outcome.citations
            val cited = expectedInts(expect["cited"])
            val unknown = expectedInts(expect["unknown"])
            if (cited != got?.cited) out += "cited: expected <$cited> but was <${got?.cited}>"
            if (unknown != got?.unknown) out += "unknown: expected <$unknown> but was <${got?.unknown}>"
        }
        "metrics" -> {
            val got = outcome.metrics
            if (got == null) out += "metrics: no result" else checkMetrics("", expect, got, out)
        }
        "eval" -> {
            val want = expect["questions"] as JsonArray
            val got = outcome.questions.orEmpty()
            if (want.size != got.size) {
                out += "questions: expected ${want.size} but was ${got.size}"
            } else {
                want.forEachIndexed { i, q ->
                    val modes = (q as JsonObject)["modes"] as JsonObject
                    got[i].modes.forEachIndexed { m, run ->
                        val name = MODE_NAMES[m]
                        val w = modes[name] as JsonObject
                        val at = "questions[$i].$name."
                        val hitIds = expectedStrings(w["hitIds"])
                        val gotIds = run.hits.map { it.chunkId }
                        if (hitIds != gotIds) out += "${at}hitIds: expected <$hitIds> but was <$gotIds>"
                        checkMetrics(at, w, run.metrics, out)
                    }
                }
            }
        }
        else -> { // answer
            val got = outcome.answer
            if (got == null) {
                out += "answer: no result"
            } else {
                if (expect["answer"].str() != got.answer) out += "answer: expected <${expect["answer"].str()}> but was <${got.answer}>"
                val sources = expectedSources(expect["sources"])
                if (sources != got.sources) out += "sources: expected <$sources> but was <${got.sources}>"
                val citations = expect["citations"] as JsonObject
                val want = Citations(expectedInts(citations["cited"]).map { it ?: -1 }, expectedInts(citations["unknown"]).map { it ?: -1 })
                if (want != got.citations) out += "citations: expected <$want> but was <${got.citations}>"
                val hitIds = expectedStrings(expect["hitIds"])
                if (hitIds != got.hits.map { it.chunkId }) out += "hitIds: expected <$hitIds> but was <${got.hits.map { it.chunkId }}>"
            }
            checkRequest(expect, outcome, out)
        }
    }
    return out
}
