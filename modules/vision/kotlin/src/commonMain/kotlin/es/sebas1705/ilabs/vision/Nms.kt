package es.sebas1705.ilabs.vision

import kotlin.math.max
import kotlin.math.min

/** A detection: a box in source-image pixels, the model's [classIndex], its [label] and [score]. */
data class Detection(val box: Box, val classIndex: Int, val label: String, val score: Double)


internal fun requireUnit(v: Double, what: String) {
    if (!(v >= 0.0 && v <= 1.0)) invalidOptions("$what must be a number from 0 to 1")
}

/** The IoU of two boxes taken as given (corners are never reordered); the operands are trusted. */
internal fun iouOf(ax1: Double, ay1: Double, ax2: Double, ay2: Double, bx1: Double, by1: Double, bx2: Double, by2: Double): Double {
    val ix1 = max(ax1, bx1)
    val iy1 = max(ay1, by1)
    val ix2 = min(ax2, bx2)
    val iy2 = min(ay2, by2)
    val iw = ix2 - ix1
    val ih = iy2 - iy1
    val inter = if (iw <= 0.0 || ih <= 0.0) 0.0 else iw * ih
    val areaA = (ax2 - ax1) * (ay2 - ay1)
    val areaB = (bx2 - bx1) * (by2 - by1)
    val union = (areaA + areaB) - inter
    return if (union <= 0.0) 0.0 else inter / union
}

/** Intersection over union of two boxes. Fails with `invalid_options` when a coordinate is not finite. */
fun iou(a: Box, b: Box): Double {
    for (v in doubleArrayOf(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1, b.x2, b.y2)) if (!isFinite(v)) invalidOptions("box coordinates must be finite")
    return iouOf(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1, b.x2, b.y2)
}

/** The first index of the non-decreasing [values] that holds a value `>= target` (`values.size` when none). */
private fun lowerBound(values: DoubleArray, target: Double): Int {
    var lo = 0
    var hi = values.size
    while (lo < hi) {
        val mid = (lo + hi) ushr 1
        if (values[mid] < target) lo = mid + 1 else hi = mid
    }
    return lo
}

/**
 * Class-aware greedy non-maximum suppression over parallel arrays: returns which positions are kept. Per class the
 * positions are processed by descending score (ties by ascending position); a kept box suppresses every later box of its
 * class with an IoU strictly above [threshold], and a suppressed box never suppresses another.
 *
 * Scores and coordinates must be finite (`invalid_options` otherwise), so every sort below is a total order and cannot
 * throw. Cost: [threshold] is in `[0, 1]`, so an IoU strictly above it needs a positive overlap width. Per class the boxes
 * are also kept sorted by `x1` with a running maximum of `x2`, and a kept box only visits the window of that list where an
 * overlap in x is possible. Every visited pair still goes through the unchanged [iouOf] with the strict `>` rule, so the
 * result is exactly that of the quadratic scan; a worst case where many overlapping boxes all survive stays quadratic.
 */
internal fun nmsKept(x1: DoubleArray, y1: DoubleArray, x2: DoubleArray, y2: DoubleArray, classIds: IntArray, scores: DoubleArray, threshold: Double): BooleanArray {
    val n = scores.size
    for (i in 0 until n) {
        if (!isFinite(scores[i]) || !isFinite(x1[i]) || !isFinite(y1[i]) || !isFinite(x2[i]) || !isFinite(y2[i])) {
            invalidOptions("detection score and box coordinates must be finite numbers")
        }
    }
    val byClass = LinkedHashMap<Int, MutableList<Int>>()
    for (i in 0 until n) byClass.getOrPut(classIds[i]) { ArrayList() }.add(i)
    val kept = BooleanArray(n)
    for (positions in byClass.values) {
        val order = positions.sortedWith { a, b ->
            val sa = scores[a]
            val sb = scores[b]
            if (sa > sb) -1 else if (sa < sb) 1 else if (a < b) -1 else if (a > b) 1 else 0
        }.toIntArray()
        val m = order.size
        // Ranks (indices into `order`) sorted by x1, with the prefix maximum of x2 over that list.
        val byX = (0 until m).sortedWith { a, b ->
            val xa = x1[order[a]]
            val xb = x1[order[b]]
            if (xa < xb) -1 else if (xa > xb) 1 else if (a < b) -1 else if (a > b) 1 else 0
        }.toIntArray()
        val xs = DoubleArray(m)
        val prefixMaxX2 = DoubleArray(m)
        var running = Double.NEGATIVE_INFINITY
        for (k in 0 until m) {
            val q = order[byX[k]]
            xs[k] = x1[q]
            if (x2[q] > running) running = x2[q]
            prefixMaxX2[k] = running
        }
        // No allocation per kept box: a suppression flag per rank and an index scan over the x window.
        val suppressed = BooleanArray(m)
        for (a in 0 until m) {
            if (suppressed[a]) continue
            val p = order[a]
            kept[p] = true
            val px1 = x1[p]
            val py1 = y1[p]
            val px2 = x2[p]
            val py2 = y2[p]
            // Before `lo` every x2 is below px1; from `hi` on every x1 is at least px2: no positive overlap there.
            val lo = lowerBound(prefixMaxX2, px1)
            val hi = lowerBound(xs, px2)
            for (k in lo until hi) {
                val b = byX[k]
                if (b <= a || suppressed[b]) continue
                val q = order[b]
                if (iouOf(px1, py1, px2, py2, x1[q], y1[q], x2[q], y2[q]) > threshold) suppressed[b] = true
            }
        }
    }
    return kept
}

/**
 * Class-aware non-maximum suppression. The survivors keep their input order. [iouThreshold] must be a number from 0 to 1
 * (`invalid_options`). The input list is never mutated.
 */
fun nms(detections: List<Detection>, iouThreshold: Double): List<Detection> {
    requireUnit(iouThreshold, "iouThreshold")
    for (d in detections) if (d.classIndex < 0) invalidOptions("classIndex must be an integer from 0 to 2147483647")
    val n = detections.size
    val x1 = DoubleArray(n)
    val y1 = DoubleArray(n)
    val x2 = DoubleArray(n)
    val y2 = DoubleArray(n)
    val classes = IntArray(n)
    val scores = DoubleArray(n)
    for (i in 0 until n) {
        val d = detections[i]
        x1[i] = d.box.x1
        y1[i] = d.box.y1
        x2[i] = d.box.x2
        y2[i] = d.box.y2
        classes[i] = d.classIndex
        scores[i] = d.score
    }
    val kept = nmsKept(x1, y1, x2, y2, classes, scores, iouThreshold)
    val result = ArrayList<Detection>()
    for (i in 0 until n) if (kept[i]) result.add(detections[i])
    return result
}
