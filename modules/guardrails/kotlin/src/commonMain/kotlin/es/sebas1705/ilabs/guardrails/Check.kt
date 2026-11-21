package es.sebas1705.ilabs.guardrails

import es.sebas1705.ilabs.rag.tokenizeSpans

/** A classifier answer: [flagged] and an optional [label]. */
data class Classification(val flagged: Boolean, val label: String? = null)

/** A text classifier, called only by classifier checks with the original text being checked. */
fun interface Classifier {
    suspend fun classify(text: String): Classification
}

/** One occurrence of a deny term: the term as written and the code-point span of the matched token run. */
data class DenyMatch(val term: String, val start: Int, val end: Int)

/** What a check found; one subtype per check kind. */
sealed interface CheckDetails {
    data class PiiDetails(val findings: List<PiiFinding>) : CheckDetails

    data class InjectionDetails(val score: Int, val signals: List<InjectionSignal>) : CheckDetails

    data class DenyTermsDetails(val matches: List<DenyMatch>) : CheckDetails

    data class MaxLengthDetails(val length: Int) : CheckDetails

    data class CanaryDetails(val found: Boolean) : CheckDetails

    data class ClassifierDetails(val flagged: Boolean, val label: String?) : CheckDetails
}

/** The outcome of check number [check] (0-based): whether it [fired] and its [details]. */
data class CheckFinding(val check: Int, val kind: CheckKind, val action: Action, val fired: Boolean, val details: CheckDetails)

enum class CheckVerdict(val wire: String) {
    ALLOW("allow"),
    BLOCK("block"),
}

/** The result of [checkText]: the verdict, the (possibly redacted) text, the extended mapping and one finding per check. */
data class CheckResult(val verdict: CheckVerdict, val text: String, val mapping: Mapping, val findings: List<CheckFinding>)

/** Whether [text] contains [needle] as a CODE POINT sequence (a lone surrogate never matches half of an astral pair). */
internal fun containsCodePoints(text: String, needle: String): Boolean {
    val t = CodePoints(text).cps
    val q = CodePoints(needle).cps
    if (q.isEmpty()) return true
    var i = 0
    while (i + q.size <= t.size) {
        var same = true
        for (k in q.indices) if (t[i + k] != q[k]) {
            same = false
            break
        }
        if (same) return true
        i++
    }
    return false
}

private fun denyMatches(text: String, terms: List<String>): List<DenyMatch> {
    val tokens = tokenizeSpans(text)
    val all = ArrayList<Pair<Int, DenyMatch>>()
    terms.forEachIndexed { x, term ->
        val parts = tokenizeSpans(term).map { it.token }
        val m = parts.size
        var i = 0
        while (i < tokens.size) {
            var occurs = m > 0 && i + m <= tokens.size
            if (occurs) for (j in 0 until m) if (tokens[i + j].token != parts[j]) {
                occurs = false
                break
            }
            if (occurs) {
                all += x to DenyMatch(term, tokens[i].start, tokens[i + m - 1].end)
                i += m
            } else {
                i++
            }
        }
    }
    return all.sortedWith(compareBy<Pair<Int, DenyMatch>> { it.second.start }.thenBy { it.first }).map { it.second }
}

/** Evaluates every check on the ORIGINAL [text], in order, without short circuit. Classifier failures propagate. */
internal suspend fun evaluateChecks(text: String, checks: List<Check>, classifier: Classifier?): List<CheckFinding> {
    val out = ArrayList<CheckFinding>()
    checks.forEachIndexed { i, check ->
        val (fired, details) = when (check) {
            is Check.Pii -> detectPii(text, check.kinds).let { it.isNotEmpty() to CheckDetails.PiiDetails(it) }
            is Check.Injection -> detectInjection(text).let { (it.score >= check.threshold) to CheckDetails.InjectionDetails(it.score, it.signals) }
            is Check.DenyTerms -> denyMatches(text, check.terms).let { it.isNotEmpty() to CheckDetails.DenyTermsDetails(it) }
            is Check.MaxLength -> codePointCount(text).let { (it > check.max) to CheckDetails.MaxLengthDetails(it) }
            is Check.Canary -> containsCodePoints(text, check.canary).let { it to CheckDetails.CanaryDetails(it) }
            is Check.Classify -> {
                val answer = requireNotNull(classifier) { "no classifier" }.classify(text)
                val fires = answer.flagged && (check.label == null || (answer.label != null && answer.label == check.label))
                fires to CheckDetails.ClassifierDetails(answer.flagged, answer.label)
            }
        }
        out += CheckFinding(i, check.kind, check.action, fired, details)
    }
    return out.toList()
}

internal fun verdictOf(findings: List<CheckFinding>): CheckVerdict =
    if (findings.any { it.fired && it.action == Action.BLOCK }) CheckVerdict.BLOCK else CheckVerdict.ALLOW

/** The PII findings of every fired `redact` check, deduplicated and resolved for overlaps; null when none fired. */
internal fun redactionFindings(findings: List<CheckFinding>, text: String): List<PiiFinding>? {
    val fired = findings.filter { it.kind == CheckKind.PII && it.action == Action.REDACT && it.fired }
    if (fired.isEmpty()) return null
    val cp = CodePoints(text)
    val candidates = fired.flatMap { (it.details as CheckDetails.PiiDetails).findings }.map { Candidate(it.kind, it.start, it.end) }.distinct()
    return resolveOverlaps(candidates).map { PiiFinding(it.kind, it.start, it.end, cp.slice(it.start, it.end)) }
}

/**
 * Evaluates [checks] on [text]: every check sees the original text (spans are offsets into it), none is skipped, `block`
 * decides the verdict, `flag` only records, and the result text is [text] redacted once over the resolved union of the
 * firing `redact` checks (also when blocked), extending [mapping]. A classifier check without a [classifier] fails with
 * `no_classifier` before anything runs; classifier exceptions propagate unchanged.
 */
suspend fun checkText(text: String, checks: List<Check>, mapping: Mapping = emptyList(), classifier: Classifier? = null): CheckResult {
    validateChecks(checks, allowCanary = true)
    if (classifier == null && hasClassifierCheck(checks)) throw GuardrailException(GuardrailErrorKind.NO_CLASSIFIER)
    val findings = evaluateChecks(text, checks, classifier)
    val toRedact = redactionFindings(findings, text)
    val redacted = if (toRedact == null) Redacted(text, mapping.toList()) else redact(text, toRedact, mapping)
    return CheckResult(verdictOf(findings), redacted.text, redacted.mapping, findings)
}
