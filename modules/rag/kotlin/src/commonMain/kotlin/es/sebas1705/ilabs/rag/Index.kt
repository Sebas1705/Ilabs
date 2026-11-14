package es.sebas1705.ilabs.rag

/** True when no component is NaN or infinite (such a vector is `invalid_embedding`). */
internal fun allFinite(v: DoubleArray): Boolean = v.all { !it.isNaN() && !it.isInfinite() }

/**
 * Validates the documents (non-empty, unique ids) and [chunking], chunks every document in order and, when an
 * [embedder] is given and there is at least one chunk, embeds all chunk texts with ONE call in index order. The result
 * must hold exactly one vector per chunk, all of the same length and finite, else `RagException(invalid_embedding)`.
 * Neither [documents] nor the returned vectors are kept by reference.
 */
suspend fun buildIndex(documents: List<Document>, chunking: Chunking, embedder: Embedder? = null): RagIndex {
    val seen = HashSet<String>()
    for (doc in documents) {
        if (doc.id.isEmpty() || !seen.add(doc.id)) invalidOptions()
    }
    validateChunking(chunking)
    val chunks = documents.flatMap { chunkUnchecked(it, chunking) }
    val tokens = chunks.map { tokenize(it.text) }
    var vectors: List<DoubleArray> = emptyList()
    if (embedder != null && chunks.isNotEmpty()) {
        val result = embedder.embed(chunks.map { it.text })
        if (result.size != chunks.size) throw RagException(RagErrorKind.INVALID_EMBEDDING)
        val length = result[0].size
        if (result.any { it.size != length || !allFinite(it) }) throw RagException(RagErrorKind.INVALID_EMBEDDING)
        vectors = result.map { it.copyOf() }
    }
    return RagIndex(chunks, tokens, embedder, vectors)
}
