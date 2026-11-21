package es.sebas1705.ilabs.guardrails

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class PlaceholdersTest {
    private fun invalidOptions(block: () -> Unit) {
        val e = assertFailsWith<GuardrailException> { block() }
        assertEquals(GuardrailErrorKind.INVALID_OPTIONS, e.kind)
    }

    @Test
    fun numberingIsPerKindInOrderOfFirstAppearance() {
        val text = "a ana@example.com b 612 345 678 c bob@example.com d ana@example.com"
        val r = redact(text, detectPii(text))
        assertEquals("a <EMAIL_1> b <PHONE_1> c <EMAIL_2> d <EMAIL_1>", r.text)
        assertEquals(
            listOf("<EMAIL_1>" to "ana@example.com", "<PHONE_1>" to "612 345 678", "<EMAIL_2>" to "bob@example.com"),
            r.mapping,
        )
    }

    @Test
    fun aGivenMappingIsExtendedNotMutated() {
        val given = mutableListOf("<EMAIL_3>" to "old@example.com", "<FOO_9>" to "x")
        val text = "old@example.com and new@example.com"
        val r = redact(text, detectPii(text), given)
        assertEquals("<EMAIL_3> and <EMAIL_4>", r.text)
        assertEquals(listOf("<EMAIL_3>" to "old@example.com", "<FOO_9>" to "x", "<EMAIL_4>" to "new@example.com"), r.mapping)
        assertEquals(2, given.size)
    }

    @Test
    fun placeholderShapeIsExact() {
        // leading zeros, other kinds and other shapes are kept but never counted or reused
        val given = listOf("<EMAIL_01>" to "a@example.com", "<EMAIL_0>" to "a@example.com", "<PHONE_7>" to "a@example.com", "<EMAIL_2x>" to "a@example.com")
        val r = redact("a@example.com", detectPii("a@example.com"), given)
        assertEquals("<EMAIL_1>", r.text)
        assertEquals(given + ("<EMAIL_1>" to "a@example.com"), r.mapping)
    }

    @Test
    fun numbersOfMoreThanNineDigitsAreNotCounted() {
        val given = listOf("<EMAIL_9999999999>" to "a@example.com", "<EMAIL_99999999999999999999999>" to "b@example.com")
        val r = redact("a@example.com", detectPii("a@example.com"), given)
        // ignored like a foreign shape: neither counted for numbering nor reused
        assertEquals("<EMAIL_1>", r.text)
        // nine digits are still counted
        val nine = redact("c@example.com", detectPii("c@example.com"), listOf("<EMAIL_999999999>" to "x@example.com"))
        assertEquals("<EMAIL_1000000000>", nine.text)
    }

    @Test
    fun placeholderShapedTextIsNotSpecial() {
        val text = "keep <EMAIL_1> and ana@example.com"
        assertEquals("keep <EMAIL_1> and <EMAIL_1>", redact(text, detectPii(text)).text)
    }

    @Test
    fun redactRejectsBadFindings() {
        val text = "ana@example.com 612 345 678"
        val good = detectPii(text)
        invalidOptions { redact(text, good.reversed()) }
        invalidOptions { redact(text, listOf(PiiFinding(PiiKind.EMAIL, 0, 15, "ana@example.com"), PiiFinding(PiiKind.PHONE, 10, 20, text.substring(10, 20)))) }
        invalidOptions { redact(text, listOf(PiiFinding(PiiKind.EMAIL, 0, 99, "ana@example.com"))) }
        invalidOptions { redact(text, listOf(PiiFinding(PiiKind.EMAIL, -1, 15, "ana@example.com"))) }
        invalidOptions { redact(text, listOf(PiiFinding(PiiKind.EMAIL, 0, 15, "bob@example.com"))) }
        invalidOptions { redact(text, listOf(PiiFinding(PiiKind.EMAIL, 5, 2, ""))) }
    }

    @Test
    fun restoreIsOnePassLongestFirstAndIgnoresEmptyPlaceholders() {
        assertEquals("a@x.org and <PHONE_9>", restore("<EMAIL_1> and <PHONE_9>", listOf("<EMAIL_1>" to "a@x.org")))
        assertEquals("<EMAIL_1>", restore("<EMAIL_1>", listOf("<EMAIL_1>" to "<EMAIL_1>")))
        assertEquals("B A", restore("<A> <B>", listOf("<A>" to "B", "<B>" to "A")))
        assertEquals("long", restore("<E_1>2", listOf("<E_1>" to "short", "<E_1>2" to "long")))
        assertEquals("first", restore("<E_1>", listOf("<E_1>" to "first", "<E_1>" to "second")))
        assertEquals("abc", restore("abc", listOf("" to "X")))
        assertEquals("a😀", restore("a<E_1>", listOf("<E_1>" to "😀")))
    }
}
