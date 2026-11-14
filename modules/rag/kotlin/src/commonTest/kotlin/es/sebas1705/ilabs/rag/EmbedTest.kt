package es.sebas1705.ilabs.rag

import kotlinx.coroutines.test.runTest
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class EmbedTest {
    private fun bytes(vararg b: Int) = ByteArray(b.size) { b[it].toByte() }

    private fun ascii(s: String) = ByteArray(s.length) { s[it].code.toByte() }

    @Test
    fun fnv1aCheckValues() {
        assertEquals(0x811C9DC5u, fnv1a32(ByteArray(0)))
        assertEquals(0xE40C292Cu, fnv1a32(ascii("a")))
        assertEquals(0xBF9CF968u, fnv1a32(ascii("foobar")))
    }

    @Test
    fun handWrittenUtf8Encoder() {
        assertContentEquals(bytes(0x00), utf8Bytes(0x00))
        assertContentEquals(bytes(0x61), utf8Bytes(0x61))
        assertContentEquals(bytes(0x7F), utf8Bytes(0x7F))
        assertContentEquals(bytes(0xC2, 0x80), utf8Bytes(0x80))
        assertContentEquals(bytes(0xC3, 0xB1), utf8Bytes(0xF1))
        assertContentEquals(bytes(0xDF, 0xBF), utf8Bytes(0x7FF))
        assertContentEquals(bytes(0xE0, 0xA0, 0x80), utf8Bytes(0x800))
        assertContentEquals(bytes(0xE2, 0x82, 0xAC), utf8Bytes(0x20AC))
        assertContentEquals(bytes(0xEF, 0xBF, 0xBF), utf8Bytes(0xFFFF))
        assertContentEquals(bytes(0xF0, 0x90, 0x80, 0x80), utf8Bytes(0x10000))
        assertContentEquals(bytes(0xF0, 0x9F, 0x98, 0x80), utf8Bytes(0x1F600))
        assertContentEquals(bytes(0xF4, 0x8F, 0xBF, 0xBF), utf8Bytes(0x10FFFF))
        // lone surrogates (high or low) encode as U+FFFD
        assertContentEquals(bytes(0xEF, 0xBF, 0xBD), utf8Bytes(0xD800))
        assertContentEquals(bytes(0xEF, 0xBF, 0xBD), utf8Bytes(0xDBFF))
        assertContentEquals(bytes(0xEF, 0xBF, 0xBD), utf8Bytes(0xDC00))
        assertContentEquals(bytes(0xEF, 0xBF, 0xBD), utf8Bytes(0xDFFF))
    }

    private fun nonZero(v: DoubleArray) = v.withIndex().filter { it.value != 0.0 }.map { it.index to it.value }

    private fun assertNonZero(expected: List<Pair<Int, Double>>, v: DoubleArray) {
        val got = nonZero(v)
        assertEquals(expected.map { it.first }, got.map { it.first })
        for ((e, g) in expected.zip(got)) assertTrue(abs(e.second - g.second) <= 1e-9, "bucket ${e.first}: $e vs $g")
    }

    @Test
    fun knownBucketsAndFolding() {
        val hola = listOf(12 to -0.5, 114 to 0.5, 160 to -0.5, 181 to -0.5)
        assertNonZero(hola, hashEmbed("hola"))
        assertContentEquals(hashEmbed("hola"), hashEmbed("HÓLA"))
        assertNonZero(listOf(0 to -0.8944271909999159, 1 to 0.4472135954999579), hashEmbed("hola mundo", 3))
        assertEquals(256, hashEmbed("hola").size)
        assertEquals(1.0, hashEmbed("hola mundo").sumOf { it * it }, 1e-12)
    }

    @Test
    fun windowsOfSpecialTokens() {
        // a one-code-point token has exactly one window
        assertEquals(1, nonZero(hashEmbed("a")).size)
        // the lone surrogate hashes like U+FFFD, the astral one as 4 bytes
        assertContentEquals(hashEmbed("\uD800"), hashEmbed("\uDC00"))
        assertNonZero(listOf(182 to -1.0), hashEmbed("\uD800"))
        assertNonZero(listOf(148 to 1.0), hashEmbed("😀"))
    }

    @Test
    fun noTokensGiveTheZeroVector() {
        assertTrue(hashEmbed("").all { it == 0.0 })
        assertTrue(hashEmbed("¿? ¡! …", 7).all { it == 0.0 })
        assertEquals(7, hashEmbed("", 7).size)
    }

    @Test
    fun dimIsValidatedByBothFunctions() = runTest {
        assertEquals(RagErrorKind.INVALID_OPTIONS, assertFailsWith<RagException> { hashEmbed("a", 0) }.kind)
        assertEquals(RagErrorKind.INVALID_OPTIONS, assertFailsWith<RagException> { hashEmbed("a", -1) }.kind)
        assertEquals(RagErrorKind.INVALID_OPTIONS, assertFailsWith<RagException> { hashEmbedder(0) }.kind)
        val vectors = hashEmbedder(16).embed(listOf("hola", ""))
        assertEquals(2, vectors.size)
        assertContentEquals(hashEmbed("hola", 16), vectors[0])
        assertContentEquals(DoubleArray(16), vectors[1])
    }

    @Test
    fun integerOptionsAreJudgedByValue() {
        assertEquals(2, parseIntOption(2.0))
        assertEquals(100, parseIntOption(1e2))
        assertEquals(-1, parseIntOption(-1.0))
        for (bad in listOf(null, 2.5, 0.5, Double.NaN, Double.POSITIVE_INFINITY, 3e9)) {
            assertEquals(RagErrorKind.INVALID_OPTIONS, assertFailsWith<RagException>("$bad") { parseIntOption(bad) }.kind)
        }
    }
}
