package es.sebas1705.ilabs.rag

import es.sebas1705.ilabs.providers.Message

/** A document: [id] non-empty and unique within one [buildIndex] call; [text] any string (empty is valid). */
data class Document(val id: String, val text: String)

/** How a document is split into chunks. Options are validated by the operations, not by the constructors. */
sealed interface Chunking {
    /** Windows of [size] code points advancing by `size - overlap`; `size >= 1`, `0 <= overlap < size`. */
    data class Fixed(val size: Int, val overlap: Int) : Chunking

    /** Paragraphs packed greedily while the original slice has `<= maxSize` code points; `maxSize >= 1`. */
    data class Paragraph(val maxSize: Int) : Chunking
}

/** A chunk: [start]/[end] are code-point offsets into the document text (`end` exclusive); `id = docId + "#" + index`. */
data class Chunk(val id: String, val docId: String, val index: Int, val text: String, val start: Int, val end: Int)

/** Retrieval method of [search]. */
enum class Mode(val wire: String) {
    BM25("bm25"),
    DENSE("dense"),
    HYBRID("hybrid"),
}

/** A ranked hit. [bm25Rank] and [denseRank] are set in hybrid mode only, exactly when the chunk is in that cut list. */
data class Hit(
    val chunkId: String,
    val docId: String,
    val rank: Int,
    val score: Double,
    val bm25Rank: Int? = null,
    val denseRank: Int? = null,
)

/** A numbered source of a composed context: [n] is its 1-based number in the message. */
data class Source(val n: Int, val chunkId: String, val docId: String)

/** Result of [composeContext]: ONE system [message], the kept [sources] and how many hits were dropped. */
data class ComposedContext(val message: Message, val sources: List<Source>, val droppedCount: Int)

/** Citation markers of an answer in order of first appearance: those that name a source, and the others. */
data class Citations(val cited: List<Int>, val unknown: List<Int>)

/** Granularity of [retrievalMetrics]. */
enum class Level(val wire: String) {
    CHUNK("chunk"),
    DOC("doc"),
}

/** Retrieval metrics over a list of hits (IEEE-754 doubles). */
data class RetrievalMetrics(val recallAtK: Double, val precisionAtK: Double, val reciprocalRank: Double, val hit: Boolean)

/** Result of [answerWithSources]: the reply text verbatim, the KEPT sources, their citations and the search hits. */
data class Answer(val answer: String, val sources: List<Source>, val citations: Citations, val hits: List<Hit>)

/** A list view without mutators: a Kotlin read-only class, so it cannot be cast to `MutableList`. */
private class ReadOnlyList<T>(private val items: List<T>) : AbstractList<T>() {
    override val size: Int get() = items.size
    override fun get(index: Int): T = items[index]
}

/**
 * An in-memory index built by [buildIndex]. [chunks] are in index order (document order, then chunk index); the token
 * statistics and the chunk vectors are internal.
 */
class RagIndex internal constructor(
    chunks: List<Chunk>,
    internal val tokens: List<List<String>>,
    internal val embedder: Embedder?,
    internal val vectors: List<DoubleArray>,
) {
    /** The chunks in index order: a read-only copy (casting it to `MutableList` fails; Java mutators throw). */
    val chunks: List<Chunk> = ReadOnlyList(chunks.toList())

    internal val position: Map<String, Int> = HashMap<String, Int>().also { map -> chunks.forEachIndexed { i, c -> map[c.id] = i } }

    /** Per chunk: occurrences of each token. */
    internal val termFrequencies: List<Map<String, Int>> = tokens.map { list ->
        HashMap<String, Int>().also { tf -> for (t in list) tf[t] = (tf[t] ?: 0) + 1 }
    }

    /** Per token: number of chunks that contain it at least once. */
    internal val documentFrequencies: Map<String, Int> = HashMap<String, Int>().also { df ->
        for (tf in termFrequencies) for (t in tf.keys) df[t] = (df[t] ?: 0) + 1
    }

    /** Sum of the token counts of ALL chunks (chunks without tokens included). */
    internal val totalLength: Int = tokens.sumOf { it.size }
}
