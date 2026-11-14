package es.sebas1705.ilabs.rag

import es.sebas1705.ilabs.context.defaultCounter
import es.sebas1705.ilabs.providers.Message
import es.sebas1705.ilabs.providers.Role
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class ComposeTest {
    private suspend fun index() = buildIndex(
        listOf(Document("a", "Alfa."), Document("b", "Bravo bravo bravo bravo bravo."), Document("c", "Charlie.")),
        Chunking.Paragraph(100),
    )

    private fun hit(id: String, rank: Int) = Hit("$id#0", id, rank, 1.0)

    @Test
    fun instructionIsPinned() {
        assertEquals(
            "Answer the question using only the numbered sources below. Cite the sources you use as [n]. If the sources do not contain the answer, say so.",
            RAG_INSTRUCTION,
        )
        assertEquals(141, RAG_INSTRUCTION.length)
        assertEquals(40, defaultCounter(Message(Role.SYSTEM, RAG_INSTRUCTION)))
    }

    @Test
    fun exactLayoutInArrayOrder() = runTest {
        val idx = index()
        // ranks disagree with the array order on purpose: the array order wins and is never re-sorted
        val hits = listOf(hit("c", 3), hit("a", 1))
        val out = composeContext(hits, idx, maxTokens = 1000)
        assertEquals(Message(Role.SYSTEM, "$RAG_INSTRUCTION\n\n[1] Charlie.\n\n[2] Alfa."), out.message)
        assertEquals(listOf(Source(1, "c#0", "c"), Source(2, "a#0", "a")), out.sources)
        assertEquals(0, out.droppedCount)
        assertEquals(listOf(hit("c", 3), hit("a", 1)), hits)
    }

    @Test
    fun emptyHitsGiveTheInstructionAlone() = runTest {
        val out = composeContext(emptyList(), index(), maxTokens = 40)
        assertEquals(ComposedContext(Message(Role.SYSTEM, RAG_INSTRUCTION), emptyList(), 0), out)
        val e = assertFailsWith<RagException> { composeContext(emptyList(), index(), maxTokens = 39) }
        assertEquals(RagErrorKind.BUDGET_TOO_SMALL, e.kind)
        assertEquals(40, e.required)
    }

    @Test
    fun walkStopsAtTheFirstMisfit() = runTest {
        val idx = index()
        val counter: (Message) -> Int = { it.content.length }
        val one = "$RAG_INSTRUCTION\n\n[1] Alfa.".length
        val withLong = "$RAG_INSTRUCTION\n\n[1] Alfa.\n\n[2] Bravo bravo bravo bravo bravo.".length
        val skipLong = "$RAG_INSTRUCTION\n\n[1] Alfa.\n\n[2] Charlie.".length
        check(skipLong < withLong)
        val out = composeContext(listOf(hit("a", 1), hit("b", 2), hit("c", 3)), idx, maxTokens = skipLong, counter = counter)
        assertEquals(listOf(Source(1, "a#0", "a")), out.sources)
        assertEquals(2, out.droppedCount)
        assertEquals(one, counter(out.message))
        // the budget is inclusive
        val exact = composeContext(listOf(hit("a", 1), hit("b", 2)), idx, maxTokens = withLong, counter = counter)
        assertEquals(2, exact.sources.size)
    }

    @Test
    fun customCounterIsUsedForRequired() = runTest {
        val idx = index()
        val counter: (Message) -> Int = { it.content.length * 10 }
        val e = assertFailsWith<RagException> { composeContext(listOf(hit("b", 1)), idx, maxTokens = 50, counter = counter) }
        assertEquals(RagErrorKind.BUDGET_TOO_SMALL, e.kind)
        assertEquals("$RAG_INSTRUCTION\n\n[1] Bravo bravo bravo bravo bravo.".length * 10, e.required)
        val empty = assertFailsWith<RagException> { composeContext(emptyList(), idx, maxTokens = 50, counter = counter) }
        assertEquals(1410, empty.required)
    }

    @Test
    fun defaultCostCountsCodePoints() = runTest {
        val idx = buildIndex(listOf(Document("e", "😀".repeat(8))), Chunking.Paragraph(100))
        // 141 + 2 + 4 + 8 code points = 155 -> 4 + 39 = 43 (UTF-16 would count 163 -> 45)
        val out = composeContext(listOf(Hit("e#0", "e", 1, 1.0)), idx, maxTokens = 43)
        assertEquals(1, out.sources.size)
    }

    @Test
    fun sourcesComeFromTheIndexChunks() = runTest {
        val idx = index()
        // a hand-built hit with a wrong docId: the source takes the docId of the index chunk
        val out = composeContext(listOf(Hit("a#0", "zzz", 1, 1.0)), idx, maxTokens = 1000)
        assertEquals(listOf(Source(1, "a#0", "a")), out.sources)
        assertFailsWith<IllegalArgumentException> { composeContext(listOf(hit("a", 1), Hit("nope#0", "nope", 2, 1.0)), idx, maxTokens = 1000) }
    }

    @Test
    fun allHitsAreResolvedBeforeAnyCost() = runTest {
        // the first hit alone would be budget_too_small, but the unknown chunk id after it is reported first
        val counted = mutableListOf<Message>()
        val e = assertFailsWith<IllegalArgumentException> {
            composeContext(listOf(hit("b", 1), Hit("nope#0", "nope", 2, 1.0)), index(), maxTokens = 1, counter = { counted += it; 1000 })
        }
        assertEquals(true, "nope#0" in (e.message ?: ""))
        assertEquals(emptyList(), counted, "no cost is computed before every hit is resolved")
    }

    @Test
    fun maxTokensIsValidated() = runTest {
        val e = assertFailsWith<RagException> { composeContext(emptyList(), index(), maxTokens = 0) }
        assertEquals(RagErrorKind.INVALID_OPTIONS, e.kind)
        assertEquals(null, e.required)
    }
}
