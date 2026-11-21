package es.sebas1705.ilabs.guardrails.contract

import es.sebas1705.ilabs.guardrails.CANARY_PREFIX
import es.sebas1705.ilabs.guardrails.CANARY_SUFFIX
import es.sebas1705.ilabs.guardrails.CANARY_WHITESPACE
import es.sebas1705.ilabs.guardrails.CheckDetails
import es.sebas1705.ilabs.guardrails.CheckFinding
import es.sebas1705.ilabs.guardrails.CheckResult
import es.sebas1705.ilabs.guardrails.Classification
import es.sebas1705.ilabs.guardrails.Classifier
import es.sebas1705.ilabs.guardrails.DEFAULT_BLOCKED_TEXT
import es.sebas1705.ilabs.guardrails.DNI_LETTERS
import es.sebas1705.ilabs.guardrails.GuardedProvider
import es.sebas1705.ilabs.guardrails.GuardedResult
import es.sebas1705.ilabs.guardrails.GuardrailException
import es.sebas1705.ilabs.guardrails.INJECTION_TABLE
import es.sebas1705.ilabs.guardrails.InjectionEntry
import es.sebas1705.ilabs.guardrails.InjectionResult
import es.sebas1705.ilabs.guardrails.InjectionSignal
import es.sebas1705.ilabs.guardrails.METRIC_KINDS
import es.sebas1705.ilabs.guardrails.Mapping
import es.sebas1705.ilabs.guardrails.MetricSpan
import es.sebas1705.ilabs.guardrails.Metrics
import es.sebas1705.ilabs.guardrails.PII_KINDS
import es.sebas1705.ilabs.guardrails.PLACEHOLDER_NAMES
import es.sebas1705.ilabs.guardrails.PiiFinding
import es.sebas1705.ilabs.guardrails.Redacted
import es.sebas1705.ilabs.guardrails.SECRET_PREFIXES
import es.sebas1705.ilabs.guardrails.checkText
import es.sebas1705.ilabs.guardrails.detectInjection
import es.sebas1705.ilabs.guardrails.detectPii
import es.sebas1705.ilabs.guardrails.detectionMetrics
import es.sebas1705.ilabs.guardrails.guardedComplete
import es.sebas1705.ilabs.guardrails.parsePiiKind
import es.sebas1705.ilabs.guardrails.parsePolicy
import es.sebas1705.ilabs.guardrails.redact
import es.sebas1705.ilabs.guardrails.restore
import es.sebas1705.ilabs.guardrails.withCanary
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
import es.sebas1705.ilabs.structured.parseStrict
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

// The fixture harness of `contracts/guardrails/README.md` (Fixture format, Comparison and harness, Malformed fixtures).
// Common code: no java.* (usable from the Android demo). Outside the library only `GuardrailException` and (in
// `guarded` fixtures) `ProviderException` are caught; nothing else, cancellation included.

/** A contract fixture as raw JSON: it is checked against the format rules by [runFixture] and [checkOutcome]. */
class Fixture(val root: JsonObject) {
    val name: String get() = root["name"].str() ?: ""

    /** `setup.kind`, or "" when absent. */
    val kind: String get() = (root["setup"] as? JsonObject)?.get("kind").str() ?: ""
}

/** An error a run reported: a `guardrails` error kind, or a provider error kind in `guarded` fixtures. */
data class FixtureError(val kind: String)

/** One run of a `guarded` fixture: its result or error, the requests its provider recorded and its classifier inputs. */
class GuardedRun(
    val result: GuardedResult?,
    val error: FixtureError?,
    val requests: List<CompletionRequest>,
    val classifierInputs: List<String>?,
)

/** The second run of a `guarded` fixture: `GuardedProvider.complete`. */
class WrappedRun(val run: GuardedRun, val id: String, val response: CompletionResponse?, val lastReport: GuardedResult?)

/** The `pii` and `injection` metrics of an `eval` fixture. */
data class EvalOutcome(val pii: Metrics, val injection: Metrics)

/** What a run produced: [error] when the library failed; otherwise the field of the fixture's kind. */
class FixtureOutcome(
    val kind: String,
    val error: FixtureError? = null,
    val findings: List<PiiFinding>? = null,
    val redacted: Redacted? = null,
    val restored: String? = null,
    val injection: InjectionResult? = null,
    val check: CheckResult? = null,
    val valid: Boolean = false,
    val guarded: GuardedRun? = null,
    val wrapped: WrappedRun? = null,
    val messages: List<Message>? = null,
    val metrics: Metrics? = null,
    val eval: EvalOutcome? = null,
    val table: JsonObject? = null,
    val classifierInputs: List<String>? = null,
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
private fun JsonElement?.integer(): Int? {
    val d = number() ?: return null
    if (d.isNaN() || d.isInfinite() || d % 1.0 != 0.0) return null
    if (d < Int.MIN_VALUE.toDouble() || d > Int.MAX_VALUE.toDouble()) return null
    return d.toInt()
}

private fun JsonElement?.bool(): Boolean? = when ((this as? JsonPrimitive)?.takeIf { it !is JsonNull && !it.isString }?.content) {
    "true" -> true
    "false" -> false
    else -> null
}

private fun keys(o: JsonObject, allowed: Set<String>, required: Set<String> = emptySet()) {
    val unknown = o.keys.firstOrNull { it !in allowed }
    if (unknown != null) invalid("unknown key: $unknown")
    val missing = required.firstOrNull { it !in o }
    if (missing != null) invalid("missing key: $missing")
}

private fun wrongType(key: String): Nothing = invalid("wrong type: $key")

private fun obj(key: String, el: JsonElement?): JsonObject = el as? JsonObject ?: wrongType(key)

private fun arr(key: String, el: JsonElement?): JsonArray = el as? JsonArray ?: wrongType(key)

private fun string(key: String, el: JsonElement?): String = el.str() ?: wrongType(key)

private fun int(key: String, el: JsonElement?): Int = el.integer() ?: wrongType(key)

// ---- format ---------------------------------------------------------------------------------------------------------

private val TOP_LEVEL_KEYS = setOf("name", "setup", "expect")

private class KindKeys(val required: Set<String>, val optional: Set<String> = emptySet()) {
    val all: Set<String> get() = required + optional
}

private val SETUP_KEYS: Map<String, KindKeys> = mapOf(
    "pii" to KindKeys(setOf("kind", "text"), setOf("kinds")),
    "redact" to KindKeys(setOf("kind", "text"), setOf("kinds", "mapping")),
    "restore" to KindKeys(setOf("kind", "text", "mapping")),
    "injection" to KindKeys(setOf("kind", "text")),
    "check" to KindKeys(setOf("kind", "text", "checks"), setOf("mapping", "classifier")),
    "policy" to KindKeys(setOf("kind", "policy")),
    "guarded" to KindKeys(setOf("kind", "request", "policy", "provider"), setOf("classifier", "blockedText")),
    "canary" to KindKeys(setOf("kind", "messages", "canary")),
    "metrics" to KindKeys(setOf("kind", "expected", "found")),
    "eval" to KindKeys(setOf("kind", "samples")),
    "table" to KindKeys(setOf("kind")),
)

private val TABLE_KEYS = setOf(
    "piiKinds", "placeholderNames", "secretPrefixes", "dniLetters", "canaryPrefix", "canarySuffix",
    "canaryWhitespace", "defaultBlockedText", "metricKinds", "injection",
)

private val EXPECT_KEYS: Map<String, KindKeys> = mapOf(
    "pii" to KindKeys(setOf("findings")),
    "redact" to KindKeys(setOf("text", "mapping")),
    "restore" to KindKeys(setOf("text")),
    "injection" to KindKeys(setOf("score", "signals")),
    "check" to KindKeys(setOf("verdict", "text", "mapping", "findings"), setOf("classifierInputs")),
    "policy" to KindKeys(setOf("valid")),
    "guarded" to KindKeys(
        setOf("status", "input", "calls", "mapping", "outputMapping", "reply"),
        setOf("text", "sent", "output", "classifierInputs"),
    ),
    "canary" to KindKeys(setOf("messages")),
    "metrics" to KindKeys(setOf("precision", "recall", "f1", "byKind")),
    "eval" to KindKeys(setOf("pii", "injection")),
    "table" to KindKeys(TABLE_KEYS),
)

private const val PROVIDER_ID = "mock"

private val PROVIDER_ERROR_KINDS: Map<String, ErrorKind> = ErrorKind.entries.associateBy { it.wire }

private val ROLES: Map<String, Role> = mapOf("system" to Role.SYSTEM, "user" to Role.USER, "assistant" to Role.ASSISTANT)

private class Checked(val kind: String, val setup: JsonObject, val expect: JsonObject, val expectsError: Boolean)

private fun checkMessages(key: String, el: JsonElement?): List<Message> = arr(key, el).map { m ->
    val o = obj(key, m)
    keys(o, setOf("role", "content"), setOf("role", "content"))
    val role = ROLES[string("role", o["role"])] ?: wrongType("role")
    Message(role, string("content", o["content"]))
}

private fun checkMapping(el: JsonElement?): Mapping = arr("mapping", el).map { pair ->
    val p = pair as? JsonArray ?: wrongType("mapping")
    if (p.size != 2) wrongType("mapping")
    string("mapping", p[0]) to string("mapping", p[1])
}

private fun checkSpans(key: String, el: JsonElement?): List<MetricSpan> = arr(key, el).map { s ->
    val o = obj(key, s)
    keys(o, setOf("kind", "start", "end"), setOf("kind", "start", "end"))
    MetricSpan(string("kind", o["kind"]), int("start", o["start"]), int("end", o["end"]))
}

private fun checkScript(el: JsonElement?): List<JsonObject> {
    val o = obj("script", el)
    keys(o, setOf("script"), setOf("script"))
    return arr("script", o["script"]).map { obj("script", it) }
}

private fun parseProviderScript(el: JsonElement?): List<ScriptEntry> =
    checkScript(el).mapIndexed { i, o ->
        val n = i + 1
        val response = o["response"]
        val error = o["error"]
        if (response == null && error == null) invalid("script entry $n of provider $PROVIDER_ID has neither response nor error")
        keys(o, setOf("response", "error"))
        if (response != null) string("response", response)
        val scriptError = error?.let {
            val eo = obj("error", it)
            keys(eo, setOf("kind", "retryAfterMs"), setOf("kind"))
            val name = string("kind", eo["kind"])
            val kind = PROVIDER_ERROR_KINDS[name] ?: invalid("unknown provider error kind: $name")
            val retry = if ("retryAfterMs" in eo) {
                val d = eo["retryAfterMs"].number() ?: wrongType("retryAfterMs")
                if (d.isNaN() || d.isInfinite() || d % 1.0 != 0.0) wrongType("retryAfterMs")
                d.toLong()
            } else {
                null
            }
            ScriptError(kind, retry)
        }
        ScriptEntry(response.str(), scriptError)
    }

private fun parseClassifierScript(el: JsonElement?): List<Classification> =
    checkScript(el).map { o ->
        keys(o, setOf("flagged", "label"), setOf("flagged"))
        val flagged = o["flagged"].bool() ?: wrongType("flagged")
        Classification(flagged, if ("label" in o) string("label", o["label"]) else null)
    }

private fun checkSamples(el: JsonElement?) {
    arr("samples", el).forEach { s ->
        val o = obj("samples", s)
        keys(o, setOf("text", "expected"), setOf("text", "expected"))
        val length = codePointLength(string("text", o["text"]))
        for (span in checkSpans("expected", o["expected"])) {
            if (span.start < 0 || span.end < span.start || span.end > length) invalid("span outside sample text")
        }
    }
}

private fun checkSetup(kind: String, setup: JsonObject) {
    val spec = SETUP_KEYS[kind] ?: invalid("unknown setup kind: $kind")
    keys(setup, spec.all, spec.required)
    if ("text" in setup) string("text", setup["text"])
    if ("canary" in setup) string("canary", setup["canary"])
    if ("blockedText" in setup) string("blockedText", setup["blockedText"])
    if ("kinds" in setup) arr("kinds", setup["kinds"]).forEach { string("kinds", it) }
    if ("mapping" in setup) checkMapping(setup["mapping"])
    if ("messages" in setup) checkMessages("messages", setup["messages"])
    if ("expected" in setup) checkSpans("expected", setup["expected"])
    if ("found" in setup) checkSpans("found", setup["found"])
    if ("samples" in setup) checkSamples(setup["samples"])
    if ("request" in setup) {
        val request = obj("request", setup["request"])
        keys(request, setOf("messages"), setOf("messages"))
        checkMessages("messages", request["messages"])
    }
    if ("provider" in setup) parseProviderScript(setup["provider"])
    if ("classifier" in setup) parseClassifierScript(setup["classifier"])
}

private fun checkExpect(kind: String, setup: JsonObject, expect: JsonObject): Boolean {
    val spec = EXPECT_KEYS.getValue(kind)
    val classifierInputs = if (kind == "check" || kind == "guarded") "classifierInputs" in expect else false
    val hasError = "error" in expect
    if (hasError) {
        val extra = if (kind == "guarded") setOf("calls", "sent", "classifierInputs") else if (kind == "check") setOf("classifierInputs") else emptySet()
        keys(expect, setOf("error") + extra, if (kind == "guarded") setOf("error", "calls") else setOf("error"))
        val error = obj("error", expect["error"])
        keys(error, setOf("kind"), setOf("kind"))
        string("kind", error["kind"])
    } else {
        if (!spec.required.all { it in expect }) invalid("expect has neither the keys of its kind nor error")
        keys(expect, spec.all, spec.required)
    }
    if (kind == "check" || kind == "guarded") {
        val hasClassifier = "classifier" in setup
        if (hasClassifier && !classifierInputs) invalid("missing key: classifierInputs")
        if (!hasClassifier && classifierInputs) invalid("unknown key: classifierInputs")
    }
    return hasError
}

private fun checkFixture(fixture: Fixture): Checked {
    val root = fixture.root
    keys(root, TOP_LEVEL_KEYS, TOP_LEVEL_KEYS)
    string("name", root["name"])
    val setup = obj("setup", root["setup"])
    if ("kind" !in setup) invalid("missing key: kind")
    val kind = string("kind", setup["kind"])
    checkSetup(kind, setup)
    val expect = obj("expect", root["expect"])
    val expectsError = checkExpect(kind, setup, expect)
    return Checked(kind, setup, expect, expectsError)
}

private fun codePointLength(text: String): Int {
    var count = 0
    var i = 0
    while (i < text.length) {
        i += if (text[i].code in 0xD800..0xDBFF && i + 1 < text.length && text[i + 1].code in 0xDC00..0xDFFF) 2 else 1
        count++
    }
    return count
}

// ---- conversions from the checked raw JSON ----------------------------------------------------------------------------

private fun mappingOf(el: JsonElement?): Mapping = checkMapping(el)

private fun messagesOf(el: JsonElement?): List<Message> = checkMessages("messages", el)

private fun spansOf(el: JsonElement?): List<MetricSpan> = checkSpans("expected", el)

private fun kindsOf(setup: JsonObject) = if ("kinds" in setup) arr("kinds", setup["kinds"]).map { parsePiiKind(it.str()) } else null

private fun policyOf(setup: JsonObject) = parsePolicy(setup["policy"] ?: JsonNull)

// ---- run ------------------------------------------------------------------------------------------------------------

/** The fixture classifier: call N (1-based) answers `script[N-1]` whatever the text, and records the text. */
private class ScriptClassifier(private val script: List<Classification>) : Classifier {
    val inputs = mutableListOf<String>()

    override suspend fun classify(text: String): Classification {
        inputs += text
        return script.getOrNull(inputs.size - 1) ?: invalid("classifier script exhausted")
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

private fun classifierOf(setup: JsonObject): ScriptClassifier? = setup["classifier"]?.let { ScriptClassifier(parseClassifierScript(it)) }

private suspend fun <T> libraryCall(block: suspend () -> T): Pair<T?, FixtureError?> = try {
    block() to null
} catch (e: GuardrailException) {
    null to FixtureError(e.kind.wire)
} catch (e: ProviderException) {
    null to FixtureError(e.kind.wire)
}

private suspend fun runGuarded(setup: JsonObject): Pair<GuardedRun, WrappedRun> {
    val script = parseProviderScript(setup["provider"])
    val request = CompletionRequest(messagesOf((setup["request"] as JsonObject)["messages"]))
    val blockedText = if ("blockedText" in setup) string("blockedText", setup["blockedText"]) else DEFAULT_BLOCKED_TEXT

    val provider1 = Recorder(MockProvider(PROVIDER_ID, script))
    val classifier1 = classifierOf(setup)
    val (result, error1) = libraryCall { guardedComplete(provider1, request, policyOf(setup), classifier1) }
    val direct = GuardedRun(result, error1, provider1.requests.toList(), classifier1?.inputs?.toList())

    val provider2 = Recorder(MockProvider(PROVIDER_ID, script))
    val classifier2 = classifierOf(setup)
    var wrapper: GuardedProvider? = null
    val (response, error2) = libraryCall {
        val gp = GuardedProvider(provider2, policyOf(setup), classifier2, blockedText)
        wrapper = gp
        gp.complete(request)
    }
    val second = GuardedRun(null, error2, provider2.requests.toList(), classifier2?.inputs?.toList())
    return direct to WrappedRun(second, wrapper?.id ?: PROVIDER_ID, response, wrapper?.lastReport)
}

private fun shifted(spans: List<MetricSpan>, base: Int) = spans.map { it.copy(start = it.start + base, end = it.end + base) }

private fun runEval(setup: JsonObject): EvalOutcome {
    val expectedPii = mutableListOf<MetricSpan>()
    val expectedInjection = mutableListOf<MetricSpan>()
    val foundPii = mutableListOf<MetricSpan>()
    val foundInjection = mutableListOf<MetricSpan>()
    var base = 0
    for (s in arr("samples", setup["samples"])) {
        val o = s as JsonObject
        val text = string("text", o["text"])
        for (span in shifted(spansOf(o["expected"]), base)) if (span.kind in PII_KINDS) expectedPii += span else expectedInjection += span
        for (f in detectPii(text)) foundPii += MetricSpan(f.kind.wire, f.start + base, f.end + base)
        for (sig in detectInjection(text).signals) foundInjection += MetricSpan(sig.category.wire, sig.start + base, sig.end + base)
        base += codePointLength(text) + 1
    }
    return EvalOutcome(detectionMetrics(expectedPii, foundPii), detectionMetrics(expectedInjection, foundInjection))
}

private fun tableJson(): JsonObject = buildJsonObject {
    putJsonArray("piiKinds") { PII_KINDS.forEach { add(JsonPrimitive(it)) } }
    put("placeholderNames", buildJsonArray { PLACEHOLDER_NAMES.forEach { (k, n) -> add(buildJsonArray { add(JsonPrimitive(k)); add(JsonPrimitive(n)) }) } })
    putJsonArray("secretPrefixes") { SECRET_PREFIXES.forEach { add(JsonPrimitive(it)) } }
    put("dniLetters", DNI_LETTERS)
    put("canaryPrefix", CANARY_PREFIX)
    put("canarySuffix", CANARY_SUFFIX)
    putJsonArray("canaryWhitespace") { CANARY_WHITESPACE.forEach { add(JsonPrimitive(it)) } }
    put("defaultBlockedText", DEFAULT_BLOCKED_TEXT)
    putJsonArray("metricKinds") { METRIC_KINDS.forEach { add(JsonPrimitive(it)) } }
    put(
        "injection",
        buildJsonArray {
            for (e in INJECTION_TABLE) add(
                buildJsonObject {
                    put("id", e.id)
                    put("category", e.category.wire)
                    put("weight", e.weight)
                    when (e) {
                        is InjectionEntry.Tokens -> {
                            put("maxGap", e.maxGap)
                            put("anchors", buildJsonArray { e.anchors.forEach { a -> add(buildJsonArray { a.forEach { add(JsonPrimitive(it)) } }) } })
                        }
                        is InjectionEntry.Delimiter -> {
                            put("literal", e.literal)
                            put("lineStart", e.lineStart)
                        }
                    }
                },
            )
        },
    )
}

private suspend fun runSetup(kind: String, setup: JsonObject): FixtureOutcome = when (kind) {
    "pii" -> FixtureOutcome(kind, findings = detectPii(string("text", setup["text"]), kindsOf(setup)))
    "redact" -> {
        val text = string("text", setup["text"])
        FixtureOutcome(kind, redacted = redact(text, detectPii(text, kindsOf(setup)), if ("mapping" in setup) mappingOf(setup["mapping"]) else emptyList()))
    }
    "restore" -> FixtureOutcome(kind, restored = restore(string("text", setup["text"]), mappingOf(setup["mapping"])))
    "injection" -> FixtureOutcome(kind, injection = detectInjection(string("text", setup["text"])))
    "check" -> {
        val classifier = classifierOf(setup)
        // an invalid `checks` list is the library's invalid_policy; the classifier inputs are then `[]` (never called)
        val (result, error) = libraryCall {
            val checks = parsePolicy(buildJsonObject { put("input", JsonArray(emptyList())); put("output", setup["checks"] ?: JsonNull) }).output
            val mapping = if ("mapping" in setup) mappingOf(setup["mapping"]) else emptyList()
            checkText(string("text", setup["text"]), checks, mapping, classifier)
        }
        FixtureOutcome(kind, error = error, check = result, classifierInputs = classifier?.inputs?.toList())
    }
    "policy" -> {
        parsePolicy(setup["policy"] ?: JsonNull)
        FixtureOutcome(kind, valid = true)
    }
    "guarded" -> {
        val (direct, wrapped) = runGuarded(setup)
        FixtureOutcome(kind, error = direct.error, guarded = direct, wrapped = wrapped)
    }
    "canary" -> FixtureOutcome(kind, messages = withCanary(messagesOf(setup["messages"]), string("canary", setup["canary"])))
    "metrics" -> FixtureOutcome(kind, metrics = detectionMetrics(spansOf(setup["expected"]), checkSpans("found", setup["found"])))
    "eval" -> FixtureOutcome(kind, eval = runEval(setup))
    else -> FixtureOutcome(kind, table = tableJson()) // table
}

/**
 * Runs a contract fixture against `guardrails`: checks its format (`invalid fixture: <reason>` as an
 * IllegalStateException), builds what the setup describes and calls the library. A `GuardrailException` (and, in
 * `guarded` fixtures, a `ProviderException`) is reported as an error; nothing else is caught.
 */
suspend fun runFixture(fixture: Fixture): FixtureOutcome {
    val checked = checkFixture(fixture)
    val kind = checked.kind
    return try {
        runSetup(kind, checked.setup)
    } catch (e: GuardrailException) {
        FixtureOutcome(kind, error = FixtureError(e.kind.wire))
    }
}

// ---- JSON of the actual results ---------------------------------------------------------------------------------------

private fun findingJson(f: PiiFinding): JsonElement = buildJsonObject {
    put("kind", f.kind.wire)
    put("start", f.start)
    put("end", f.end)
    put("text", f.text)
}

private fun mappingJson(m: Mapping): JsonElement = buildJsonArray { m.forEach { (a, b) -> add(buildJsonArray { add(JsonPrimitive(a)); add(JsonPrimitive(b)) }) } }

private fun signalJson(s: InjectionSignal): JsonElement = buildJsonObject {
    put("id", s.id)
    put("category", s.category.wire)
    put("start", s.start)
    put("end", s.end)
}

private fun detailsJson(d: CheckDetails): JsonElement = buildJsonObject {
    when (d) {
        is CheckDetails.PiiDetails -> put("findings", buildJsonArray { d.findings.forEach { add(findingJson(it)) } })
        is CheckDetails.InjectionDetails -> {
            put("score", d.score)
            put("signals", buildJsonArray { d.signals.forEach { add(signalJson(it)) } })
        }
        is CheckDetails.DenyTermsDetails -> put(
            "matches",
            buildJsonArray { d.matches.forEach { add(buildJsonObject { put("term", it.term); put("start", it.start); put("end", it.end) }) } },
        )
        is CheckDetails.MaxLengthDetails -> put("length", d.length)
        is CheckDetails.CanaryDetails -> put("found", d.found)
        is CheckDetails.ClassifierDetails -> {
            put("flagged", d.flagged)
            if (d.label != null) put("label", d.label)
        }
    }
}

private fun checkFindingJson(f: CheckFinding): JsonElement = buildJsonObject {
    put("check", f.check)
    put("kind", f.kind.wire)
    put("action", f.action.wire)
    put("fired", f.fired)
    put("details", detailsJson(f.details))
}

private fun checkFindingsJson(list: List<CheckFinding>): JsonElement = buildJsonArray { list.forEach { add(checkFindingJson(it)) } }

private fun messagesJson(list: List<Message>): JsonElement = buildJsonArray {
    list.forEach { m -> add(buildJsonObject { put("role", ROLES.entries.first { it.value == m.role }.key); put("content", m.content) }) }
}

private fun metricsJson(m: Metrics): JsonObject = buildJsonObject {
    put("precision", m.precision)
    put("recall", m.recall)
    put("f1", m.f1)
    put(
        "byKind",
        buildJsonArray {
            for (k in m.byKind) add(
                buildJsonObject {
                    put("kind", k.kind)
                    put("precision", k.precision)
                    put("recall", k.recall)
                    put("f1", k.f1)
                    put("expected", k.expected)
                    put("found", k.found)
                    put("correct", k.correct)
                },
            )
        },
    )
}

private fun guardedJson(r: GuardedResult): JsonObject = buildJsonObject {
    put("status", r.status.wire)
    if (r.text != null) put("text", r.text)
    if (r.sent != null) put("sent", messagesJson(r.sent))
    put("input", buildJsonArray { r.input.forEach { add(checkFindingsJson(it)) } })
    if (r.output != null) put("output", checkFindingsJson(r.output))
    put("calls", r.calls)
    put("mapping", mappingJson(r.mapping))
    put("outputMapping", mappingJson(r.outputMapping))
}

// ---- checks ---------------------------------------------------------------------------------------------------------

/** Deep equality of JSON values: strings unit by unit, numbers by VALUE (`1` equals `1.0`), objects by key set. */
private fun same(want: JsonElement?, got: JsonElement?): Boolean = when {
    want is JsonObject && got is JsonObject -> want.keys == got.keys && want.all { (k, v) -> same(v, got[k]) }
    want is JsonArray && got is JsonArray -> want.size == got.size && want.indices.all { same(want[it], got[it]) }
    want is JsonNull || got is JsonNull -> want is JsonNull && got is JsonNull
    want is JsonPrimitive && got is JsonPrimitive -> when {
        want.isString || got.isString -> want.isString && got.isString && want.content == got.content
        else -> {
            val a = want.doubleOrNull
            val b = got.doubleOrNull
            if (a != null && b != null) a == b else want.content == got.content
        }
    }
    else -> false
}

private fun compare(key: String, want: JsonElement?, got: JsonElement?, out: MutableList<String>) {
    if (!same(want, got)) out += "$key: expected <$want> but was <$got>"
}

private fun sameRequest(want: List<Message>, got: CompletionRequest) = got == CompletionRequest(want)

private fun checkGuardedRun(name: String, run: GuardedRun, expect: JsonObject, calls: Int?, out: MutableList<String>) {
    if (calls != run.requests.size) out += "$name: calls: expected <$calls> but ${run.requests.size} request(s) were recorded"
    val sent = expect["sent"]
    if (sent == null) {
        if (run.requests.isNotEmpty()) out += "$name: no request expected but ${run.requests.size} recorded"
    } else {
        val want = messagesOf(sent)
        if (run.requests.size != 1 || !sameRequest(want, run.requests[0])) out += "$name: request: expected exactly <${CompletionRequest(want)}> but was <${run.requests}>"
    }
    val inputs = expect["classifierInputs"]
    if (inputs != null) {
        val got = run.classifierInputs
        compare("$name: classifierInputs", inputs, got?.let { list -> buildJsonArray { list.forEach { add(JsonPrimitive(it)) } } }, out)
    }
}

private fun checkGuarded(expect: JsonObject, outcome: FixtureOutcome, expectsError: Boolean, out: MutableList<String>) {
    val direct = outcome.guarded ?: GuardedRun(null, outcome.error, emptyList(), null)
    val wrapped = outcome.wrapped
    val calls = expect["calls"].integer()
    if (expectsError) {
        val want = (expect["error"] as JsonObject)["kind"].str()
        if (direct.error?.kind != want) out += "guardedComplete: error kind: expected <$want> but was <${direct.error?.kind}>"
        if (wrapped != null && wrapped.run.error?.kind != want) out += "GuardedProvider: error kind: expected <$want> but was <${wrapped.run.error?.kind}>"
        checkGuardedRun("guardedComplete", direct, expect, calls, out)
        if (wrapped != null) checkGuardedRun("GuardedProvider", wrapped.run, expect, calls, out)
        return
    }
    val result = direct.result
    if (result == null) {
        out += "guarded: no result"
        return
    }
    val actual = guardedJson(result)
    for (key in listOf("text", "sent", "output")) if ((key in expect) != (key in actual)) out += "$key: expected ${if (key in expect) "present" else "absent"} but was ${if (key in actual) "present" else "absent"}"
    for ((key, value) in expect) if (key != "reply" && key != "classifierInputs") compare(key, value, actual[key], out)
    checkGuardedRun("guardedComplete", direct, expect, result.calls, out)
    if (wrapped == null) {
        out += "GuardedProvider: no run"
        return
    }
    checkGuardedRun("GuardedProvider", wrapped.run, expect, result.calls, out)
    if (wrapped.id != PROVIDER_ID) out += "GuardedProvider: id: expected <$PROVIDER_ID> but was <${wrapped.id}>"
    val response = wrapped.response
    if (response == null) {
        out += "GuardedProvider: no response (error <${wrapped.run.error?.kind}>)"
    } else {
        if (response.provider != PROVIDER_ID) out += "GuardedProvider: provider: expected <$PROVIDER_ID> but was <${response.provider}>"
        if (response.text != expect["reply"].str()) out += "GuardedProvider: reply: expected <${expect["reply"].str()}> but was <${response.text}>"
    }
    if (wrapped.lastReport != result) out += "GuardedProvider: lastReport differs from the guardedComplete result"
}

/**
 * Compares an outcome with the fixture's expectation per the contract's comparison rules. Returns every failing check;
 * an empty list means the fixture passed. A malformed fixture fails with `invalid fixture: <reason>`.
 */
fun checkOutcome(fixture: Fixture, outcome: FixtureOutcome): List<String> {
    val checked = checkFixture(fixture)
    val expect = checked.expect
    val out = mutableListOf<String>()
    val kind = checked.kind

    if (kind == "guarded") {
        if (!checked.expectsError && outcome.error != null && outcome.guarded?.result == null) {
            out += "unexpected error <${outcome.error.kind}>"
            return out
        }
        checkGuarded(expect, outcome, checked.expectsError, out)
        return out
    }
    if (checked.expectsError) {
        val want = (expect["error"] as JsonObject)["kind"].str()
        val got = outcome.error
        if (got == null) out += "expected error <$want> but the run succeeded" else if (want != got.kind) out += "error kind: expected <$want> but was <${got.kind}>"
        if (kind == "check") checkInputs(expect, outcome, out)
        return out
    }
    val error = outcome.error
    if (error != null) {
        out += "unexpected error <${error.kind}>"
        return out
    }
    when (kind) {
        "pii" -> compare("findings", expect["findings"], buildJsonArray { outcome.findings.orEmpty().forEach { add(findingJson(it)) } }, out)
        "redact" -> {
            compare("text", expect["text"], outcome.redacted?.text?.let { JsonPrimitive(it) }, out)
            compare("mapping", expect["mapping"], outcome.redacted?.let { mappingJson(it.mapping) }, out)
        }
        "restore" -> compare("text", expect["text"], outcome.restored?.let { JsonPrimitive(it) }, out)
        "injection" -> {
            val r = outcome.injection
            compare("score", expect["score"], r?.let { JsonPrimitive(it.score) }, out)
            compare("signals", expect["signals"], r?.let { x -> buildJsonArray { x.signals.forEach { add(signalJson(it)) } } }, out)
        }
        "check" -> {
            val r = outcome.check
            compare("verdict", expect["verdict"], r?.let { JsonPrimitive(it.verdict.wire) }, out)
            compare("text", expect["text"], r?.let { JsonPrimitive(it.text) }, out)
            compare("mapping", expect["mapping"], r?.let { mappingJson(it.mapping) }, out)
            compare("findings", expect["findings"], r?.let { checkFindingsJson(it.findings) }, out)
            checkInputs(expect, outcome, out)
        }
        "policy" -> if (expect["valid"].bool() != outcome.valid) out += "valid: expected <${expect["valid"]}> but was <${outcome.valid}>"
        "canary" -> compare("messages", expect["messages"], outcome.messages?.let { messagesJson(it) }, out)
        "metrics" -> {
            val got = outcome.metrics?.let { metricsJson(it) }
            for (key in listOf("precision", "recall", "f1", "byKind")) compare(key, expect[key], got?.get(key), out)
        }
        "eval" -> {
            val got = outcome.eval
            compare("pii", expect["pii"], got?.let { metricsJson(it.pii) }, out)
            compare("injection", expect["injection"], got?.let { metricsJson(it.injection) }, out)
        }
        else -> compare("table", expect, outcome.table, out)
    }
    return out
}

private fun checkInputs(expect: JsonObject, outcome: FixtureOutcome, out: MutableList<String>) {
    val want = expect["classifierInputs"] ?: return
    compare("classifierInputs", want, outcome.classifierInputs?.let { list -> buildJsonArray { list.forEach { add(JsonPrimitive(it)) } } }, out)
}
