package es.sebas1705.ilabs.rag

import kotlin.math.sqrt

/** Turns texts into vectors: one vector per text, all of the same length. Plug a real model in through this interface. */
fun interface Embedder {
    suspend fun embed(texts: List<String>): List<DoubleArray>
}

/** UTF-8 bytes of one code point, encoded by hand; a lone surrogate (D800-DFFF) encodes as U+FFFD (`EF BF BD`). */
internal fun utf8Bytes(codePoint: Int): ByteArray {
    val cp = if (codePoint in 0xD800..0xDFFF) 0xFFFD else codePoint
    return when {
        cp < 0x80 -> byteArrayOf(cp.toByte())
        cp < 0x800 -> byteArrayOf((0xC0 or (cp shr 6)).toByte(), (0x80 or (cp and 0x3F)).toByte())
        cp < 0x10000 -> byteArrayOf(
            (0xE0 or (cp shr 12)).toByte(),
            (0x80 or ((cp shr 6) and 0x3F)).toByte(),
            (0x80 or (cp and 0x3F)).toByte(),
        )
        else -> byteArrayOf(
            (0xF0 or (cp shr 18)).toByte(),
            (0x80 or ((cp shr 12) and 0x3F)).toByte(),
            (0x80 or ((cp shr 6) and 0x3F)).toByte(),
            (0x80 or (cp and 0x3F)).toByte(),
        )
    }
}

private const val FNV_OFFSET: UInt = 0x811C9DC5u
private const val FNV_PRIME: UInt = 0x01000193u

/** FNV-1a 32-bit: `h = h XOR byte`, then `h = h * prime mod 2^32` (UInt arithmetic wraps). */
internal fun fnv1a32(bytes: ByteArray): UInt {
    var h = FNV_OFFSET
    for (b in bytes) {
        h = h xor (b.toInt() and 0xFF).toUInt()
        h *= FNV_PRIME
    }
    return h
}

private const val LT = 0x3C
private const val GT = 0x3E

/**
 * The built-in hashing embedder: character trigrams of `<token>` for every token of [tokenize] (so folded), hashed with
 * FNV-1a over hand-encoded UTF-8, bucket `h mod dim`, sign from bit 31, then L2-normalized (a text without tokens gives
 * the zero vector). It matches character n-grams, not meaning. Throws `RagException(invalid_options)` when `dim < 1`.
 */
fun hashEmbed(text: String, dim: Int = 256): DoubleArray {
    if (dim < 1) invalidOptions()
    val v = DoubleArray(dim)
    val udim = dim.toUInt()
    for (token in tokenize(text)) {
        val cps = codePoints(token)
        val w = IntArray(cps.size + 2)
        w[0] = LT
        cps.copyInto(w, 1)
        w[w.size - 1] = GT
        for (i in 0..w.size - 3) {
            val bytes = utf8Bytes(w[i]) + utf8Bytes(w[i + 1]) + utf8Bytes(w[i + 2])
            val h = fnv1a32(bytes)
            val bucket = (h % udim).toInt()
            v[bucket] += if (h and 0x80000000u == 0u) 1.0 else -1.0
        }
    }
    var s = 0.0
    for (i in 0 until dim) s += v[i] * v[i]
    if (s != 0.0) {
        val norm = sqrt(s)
        for (i in 0 until dim) v[i] = v[i] / norm
    }
    return v
}

/**
 * An [Embedder] backed by [hashEmbed]. `dim` is validated here, at construction, before any `embed` call
 * (`RagException(invalid_options)` when `dim < 1`).
 */
fun hashEmbedder(dim: Int = 256): Embedder {
    if (dim < 1) invalidOptions()
    return Embedder { texts -> texts.map { hashEmbed(it, dim) } }
}
