package es.sebas1705.ilabs.vision

import kotlin.math.max
import kotlin.math.min

/** A box `{ x1, y1, x2, y2 }` in pixels. Corners are never reordered by [iou] or [unmapBox]. */
data class Box(val x1: Double, val y1: Double, val x2: Double, val y2: Double)

/**
 * How an image of some source size was fitted to the model input. [scaleX] and [scaleY] are the ACTUAL ratios between the
 * resized content and the source; a model-input coordinate `u` maps back to the source as `(u - offset) / scale`.
 */
data class Geometry(
    val scaleX: Double,
    val scaleY: Double,
    val offsetX: Double,
    val offsetY: Double,
    val newWidth: Int,
    val newHeight: Int,
)

/** The geometry for a source of `srcW x srcH` and a classifier or detector [spec]. Sizes are validated like image sizes. */
fun preprocessGeometry(srcW: Int, srcH: Int, spec: ModelSpec): Geometry {
    requireSource(srcW, srcH)
    validateModelSpec(spec)
    return geometryOf(srcW, srcH, spec)
}

/** The geometry of already validated arguments. */
internal fun geometryOf(srcW: Int, srcH: Int, spec: ModelSpec): Geometry {
    val dstW = spec.input.width
    val dstH = spec.input.height
    val srcWd = srcW.toDouble()
    val srcHd = srcH.toDouble()
    val dstWd = dstW.toDouble()
    val dstHd = dstH.toDouble()
    when (spec.input.mode) {
        ResizeMode.STRETCH -> return Geometry(dstWd / srcWd, dstHd / srcHd, 0.0, 0.0, dstW, dstH)
        ResizeMode.CENTER_CROP -> {
            val rx = dstWd / srcWd
            val ry = dstHd / srcHd
            val scale = max(rx, ry)
            val scaledW = max(dstWd, roundHalfUp(srcWd * scale)).toInt()
            val scaledH = max(dstHd, roundHalfUp(srcHd * scale)).toInt()
            val cropX = (scaledW - dstW) / 2
            val cropY = (scaledH - dstH) / 2
            return Geometry(scaledW.toDouble() / srcWd, scaledH.toDouble() / srcHd, 0.0 - cropX.toDouble(), 0.0 - cropY.toDouble(), scaledW, scaledH)
        }
        ResizeMode.LETTERBOX -> {
            val rx = dstWd / srcWd
            val ry = dstHd / srcHd
            val scale = min(rx, ry)
            val newW = max(1.0, roundHalfUp(srcWd * scale)).toInt()
            val newH = max(1.0, roundHalfUp(srcHd * scale)).toInt()
            val padX = (dstW - newW) / 2
            val padY = (dstH - newH) / 2
            return Geometry(newW.toDouble() / srcWd, newH.toDouble() / srcHd, padX.toDouble(), padY.toDouble(), newW, newH)
        }
    }
}


private fun clamp(v: Double, limit: Double): Double = min(max(v, 0.0), limit)

/**
 * Maps [box] (model-input pixels) back to a source of `srcW x srcH`, or returns null when the mapped box has no area.
 * Fails with `invalid_options` for a source size outside `1..16384` or a non-finite coordinate.
 */
fun unmapBox(box: Box, geometry: Geometry, srcW: Int, srcH: Int): Box? {
    requireSource(srcW, srcH)
    if (!isFinite(box.x1) || !isFinite(box.y1) || !isFinite(box.x2) || !isFinite(box.y2)) invalidOptions("box coordinates must be finite")
    return unmapValidated(box, geometry, srcW, srcH)
}

internal fun unmapValidated(box: Box, geometry: Geometry, srcW: Int, srcH: Int): Box? {
    val ux1 = (box.x1 - geometry.offsetX) / geometry.scaleX
    val uy1 = (box.y1 - geometry.offsetY) / geometry.scaleY
    val ux2 = (box.x2 - geometry.offsetX) / geometry.scaleX
    val uy2 = (box.y2 - geometry.offsetY) / geometry.scaleY
    val limitX = srcW.toDouble()
    val limitY = srcH.toDouble()
    val x1 = clamp(ux1, limitX)
    val y1 = clamp(uy1, limitY)
    val x2 = clamp(ux2, limitX)
    val y2 = clamp(uy2, limitY)
    if (x2 - x1 <= 0.0 || y2 - y1 <= 0.0) return null
    return Box(x1, y1, x2, y2)
}
