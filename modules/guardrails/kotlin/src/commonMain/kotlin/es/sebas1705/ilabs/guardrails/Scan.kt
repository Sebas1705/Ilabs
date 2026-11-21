package es.sebas1705.ilabs.guardrails

// Code points are walked by hand over the UTF-16 string: a high surrogate (D800-DBFF) immediately followed by a low
// surrogate (DC00-DFFF) is one code point; every other unit, lone surrogates included, is one code point on its own.
// ASCII classes are explicit range checks. No Unicode- or locale-aware stdlib call is used for the contract rules.

internal fun isAsciiDigit(cp: Int): Boolean = cp in 0x30..0x39

internal fun isAsciiUpper(cp: Int): Boolean = cp in 0x41..0x5A

internal fun isAsciiLower(cp: Int): Boolean = cp in 0x61..0x7A

internal fun isAsciiLetter(cp: Int): Boolean = isAsciiUpper(cp) || isAsciiLower(cp)

internal fun isAsciiAlnum(cp: Int): Boolean = isAsciiLetter(cp) || isAsciiDigit(cp)

/** A text decomposed into code points, with the UTF-16 index of each one (for slicing the original string). */
internal class CodePoints(val text: String) {
    val cps: IntArray
    private val units: IntArray
    val size: Int get() = cps.size

    init {
        var count = 0
        var i = 0
        while (i < text.length) {
            i += widthAt(i)
            count++
        }
        cps = IntArray(count)
        units = IntArray(count + 1)
        i = 0
        var k = 0
        while (i < text.length) {
            val width = widthAt(i)
            cps[k] = if (width == 2) 0x10000 + ((text[i].code - 0xD800) shl 10) + (text[i + 1].code - 0xDC00) else text[i].code
            units[k] = i
            i += width
            k++
        }
        units[count] = text.length
    }

    private fun widthAt(i: Int): Int =
        if (text[i].code in 0xD800..0xDBFF && i + 1 < text.length && text[i + 1].code in 0xDC00..0xDFFF) 2 else 1

    /** The original text of the code points `[start, end)`. */
    fun slice(start: Int, end: Int): String = text.substring(units[start], units[end])
}

internal fun codePointCount(text: String): Int = CodePoints(text).size
