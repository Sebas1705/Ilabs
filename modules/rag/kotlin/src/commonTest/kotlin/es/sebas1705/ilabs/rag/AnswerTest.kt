package es.sebas1705.ilabs.rag

import es.sebas1705.ilabs.providers.CompletionRequest
import es.sebas1705.ilabs.providers.CompletionResponse
import es.sebas1705.ilabs.providers.ErrorKind
import es.sebas1705.ilabs.providers.Message
import es.sebas1705.ilabs.providers.Provider
import es.sebas1705.ilabs.providers.ProviderException
import es.sebas1705.ilabs.providers.Role
import kotlinx.coroutines.test.runTest
import kotlin.coroutines.cancellation.CancellationException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertSame

class AnswerTest {
    private class Fake(val reply: suspend (CompletionRequest) -> String) : Provider {
        override val id = "fake"
        val requests = mutableListOf<CompletionRequest>()
        override suspend fun complete(req: CompletionRequest): CompletionResponse {
            requests += req
            return CompletionResponse(reply(req), id)
        }
    }

    private suspend fun index(embedder: Embedder? = null) = buildIndex(
        listOf(Document("a", "Alfa rojo.\n\nBravo rojo rojo."), Document("b", "Charlie verde.")),
        Chunking.Paragraph(16),
        embedder,
    ).also { check(it.chunks.size == 3) }

    @Test
    fun oneCallWithTheComposedSystemMessageAndTheQuery() = runTest {
        val provider = Fake { "  See [1] and [3].\n" }
        val idx = index()
        val out = answerWithSources(provider, idx, "rojo", Mode.BM25, topK = 5, maxTokens = 1000)
        val hits = search(idx, "rojo", Mode.BM25)
        val composed = composeContext(hits, idx, 1000)
        assertEquals(
            listOf(CompletionRequest(listOf(Message(Role.SYSTEM, composed.message.content), Message(Role.USER, "rojo")))),
            provider.requests,
        )
        assertEquals(null, provider.requests.single().maxTokens)
        assertEquals(Answer("  See [1] and [3].\n", composed.sources, Citations(listOf(1), listOf(3)), hits), out)
    }

    @Test
    fun sourcesAreTheKeptOnes() = runTest {
        val provider = Fake { "[1] [2]" }
        val idx = index()
        val hits = search(idx, "rojo", Mode.BM25)
        val oneSource = es.sebas1705.ilabs.context.defaultCounter(Message(Role.SYSTEM, "$RAG_INSTRUCTION\n\n[1] ${idx.chunks[1].text}"))
        val out = answerWithSources(provider, idx, "rojo", Mode.BM25, maxTokens = oneSource)
        assertEquals(2, hits.size)
        assertEquals(listOf(Source(1, "a#1", "a")), out.sources)
        assertEquals(Citations(listOf(1), listOf(2)), out.citations)
        assertEquals(hits, out.hits)
    }

    @Test
    fun noHitsStillCall() = runTest {
        val provider = Fake { "No sé." }
        val out = answerWithSources(provider, index(), "zzz", Mode.BM25, maxTokens = 40)
        assertEquals(RAG_INSTRUCTION, provider.requests.single().messages[0].content)
        assertEquals(emptyList(), out.sources)
        assertEquals(emptyList(), out.hits)
    }

    @Test
    fun ragErrorsHappenBeforeTheCall() = runTest {
        val provider = Fake { "x" }
        val idx = index()
        suspend fun kind(block: suspend () -> Unit): RagErrorKind? = try {
            block()
            null
        } catch (e: RagException) {
            e.kind
        }
        assertEquals(RagErrorKind.INVALID_OPTIONS, kind { answerWithSources(provider, idx, "rojo", Mode.BM25, topK = 0, maxTokens = 100) })
        assertEquals(RagErrorKind.INVALID_OPTIONS, kind { answerWithSources(provider, idx, "rojo", Mode.BM25, maxTokens = 0) })
        assertEquals(RagErrorKind.INVALID_OPTIONS, kind { answerWithSources(provider, idx, "rojo", Mode.HYBRID, candidates = 2, maxTokens = 100) })
        // invalid_options wins over no_embedder: everything is validated before searching
        assertEquals(RagErrorKind.INVALID_OPTIONS, kind { answerWithSources(provider, idx, "rojo", Mode.DENSE, maxTokens = 0) })
        assertEquals(RagErrorKind.NO_EMBEDDER, kind { answerWithSources(provider, idx, "rojo", Mode.DENSE, maxTokens = 100) })
        assertEquals(RagErrorKind.BUDGET_TOO_SMALL, kind { answerWithSources(provider, idx, "rojo", Mode.BM25, maxTokens = 41) })
        assertEquals(RagErrorKind.BUDGET_TOO_SMALL, kind { answerWithSources(provider, idx, "zzz", Mode.BM25, maxTokens = 39) })
        // candidates is ignored outside hybrid
        assertEquals(null, kind { answerWithSources(provider, idx, "rojo", Mode.BM25, candidates = 0, maxTokens = 100) })
        assertEquals(1, provider.requests.size)
    }

    @Test
    fun providerErrorsPropagateUnchangedAfterOneCall() = runTest {
        val boom = ProviderException(ErrorKind.RATE_LIMIT, 250)
        val provider = Fake { throw boom }
        val thrown = assertFailsWith<ProviderException> { answerWithSources(provider, index(), "rojo", Mode.BM25, maxTokens = 1000) }
        assertSame(boom, thrown)
        assertEquals(1, provider.requests.size)
    }

    @Test
    fun otherExceptionsAndCancellationPropagateUnchanged() = runTest {
        val bug = IllegalStateException("bug")
        assertSame(bug, assertFailsWith<IllegalStateException> { answerWithSources(Fake { throw bug }, index(), "rojo", Mode.BM25, maxTokens = 1000) })
        val cancel = CancellationException("stop")
        assertSame(cancel, assertFailsWith<CancellationException> { answerWithSources(Fake { throw cancel }, index(), "rojo", Mode.BM25, maxTokens = 1000) })
        val embedCancel = CancellationException("embed")
        val idx = index { t -> if (t.size == 3) t.map { hashEmbed(it) } else throw embedCancel }
        assertSame(embedCancel, assertFailsWith<CancellationException> { answerWithSources(Fake { "x" }, idx, "rojo", Mode.HYBRID, maxTokens = 1000) })
    }
}
