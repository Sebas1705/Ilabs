package es.sebas1705.ilabs.rag

import es.sebas1705.ilabs.context.TokenCounter
import es.sebas1705.ilabs.context.defaultCounter
import es.sebas1705.ilabs.providers.Message
import es.sebas1705.ilabs.providers.Role

/** The pinned instruction that opens every composed context (141 code points, ASCII; see `contracts/rag/README.md`). */
const val RAG_INSTRUCTION =
    "Answer the question using only the numbered sources below. Cite the sources you use as [n]. If the sources do not contain the answer, say so."

/**
 * Composes ONE system message: [RAG_INSTRUCTION], a blank line, then `[n] <chunk text>` entries separated by a blank
 * line, no trailing newline (the instruction alone with no source). Walks [hits] in ARRAY order (`rank` is never read)
 * and keeps hit `k` as source `n = k` while the message with sources `1..k` costs `<= maxTokens` under [counter]; the
 * first misfit stops the walk. Throws `RagException(budget_too_small)` with `required` = the cost of the message with
 * the first source (or of the instruction alone for empty hits) when even that does not fit, and
 * `RagException(invalid_options)` when `maxTokens < 1`. Every hit must name a chunk of [index]
 * (`IllegalArgumentException` otherwise); a source's `chunkId`/`docId` are those of that index chunk.
 */
fun composeContext(hits: List<Hit>, index: RagIndex, maxTokens: Int, counter: TokenCounter = defaultCounter): ComposedContext {
    if (maxTokens < 1) invalidOptions()
    // every hit is resolved first (before any cost is computed); the source's docId comes from the index chunk
    val chunks = hits.map { hit ->
        val position = index.position[hit.chunkId] ?: throw IllegalArgumentException("hit ${hit.chunkId} is not a chunk of the index")
        index.chunks[position]
    }
    if (hits.isEmpty()) {
        val message = Message(Role.SYSTEM, RAG_INSTRUCTION)
        val cost = counter(message)
        if (cost > maxTokens) throw RagException(RagErrorKind.BUDGET_TOO_SMALL, cost)
        return ComposedContext(message, emptyList(), 0)
    }
    val content = StringBuilder(RAG_INSTRUCTION)

    /** The message with sources `1..k + 1`: appends the entry of chunk `k` to the content built so far. */
    fun withSource(k: Int): Message {
        content.append("\n\n[").append(k + 1).append("] ").append(chunks[k].text)
        return Message(Role.SYSTEM, content.toString())
    }

    var kept = withSource(0)
    val firstCost = counter(kept)
    if (firstCost > maxTokens) throw RagException(RagErrorKind.BUDGET_TOO_SMALL, firstCost)
    val sources = arrayListOf(Source(1, chunks[0].id, chunks[0].docId))
    for (k in 1 until chunks.size) {
        val candidate = withSource(k)
        if (counter(candidate) > maxTokens) break // the first misfit stops the walk: no skipping
        kept = candidate
        sources += Source(k + 1, chunks[k].id, chunks[k].docId)
    }
    return ComposedContext(kept, sources, hits.size - sources.size)
}
