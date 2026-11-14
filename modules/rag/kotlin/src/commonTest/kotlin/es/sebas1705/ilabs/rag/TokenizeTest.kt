package es.sebas1705.ilabs.rag

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals

class TokenizeTest {
    @Test
    fun codePointScannerHandlesPairsAndLoneSurrogates() {
        assertContentEquals(intArrayOf(0x61, 0x1F600, 0x62), codePoints("a😀b"))
        assertContentEquals(intArrayOf(0x10000), codePoints("𐀀"))
        // a low followed by a high is two lone surrogates; a trailing high is one
        assertContentEquals(intArrayOf(0xDC00, 0xD800), codePoints("\uDC00\uD800"))
        assertContentEquals(intArrayOf(0x78, 0xD83D), codePoints("x\uD83D"))
        assertContentEquals(intArrayOf(0xD800, 0x61), codePoints("\uD800a"))
        assertContentEquals(intArrayOf(), codePoints(""))
    }

    @Test
    fun asciiFoldsAndPunctuationSeparates() {
        assertEquals(listOf("hello", "world", "mixed", "case"), tokenize("Hello, WORLD! MiXeD-case"))
        assertEquals(listOf("it", "s", "snake", "case", "path", "v1"), tokenize("it's snake_case path/v1"))
        assertEquals(listOf("room", "101", "9am", "v2"), tokenize("Room 101 9am v2."))
        assertEquals(emptyList(), tokenize(""))
        assertEquals(emptyList(), tokenize(" ¿¡!?…— \t\n"))
    }

    @Test
    fun spanishMarksAndAccents() {
        assertEquals(listOf("que", "hora", "es"), tokenize("¿Qué hora es?"))
        assertEquals(tokenize("cancion arbol pinguino nandu"), tokenize("Canción ÁRBOL pingüino ÑANDÚ"))
        assertEquals(listOf("prestamo"), tokenize("PRÉSTAMO"))
    }

    @Test
    fun multiLetterReplacementsAreInsertedInPlace() {
        assertEquals(listOf("strasse", "aesir", "aether", "thorr", "de"), tokenize("Straße Æsir æther Þorr ðe"))
    }

    @Test
    fun separatorRangesArePinnedNotUnicodeCategories() {
        assertEquals(listOf("1", "5", "m", "x", "a"), tokenize("1º 5µm x²a"))
        for (sep in listOf(' ', 'ª', '¿', '×', '÷', ' ', '—', '“', '…', '⁯')) {
            assertEquals(listOf("a", "b"), tokenize("a${sep}b"), "U+${sep.code.toString(16)} separates")
        }
        for (word in listOf('\u009F', 'À', '῿', '⁰', '　', '，')) {
            assertEquals(1, tokenize("a${word}b").size, "U+${word.code.toString(16)} is a word code point")
        }
    }

    @Test
    fun codePointsOutsideTheTableAreKept() {
        assertEquals(listOf("Łodź", "Œuvre", "Ÿ", "日本語", "Σοφία"), tokenize("Łódź Œuvre Ÿ 日本語 Σοφία"))
        assertEquals(listOf("café", "cafe"), tokenize("café café"))
        assertEquals(listOf("x😀y"), tokenize("x😀y"))
    }

    @Test
    fun loneSurrogatesAreWordCodePoints() {
        assertEquals(listOf("a\uD800b", "\uDC00", "x\uD83D", "\uDE00\uD83D"), tokenize("a\uD800b \uDC00 x\uD83D \uDE00\uD83D"))
    }

    @Test
    fun theWholeLatin1Table() {
        val text = (0xC0..0xFF).filter { it != 0xD7 && it != 0xF7 }.joinToString(" ") { it.toChar().toString() }
        val upper = listOf(
            "a", "a", "a", "a", "a", "a", "ae", "c", "e", "e", "e", "e", "i", "i", "i", "i",
            "d", "n", "o", "o", "o", "o", "o", "o", "u", "u", "u", "u", "y", "th", "ss",
        )
        val lower = listOf(
            "a", "a", "a", "a", "a", "a", "ae", "c", "e", "e", "e", "e", "i", "i", "i", "i",
            "d", "n", "o", "o", "o", "o", "o", "o", "u", "u", "u", "u", "y", "th", "y",
        )
        assertEquals(upper + lower, tokenize(text))
        assertEquals(62, tokenize(text).size)
    }
}
