package es.sebas1705.ilabs.vision

import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/** `roundHalfUp(v) = floor(v + 0.5)`: the only rounding of the module. */
internal fun roundHalfUp(v: Double): Double = floor(v + 0.5)

/** A rounded double clamped to a byte value `0..255`, written back by explicit conversion. */
private fun byteOf(v: Double): Byte {
    val rounded = roundHalfUp(v)
    val clamped = if (rounded < 0.0) 0 else if (rounded > 255.0) 255 else rounded.toInt()
    return clamped.toByte()
}

/**
 * Source positions of one axis for the destination indices `start until start + count` of a resize to `dst` samples:
 * every line one double operation, in the contract's order.
 */
private class Axis(count: Int) {
    val i0 = IntArray(count)
    val i1 = IntArray(count)
    val w0 = DoubleArray(count)
    val w1 = DoubleArray(count)
}

private fun axis(start: Int, count: Int, src: Int, dst: Int, method: ResizeMethod): Axis {
    val axis = Axis(count)
    val srcD = src.toDouble()
    val dstD = dst.toDouble()
    val last = (src - 1).toDouble()
    for (k in 0 until count) {
        val t = (start + k).toDouble() + 0.5
        val u = t * srcD
        val v = u / dstD
        val s = v - 0.5
        if (method == ResizeMethod.NEAREST) {
            val i = floor(s + 0.5)
            axis.i0[k] = min(max(i, 0.0), last).toInt()
        } else {
            val p0 = floor(s)
            val f = s - p0
            val p1 = p0 + 1.0
            axis.i0[k] = min(max(p0, 0.0), last).toInt()
            axis.i1[k] = min(max(p1, 0.0), last).toInt()
            axis.w0[k] = 1.0 - f
            axis.w1[k] = f
        }
    }
    return axis
}

/**
 * The pixels `[cropX, cropX + outW) x [cropY, cropY + outH)` of [image] resized to `scaledW x scaledH`, without ever
 * allocating the scaled image (`scaledW` and `scaledH` may exceed 16,384). The image must be valid.
 */
internal fun resizeWindow(image: Image, scaledW: Int, scaledH: Int, cropX: Int, cropY: Int, outW: Int, outH: Int, method: ResizeMethod): ByteArray {
    val out = ByteArray(outW * outH * 3)
    val xs = axis(cropX, outW, image.width, scaledW, method)
    val ys = axis(cropY, outH, image.height, scaledH, method)
    val src = image.data
    val width = image.width
    var o = 0
    for (y in 0 until outH) {
        if (method == ResizeMethod.NEAREST) {
            val rowBase = ys.i0[y] * width
            for (x in 0 until outW) {
                val p = (rowBase + xs.i0[x]) * 3
                out[o] = src[p]
                out[o + 1] = src[p + 1]
                out[o + 2] = src[p + 2]
                o += 3
            }
        } else {
            val row0 = ys.i0[y] * width
            val row1 = ys.i1[y] * width
            val wy0 = ys.w0[y]
            val wy1 = ys.w1[y]
            for (x in 0 until outW) {
                val x0 = xs.i0[x]
                val x1 = xs.i1[x]
                val wx0 = xs.w0[x]
                val wx1 = xs.w1[x]
                val p00 = (row0 + x0) * 3
                val p10 = (row0 + x1) * 3
                val p01 = (row1 + x0) * 3
                val p11 = (row1 + x1) * 3
                for (c in 0 until 3) {
                    var a = src.u(p00 + c).toDouble() * wx0
                    a = a * wy0
                    var b = src.u(p10 + c).toDouble() * wx1
                    b = b * wy0
                    var cc = src.u(p01 + c).toDouble() * wx0
                    cc = cc * wy1
                    var d = src.u(p11 + c).toDouble() * wx1
                    d = d * wy1
                    val v = ((a + b) + cc) + d
                    out[o + c] = byteOf(v)
                }
                o += 3
            }
        }
    }
    return out
}

/**
 * Resizes [image] to [width] x [height] with half-pixel centres. Fails with `invalid_options` for an invalid image or a
 * target outside `1..16384`. The input is never mutated.
 */
fun resize(image: Image, width: Int, height: Int, method: ResizeMethod): Image {
    validateImage(image)
    requireSide(width, "resize width")
    requireSide(height, "resize height")
    return Image(width, height, resizeWindow(image, width, height, 0, 0, width, height, method))
}
