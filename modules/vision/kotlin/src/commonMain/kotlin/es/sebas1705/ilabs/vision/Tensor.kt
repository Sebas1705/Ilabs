package es.sebas1705.ilabs.vision

/**
 * A tensor: [shape] and flat row-major [data]. The constructor does not validate (a hand-built tensor can be
 * inconsistent): the operations that consume tensors check the shape against the data length (`invalid_output`).
 */
class Tensor(val shape: List<Int>, val data: DoubleArray)

/** The result of [toTensor]: the model input and the geometry that maps model-input coordinates back to the source. */
class Prepared(val tensor: Tensor, val geometry: Geometry)

private val ZERO3 = listOf(0.0, 0.0, 0.0)
private val ONE3 = listOf(1.0, 1.0, 1.0)

/**
 * Turns [image] into the model input described by [spec] (resize, crop or letterbox, channel order, normalization,
 * layout). Fails with `invalid_options` for an invalid image and `invalid_spec` for an invalid typed spec.
 */
fun toTensor(image: Image, spec: ModelSpec): Prepared {
    validateImage(image)
    validateModelSpec(spec)
    val geometry = geometryOf(image.width, image.height, spec)
    val input = spec.input
    val dstW = input.width
    val dstH = input.height
    val canvas: ByteArray = when (input.mode) {
        ResizeMode.STRETCH -> resizeWindow(image, dstW, dstH, 0, 0, dstW, dstH, input.resample)
        ResizeMode.CENTER_CROP -> {
            val cropX = (0.0 - geometry.offsetX).toInt()
            val cropY = (0.0 - geometry.offsetY).toInt()
            resizeWindow(image, geometry.newWidth, geometry.newHeight, cropX, cropY, dstW, dstH, input.resample)
        }
        ResizeMode.LETTERBOX -> {
            val newW = geometry.newWidth
            val newH = geometry.newHeight
            val padX = geometry.offsetX.toInt()
            val padY = geometry.offsetY.toInt()
            val resized = resizeWindow(image, newW, newH, 0, 0, newW, newH, input.resample)
            val canvas = ByteArray(dstW * dstH * 3)
            val pad = input.padValue.toByte()
            canvas.fill(pad)
            for (y in 0 until newH) {
                resized.copyInto(canvas, ((y + padY) * dstW + padX) * 3, y * newW * 3, (y + 1) * newW * 3)
            }
            canvas
        }
    }
    if (input.channels == ChannelOrder.BGR) {
        var p = 0
        while (p < canvas.size) {
            val first = canvas[p]
            canvas[p] = canvas[p + 2]
            canvas[p + 2] = first
            p += 3
        }
    }
    val float = input.dtype == InputDType.FLOAT
    val scale = input.scale ?: 1.0
    val mean = input.mean ?: ZERO3
    val std = input.std ?: ONE3
    val data = DoubleArray(canvas.size)
    for (y in 0 until dstH) {
        for (x in 0 until dstW) {
            val base = (y * dstW + x) * 3
            for (c in 0 until 3) {
                val v = canvas.u(base + c).toDouble()
                val value = if (float) {
                    val t1 = v * scale
                    val t2 = t1 - mean[c]
                    t2 / std[c]
                } else {
                    v
                }
                val at = if (input.layout == TensorLayout.NHWC) base + c else (c * dstH + y) * dstW + x
                data[at] = value
            }
        }
    }
    val shape = if (input.layout == TensorLayout.NHWC) listOf(1, dstH, dstW, 3) else listOf(1, 3, dstH, dstW)
    return Prepared(Tensor(shape, data), geometry)
}

/**
 * The element count of a [shape], or `null` when a dimension is negative. The product saturates at a bound far above
 * any array size, so it never overflows; a zero dimension always gives `0`.
 */
internal fun elementCount(shape: List<Int>): Long? {
    var product = 1L
    for (dim in shape) {
        if (dim < 0) return null
        product = if (dim == 0 || product == 0L) 0L else if (product > SATURATION / dim.toLong()) SATURATION else product * dim.toLong()
    }
    return product
}

private const val SATURATION = 1L shl 40

/** Whether the tensor is consistent: no negative dimension and `data.size == product(shape)`. */
internal fun Tensor.isConsistent(): Boolean = elementCount(shape) == data.size.toLong()
