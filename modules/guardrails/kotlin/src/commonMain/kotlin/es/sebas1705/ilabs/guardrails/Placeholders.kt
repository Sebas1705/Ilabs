package es.sebas1705.ilabs.guardrails

/** A mapping: an ordered list of `(placeholder, original)` pairs. */
typealias Mapping = List<Pair<String, String>>

/** The result of [redact]: the redacted [text] and the extended [mapping]. */
data class Redacted(val text: String, val mapping: Mapping)

/** The placeholder name of each PII kind, as `(kind, NAME)` pairs in kind order. */
val PLACEHOLDER_NAMES: List<Pair<String, String>> = PiiKind.entries.map { it.wire to it.placeholderName }

/**
 * The `n` of a placeholder exactly shaped `<NAME_n>` (decimal, no leading zeros, at least 1), or null for any other
 * shape. A number of more than 9 digits is not counted (ignored like a foreign shape), so no overflow is possible.
 */
private fun placeholderNumber(placeholder: String, name: String): Long? {
    val prefix = "<${name}_"
    if (placeholder.length < prefix.length + 2 || !placeholder.startsWith(prefix) || !placeholder.endsWith(">")) return null
    val digits = placeholder.substring(prefix.length, placeholder.length - 1)
    if (digits.length > 9 || digits[0] !in '1'..'9') return null
    var n = 0L
    for (ch in digits) {
        if (ch !in '0'..'9') return null
        n = n * 10 + (ch - '0')
    }
    return n
}

/**
 * Redacts [findings] in [text]. Entries of [out] with an index below [reuseFrom] are never reused (output redaction of
 * a guarded call); every entry counts for numbering. [out] is extended in place (a private copy).
 */
internal fun redactInto(text: String, findings: List<PiiFinding>, out: MutableList<Pair<String, String>>, reuseFrom: Int): String {
    val cp = CodePoints(text)
    validateFindings(cp, findings)
    val next = HashMap<PiiKind, Long>()
    for (kind in PiiKind.entries) {
        var largest = 0L
        for ((placeholder, _) in out) {
            val n = placeholderNumber(placeholder, kind.placeholderName)
            if (n != null && n > largest) largest = n
        }
        next[kind] = largest + 1
    }
    val sb = StringBuilder()
    var position = 0
    for (f in findings) {
        sb.append(cp.slice(position, f.start))
        val name = f.kind.placeholderName
        var placeholder: String? = null
        for (i in reuseFrom until out.size) {
            val entry = out[i]
            if (entry.second == f.text && placeholderNumber(entry.first, name) != null) {
                placeholder = entry.first
                break
            }
        }
        if (placeholder == null) {
            val n = next.getValue(f.kind)
            placeholder = "<${name}_$n>"
            next[f.kind] = n + 1
            out += placeholder to f.text
        }
        sb.append(placeholder)
        position = f.end
    }
    sb.append(cp.slice(position, cp.size))
    return sb.toString()
}

private fun validateFindings(cp: CodePoints, findings: List<PiiFinding>) {
    var previousEnd = 0
    for (f in findings) {
        if (f.start < 0 || f.end < f.start || f.end > cp.size) invalidOptions("a finding is outside the text")
        if (f.start < previousEnd) invalidOptions("findings must be ordered by start and not overlap")
        if (cp.slice(f.start, f.end) != f.text) invalidOptions("a finding text differs from its slice")
        previousEnd = f.end
    }
}

/**
 * Replaces each finding of [text] with a reversible placeholder `<KIND_n>`: numbering is per kind from one more than
 * the largest `n` of the kind in [mapping], in order of first appearance; the same original of the same kind reuses
 * its placeholder (also an entry of the given [mapping]). [findings] must be ordered, non-overlapping, inside the text
 * and equal to their slices (`invalid_options` otherwise). Nothing given is mutated.
 */
fun redact(text: String, findings: List<PiiFinding>, mapping: Mapping = emptyList()): Redacted {
    val out = ArrayList(mapping)
    val redacted = redactInto(text, findings, out, 0)
    return Redacted(redacted, out.toList())
}

/**
 * Puts the originals back in one left-to-right pass: at each position the longest mapped placeholder that occurs
 * there wins (equal placeholders: the first entry); empty placeholders are ignored; the result is never re-scanned.
 */
fun restore(text: String, mapping: Mapping): String {
    val cp = CodePoints(text)
    val entries = ArrayList<Pair<IntArray, String>>()
    for ((placeholder, original) in mapping) {
        if (placeholder.isEmpty()) continue
        entries += CodePoints(placeholder).cps to original
    }
    val c = cp.cps
    val sb = StringBuilder()
    var i = 0
    while (i < c.size) {
        var best: Pair<IntArray, String>? = null
        for (entry in entries) {
            val ph = entry.first
            if (i + ph.size > c.size) continue
            if (best != null && ph.size <= best.first.size) continue
            var same = true
            for (k in ph.indices) if (c[i + k] != ph[k]) {
                same = false
                break
            }
            if (same) best = entry
        }
        if (best != null) {
            sb.append(best.second)
            i += best.first.size
        } else {
            sb.append(cp.slice(i, i + 1))
            i++
        }
    }
    return sb.toString()
}
