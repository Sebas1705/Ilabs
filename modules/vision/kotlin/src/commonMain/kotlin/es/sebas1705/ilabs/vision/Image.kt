package es.sebas1705.ilabs.vision

/** The largest width or height of an image, a resize target, a source size or a model input. */
internal const val MAX_SIDE = 16384

/**
 * An 8-bit RGB image: [data] holds `width * height * 3` bytes, row-major and interleaved (`R G B` of the pixel
 * `(0, 0)`, then of `(1, 0)`, ...), top row first. Bytes are read as unsigned (`0` to `255`). The constructor does not
 * validate: every operation that takes an image does (`invalid_options`), and none of them mutates it.
 */
class Image(val width: Int, val height: Int, val data: ByteArray)

/** The size of the original image, for [postprocessDetections]. */
data class ImageSize(val width: Int, val height: Int)

internal fun validSide(v: Int): Boolean = v >= 1 && v <= MAX_SIDE

internal fun requireSide(v: Int, what: String) {
    if (!validSide(v)) invalidOptions("$what must be an integer from 1 to $MAX_SIDE")
}

/** Images rule: sizes, then the data length (computed as a Long: a size is at most 16,384, so it also fits an Int). */
internal fun validateImage(image: Image) {
    requireSide(image.width, "image width")
    requireSide(image.height, "image height")
    val expected = image.width.toLong() * image.height.toLong() * 3L
    if (image.data.size.toLong() != expected) invalidOptions("image data must have width * height * 3 bytes")
}

internal fun requireSource(width: Int, height: Int) {
    requireSide(width, "source width")
    requireSide(height, "source height")
}

/** The byte at [index] as an unsigned value. */
internal fun ByteArray.u(index: Int): Int = this[index].toInt() and 0xFF
