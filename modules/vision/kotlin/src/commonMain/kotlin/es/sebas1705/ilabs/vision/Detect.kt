package es.sebas1705.ilabs.vision

import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * Options of [postprocessDetections] and [detect]. [nms] `null` means the format's default: on for `rows`, off for `ssd`.
 * All four options are validated (`invalid_options`) even when NMS is off.
 */
data class DetectionOptions(
    val scoreThreshold: Double = 0.3,
    val iouThreshold: Double = 0.5,
    val maxDetections: Int = 100,
    val nms: Boolean? = null,
)

internal fun validateDetectionOptions(options: DetectionOptions) {
    requireUnit(options.scoreThreshold, "scoreThreshold")
    requireUnit(options.iouThreshold, "iouThreshold")
    if (options.maxDetections < 1) invalidOptions("maxDetections must be an integer >= 1")
}


/** The candidates of a decoder, in ascending row order: parallel arrays in model-input pixels. */
private class Candidates(count: Int) {
    val x1 = DoubleArray(count)
    val y1 = DoubleArray(count)
    val x2 = DoubleArray(count)
    val y2 = DoubleArray(count)
    val classIds = IntArray(count)
    val scores = DoubleArray(count)
    val size: Int get() = scores.size

    /** Stores a candidate; every value must be finite after the decoder's arithmetic. */
    fun set(row: Int, ax1: Double, ay1: Double, ax2: Double, ay2: Double, classId: Int, score: Double) {
        if (!isFinite(ax1) || !isFinite(ay1) || !isFinite(ax2) || !isFinite(ay2) || !isFinite(score)) invalidOutput("a decoded value is not finite")
        x1[row] = ax1
        y1[row] = ay1
        x2[row] = ax2
        y2[row] = ay2
        classIds[row] = classId
        scores[row] = score
    }
}

/** A class id must be a finite integer by value in `0..2147483647` and, with labels, inside them after the offset. */
private fun checkClassId(value: Double, spec: ModelSpec): Int {
    if (!isFinite(value) || floor(value) != value || value < 0.0 || value > 2147483647.0) invalidOutput("a class id must be an integer from 0 to 2147483647")
    val id = value.toInt()
    val labels = spec.labels
    if (labels != null) {
        val k = id.toLong() - spec.labelOffset.toLong()
        if (k < 0L || k >= labels.size.toLong()) invalidOutput("a class id is outside the labels")
    }
    return id
}

private fun tensorOf(outputs: Map<String, Tensor>, name: String): Tensor {
    val tensor = outputs[name] ?: invalidOutput("missing tensor: $name")
    if (!tensor.isConsistent()) invalidOutput("tensor $name: the data length must equal the product of the shape")
    return tensor
}

/** `n` of a `[1, n, 4]` or `[n, 4]` box tensor. */
private fun boxCount(shape: List<Int>): Int =
    if (shape.size == 3 && shape[0] == 1 && shape[2] == 4) shape[1] else if (shape.size == 2 && shape[1] == 4) shape[0] else invalidOutput("boxes must have shape [1, n, 4] or [n, 4]")

/** `n` of a `[1, n]` or `[n]` tensor. */
private fun vectorCount(shape: List<Int>, name: String): Int =
    if (shape.size == 2 && shape[0] == 1) shape[1] else if (shape.size == 1) shape[0] else invalidOutput("$name must have shape [1, n] or [n]")

private fun decodeSsd(outputs: Map<String, Tensor>, spec: ModelSpec, output: OutputSpec.Ssd): Candidates {
    val boxes = tensorOf(outputs, "boxes")
    val classes = tensorOf(outputs, "classes")
    val scores = tensorOf(outputs, "scores")
    val count = if ("count" in outputs) tensorOf(outputs, "count") else null
    val n = boxCount(boxes.shape)
    if (vectorCount(classes.shape, "classes") != n || vectorCount(scores.shape, "scores") != n) invalidOutput("boxes, classes and scores must agree on n")
    var examined = n
    if (count != null) {
        if (!(count.shape.isEmpty() || (count.shape.size == 1 && count.shape[0] == 1))) invalidOutput("count must have shape [] or [1]")
        val c = count.data[0]
        if (!isFinite(c)) invalidOutput("count must be finite")
        examined = min(max(floor(c), 0.0), n.toDouble()).toInt()
    }
    val inW = spec.input.width.toDouble()
    val inH = spec.input.height.toDouble()
    val candidates = Candidates(examined)
    for (i in 0 until examined) {
        val a = boxes.data[i * 4]
        val b = boxes.data[i * 4 + 1]
        val c = boxes.data[i * 4 + 2]
        val d = boxes.data[i * 4 + 3]
        val score = scores.data[i]
        if (!isFinite(a) || !isFinite(b) || !isFinite(c) || !isFinite(d) || !isFinite(score)) invalidOutput("boxes and scores must be finite")
        val classId = checkClassId(classes.data[i], spec)
        var x1: Double
        var y1: Double
        var x2: Double
        var y2: Double
        if (output.boxOrder == BoxOrder.YXYX) {
            x1 = b
            y1 = a
            x2 = d
            y2 = c
        } else {
            x1 = a
            y1 = b
            x2 = c
            y2 = d
        }
        if (output.coordinates == Coordinates.NORMALIZED) {
            x1 = x1 * inW
            y1 = y1 * inH
            x2 = x2 * inW
            y2 = y2 * inH
        }
        candidates.set(i, x1, y1, x2, y2, classId, score)
    }
    return candidates
}

private fun logistic(z: Double): Double {
    val q = exp(0.0 - z)
    val p = 1.0 + q
    return 1.0 / p
}

private fun decodeRows(outputs: Map<String, Tensor>, spec: ModelSpec, output: OutputSpec.Rows): Candidates {
    val rows = tensorOf(outputs, "rows")
    val shape = rows.shape
    val a: Int
    val b: Int
    if (shape.size == 3 && shape[0] == 1) {
        a = shape[1]
        b = shape[2]
    } else if (shape.size == 2) {
        a = shape[0]
        b = shape[1]
    } else {
        invalidOutput("rows must have shape [1, a, b] or [a, b]")
    }
    val n = if (output.transposed) b else a
    val columns = if (output.transposed) a else b
    val first = if (output.objectness) 5 else 4
    if (columns - first < 1) invalidOutput("rows needs at least one class column")
    for (v in rows.data) if (!isFinite(v)) invalidOutput("rows must be finite")
    val data = rows.data
    val values = DoubleArray(columns)
    val candidates = Candidates(n)
    val sigmoid = output.scoreActivation == ScoreActivation.SIGMOID
    for (i in 0 until n) {
        for (j in 0 until columns) values[j] = if (output.transposed) data[j * b + i] else data[i * b + j]
        var obj = 0.0
        if (output.objectness) obj = values[4]
        if (sigmoid) {
            if (output.objectness) obj = logistic(obj)
            for (k in first until columns) values[k] = logistic(values[k])
        }
        if (output.objectness) for (k in first until columns) values[k] = obj * values[k]
        var best = first
        for (k in first + 1 until columns) if (values[k] > values[best]) best = k
        val classId = checkClassId((best - first).toDouble(), spec)
        val score = values[best]
        val x1: Double
        val y1: Double
        val x2: Double
        val y2: Double
        if (output.boxFormat == BoxFormat.XYXY) {
            x1 = values[0]
            y1 = values[1]
            x2 = values[2]
            y2 = values[3]
        } else {
            val hw = values[2] / 2.0
            val hh = values[3] / 2.0
            x1 = values[0] - hw
            y1 = values[1] - hh
            x2 = values[0] + hw
            y2 = values[1] + hh
        }
        candidates.set(i, x1, y1, x2, y2, classId, score)
    }
    return candidates
}

/**
 * Decodes a detector's named output tensors into detections mapped back to the original image: shapes and class ids are
 * checked on every examined row (`invalid_output`), then threshold, coordinate swap, optional NMS, sort, cut, unmapping.
 * [geometry] is the geometry of the original image for [spec] (a hand-built one is trusted); [source] is its size.
 * Options are validated first (`invalid_options`). Nothing passed in is mutated.
 */
fun postprocessDetections(outputs: Map<String, Tensor>, spec: ModelSpec, geometry: Geometry, source: ImageSize, options: DetectionOptions = DetectionOptions()): List<Detection> {
    validateModelSpec(spec)
    val output = requireDetector(spec)
    validateDetectionOptions(options)
    requireSource(source.width, source.height)
    val candidates = when (output) {
        is OutputSpec.Ssd -> decodeSsd(outputs, spec, output)
        is OutputSpec.Rows -> decodeRows(outputs, spec, output)
        is OutputSpec.Classifier -> invalidOptions("the spec describes a classifier, not a detector")
    }
    val runNms = options.nms ?: (output is OutputSpec.Rows)
    // 1. threshold (inclusive), in row order
    var rows = (0 until candidates.size).filter { candidates.scores[it] >= options.scoreThreshold }
    // 2. swap coordinates independently
    val x1 = DoubleArray(candidates.size)
    val y1 = DoubleArray(candidates.size)
    val x2 = DoubleArray(candidates.size)
    val y2 = DoubleArray(candidates.size)
    for (r in rows) {
        val ax1 = candidates.x1[r]
        val ax2 = candidates.x2[r]
        val ay1 = candidates.y1[r]
        val ay2 = candidates.y2[r]
        x1[r] = if (ax2 < ax1) ax2 else ax1
        x2[r] = if (ax2 < ax1) ax1 else ax2
        y1[r] = if (ay2 < ay1) ay2 else ay1
        y2[r] = if (ay2 < ay1) ay1 else ay2
    }
    // 3. NMS on the list of step 2 (row order); survivors keep it
    if (runNms) {
        val m = rows.size
        val kept = nmsKept(
            DoubleArray(m) { x1[rows[it]] }, DoubleArray(m) { y1[rows[it]] }, DoubleArray(m) { x2[rows[it]] }, DoubleArray(m) { y2[rows[it]] },
            IntArray(m) { candidates.classIds[rows[it]] }, DoubleArray(m) { candidates.scores[rows[it]] }, options.iouThreshold,
        )
        rows = rows.filterIndexed { index, _ -> kept[index] }
    }
    // 4. descending score, ties by ascending row; 5. cut
    val sorted = rows.sortedWith { p, q ->
        val sp = candidates.scores[p]
        val sq = candidates.scores[q]
        if (sp > sq) -1 else if (sp < sq) 1 else if (p < q) -1 else if (p > q) 1 else 0
    }
    val cut = if (sorted.size > options.maxDetections) sorted.subList(0, options.maxDetections) else sorted
    // 6. unmap, dropping boxes without area; 7. build
    val result = ArrayList<Detection>(cut.size)
    for (r in cut) {
        val box = unmapValidated(Box(x1[r], y1[r], x2[r], y2[r]), geometry, source.width, source.height) ?: continue
        val classId = candidates.classIds[r]
        result.add(Detection(box, classId, labelFor(classId, spec), candidates.scores[r]))
    }
    return result
}
