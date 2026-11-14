package es.sebas1705.ilabs.rag

import kotlinx.coroutines.test.runTest
import kotlin.math.ln
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class SearchTest {
    private val p = Chunking.Paragraph(100)

    /** An embedder that records its calls and answers with [answer]. */
    private class Recording(val answer: (List<String>) -> List<DoubleArray>) : Embedder {
        val calls = mutableListOf<List<String>>()
        override suspend fun embed(texts: List<String>): List<DoubleArray> {
            calls += texts
            return answer(texts)
        }
    }

    private suspend fun kind(block: suspend () -> Unit): RagErrorKind {
        try {
            block()
        } catch (e: RagException) {
            return e.kind
        }
        error("expected a RagException")
    }

    @Test
    fun bm25HandValues() = runTest {
        val single = buildIndex(listOf(Document("d", "rojo")), p)
        val hit = search(single, "rojo", Mode.BM25).single()
        assertEquals(Hit("d#0", "d", 1, ln(4.0 / 3.0)), hit)

        val tie = buildIndex(listOf(Document("zeta", "rojo verde"), Document("alfa", "verde rojo")), p)
        assertEquals(
            listOf(Hit("zeta#0", "zeta", 1, 0.1823215567939546), Hit("alfa#0", "alfa", 2, 0.1823215567939546)),
            search(tie, "rojo rojo ROJO", Mode.BM25),
        )

        // idf = ln(1.6); x: tf 2, len 3; y: tf 1, len 1; avgLen 4/3 (the empty-token chunk z counts in N and avgLen)
        val idx = buildIndex(listOf(Document("x", "uno uno dos"), Document("y", "uno"), Document("z", "¿?")), p)
        assertEquals(3, idx.chunks.size)
        val idf = ln(1.0 + (3 - 2 + 0.5) / (2 + 0.5))
        val avg = 4.0 / 3
        val x = idf * (2.0 * (1.2 + 1)) / (2.0 + 1.2 * (1 - 0.75 + 0.75 * 3.0 / avg))
        val y = idf * (1.0 * (1.2 + 1)) / (1.0 + 1.2 * (1 - 0.75 + 0.75 * 1.0 / avg))
        assertEquals(listOf(Hit("y#0", "y", 1, y), Hit("x#0", "x", 2, x)), search(idx, "uno", Mode.BM25))
        assertEquals(emptyList(), search(idx, "tres", Mode.BM25))
    }

    @Test
    fun topKCutsAndDefaultsToFive() = runTest {
        val docs = (1..7).map { Document("d$it", "rojo " + "x ".repeat(it)) }
        val idx = buildIndex(docs, p)
        assertEquals((1..5).map { "d$it#0" }, search(idx, "rojo", Mode.BM25).map { it.chunkId })
        assertEquals(listOf("d1#0", "d2#0"), search(idx, "rojo", Mode.BM25, topK = 2).map { it.chunkId })
        assertEquals(7, search(idx, "rojo", Mode.BM25, topK = 50).size)
        assertEquals(listOf(1, 2), search(idx, "rojo", Mode.BM25, topK = 2).map { it.rank })
    }

    @Test
    fun hybridFusesRanksWithTiesInIndexOrder() = runTest {
        val emb = Recording { texts ->
            if (texts.size == 3) listOf(doubleArrayOf(1.0, 0.0), doubleArrayOf(0.5, 0.0), doubleArrayOf(0.25, 0.0))
            else listOf(doubleArrayOf(1.0, 0.0))
        }
        val idx = buildIndex(listOf(Document("x", "uno uno dos"), Document("y", "uno"), Document("z", "tres")), p, emb)
        val hits = search(idx, "uno", Mode.HYBRID)
        assertEquals(
            listOf(
                Hit("x#0", "x", 1, 1.0 / 62 + 1.0 / 61, bm25Rank = 2, denseRank = 1),
                Hit("y#0", "y", 2, 1.0 / 61 + 1.0 / 62, bm25Rank = 1, denseRank = 2),
                Hit("z#0", "z", 3, 1.0 / 63, bm25Rank = null, denseRank = 3),
            ),
            hits,
        )
        // each list is cut at candidates before fusion
        val cut = search(idx, "uno", Mode.HYBRID, topK = 1, candidates = 1)
        assertEquals(listOf(Hit("x#0", "x", 1, 1.0 / 61, bm25Rank = null, denseRank = 1)), cut)
        // dense scores are plain dot products, ranks from the dense list alone
        assertEquals(listOf(1.0, 0.5, 0.25), search(idx, "uno", Mode.DENSE).map { it.score })
        assertTrue(search(idx, "uno", Mode.DENSE).all { it.bm25Rank == null && it.denseRank == null })
    }

    @Test
    fun denseExcludesZeroAndNegativeScores() = runTest {
        val emb = Recording { texts ->
            if (texts.size == 3) listOf(doubleArrayOf(-1.0, 0.0), doubleArrayOf(0.0, 1.0), doubleArrayOf(2.0, 0.0))
            else listOf(doubleArrayOf(1.0, 0.0))
        }
        val idx = buildIndex(listOf(Document("neg", "a"), Document("zero", "b"), Document("pos", "c")), p, emb)
        assertEquals(listOf(Hit("pos#0", "pos", 1, 2.0)), search(idx, "q", Mode.DENSE))
    }

    @Test
    fun embedderCallsAreExactlyThoseOfTheContract() = runTest {
        val emb = Recording { texts -> texts.map { hashEmbed(it) } }
        val empty = buildIndex(listOf(Document("e", "")), p, emb)
        assertEquals(0, emb.calls.size, "no build call for an index without chunks")
        assertEquals(emptyList(), search(empty, "hola", Mode.DENSE))
        assertEquals(0, emb.calls.size, "no query call on an empty index")

        val idx = buildIndex(listOf(Document("a", "hola mundo\n\nadios"), Document("b", "mundo")), Chunking.Paragraph(10), emb)
        assertEquals(listOf(listOf("hola mundo", "adios", "mundo")), emb.calls)
        search(idx, "mundo", Mode.BM25)
        assertEquals(1, emb.calls.size, "bm25 never embeds")
        assertEquals(emptyList(), search(idx, "¿?", Mode.DENSE))
        assertEquals(emptyList(), search(idx, "", Mode.HYBRID))
        assertEquals(1, emb.calls.size, "a query without tokens never embeds")
        search(idx, "mundo", Mode.DENSE)
        assertEquals(listOf("mundo"), emb.calls.last())
        search(idx, "mundo", Mode.HYBRID)
        assertEquals(3, emb.calls.size, "one query call per dense or hybrid search")
    }

    @Test
    fun queryWithoutTokensGivesNoHitsInEveryMode() = runTest {
        val idx = buildIndex(listOf(Document("a", "uno")), p, hashEmbedder())
        for (mode in Mode.entries) assertEquals(emptyList(), search(idx, "¡¿…?!", mode))
    }

    @Test
    fun noEmbedderIsCheckedBeforeEarlyReturnsButAfterOptions() = runTest {
        val idx = buildIndex(listOf(Document("a", "uno")), p)
        val empty = buildIndex(emptyList(), p)
        for (mode in listOf(Mode.DENSE, Mode.HYBRID)) {
            assertEquals(RagErrorKind.NO_EMBEDDER, kind { search(idx, "uno", mode) })
            assertEquals(RagErrorKind.NO_EMBEDDER, kind { search(idx, "¿?", mode) })
            assertEquals(RagErrorKind.NO_EMBEDDER, kind { search(empty, "uno", mode) })
            assertEquals(RagErrorKind.INVALID_OPTIONS, kind { search(idx, "uno", mode, topK = 0) })
        }
        assertEquals(RagErrorKind.INVALID_OPTIONS, kind { search(idx, "uno", Mode.HYBRID, candidates = 0) })
    }

    @Test
    fun candidatesAreValidatedInHybridOnly() = runTest {
        val idx = buildIndex(listOf(Document("a", "uno")), p, hashEmbedder())
        assertEquals(1, search(idx, "uno", Mode.BM25, candidates = 0).size)
        assertEquals(1, search(idx, "uno", Mode.DENSE, candidates = -4).size)
        assertEquals(RagErrorKind.INVALID_OPTIONS, kind { search(idx, "uno", Mode.HYBRID, candidates = 3) })
        assertEquals(RagErrorKind.INVALID_OPTIONS, kind { search(idx, "uno", Mode.HYBRID, topK = 4, candidates = 3) })
        assertEquals(1, search(idx, "uno", Mode.HYBRID, topK = 3, candidates = 3).size)
        assertEquals(1, search(idx, "uno", Mode.HYBRID, topK = 60).size)
        assertEquals(RagErrorKind.INVALID_OPTIONS, kind { search(idx, "uno", Mode.BM25, topK = -1) })
    }

    @Test
    fun embeddingsAreValidated() = runTest {
        val docs = listOf(Document("a", "uno"), Document("b", "dos"))
        val wrongCount = Recording { listOf(doubleArrayOf(1.0)) }
        assertEquals(RagErrorKind.INVALID_EMBEDDING, kind { buildIndex(docs, p, wrongCount) })
        val ragged = Recording { listOf(doubleArrayOf(1.0), doubleArrayOf(1.0, 0.0)) }
        assertEquals(RagErrorKind.INVALID_EMBEDDING, kind { buildIndex(docs, p, ragged) })

        val twoQueryVectors = Recording { t -> if (t.size == 2) listOf(doubleArrayOf(1.0), doubleArrayOf(0.0)) else listOf(doubleArrayOf(1.0), doubleArrayOf(1.0)) }
        val idx = buildIndex(docs, p, twoQueryVectors)
        // query validation happens in dense and hybrid alike; the call is made anyway (one call)
        assertEquals(RagErrorKind.INVALID_EMBEDDING, kind { search(idx, "uno", Mode.DENSE) })
        assertEquals(RagErrorKind.INVALID_EMBEDDING, kind { search(idx, "uno", Mode.HYBRID) })

        val wrongLength = Recording { t -> if (t.size == 2) listOf(doubleArrayOf(1.0), doubleArrayOf(0.0)) else listOf(doubleArrayOf(1.0, 0.0)) }
        val idx2 = buildIndex(docs, p, wrongLength)
        assertEquals(RagErrorKind.INVALID_EMBEDDING, kind { search(idx2, "uno", Mode.DENSE) })
        assertEquals(1, search(idx2, "uno", Mode.BM25).size)
    }

    @Test
    fun nonFiniteVectorsAreInvalidEmbeddings() = runTest {
        val docs = listOf(Document("a", "uno"), Document("b", "dos"))
        for (bad in listOf(Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY)) {
            val atBuild = Recording { listOf(doubleArrayOf(1.0), doubleArrayOf(bad)) }
            assertEquals(RagErrorKind.INVALID_EMBEDDING, kind { buildIndex(docs, p, atBuild) })
            val atQuery = Recording { t -> if (t.size == 2) listOf(doubleArrayOf(1.0), doubleArrayOf(0.5)) else listOf(doubleArrayOf(bad)) }
            val idx = buildIndex(docs, p, atQuery)
            assertEquals(RagErrorKind.INVALID_EMBEDDING, kind { search(idx, "uno", Mode.DENSE) })
            assertEquals(RagErrorKind.INVALID_EMBEDDING, kind { search(idx, "uno", Mode.HYBRID) })
        }
    }

    @Test
    fun buildIndexValidatesEverythingBeforeAnyWork() = runTest {
        val emb = Recording { texts -> texts.map { hashEmbed(it) } }
        assertEquals(RagErrorKind.INVALID_OPTIONS, kind { buildIndex(listOf(Document("a", "x"), Document("a", "y")), p, emb) })
        assertEquals(RagErrorKind.INVALID_OPTIONS, kind { buildIndex(listOf(Document("a", "x"), Document("", "y")), p, emb) })
        assertEquals(RagErrorKind.INVALID_OPTIONS, kind { buildIndex(listOf(Document("a", "x")), Chunking.Fixed(2, 2), emb) })
        assertEquals(0, emb.calls.size)
    }

    @Test
    fun indexOrderIsDocumentOrderThenChunkIndex() = runTest {
        val idx = buildIndex(listOf(Document("b", "abcdef"), Document("e", ""), Document("a", "xy")), Chunking.Fixed(4, 0))
        assertEquals(listOf("b#0", "b#1", "a#0"), idx.chunks.map { it.id })
    }

    @Test
    fun inputsAreNotMutatedAndVectorsAreCopied() = runTest {
        val stored = listOf(doubleArrayOf(1.0, 0.0))
        val emb = Recording { t -> if (t.size == 1 && t[0] == "uno") stored else listOf(doubleArrayOf(1.0, 0.0)) }
        val docs = mutableListOf(Document("a", "uno"))
        val idx = buildIndex(docs, p, emb)
        stored[0][0] = -5.0
        docs.clear()
        assertEquals(listOf("a#0"), idx.chunks.map { it.id })
        assertEquals(listOf(Hit("a#0", "a", 1, 1.0)), search(idx, "UNO", Mode.DENSE))
    }
}
