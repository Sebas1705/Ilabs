package es.sebas1705.ilabs.rag

private const val MAX_MARKER_DIGITS = 9

/**
 * Finds the citation markers of [answer]: `[`, 1 to 9 ASCII digits whose first is not `0`, `]`. A marker is tried at
 * every `[` and scanning resumes right after that `[` whatever the outcome. Values are listed in order of first
 * appearance, deduplicated; `cited` are those equal to the `n` of some source (membership), `unknown` the others.
 * The scan is over UTF-16 units: `[`, `]` and ASCII digits are BMP units that no surrogate can equal, so this is the
 * same as a code-point scan.
 */
fun extractCitations(answer: String, sources: List<Source>): Citations {
    val known = sources.mapTo(HashSet()) { it.n }
    val seen = LinkedHashSet<Int>()
    for (i in answer.indices) {
        if (answer[i] != '[') continue
        var j = i + 1
        while (j < answer.length && answer[j] in '0'..'9') j++
        val digits = j - (i + 1)
        if (digits < 1 || digits > MAX_MARKER_DIGITS) continue
        if (answer[i + 1] == '0') continue
        if (j >= answer.length || answer[j] != ']') continue
        var value = 0
        for (k in i + 1 until j) value = value * 10 + (answer[k] - '0')
        seen += value
    }
    val cited = ArrayList<Int>()
    val unknown = ArrayList<Int>()
    for (n in seen) if (n in known) cited += n else unknown += n
    return Citations(cited, unknown)
}
