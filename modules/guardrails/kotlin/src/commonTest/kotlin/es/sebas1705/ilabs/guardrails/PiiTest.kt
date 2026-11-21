package es.sebas1705.ilabs.guardrails

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class PiiTest {
    private fun kinds(text: String, only: List<PiiKind>? = null) = detectPii(text, only).map { it.kind to it.text }

    private fun invalidOptions(block: () -> Unit) {
        val e = assertFailsWith<GuardrailException> { block() }
        assertEquals(GuardrailErrorKind.INVALID_OPTIONS, e.kind)
    }

    @Test
    fun findsEachKindWithCodePointOffsets() {
        val text = "Escríbeme a ana@example.com mañana."
        assertEquals(listOf(PiiFinding(PiiKind.EMAIL, 12, 27, "ana@example.com")), detectPii(text))
        assertEquals(listOf(PiiKind.PHONE to "612 345 678"), kinds("Llama al 612 345 678."))
        assertEquals(listOf(PiiKind.PHONE to "+34 600 000 000"), kinds("tel +34 600 000 000 ok"))
        assertEquals(listOf(PiiKind.IBAN to "ES28 0000 0000 0012 3456 7890"), kinds("IBAN ES28 0000 0000 0012 3456 7890."))
        assertEquals(listOf(PiiKind.CARD to "4111 1111 1111 1111"), kinds("card 4111 1111 1111 1111 ok"))
        assertEquals(listOf(PiiKind.SPANISH_ID to "12345678Z"), kinds("DNI 12345678Z."))
        assertEquals(listOf(PiiKind.SPANISH_ID to "X1234567L"), kinds("NIE X1234567L."))
        assertEquals(listOf(PiiKind.SECRET to "sk-aaaaaaaaaaaaaaaa"), kinds("key sk-aaaaaaaaaaaaaaaa."))
    }

    @Test
    fun offsetsCountCodePointsNotUtf16Units() {
        // an emoji before the address: offsets are code points (1 for the emoji), not units (2)
        assertEquals(PiiFinding(PiiKind.EMAIL, 2, 17, "ana@example.com"), detectPii("😀 ana@example.com").single())
        // a lone low surrogate followed by a lone high surrogate is two code points
        assertEquals(PiiFinding(PiiKind.EMAIL, 3, 18, "ana@example.com"), detectPii("\uDC00\uD800 ana@example.com").single())
    }

    @Test
    fun maximalRunIsNotBacktracked() {
        assertEquals(emptyList(), detectPii("612 345 678 90"))
        assertEquals(listOf(PiiKind.PHONE to "612 345 678"), kinds("91 612 345 678"))
        assertEquals(emptyList(), detectPii("612 345 678 9 h"))
        assertEquals(emptyList(), detectPii("4111 1111 1111 1111 123"))
    }

    @Test
    fun glueIsAsciiOnly() {
        assertEquals(listOf(PiiKind.PHONE to "612345678"), kinds("aquí612345678"))
        assertEquals(emptyList(), detectPii("teléfono612345678"))
        assertEquals(emptyList(), detectPii("DNI12345678Z"))
        assertEquals(emptyList(), detectPii("612345678x"))
    }

    @Test
    fun checksumsDecideValidity() {
        assertEquals(emptyList(), detectPii("ES29 0000 0000 0012 3456 7890"))
        assertEquals(emptyList(), detectPii("4111 1111 1111 1112"))
        assertEquals(emptyList(), detectPii("12345678A"))
        assertEquals(listOf(PiiKind.IBAN to "GB31 TEST 4111 1111 1111 1111"), kinds("GB31 TEST 4111 1111 1111 1111"))
        assertEquals(listOf(PiiKind.CARD to "4000 0000 0000 0000 006"), kinds("4000 0000 0000 0000 006"))
    }

    @Test
    fun overlapResolutionEarliestThenLongest() {
        // the card inside the IBAN loses: the IBAN starts earlier
        assertEquals(listOf(PiiKind.IBAN to "GB31 TEST 4111 1111 1111 1111"), kinds("GB31 TEST 4111 1111 1111 1111"))
        // kinds restricts scanning AND resolution: the card is reported on its own
        assertEquals(listOf(PiiKind.CARD to "4111 1111 1111 1111"), kinds("GB31 TEST 4111 1111 1111 1111", listOf(PiiKind.CARD)))
    }

    @Test
    fun kindsAreValidated() {
        invalidOptions { detectPii("x", emptyList()) }
        invalidOptions { detectPii("x", listOf(PiiKind.EMAIL, PiiKind.EMAIL)) }
        assertEquals(PiiKind.CARD, parsePiiKind("card"))
        invalidOptions { parsePiiKind("Card") }
        invalidOptions { parsePiiKind("constructor") }
        invalidOptions { parsePiiKind(null) }
    }

    @Test
    fun theInputListIsNotMutatedAndResultsAreReadOnly() {
        val given = mutableListOf(PiiKind.EMAIL)
        detectPii("ana@example.com", given)
        assertEquals(listOf(PiiKind.EMAIL), given)
    }

    @Test
    fun emptyTextHasNoFindings() {
        assertEquals(emptyList(), detectPii(""))
    }
}
