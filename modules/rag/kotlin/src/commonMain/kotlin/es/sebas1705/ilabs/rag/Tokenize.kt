package es.sebas1705.ilabs.rag

// Code points are walked by hand over the UTF-16 string: a high surrogate (D800-DBFF) immediately followed by a low
// surrogate (DC00-DFFF) is one code point; every other unit, lone surrogates included, is one code point on its own.
// No Unicode- or locale-aware stdlib call is used for the contract rules.

internal fun isHighSurrogate(unit: Int): Boolean = unit in 0xD800..0xDBFF

internal fun isLowSurrogate(unit: Int): Boolean = unit in 0xDC00..0xDFFF

/** Number of UTF-16 units of the code point starting at [i] (1 or 2). */
internal fun codePointWidth(text: String, i: Int): Int =
    if (isHighSurrogate(text[i].code) && i + 1 < text.length && isLowSurrogate(text[i + 1].code)) 2 else 1

/** The code point starting at [i]; a lone surrogate is returned as its own unit value. */
internal fun codePointAt(text: String, i: Int): Int =
    if (codePointWidth(text, i) == 2) 0x10000 + ((text[i].code - 0xD800) shl 10) + (text[i + 1].code - 0xDC00) else text[i].code

/** The code points of [text], in order. */
internal fun codePoints(text: String): IntArray {
    var count = 0
    var i = 0
    while (i < text.length) {
        i += codePointWidth(text, i)
        count++
    }
    val out = IntArray(count)
    i = 0
    var k = 0
    while (i < text.length) {
        out[k++] = codePointAt(text, i)
        i += codePointWidth(text, i)
    }
    return out
}

/**
 * Word code points: ASCII `0-9`, `A-Z`, `a-z`, and every code point `>= 0x80` outside the pinned separator ranges
 * U+00A0..U+00BF, U+00D7, U+00F7 and U+2000..U+206F. Lone surrogates are word code points.
 */
internal fun isWordCodePoint(cp: Int): Boolean = when {
    cp < 0x80 -> cp in 0x30..0x39 || cp in 0x41..0x5A || cp in 0x61..0x7A
    cp in 0xA0..0xBF -> false
    cp == 0xD7 || cp == 0xF7 -> false
    cp in 0x2000..0x206F -> false
    else -> true
}

/**
 * The Latin-1 folding table of `contracts/rag/README.md`, copied verbatim (U+00C0 to U+00FF; U+00D7 and U+00F7 are
 * separators and never folded).
 */
private val LATIN1_FOLD: Map<Int, String> = mapOf(
    0xC0 to "a", 0xC1 to "a", 0xC2 to "a", 0xC3 to "a", 0xC4 to "a", 0xC5 to "a",
    0xC6 to "ae",
    0xC7 to "c",
    0xC8 to "e", 0xC9 to "e", 0xCA to "e", 0xCB to "e",
    0xCC to "i", 0xCD to "i", 0xCE to "i", 0xCF to "i",
    0xD0 to "d",
    0xD1 to "n",
    0xD2 to "o", 0xD3 to "o", 0xD4 to "o", 0xD5 to "o", 0xD6 to "o", 0xD8 to "o",
    0xD9 to "u", 0xDA to "u", 0xDB to "u", 0xDC to "u",
    0xDD to "y",
    0xDE to "th",
    0xDF to "ss",
    0xE0 to "a", 0xE1 to "a", 0xE2 to "a", 0xE3 to "a", 0xE4 to "a", 0xE5 to "a",
    0xE6 to "ae",
    0xE7 to "c",
    0xE8 to "e", 0xE9 to "e", 0xEA to "e", 0xEB to "e",
    0xEC to "i", 0xED to "i", 0xEE to "i", 0xEF to "i",
    0xF0 to "d",
    0xF1 to "n",
    0xF2 to "o", 0xF3 to "o", 0xF4 to "o", 0xF5 to "o", 0xF6 to "o", 0xF8 to "o",
    0xF9 to "u", 0xFA to "u", 0xFB to "u", 0xFC to "u",
    0xFD to "y", 0xFF to "y",
    0xFE to "th",
)

/** Appends the folding of the word code point [cp] (spanning [width] units of [text] at [i]) to [out]. */
private fun appendFolded(out: StringBuilder, text: String, i: Int, width: Int, cp: Int) {
    when {
        cp in 0x41..0x5A -> out.append((cp + 0x20).toChar())
        else -> {
            val folded = LATIN1_FOLD[cp]
            if (folded != null) {
                out.append(folded)
            } else {
                // kept exactly as is: the original unit(s), so a lone surrogate stays the same lone unit
                out.append(text[i])
                if (width == 2) out.append(text[i + 1])
            }
        }
    }
}

/**
 * Splits [text] into tokens: maximal runs of word code points, each folded (ASCII `A-Z` to `a-z`, then the Latin-1
 * table; every other code point kept as is). Every other code point separates. Used by BM25 and the hash embedder.
 */
fun tokenize(text: String): List<String> {
    val tokens = ArrayList<String>()
    val current = StringBuilder()
    var i = 0
    while (i < text.length) {
        val width = codePointWidth(text, i)
        val cp = codePointAt(text, i)
        if (isWordCodePoint(cp)) {
            appendFolded(current, text, i, width, cp)
        } else if (current.isNotEmpty()) {
            tokens += current.toString()
            current.setLength(0)
        }
        i += width
    }
    if (current.isNotEmpty()) tokens += current.toString()
    return tokens
}
