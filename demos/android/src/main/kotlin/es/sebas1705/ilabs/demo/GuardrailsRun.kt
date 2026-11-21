package es.sebas1705.ilabs.demo

import es.sebas1705.ilabs.guardrails.Check
import es.sebas1705.ilabs.guardrails.CheckResult
import es.sebas1705.ilabs.guardrails.GuardrailException
import es.sebas1705.ilabs.guardrails.InjectionResult
import es.sebas1705.ilabs.guardrails.METRIC_KINDS
import es.sebas1705.ilabs.guardrails.MetricSpan
import es.sebas1705.ilabs.guardrails.Metrics
import es.sebas1705.ilabs.guardrails.PiiFinding
import es.sebas1705.ilabs.guardrails.PiiKind
import es.sebas1705.ilabs.guardrails.Redacted
import es.sebas1705.ilabs.guardrails.checkText
import es.sebas1705.ilabs.guardrails.contract.Fixture
import es.sebas1705.ilabs.guardrails.contract.FixtureOutcome
import es.sebas1705.ilabs.guardrails.contract.GuardedRun
import es.sebas1705.ilabs.guardrails.detectInjection
import es.sebas1705.ilabs.guardrails.detectPii
import es.sebas1705.ilabs.guardrails.parsePolicy
import es.sebas1705.ilabs.guardrails.redact
import es.sebas1705.ilabs.providers.Message
import es.sebas1705.ilabs.providers.Role
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Nothing in this file scans, matches, scores or validates: every result comes from the library. The only computation
// of the demo is the span-equality marking of the Measure section and the text slicing that draws the highlights.

/** Playground sample groups, in display order; the group comes from the start of the fixture name. */
enum class GuardrailsGroup(val prefix: String) {
    PII("pii-"),
    INJECTION("injection-"),
    CHECKS("check-"),
    ;

    companion object {
        /** The group of a fixture name, or null for fixtures the playground does not offer (`policy-*`, `guarded-*`, ...). */
        fun of(name: String): GuardrailsGroup? = entries.firstOrNull { name.startsWith(it.prefix) }
    }
}

/** What a check does when it fires; the toggles of the policy card pick one per check (`OFF` leaves the check out). */
enum class ControlAction(val wire: String?) {
    OFF(null),
    FLAG("flag"),
    REDACT("redact"),
    BLOCK("block"),
    ;

    companion object {
        fun ofWire(wire: String?): ControlAction? = entries.firstOrNull { it.wire != null && it.wire == wire }
        fun ofName(name: String?): ControlAction? = entries.firstOrNull { it.name == name }
    }
}

internal const val DEFAULT_THRESHOLD = "50"
internal const val DEFAULT_MAX_LENGTH = "500"

/**
 * The policy toggles. The numbers and the terms are the raw text of their fields: nothing is parsed or clamped here,
 * so an invalid value reaches `parsePolicy` and the library names what is wrong.
 */
data class PolicyControls(
    val piiAction: ControlAction = ControlAction.REDACT,
    val piiKinds: Set<PiiKind> = PiiKind.entries.toSet(),
    val injectionAction: ControlAction = ControlAction.FLAG,
    val injectionThreshold: String = DEFAULT_THRESHOLD,
    val denyAction: ControlAction = ControlAction.OFF,
    val denyTerms: String = "",
    val maxAction: ControlAction = ControlAction.OFF,
    val maxLength: String = DEFAULT_MAX_LENGTH,
) {
    /** The kinds to scan: null (all) when every kind is selected. An empty selection is the library's `invalid_options`. */
    val scanKinds: List<PiiKind>?
        get() = if (piiKinds.size == PiiKind.entries.size) null else PiiKind.entries.filter { it in piiKinds }
}

private val CHECK_ORDER = listOf("pii", "injection", "denyTerms", "maxLength")

/** A number field as JSON: a number when it reads as one, else the text itself (the library then rejects it). */
private fun numberOrText(raw: String): JsonPrimitive {
    val text = raw.trim()
    return text.toLongOrNull()?.let { JsonPrimitive(it) } ?: text.toDoubleOrNull()?.let { JsonPrimitive(it) } ?: JsonPrimitive(raw)
}

private fun termsOf(raw: String): List<String> = if (raw.isBlank()) emptyList() else raw.split(',').map { it.trim() }.filter { it.isNotEmpty() }

/** The policy the toggles describe, as the JSON `parsePolicy` takes: the enabled checks, in the order of the card. */
internal fun policyJson(c: PolicyControls): JsonObject = buildJsonObject {
    put("input", JsonArray(emptyList()))
    put(
        "output",
        buildJsonArray {
            c.piiAction.wire?.let { action ->
                add(
                    buildJsonObject {
                        put("kind", "pii")
                        put("action", action)
                        if (c.piiKinds.size != PiiKind.entries.size) {
                            put("kinds", buildJsonArray { PiiKind.entries.filter { it in c.piiKinds }.forEach { add(JsonPrimitive(it.wire)) } })
                        }
                    },
                )
            }
            c.injectionAction.wire?.let { action ->
                add(buildJsonObject { put("kind", "injection"); put("action", action); put("threshold", numberOrText(c.injectionThreshold)) })
            }
            c.denyAction.wire?.let { action ->
                add(buildJsonObject { put("kind", "denyTerms"); put("action", action); put("terms", buildJsonArray { termsOf(c.denyTerms).forEach { add(JsonPrimitive(it)) } }) })
            }
            c.maxAction.wire?.let { action ->
                add(buildJsonObject { put("kind", "maxLength"); put("action", action); put("max", numberOrText(c.maxLength)) })
            }
        },
    )
}

// ---- reading a sample -----------------------------------------------------------------------------------------------

private fun JsonElement?.string(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun JsonElement?.obj(): JsonObject? = this as? JsonObject

private fun JsonElement?.array(): JsonArray? = this as? JsonArray

/** The text and the starting toggles of a playground sample; [partial] when the toggles cannot show all of its checks. */
internal class SampleSetup(val text: String, val controls: PolicyControls, val partial: Boolean)

/** The kinds a `kinds` list names (unknown names dropped, duplicates merged), and whether that changed the list. */
private fun kindsOf(el: JsonElement?): Pair<Set<PiiKind>, Boolean>? {
    val list = el.array() ?: return null
    val kinds = list.mapNotNull { item -> PiiKind.entries.firstOrNull { it.wire == item.string() } }.toSet()
    return kinds to (kinds.size != list.size)
}

/** Loads the first check of each of the four offered kinds into the toggles; anything else sets `partial`. */
internal fun controlsOfChecks(setup: JsonObject): Pair<PolicyControls, Boolean> {
    var controls = PolicyControls(piiAction = ControlAction.OFF, injectionAction = ControlAction.OFF)
    var partial = setup["classifier"] != null || (setup["mapping"].array()?.isNotEmpty() == true)
    val seen = mutableSetOf<String>()
    var lastOrder = -1
    for (el in setup["checks"].array().orEmpty()) {
        val check = el.obj()
        val kind = check?.get("kind").string()
        val action = ControlAction.ofWire(check?.get("action").string())
        val order = CHECK_ORDER.indexOf(kind)
        if (check == null || kind == null || action == null || order < 0 || kind in seen || (action == ControlAction.REDACT && kind != "pii")) {
            partial = true
            continue
        }
        seen += kind
        if (order < lastOrder) partial = true
        lastOrder = order
        controls = when (kind) {
            "pii" -> {
                val kinds = kindsOf(check["kinds"])
                if (kinds?.second == true) partial = true
                controls.copy(piiAction = action, piiKinds = kinds?.first ?: PiiKind.entries.toSet())
            }
            "injection" -> controls.copy(
                injectionAction = action,
                injectionThreshold = (check["threshold"] as? JsonPrimitive)?.content ?: DEFAULT_THRESHOLD.also { partial = true },
            )
            "denyTerms" -> {
                val terms = check["terms"].array().orEmpty().mapNotNull { it.string() }
                if (terms.any { ',' in it }) partial = true
                controls.copy(denyAction = action, denyTerms = terms.joinToString(", "))
            }
            else -> controls.copy(
                maxAction = action,
                maxLength = (check["max"] as? JsonPrimitive)?.content ?: DEFAULT_MAX_LENGTH.also { partial = true },
            )
        }
    }
    return controls to partial
}

internal fun sampleSetupOf(fixture: Fixture): SampleSetup {
    val setup = fixture.root["setup"].obj() ?: error("invalid fixture: setup must be an object")
    val text = setup["text"].string() ?: error("invalid fixture: setup.text must be a string")
    return when (fixture.kind) {
        "check" -> controlsOfChecks(setup).let { (controls, partial) -> SampleSetup(text, controls, partial) }
        "pii" -> SampleSetup(text, kindsOf(setup["kinds"])?.let { PolicyControls(piiKinds = it.first) } ?: PolicyControls(), false)
        else -> SampleSetup(text, PolicyControls(), false)
    }
}

// ---- the playground run ---------------------------------------------------------------------------------------------

/** What the playground runs: the text and the toggles. Also the key of a run: a result is applied only while it is current. */
data class PlaygroundRequest(val text: String, val controls: PolicyControls)

/** The policy of the toggles after the library looked at it: its verdict and findings, or the library's reason. */
sealed interface PolicyRun {
    data class Checked(val checks: List<Check>, val result: CheckResult) : PolicyRun

    /** [kind] is the library's error wire name and [reason] its message (`invalid policy: ...`). */
    data class Invalid(val kind: String, val reason: String) : PolicyRun
}

/** Everything one playground run produced. [piiError] is the library's reason when the kinds are not valid. */
data class PlaygroundRun(
    val findings: List<PiiFinding>,
    val piiError: String?,
    val redacted: Redacted?,
    val injection: InjectionResult,
    val policy: PolicyRun,
)

/** Runs the request through the library: `detectPii` and `redact`, `detectInjection`, then `parsePolicy` and `checkText`. */
suspend fun runPlayground(request: PlaygroundRequest): PlaygroundRun {
    val controls = request.controls
    var findings: List<PiiFinding> = emptyList()
    var redacted: Redacted? = null
    var piiError: String? = null
    try {
        findings = detectPii(request.text, controls.scanKinds)
        redacted = redact(request.text, findings)
    } catch (e: GuardrailException) {
        piiError = e.message ?: e.kind.wire
    }
    val injection = detectInjection(request.text)
    val policy = try {
        val checks = parsePolicy(policyJson(controls)).output
        PolicyRun.Checked(checks, checkText(request.text, checks))
    } catch (e: GuardrailException) {
        PolicyRun.Invalid(e.kind.wire, e.message ?: e.kind.wire)
    }
    return PlaygroundRun(findings, piiError, redacted, injection, policy)
}

// ---- highlights -----------------------------------------------------------------------------------------------------

/** Texts above this many code points are shown without per-character highlighting (the findings list stays). */
const val HIGHLIGHT_LIMIT_CODE_POINTS = 200_000

/** Every list (findings, mapping, check details) shows this many entries, then a "+N more" note. */
const val FINDINGS_LIST_LIMIT = 200

/** The first [FINDINGS_LIST_LIMIT] entries of a list and how many were left out. */
data class Capped<T>(val shown: List<T>, val more: Int)

fun <T> capEntries(list: List<T>, limit: Int = FINDINGS_LIST_LIMIT): Capped<T> = Capped(list.take(limit), (list.size - limit).coerceAtLeast(0))

/** With more findings than this the text is shown without per-character highlighting. */
const val FINDINGS_PLAIN_TEXT_LIMIT = 2_000

/** Whether a PII finding or an injection signal is drawn. */
enum class HighlightFamily { PII, INJECTION }

/** One span to draw: [kind] is a PII kind or an injection category (wire name), [detail] the signal id of an injection signal. */
data class HighlightSpan(val family: HighlightFamily, val kind: String, val start: Int, val end: Int, val detail: String? = null)

/** A stretch of the text covered by the same spans: plain when [marks] is empty, else the indexes of the covering spans. */
data class HighlightSegment(val text: String, val marks: List<Int>)

/** The spans of a playground run: its PII findings, then its injection signals. */
fun highlightSpansOf(run: PlaygroundRun): List<HighlightSpan> =
    run.findings.map { HighlightSpan(HighlightFamily.PII, it.kind.wire, it.start, it.end) } +
        run.injection.signals.map { HighlightSpan(HighlightFamily.INJECTION, it.category.wire, it.start, it.end, it.id) }

/** UTF-16 index of each code point of [text] (and the length as the last entry): a lone surrogate is one code point. */
private fun unitIndexes(text: String): IntArray {
    val units = IntArray(codePointLength(text) + 1)
    var i = 0
    var k = 0
    while (i < text.length) {
        units[k++] = i
        i += if (text[i].isHighSurrogate() && i + 1 < text.length && text[i + 1].isLowSurrogate()) 2 else 1
    }
    units[k] = text.length
    return units
}

/** The most characters of a very long text the page draws. */
const val LARGE_TEXT_PREVIEW_CHARS = 20_000

/** [text] cut to [LARGE_TEXT_PREVIEW_CHARS] characters, never inside a surrogate pair. */
fun largeTextPreview(text: String): String {
    if (text.length <= LARGE_TEXT_PREVIEW_CHARS) return text
    val cut = if (text[LARGE_TEXT_PREVIEW_CHARS - 1].isHighSurrogate()) LARGE_TEXT_PREVIEW_CHARS - 1 else LARGE_TEXT_PREVIEW_CHARS
    return text.substring(0, cut)
}

/** [sliceCodePoints] for several ranges, scanning the text once. */
fun sliceCodePointRanges(text: String, ranges: List<Pair<Int, Int>>): List<String> {
    val units = unitIndexes(text)
    val count = units.size - 1
    return ranges.map { (start, end) ->
        val a = start.coerceIn(0, count)
        text.substring(units[a], units[end.coerceIn(a, count)])
    }
}

/** The number of code points of [text]; a lone surrogate counts as one, like the library's offsets. */
fun codePointLength(text: String): Int {
    var count = 0
    var i = 0
    while (i < text.length) {
        i += if (text[i].isHighSurrogate() && i + 1 < text.length && text[i + 1].isLowSurrogate()) 2 else 1
        count++
    }
    return count
}

/** The text of the code points `[start, end)` (the library's offsets); offsets outside the text are clamped. */
fun sliceCodePoints(text: String, start: Int, end: Int): String = sliceCodePointRanges(text, listOf(start to end)).single()

/**
 * Cuts [text] at every span boundary (code-point offsets), so each segment is covered by the same spans from start to
 * end. Spans may overlap; empty spans are ignored and offsets outside the text are clamped. Joining the segments gives
 * [text] back.
 */
fun highlightSegments(text: String, spans: List<HighlightSpan>): List<HighlightSegment> {
    val units = unitIndexes(text)
    val count = units.size - 1
    val clamped = spans.map { it.start.coerceIn(0, count) to it.end.coerceIn(0, count) }
    val cuts = sortedSetOf(0, count)
    for ((s, e) in clamped) if (e > s) {
        cuts += s
        cuts += e
    }
    val bounds = cuts.toList()
    val out = ArrayList<HighlightSegment>()
    for (i in 0 until bounds.size - 1) {
        val a = bounds[i]
        val b = bounds[i + 1]
        val marks = clamped.indices.filter { clamped[it].second > clamped[it].first && clamped[it].first <= a && clamped[it].second >= b }
        out += HighlightSegment(text.substring(units[a], units[b]), marks)
    }
    return out
}

/** The visible tag after a highlighted stretch: a space, the glyph, a space and the kind label. */
fun highlightTag(glyph: String, label: String): String = " $glyph $label"

// ---- guarded conversation and measure -------------------------------------------------------------------------------

/** A `guarded` fixture as shown: the request as written, the scripted reply and the harness run, untouched. */
data class GuardedView(val request: List<Message>, val reply: String?, val run: GuardedRun)

private val ROLES = mapOf("system" to Role.SYSTEM, "user" to Role.USER, "assistant" to Role.ASSISTANT)

internal fun guardedViewOf(fixture: Fixture, outcome: FixtureOutcome): GuardedView {
    val setup = fixture.root["setup"].obj() ?: error("invalid fixture: setup must be an object")
    val messages = setup["request"].obj()?.get("messages").array().orEmpty().mapNotNull { m ->
        val o = m.obj() ?: return@mapNotNull null
        val role = ROLES[o["role"].string()] ?: return@mapNotNull null
        Message(role, o["content"].string() ?: "")
    }
    val run = outcome.guarded ?: error("invalid fixture: not a guarded run")
    // The scripted reply the single call consumed; none when no call was made or the call failed.
    val reply = if (run.result?.calls == 1) setup["provider"].obj()?.get("script").array()?.firstOrNull().obj()?.get("response").string() else null
    return GuardedView(messages, reply, run)
}

/** How a span of a labelled sample compares: expected and found, expected only, or found only. */
enum class MarkStatus { CORRECT, MISS, EXTRA }

data class SpanMark(val kind: String, val start: Int, val end: Int, val status: MarkStatus)

/**
 * The span-equality comparison of the Measure section: spans are equal when kind, start and end are, duplicates count
 * once (the set comparison of `detectionMetrics`). Sorted by position, then kind order.
 */
fun markSpans(expected: List<MetricSpan>, found: List<MetricSpan>): List<SpanMark> {
    val e = expected.toSet()
    val f = found.toSet()
    return (e + f)
        .map { s -> SpanMark(s.kind, s.start, s.end, if (s in e && s in f) MarkStatus.CORRECT else if (s in e) MarkStatus.MISS else MarkStatus.EXTRA) }
        .sortedWith(compareBy<SpanMark>({ it.start }, { it.end }, { METRIC_KINDS.indexOf(it.kind) }, { it.status.ordinal }))
}

/** One labelled sample: its text and every expected or found span, marked. */
data class MeasureSample(val text: String, val spans: List<SpanMark>)

/** The metrics the harness computed over a labelled set, and its samples with their spans marked. */
data class MeasureView(val pii: Metrics, val injection: Metrics, val samples: List<MeasureSample>)

internal fun measureViewOf(fixture: Fixture, outcome: FixtureOutcome): MeasureView {
    val eval = outcome.eval ?: error("invalid fixture: not an eval run")
    val setup = fixture.root["setup"].obj() ?: error("invalid fixture: setup must be an object")
    val samples = setup["samples"].array().orEmpty().map { s ->
        val o = s.obj() ?: error("invalid fixture: a sample must be an object")
        val text = o["text"].string() ?: error("invalid fixture: a sample needs a text")
        val expected = o["expected"].array().orEmpty().map { span ->
            val x = span.obj() ?: error("invalid fixture: a span must be an object")
            MetricSpan(
                x["kind"].string() ?: "",
                (x["start"] as? JsonPrimitive)?.content?.toIntOrNull() ?: 0,
                (x["end"] as? JsonPrimitive)?.content?.toIntOrNull() ?: 0,
            )
        }
        val found = detectPii(text).map { MetricSpan(it.kind.wire, it.start, it.end) } +
            detectInjection(text).signals.map { MetricSpan(it.category.wire, it.start, it.end) }
        MeasureSample(text, markSpans(expected, found))
    }
    return MeasureView(eval.pii, eval.injection, samples)
}
