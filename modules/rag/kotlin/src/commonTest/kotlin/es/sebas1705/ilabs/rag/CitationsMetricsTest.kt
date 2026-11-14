package es.sebas1705.ilabs.rag

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class CitationsMetricsTest {
    private fun sources(vararg n: Int) = n.map { Source(it, "c$it", "d") }

    @Test
    fun markersInFirstAppearanceOrder() {
        assertEquals(Citations(listOf(2, 1, 3), emptyList()), extractCitations("[2] then [1], [2] and [3][1]", sources(1, 2, 3)))
        assertEquals(Citations(listOf(1), listOf(7, 4)), extractCitations("[7] [1] [4] [7]", sources(1, 2)))
        assertEquals(Citations(listOf(2, 3), listOf(1)), extractCitations("[1] [2] [3]", sources(2, 3)))
        assertEquals(Citations(emptyList(), emptyList()), extractCitations("", emptyList()))
    }

    @Test
    fun onlyExactMarkersCount() {
        val all = sources(0, 1, 2, 3)
        assertEquals(
            Citations(listOf(2), emptyList()),
            extractCitations("[1,2] [ 1 ] [01] [0] [1a] [-1] [+1] [] [1 ] [2]", all),
        )
        assertEquals(Citations(emptyList(), listOf(123456789)), extractCitations("[1234567890] [123456789]", all))
        assertEquals(Citations(listOf(1), emptyList()), extractCitations("[٢] [３] [1]", all))
        assertEquals(Citations(listOf(2, 1), emptyList()), extractCitations("[[2]] [3[1]] [1", all))
        assertEquals(Citations(listOf(1, 2), emptyList()), extractCitations("x[1][2]😀[", all))
    }

    private fun hits(vararg ids: String) = ids.mapIndexed { i, id -> Hit(id, id.substringBefore('#'), i + 1, 1.0) }

    @Test
    fun chunkLevelMetrics() {
        assertEquals(
            RetrievalMetrics(2.0 / 3, 0.5, 1.0 / 3, true),
            retrievalMetrics(hits("x#0", "y#0", "a#0", "b#0"), listOf("a#0", "b#0", "c#0")),
        )
        assertEquals(RetrievalMetrics(0.0, 0.0, 0.0, false), retrievalMetrics(emptyList(), listOf("a#0")))
        assertEquals(RetrievalMetrics(0.0, 0.0, 0.0, false), retrievalMetrics(hits("a#0"), listOf("a")))
        // relevant is a set; chunk-level hits are not deduplicated
        assertEquals(RetrievalMetrics(0.5, 1.0, 1.0, true), retrievalMetrics(hits("a#0", "a#0"), listOf("a#0", "a#0", "b#0")))
    }

    @Test
    fun docLevelDeduplicatesKeepingTheFirst() {
        assertEquals(
            RetrievalMetrics(1.0, 2.0 / 3, 0.5, true),
            retrievalMetrics(hits("a#0", "a#1", "b#0", "c#2"), listOf("b", "c"), Level.DOC),
        )
        assertEquals(
            RetrievalMetrics(1.0, 1.0 / 3, 1.0 / 3, true),
            retrievalMetrics(hits("a#0", "b#0", "a#1", "c#0"), listOf("c"), Level.DOC),
        )
    }

    @Test
    fun hitsAreUsedInArrayOrder() {
        // ranks disagree with the array order: position is the rank
        val shuffled = listOf(Hit("x#0", "x", 1, 1.0), Hit("a#0", "a", 9, 1.0))
        assertEquals(RetrievalMetrics(1.0, 0.5, 0.5, true), retrievalMetrics(shuffled, listOf("a#0")))
        assertEquals(listOf(Hit("x#0", "x", 1, 1.0), Hit("a#0", "a", 9, 1.0)), shuffled)
    }

    @Test
    fun emptyRelevantIsInvalid() {
        val e = assertFailsWith<RagException> { retrievalMetrics(hits("a#0"), emptyList()) }
        assertEquals(RagErrorKind.INVALID_OPTIONS, e.kind)
    }

    @Test
    fun wireNamesParseOrFail() {
        assertEquals(Level.DOC, parseLevel("doc"))
        assertEquals(Level.CHUNK, parseLevel("chunk"))
        assertEquals(Mode.HYBRID, parseMode("hybrid"))
        for (bad in listOf("Doc", "page", "")) assertEquals(RagErrorKind.INVALID_OPTIONS, assertFailsWith<RagException> { parseLevel(bad) }.kind)
        for (bad in listOf("BM25", "sparse", "")) assertEquals(RagErrorKind.INVALID_OPTIONS, assertFailsWith<RagException> { parseMode(bad) }.kind)
        assertEquals(listOf("bm25", "dense", "hybrid"), Mode.entries.map { it.wire })
        assertEquals(
            listOf("invalid_options", "no_embedder", "invalid_embedding", "budget_too_small"),
            RagErrorKind.entries.map { it.wire },
        )
    }
}
