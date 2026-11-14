package es.sebas1705.ilabs.rag

private const val LF = 0x0A
private const val CR = 0x0D

/** `invalid_options` unless [chunking] follows the option rules. */
internal fun validateChunking(chunking: Chunking) {
    when (chunking) {
        is Chunking.Fixed -> if (chunking.size < 1 || chunking.overlap < 0 || chunking.overlap >= chunking.size) invalidOptions()
        is Chunking.Paragraph -> if (chunking.maxSize < 1) invalidOptions()
    }
}

/** A code-point view of a text: [starts] maps code-point offset `k` to its UTF-16 index (`starts[length]` is the end). */
private class CodePointText(val text: String) {
    val cps: IntArray = codePoints(text)
    val length: Int get() = cps.size
    val starts: IntArray = IntArray(cps.size + 1).also { starts ->
        var i = 0
        for (k in cps.indices) {
            starts[k] = i
            i += codePointWidth(text, i)
        }
        starts[cps.size] = text.length
    }

    fun slice(start: Int, end: Int): String = text.substring(starts[start], starts[end])
}

/** The `fixed` windows over `[from, to)`: the last window ends at `to`; nothing after it. */
private fun fixedWindows(from: Int, to: Int, size: Int, overlap: Int, emit: (Int, Int) -> Unit) {
    if (to <= from) return
    var s = from
    while (true) {
        val e = if (size >= to - s) to else s + size
        emit(s, e)
        if (e == to) return
        s += size - overlap
    }
}

private fun onlySpaceTabCrLf(cps: IntArray, a: Int, b: Int): Boolean {
    for (k in a until b) {
        val cp = cps[k]
        if (cp != 0x20 && cp != 0x09 && cp != CR && cp != LF) return false
    }
    return true
}

/** Paragraph spans `[a, b)` (whitespace-only ones already dropped), from the line-break runs of the contract. */
private fun paragraphs(cps: IntArray): List<IntArray> {
    val length = cps.size
    // 1. line breaks: CRLF greedily from the left, then LF; a lone CR is ordinary
    val breakStarts = ArrayList<Int>()
    val breakEnds = ArrayList<Int>()
    var i = 0
    while (i < length) {
        if (cps[i] == CR && i + 1 < length && cps[i + 1] == LF) {
            breakStarts += i
            breakEnds += i + 2
            i += 2
        } else if (cps[i] == LF) {
            breakStarts += i
            breakEnds += i + 1
            i += 1
        } else {
            i += 1
        }
    }
    // 2. runs of directly adjacent breaks; a separator has 2+ breaks, or starts at 0, or ends at the length
    val out = ArrayList<IntArray>()
    var paragraphStart = 0
    var r = 0
    while (r < breakStarts.size) {
        val runStart = breakStarts[r]
        var runEnd = breakEnds[r]
        var count = 1
        while (r + count < breakStarts.size && breakStarts[r + count] == runEnd) {
            runEnd = breakEnds[r + count]
            count++
        }
        r += count
        if (count >= 2 || runStart == 0 || runEnd == length) {
            // 3. the paragraph before this separator, if non-empty
            if (runStart > paragraphStart) out += intArrayOf(paragraphStart, runStart)
            paragraphStart = runEnd
        }
    }
    if (length > paragraphStart) out += intArrayOf(paragraphStart, length)
    return out.filter { !onlySpaceTabCrLf(cps, it[0], it[1]) }
}

/** Chunks of [doc] without validation (callers validate first). */
internal fun chunkUnchecked(doc: Document, chunking: Chunking): List<Chunk> {
    val view = CodePointText(doc.text)
    val chunks = ArrayList<Chunk>()
    fun emit(start: Int, end: Int) {
        val index = chunks.size
        chunks += Chunk(doc.id + "#" + index, doc.id, index, view.slice(start, end), start, end)
    }
    when (chunking) {
        is Chunking.Fixed -> fixedWindows(0, view.length, chunking.size, chunking.overlap, ::emit)
        is Chunking.Paragraph -> {
            val maxSize = chunking.maxSize
            var packStart = -1
            var packEnd = -1
            fun flush() {
                if (packStart >= 0) emit(packStart, packEnd)
                packStart = -1
                packEnd = -1
            }
            for (p in paragraphs(view.cps)) {
                val a = p[0]
                val b = p[1]
                if (b - a > maxSize) {
                    flush()
                    fixedWindows(a, b, maxSize, 0, ::emit)
                } else if (packStart >= 0 && b - packStart <= maxSize) {
                    packEnd = b
                } else {
                    flush()
                    packStart = a
                    packEnd = b
                }
            }
            flush()
        }
    }
    return chunks
}

/**
 * Splits [doc] into chunks with [chunking]. Offsets are code points of the ORIGINAL text and every chunk text is the
 * original slice. Throws `RagException(invalid_options)` for an empty document id or invalid chunking options.
 */
fun chunkDocument(doc: Document, chunking: Chunking): List<Chunk> {
    if (doc.id.isEmpty()) invalidOptions()
    validateChunking(chunking)
    return chunkUnchecked(doc, chunking)
}
