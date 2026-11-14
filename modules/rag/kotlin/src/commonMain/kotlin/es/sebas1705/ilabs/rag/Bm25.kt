package es.sebas1705.ilabs.rag

import kotlin.math.ln

private const val K1 = 1.2
private const val B = 0.75

/** A scored chunk before ranking: [position] is its index order. */
internal class Scored(val position: Int, val score: Double)

/**
 * BM25 scores of the chunks that contain at least one query token (score > 0), in index order. Distinct query tokens
 * in order of first appearance; terms added in that order from 0.0, each computed exactly as the contract's expression
 * reads, left to right.
 */
internal fun bm25(index: RagIndex, queryTokens: List<String>): List<Scored> {
    val n = index.chunks.size
    if (n == 0) return emptyList()
    val distinct = LinkedHashSet(queryTokens).toList()
    val avgLen = index.totalLength.toDouble() / n
    val idfs = DoubleArray(distinct.size) { k ->
        val df = index.documentFrequencies[distinct[k]] ?: 0
        ln(1.0 + (n - df + 0.5) / (df + 0.5))
    }
    val out = ArrayList<Scored>()
    for (c in 0 until n) {
        val tfs = index.termFrequencies[c]
        val len = index.tokens[c].size.toDouble()
        var score = 0.0
        var matched = false
        for (k in distinct.indices) {
            val tfCount = tfs[distinct[k]] ?: continue
            val tf = tfCount.toDouble()
            score += idfs[k] * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * len / avgLen))
            matched = true
        }
        if (matched && score > 0.0) out += Scored(c, score)
    }
    return out
}
