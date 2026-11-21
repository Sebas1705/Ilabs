package es.sebas1705.ilabs.vision

import kotlin.math.max

/** A scored detection of one image, for [averagePrecision]; [image] is an opaque id. */
data class ScoredDetection(val image: String, val classIndex: Int, val score: Double, val box: Box)

/** A ground-truth box of one image. */
data class Truth(val image: String, val classIndex: Int, val box: Box)

/** The average precision of one class. */
data class ClassAp(val classIndex: Int, val ap: Double)

/** The result of [averagePrecision]: one entry per class that has at least one truth, in ascending class order. */
data class ApResult(val byClass: List<ClassAp>)

/** The result of [meanAveragePrecision]. */
data class MapResult(val map: Double, val byClass: List<ClassAp>)


private fun finiteBox(box: Box): Boolean = isFinite(box.x1) && isFinite(box.y1) && isFinite(box.x2) && isFinite(box.y2)

/**
 * Top-k accuracy: the fraction of samples whose truth is among the first [k] entries of their ranked list (`0` for no
 * samples). [k] must be at least 1 and both lists the same length (`invalid_options`).
 */
fun topKAccuracy(predictions: List<List<Int>>, truths: List<Int>, k: Int): Double {
    if (k < 1) invalidOptions("k must be an integer >= 1")
    if (predictions.size != truths.size) invalidOptions("predictions and truths must have the same length")
    val n = predictions.size
    if (n == 0) return 0.0
    var hits = 0
    for (i in 0 until n) {
        val ranked = predictions[i]
        val limit = if (ranked.size < k) ranked.size else k
        for (j in 0 until limit) {
            if (ranked[j] == truths[i]) {
                hits++
                break
            }
        }
    }
    return hits.toDouble() / n.toDouble()
}

private fun validateMetricInputs(detections: List<ScoredDetection>, truths: List<Truth>, iouThreshold: Double) {
    requireUnit(iouThreshold, "iouThreshold")
    for (d in detections) {
        if (!isFinite(d.score)) invalidOptions("detection scores must be finite")
        if (!finiteBox(d.box)) invalidOptions("detection boxes must be finite")
        if (d.classIndex < 0) invalidOptions("detection classIndex must be an integer >= 0")
    }
    for (t in truths) {
        if (!finiteBox(t.box)) invalidOptions("truth boxes must be finite")
        if (t.classIndex < 0) invalidOptions("truth classIndex must be an integer >= 0")
    }
}

private fun classAp(classDetections: List<ScoredDetection>, classTruths: List<Truth>, iouThreshold: Double): Double {
    val truthsOfImage = HashMap<String, MutableList<Int>>()
    for (t in classTruths.indices) truthsOfImage.getOrPut(classTruths[t].image) { ArrayList() }.add(t)
    val taken = BooleanArray(classTruths.size)
    val m = classDetections.size
    val precision = DoubleArray(m + 1)
    val recall = DoubleArray(m + 1)
    var tp = 0
    var fp = 0
    for (k in 1..m) {
        val d = classDetections[k - 1]
        val candidates = truthsOfImage[d.image]
        var isTp = false
        if (candidates != null) {
            var best = candidates[0]
            var bestIou = iouBoxes(d.box, classTruths[best].box)
            for (c in 1 until candidates.size) {
                val v = iouBoxes(d.box, classTruths[candidates[c]].box)
                if (v > bestIou) {
                    bestIou = v
                    best = candidates[c]
                }
            }
            if (bestIou >= iouThreshold && !taken[best]) {
                taken[best] = true
                isTp = true
            }
        }
        if (isTp) tp++ else fp++
        precision[k] = tp.toDouble() / (tp + fp).toDouble()
        recall[k] = tp.toDouble() / classTruths.size.toDouble()
    }
    if (m == 0) return 0.0
    val envelope = DoubleArray(m + 2)
    envelope[m] = precision[m]
    for (k in m - 1 downTo 1) envelope[k] = max(precision[k], envelope[k + 1])
    var ap = 0.0
    for (k in 1..m) ap = ap + ((recall[k] - recall[k - 1]) * envelope[k])
    return ap
}

/**
 * VOC-style average precision per class (all-point interpolation): one entry for every class that has at least one truth,
 * in ascending class order. Inputs are validated first (`invalid_options`); the lists are never mutated.
 */
fun averagePrecision(detections: List<ScoredDetection>, truths: List<Truth>, iouThreshold: Double): ApResult {
    validateMetricInputs(detections, truths, iouThreshold)
    val detectionsByClass = HashMap<Int, MutableList<IndexedValue<ScoredDetection>>>()
    for (entry in detections.withIndex()) detectionsByClass.getOrPut(entry.value.classIndex) { ArrayList() }.add(entry)
    val result = ArrayList<ClassAp>()
    for ((classIndex, classTruths) in groupTruths(truths)) {
        val ordered = (detectionsByClass[classIndex] ?: emptyList<IndexedValue<ScoredDetection>>()).sortedWith { a, b ->
            val sa = a.value.score
            val sb = b.value.score
            if (sa > sb) -1 else if (sa < sb) 1 else if (a.index < b.index) -1 else if (a.index > b.index) 1 else 0
        }.map { it.value }
        result.add(ClassAp(classIndex, classAp(ordered, classTruths, iouThreshold)))
    }
    return ApResult(result)
}

private fun iouBoxes(a: Box, b: Box): Double = iouOf(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1, b.x2, b.y2)

/** The truths grouped by class, in ascending class order and input order within a class. */
private fun groupTruths(truths: List<Truth>): List<Pair<Int, List<Truth>>> {
    val groups = HashMap<Int, MutableList<Truth>>()
    for (t in truths) groups.getOrPut(t.classIndex) { ArrayList() }.add(t)
    return groups.keys.sorted().map { it to groups.getValue(it) }
}

/** Mean of the per-class APs of the classes that have truths (`0` when none): the sum in class order over their count. */
fun meanAveragePrecision(detections: List<ScoredDetection>, truths: List<Truth>, iouThreshold: Double): MapResult {
    val byClass = averagePrecision(detections, truths, iouThreshold).byClass
    if (byClass.isEmpty()) return MapResult(0.0, byClass)
    var sum = 0.0
    for (entry in byClass) sum = sum + entry.ap
    return MapResult(sum / byClass.size.toDouble(), byClass)
}
