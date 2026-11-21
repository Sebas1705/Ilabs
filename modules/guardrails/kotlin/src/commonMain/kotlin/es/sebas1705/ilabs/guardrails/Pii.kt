package es.sebas1705.ilabs.guardrails

/** The PII and secret kinds, in their pinned kind order, with their wire names and placeholder names. */
enum class PiiKind(val wire: String, val placeholderName: String) {
    EMAIL("email", "EMAIL"),
    PHONE("phone", "PHONE"),
    IBAN("iban", "IBAN"),
    CARD("card", "CARD"),
    SPANISH_ID("spanish_id", "SPANISH_ID"),
    SECRET("secret", "SECRET"),
}

/** A finding: the kind, the code-point span `[start, end)` and the original [text] of that span. */
data class PiiFinding(val kind: PiiKind, val start: Int, val end: Int, val text: String)

/** The wire names of the PII kinds, in kind order. */
val PII_KINDS: List<String> = PiiKind.entries.map { it.wire }

/** The secret prefixes, case-sensitive, in order. */
val SECRET_PREFIXES: List<String> = listOf("sk-", "pk-", "ghp_", "gho_", "github_pat_", "AKIA", "AIza", "xoxb-", "xoxp-")

/** The DNI/NIE control letters: index `N mod 23`. */
const val DNI_LETTERS: String = "TRWAGMYFPDXBNJZSQVHLCKE"

/** Parses a PII kind wire name (exact); anything else, `null` included, is `invalid_options`. */
internal fun parsePiiKind(wire: String?): PiiKind =
    PiiKind.entries.firstOrNull { it.wire == wire } ?: invalidOptions("unknown PII kind")

/** A valid candidate span of one kind (before overlap resolution). */
internal data class Candidate(val kind: PiiKind, val start: Int, val end: Int)

private val SECRET_PREFIX_CPS: List<IntArray> = SECRET_PREFIXES.map { p -> IntArray(p.length) { p[it].code } }

private fun isLocalChar(cp: Int) = isAsciiAlnum(cp) || cp == '_'.code || cp == '%'.code || cp == '+'.code || cp == '-'.code

private fun isLabelChar(cp: Int) = isAsciiAlnum(cp) || cp == '-'.code

private fun isIbanChar(cp: Int) = isAsciiUpper(cp) || isAsciiDigit(cp)

private fun isSecretBody(cp: Int) = isAsciiAlnum(cp) || cp == '_'.code || cp == '-'.code

/** Each matcher returns the end (exclusive) of the valid maximal run starting at [p] (left boundary already checked), or -1. */
private fun matchEmail(c: IntArray, p: Int): Int {
    val n = c.size
    if (p > 0) {
        val prev = c[p - 1]
        if (prev == '.'.code || prev == '_'.code || prev == '%'.code || prev == '+'.code || prev == '-'.code || prev == '@'.code) return -1
    }
    if (!isLocalChar(c[p])) return -1
    var e = p
    while (e < n && isLocalChar(c[e])) e++
    while (e + 1 < n && c[e] == '.'.code && isLocalChar(c[e + 1])) {
        e++
        while (e < n && isLocalChar(c[e])) e++
    }
    if (e >= n || c[e] != '@'.code) return -1
    e++
    if (e >= n || !isLabelChar(c[e])) return -1
    var labels = 1
    var lastStart = e
    while (e < n && isLabelChar(c[e])) e++
    while (e + 1 < n && c[e] == '.'.code && isLabelChar(c[e + 1])) {
        e++
        lastStart = e
        labels++
        while (e < n && isLabelChar(c[e])) e++
    }
    if (labels < 2 || e - lastStart < 2) return -1
    for (k in lastStart until e) if (!isAsciiLetter(c[k])) return -1
    return e
}

private fun matchPhone(c: IntArray, p: Int): Int {
    val n = c.size
    val plus = c[p] == '+'.code
    var e = p
    if (plus) {
        if (p + 1 >= n || !isAsciiDigit(c[p + 1])) return -1
        e++
    } else if (!isAsciiDigit(c[p])) {
        return -1
    }
    val firstDigit = c[e]
    val maxDigits = if (plus) 15 else 9
    var digits = 0
    while (true) {
        while (e < n && isAsciiDigit(c[e])) {
            digits++
            // more digits than the bound make the run invalid whatever follows: stop scanning (keeps the scan linear)
            if (digits > maxDigits) return -1
            e++
        }
        if (e + 1 < n && (c[e] == ' '.code || c[e] == '.'.code || c[e] == '-'.code) && isAsciiDigit(c[e + 1])) e++ else break
    }
    val valid = if (plus) digits in 8..15 else digits == 9 && firstDigit in 0x36..0x39
    return if (valid) e else -1
}

private fun matchIban(c: IntArray, p: Int): Int {
    val n = c.size
    if (!isIbanChar(c[p])) return -1
    var e = p
    var count = 0
    while (true) {
        while (e < n && isIbanChar(c[e])) {
            count++
            // more than 34 characters is invalid whatever follows: stop scanning (keeps the scan linear)
            if (count > 34) return -1
            e++
        }
        if (e + 1 < n && c[e] == ' '.code && isIbanChar(c[e + 1])) e++ else break
    }
    if (count < 15) return -1
    // the run without its spaces (at most 34 code points)
    val chars = IntArray(count)
    var filled = 0
    for (i in p until e) if (c[i] != ' '.code) chars[filled++] = c[i]
    if (!isAsciiUpper(chars[0]) || !isAsciiUpper(chars[1]) || !isAsciiDigit(chars[2]) || !isAsciiDigit(chars[3])) return -1
    var r = 0
    for (k in 0 until count) {
        val ch = chars[(k + 4) % count]
        if (isAsciiDigit(ch)) {
            r = (r * 10 + (ch - 0x30)) % 97
        } else {
            val num = ch - 55
            r = (r * 10 + num / 10) % 97
            r = (r * 10 + num % 10) % 97
        }
    }
    return if (r == 1) e else -1
}

private fun matchCard(c: IntArray, p: Int): Int {
    val n = c.size
    if (!isAsciiDigit(c[p])) return -1
    var e = p
    var count = 0
    while (true) {
        while (e < n && isAsciiDigit(c[e])) {
            count++
            // more than 19 digits is invalid whatever follows: stop scanning (keeps the scan linear)
            if (count > 19) return -1
            e++
        }
        if (e + 1 < n && (c[e] == ' '.code || c[e] == '-'.code) && isAsciiDigit(c[e + 1])) e++ else break
    }
    if (count < 13) return -1
    // Luhn from the right: position 1 is the last digit; even positions are doubled
    var sum = 0
    var position = 0
    for (i in e - 1 downTo p) {
        if (!isAsciiDigit(c[i])) continue
        position++
        val d = c[i] - 0x30
        sum += if (position % 2 == 0) (if (2 * d > 9) 2 * d - 9 else 2 * d) else d
    }
    return if (sum % 10 == 0) e else -1
}

private fun matchSpanishId(c: IntArray, p: Int): Int {
    val n = c.size
    var e = p
    var prefix = 0
    var expectedDigits = 8
    val first = c[p]
    val upperFirst = if (isAsciiLower(first)) first - 0x20 else first
    if (upperFirst == 'X'.code || upperFirst == 'Y'.code || upperFirst == 'Z'.code) {
        prefix = upperFirst - 'X'.code
        expectedDigits = 7
        e++
    } else if (!isAsciiDigit(first)) {
        return -1
    }
    var number = 0
    var digits = 0
    while (e < n && isAsciiDigit(c[e])) {
        if (digits < 8) number = number * 10 + (c[e] - 0x30)
        digits++
        e++
    }
    if (digits != expectedDigits) return -1
    val letter: Int
    if (e + 1 < n && c[e] == '-'.code && isAsciiLetter(c[e + 1])) {
        letter = c[e + 1]
        e += 2
    } else if (e < n && isAsciiLetter(c[e])) {
        letter = c[e]
        e++
    } else {
        return -1
    }
    // NIE: the prefix value followed by the 7 digits
    val value = if (expectedDigits == 7) prefix * 10_000_000 + number else number
    val upperLetter = if (isAsciiLower(letter)) letter - 0x20 else letter
    return if (upperLetter == DNI_LETTERS[value % 23].code) e else -1
}

private fun matchSecret(c: IntArray, p: Int, bodyEnd: IntArray): Int {
    val n = c.size
    for (prefix in SECRET_PREFIX_CPS) {
        if (p + prefix.size > n) continue
        var same = true
        for (k in prefix.indices) if (c[p + k] != prefix[k]) {
            same = false
            break
        }
        if (!same) continue
        var e = p + prefix.size
        val bodyStart = e
        e = bodyEnd[e] // the end of the body run, precomputed once per scan
        return if (e - bodyStart >= 16) e else -1
    }
    return -1
}

private fun matchKind(kind: PiiKind, c: IntArray, p: Int, bodyEnd: IntArray): Int = when (kind) {
    PiiKind.EMAIL -> matchEmail(c, p)
    PiiKind.PHONE -> matchPhone(c, p)
    PiiKind.IBAN -> matchIban(c, p)
    PiiKind.CARD -> matchCard(c, p)
    PiiKind.SPANISH_ID -> matchSpanishId(c, p)
    PiiKind.SECRET -> matchSecret(c, p, bodyEnd)
}

/** Every valid candidate of the scanned [kinds] (at most one per kind and start), before overlap resolution. */
internal fun scanCandidates(text: CodePoints, kinds: Collection<PiiKind>): List<Candidate> {
    val c = text.cps
    val n = c.size
    val out = ArrayList<Candidate>()
    // bodyEnd[i]: the end of the run of secret body characters starting at i, computed once in one pass
    val bodyEnd = if (PiiKind.SECRET in kinds) IntArray(n + 1) else IntArray(0)
    if (bodyEnd.isNotEmpty()) {
        bodyEnd[n] = n
        for (i in n - 1 downTo 0) bodyEnd[i] = if (isSecretBody(c[i])) bodyEnd[i + 1] else i
    }
    for (p in 0 until n) {
        if (p > 0 && isAsciiAlnum(c[p - 1])) continue
        for (kind in kinds) {
            val e = matchKind(kind, c, p, bodyEnd)
            if (e < 0) continue
            // right boundary
            if (e < n && isAsciiAlnum(c[e])) continue
            out += Candidate(kind, p, e)
        }
    }
    return out
}

/**
 * Overlap resolution: sort by start, then length (longest first), then kind order; accept a candidate when its start
 * is at or after the end of the last accepted one. A rejected candidate never blocks a later one.
 */
internal fun resolveOverlaps(candidates: List<Candidate>): List<Candidate> {
    val sorted = candidates.sortedWith(
        compareBy<Candidate> { it.start }.thenByDescending { it.end - it.start }.thenBy { it.kind.ordinal },
    )
    val accepted = ArrayList<Candidate>()
    for (cand in sorted) {
        if (accepted.isEmpty() || cand.start >= accepted.last().end) accepted += cand
    }
    return accepted
}

/**
 * Finds personal data and secrets in [text]: findings ordered by `start`, never overlapping. [kinds], when given, must
 * be non-empty and without duplicates (`invalid_options` otherwise) and restricts scanning and resolution.
 */
fun detectPii(text: String, kinds: List<PiiKind>? = null): List<PiiFinding> {
    val scanned: List<PiiKind> = if (kinds == null) {
        PiiKind.entries
    } else {
        if (kinds.isEmpty()) invalidOptions("kinds must not be empty")
        if (kinds.toSet().size != kinds.size) invalidOptions("kinds must be distinct")
        kinds.sortedBy { it.ordinal }
    }
    val cp = CodePoints(text)
    return resolveOverlaps(scanCandidates(cp, scanned)).map { PiiFinding(it.kind, it.start, it.end, cp.slice(it.start, it.end)) }
}
