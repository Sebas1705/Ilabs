package es.sebas1705.ilabs.rag

// Wildcard imports of the rag, providers and context packages plus kotlinx.serialization.json, as a consumer would
// write them. This file must compile without any import alias: the main package exposes only the library API (the
// fixture harness lives in `...rag.contract`), and no public name may clash with the other packages.
import es.sebas1705.ilabs.context.*
import es.sebas1705.ilabs.providers.*
import es.sebas1705.ilabs.rag.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import kotlin.test.Test
import kotlin.test.assertEquals

class WildcardImportsTest {
    @Test
    fun ragProvidersContextAndJsonWildcardImportsDoNotClash() = runTest {
        val index: RagIndex = buildIndex(listOf(Document("a", "La biblioteca abre a las nueve.")), Chunking.Paragraph(120), hashEmbedder())
        val hits: List<Hit> = search(index, "biblioteca", Mode.HYBRID, topK = 1)
        val composed: ComposedContext = composeContext(hits, index, maxTokens = 200, counter = defaultCounter)
        val provider: Provider = MockProvider("m", listOf(ScriptEntry(response = "Abre a las nueve [1].")))
        val answer: Answer = answerWithSources(provider, index, "biblioteca", Mode.BM25, maxTokens = 200)
        assertEquals(Citations(listOf(1), emptyList()), answer.citations)
        assertEquals(listOf(Source(1, "a#0", "a")), composed.sources)
        val metrics: RetrievalMetrics = retrievalMetrics(hits, listOf("a"), Level.DOC)
        assertEquals(1.0, metrics.recallAtK)
        assertEquals(listOf("abre"), tokenize("¡Abre!"))
        assertEquals(256, hashEmbed("abre").size)
        assertEquals(1, chunkDocument(Document("b", "x"), Chunking.Fixed(4, 0)).size)
        assertEquals(RagErrorKind.NO_EMBEDDER.wire, RagException(RagErrorKind.NO_EMBEDDER).kind.wire)
        assertEquals(JsonPrimitive(RAG_INSTRUCTION.length), JsonPrimitive(141))
        assertEquals(Role.SYSTEM, composed.message.role)
        val embedder: Embedder = hashEmbedder(8)
        assertEquals(8, embedder.embed(listOf("x")).single().size)
    }
}
