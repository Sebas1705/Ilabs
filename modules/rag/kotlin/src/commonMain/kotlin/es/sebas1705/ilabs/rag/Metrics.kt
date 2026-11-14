package es.sebas1705.ilabs.rag

/**
 * Scores [hits] (in ARRAY order: position `k` is rank `k`; `rank` is never read) against the non-empty set [relevant]
 * of chunk ids ([Level.CHUNK], default) or document ids ([Level.DOC], where the hits' document ids are deduplicated
 * keeping the first occurrence). One division per metric; precision divides by the length of the list (0 when empty).
 * Throws `RagException(invalid_options)` when [relevant] is empty.
 */
fun retrievalMetrics(hits: List<Hit>, relevant: Collection<String>, level: Level = Level.CHUNK): RetrievalMetrics {
    val relevantSet = LinkedHashSet(relevant)
    if (relevantSet.isEmpty()) invalidOptions()
    val list = when (level) {
        Level.CHUNK -> hits.map { it.chunkId }
        Level.DOC -> LinkedHashSet(hits.map { it.docId }).toList()
    }
    val present = HashSet(list)
    val found = relevantSet.count { it in present }
    val relevantEntries = list.count { it in relevantSet }
    val first = list.indexOfFirst { it in relevantSet }
    return RetrievalMetrics(
        recallAtK = found.toDouble() / relevantSet.size,
        precisionAtK = if (list.isEmpty()) 0.0 else relevantEntries.toDouble() / list.size,
        reciprocalRank = if (first < 0) 0.0 else 1.0 / (first + 1),
        hit = first >= 0,
    )
}
