package es.sebas1705.ilabs.rag

private const val DEFAULT_CANDIDATES = 50
private const val RRF_K = 60

/** Total order: score descending (only exactly equal doubles tie), then index order ascending. */
private val RANKING: Comparator<Scored> = Comparator { a, b ->
    val byScore = b.score.compareTo(a.score)
    if (byScore != 0) byScore else a.position.compareTo(b.position)
}

/** `invalid_options` unless the search options follow the rules; [candidates] is validated in hybrid mode only. */
internal fun validateSearchOptions(mode: Mode, topK: Int, candidates: Int?) {
    if (topK < 1) invalidOptions()
    if (mode == Mode.HYBRID && candidates != null && (candidates < 1 || candidates < topK)) invalidOptions()
}

private suspend fun dense(index: RagIndex, embedder: Embedder, query: String): List<Scored> {
    val result = embedder.embed(listOf(query))
    val length = index.vectors[0].size
    if (result.size != 1 || result[0].size != length || !allFinite(result[0])) throw RagException(RagErrorKind.INVALID_EMBEDDING)
    val q = result[0]
    val out = ArrayList<Scored>()
    for ((c, v) in index.vectors.withIndex()) {
        var score = 0.0
        for (d in 0 until length) score += q[d] * v[d]
        if (score > 0.0) out += Scored(c, score)
    }
    return out
}

private fun hit(index: RagIndex, scored: Scored, rank: Int, bm25Rank: Int? = null, denseRank: Int? = null): Hit {
    val chunk = index.chunks[scored.position]
    return Hit(chunk.id, chunk.docId, rank, scored.score, bm25Rank, denseRank)
}

/**
 * Retrieves the best chunks of [index] for [query]. [topK] (default 5) is an integer `>= 1`; [candidates] is used and
 * validated in [Mode.HYBRID] only (null means 50 and is never compared with [topK]), and ignored otherwise. Order of
 * steps: options (`invalid_options`), then `no_embedder` for dense/hybrid on an index without embedder, then no hits
 * for a query without tokens or an index without chunks (the embedder is not called), then ranking.
 */
suspend fun search(index: RagIndex, query: String, mode: Mode, topK: Int = 5, candidates: Int? = null): List<Hit> {
    validateSearchOptions(mode, topK, candidates)
    // dense and hybrid need an embedder: checked BEFORE the early returns below
    val embedder = if (mode == Mode.BM25) null else index.embedder ?: throw RagException(RagErrorKind.NO_EMBEDDER)
    val queryTokens = tokenize(query)
    if (queryTokens.isEmpty() || index.chunks.isEmpty()) return emptyList()
    if (embedder == null) return bm25(index, queryTokens).sortedWith(RANKING).take(topK).mapIndexed { i, s -> hit(index, s, i + 1) }

    // here the mode is dense or hybrid (only bm25 has no embedder)
    if (mode == Mode.DENSE) return dense(index, embedder, query).sortedWith(RANKING).take(topK).mapIndexed { i, s -> hit(index, s, i + 1) }

    // hybrid: reciprocal-rank fusion of the two lists, each cut at candidates
    val cut = candidates ?: DEFAULT_CANDIDATES
    val bm25List = bm25(index, queryTokens).sortedWith(RANKING).take(cut)
    val denseList = dense(index, embedder, query).sortedWith(RANKING).take(cut)
    val bm25Ranks = HashMap<Int, Int>()
    bm25List.forEachIndexed { i, s -> bm25Ranks[s.position] = i + 1 }
    val denseRanks = HashMap<Int, Int>()
    denseList.forEachIndexed { i, s -> denseRanks[s.position] = i + 1 }
    val positions = (bm25Ranks.keys + denseRanks.keys).sorted()
    val fused = positions.map { p ->
        val b = bm25Ranks[p]
        val d = denseRanks[p]
        // the BM25 term first, then the dense one
        val score = (if (b != null) 1.0 / (RRF_K + b) else 0.0) + (if (d != null) 1.0 / (RRF_K + d) else 0.0)
        Scored(p, score)
    }
    return fused.sortedWith(RANKING).take(topK).mapIndexed { i, s -> hit(index, s, i + 1, bm25Ranks[s.position], denseRanks[s.position]) }
}
