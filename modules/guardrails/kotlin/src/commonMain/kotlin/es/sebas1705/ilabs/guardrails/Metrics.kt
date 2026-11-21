package es.sebas1705.ilabs.guardrails

/** The ten metric kinds in their pinned order: the PII kinds, then the injection categories. */
val METRIC_KINDS: List<String> = PII_KINDS + InjectionCategory.entries.map { it.wire }

/** A labelled span; [kind] is one of [METRIC_KINDS]. Offsets are opaque integers here. */
data class MetricSpan(val kind: String, val start: Int, val end: Int)

/** Precision, recall and F1 of one metric kind, with the integer counts they come from. */
data class KindMetrics(
    val kind: String,
    val precision: Double,
    val recall: Double,
    val f1: Double,
    val expected: Int,
    val found: Int,
    val correct: Int,
)

/** Precision, recall and F1 over all kinds, and the same per kind present in the data (pinned order). */
data class Metrics(val precision: Double, val recall: Double, val f1: Double, val byKind: List<KindMetrics>)

private fun ratio(correct: Int, total: Int): Double = if (total == 0) 1.0 else correct.toDouble() / total.toDouble()

private fun f1Of(correct: Int, expected: Int, found: Int): Double =
    if (expected + found == 0) 1.0 else (2 * correct).toDouble() / (expected + found).toDouble()

/**
 * Compares [found] spans with [expected] ones as sets of `(kind, start, end)`. A kind outside [METRIC_KINDS] is
 * `invalid_options`. `f1` is `2 * correct / (|E| + |F|)`, one division.
 */
fun detectionMetrics(expected: List<MetricSpan>, found: List<MetricSpan>): Metrics {
    val known = METRIC_KINDS.toSet()
    for (s in expected) if (s.kind !in known) invalidOptions("unknown metric kind")
    for (s in found) if (s.kind !in known) invalidOptions("unknown metric kind")
    val e = expected.toSet()
    val f = found.toSet()
    val correct = f.count { it in e }
    val byKind = ArrayList<KindMetrics>()
    for (kind in METRIC_KINDS) {
        val ek = e.filter { it.kind == kind }
        val fk = f.filter { it.kind == kind }
        if (ek.isEmpty() && fk.isEmpty()) continue
        val ck = fk.count { it in e }
        byKind += KindMetrics(kind, ratio(ck, fk.size), ratio(ck, ek.size), f1Of(ck, ek.size, fk.size), ek.size, fk.size, ck)
    }
    return Metrics(ratio(correct, f.size), ratio(correct, e.size), f1Of(correct, e.size, f.size), byKind.toList())
}
