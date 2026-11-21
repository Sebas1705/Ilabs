package es.sebas1705.ilabs.vision

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class PostprocessTest {
    private val probabilities = spec(output = """{"type":"probabilities"}""")
    private val logits = spec()

    @Test
    fun classificationDefaultsAreTopFiveAndMinScoreZero() {
        val out = postprocessClassification(doubleArrayOf(0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.0), probabilities)
        assertEquals(listOf(5, 4, 3, 2, 1), out.map { it.index })
        assertEquals("#5", out[0].label)
        // the default minScore 0 keeps even a score of exactly 0
        val all = postprocessClassification(doubleArrayOf(0.0, 0.0), probabilities, topK = 10)
        assertEquals(listOf(0, 1), all.map { it.index })
    }

    @Test
    fun classificationOptionsAreValidatedBeforeTheOutput() {
        val badOutput = doubleArrayOf()
        for (k in listOf(0, -1, Int.MIN_VALUE)) assertKind(VisionErrorKind.INVALID_OPTIONS) { postprocessClassification(badOutput, probabilities, topK = k) }
        for (m in listOf(-0.1, 1.1, Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY)) {
            assertKind(VisionErrorKind.INVALID_OPTIONS) { postprocessClassification(badOutput, probabilities, minScore = m) }
        }
        assertKind(VisionErrorKind.INVALID_OUTPUT) { postprocessClassification(badOutput, probabilities) }
        assertEquals(1, postprocessClassification(doubleArrayOf(1.0), probabilities, minScore = 1.0).size)
        assertEquals(1, postprocessClassification(doubleArrayOf(1.0), probabilities, minScore = 0.0).size)
    }

    @Test
    fun classificationOutputValidation() {
        assertKind(VisionErrorKind.INVALID_OUTPUT) { postprocessClassification(doubleArrayOf(Double.NaN, 1.0), logits) }
        assertKind(VisionErrorKind.INVALID_OUTPUT) { postprocessClassification(doubleArrayOf(1.0, Double.POSITIVE_INFINITY), logits) }
        assertKind(VisionErrorKind.INVALID_OUTPUT) { postprocessClassification(doubleArrayOf(1.0, Double.NEGATIVE_INFINITY), logits) }
        assertKind(VisionErrorKind.INVALID_OUTPUT) { postprocessClassification(doubleArrayOf(0.5, -0.1), probabilities) }
        // negative logits are fine; -0 is accepted as a probability
        assertEquals(2, postprocessClassification(doubleArrayOf(-3.0, -2.0), logits).size)
        assertEquals(listOf(0, 1), postprocessClassification(doubleArrayOf(0.0, -0.0), probabilities).map { it.index })
        assertEquals(listOf(0, 1), postprocessClassification(doubleArrayOf(-0.0, 0.0), probabilities).map { it.index })
    }

    @Test
    fun classificationNeedsAClassifierSpec() {
        assertKind(VisionErrorKind.INVALID_OPTIONS) { postprocessClassification(doubleArrayOf(1.0), detectorSpec()) }
        assertKind(VisionErrorKind.INVALID_OPTIONS) { postprocessClassification(doubleArrayOf(1.0), detectorSpec(output = """{"format":"rows"}""")) }
    }

    @Test
    fun classificationDoesNotMutateItsInputAndLabelsUseTheOffset() {
        val output = doubleArrayOf(2.0, 1.0, 0.1)
        val copy = output.copyOf()
        val s = spec(rest = ""","labels":["a","b"],"labelOffset":1""")
        val out = postprocessClassification(output, s)
        assertContentEquals(copy, output)
        // index 0 has k = -1 (no label), index 1 -> labels[0], index 2 -> labels[1]
        assertEquals(listOf("#0", "a", "b"), out.map { it.label })
        assertEquals(listOf(0, 1, 2), out.map { it.index })
        assertClose(1.0, out.sumOf { it.score })
    }

    @Test
    fun theSoftmaxFollowsTheWrittenOperationOrder() {
        val out = postprocessClassification(doubleArrayOf(1000.0, 999.0, -1000.0), logits)
        val e1 = kotlin.math.exp(-1.0)
        val s = (1.0 + e1) + 0.0
        assertClose(1.0 / (1.0 + e1), out[0].score)
        assertClose(e1 / s, out[1].score)
        assertEquals(0.0, out[2].score)
        assertTrue(out[2].score >= 0.0)
    }

    // ---- detection ---------------------------------------------------------------------------------------------

    private val ssdTensors = mapOf(
        "boxes" to tensor(listOf(2, 4), 0.0, 0.0, 10.0, 10.0, 5.0, 5.0, 15.0, 15.0),
        "classes" to tensor(listOf(2), 0.0, 0.0),
        "scores" to tensor(listOf(2), 0.9, 0.8),
    )

    private fun detect(outputs: Map<String, Tensor>, s: ModelSpec = detectorSpec(), options: DetectionOptions = DetectionOptions()) =
        postprocessDetections(outputs, s, preprocessGeometry(20, 20, s), ImageSize(20, 20), options)

    @Test
    fun detectionDefaults() {
        val options = DetectionOptions()
        assertEquals(0.3, options.scoreThreshold)
        assertEquals(0.5, options.iouThreshold)
        assertEquals(100, options.maxDetections)
        assertEquals(null, options.nms)
        val out = detect(ssdTensors)
        assertEquals(2, out.size)
        assertEquals("#0", out[0].label)
        assertEquals(0, out[0].classIndex)
    }

    @Test
    fun detectionNeedsADetectorSpec() {
        assertKind(VisionErrorKind.INVALID_OPTIONS) { detect(ssdTensors, s = spec()) }
        assertKind(VisionErrorKind.INVALID_OPTIONS) { postprocessDetections(ssdTensors, spec(), preprocessGeometry(20, 20, spec()), ImageSize(20, 20), DetectionOptions()) }
    }

    @Test
    fun detectionOptionsAreAllValidatedEvenWhenNmsIsOff() {
        val badOutput = mapOf<String, Tensor>()
        fun fails(o: DetectionOptions) = assertKind(VisionErrorKind.INVALID_OPTIONS) { detect(badOutput, options = o) }
        fails(DetectionOptions(scoreThreshold = -0.1))
        fails(DetectionOptions(scoreThreshold = 1.5))
        fails(DetectionOptions(scoreThreshold = Double.NaN))
        fails(DetectionOptions(iouThreshold = -0.1, nms = false))
        fails(DetectionOptions(iouThreshold = 2.0, nms = false))
        fails(DetectionOptions(iouThreshold = Double.NaN, nms = false))
        fails(DetectionOptions(maxDetections = 0))
        fails(DetectionOptions(maxDetections = -4))
        assertKind(VisionErrorKind.INVALID_OUTPUT) { detect(badOutput) }
    }

    @Test
    fun detectionSourceSizeIsValidated() {
        val s = detectorSpec()
        for (bad in listOf(0, -1, 16385)) {
            assertKind(VisionErrorKind.INVALID_OPTIONS) { postprocessDetections(ssdTensors, s, preprocessGeometry(20, 20, s), ImageSize(bad, 20), DetectionOptions()) }
            assertKind(VisionErrorKind.INVALID_OPTIONS) { postprocessDetections(ssdTensors, s, preprocessGeometry(20, 20, s), ImageSize(20, bad), DetectionOptions()) }
        }
    }

    @Test
    fun detectionTensorsAreNotMutatedAndExtraTensorsAreIgnored() {
        val boxes = tensor(listOf(1, 4), 1.0, 2.0, 3.0, 4.0)
        val outputs = mapOf("boxes" to boxes, "classes" to tensor(listOf(1), 0.0), "scores" to tensor(listOf(1), 0.9), "extra" to tensor(listOf(2), Double.NaN, 1.0))
        val shape = boxes.shape.toList()
        val data = boxes.data.copyOf()
        val out = detect(outputs)
        assertEquals(1, out.size)
        assertEquals(shape, boxes.shape)
        assertContentEquals(data, boxes.data)
    }

    @Test
    fun tensorShapeAndDataLengthMustAgree() {
        val s = detectorSpec()
        val bad = ssdTensors + ("scores" to Tensor(listOf(2), doubleArrayOf(0.9)))
        assertKind(VisionErrorKind.INVALID_OUTPUT) { detect(bad, s) }
        val negative = ssdTensors + ("scores" to Tensor(listOf(-2), doubleArrayOf()))
        assertKind(VisionErrorKind.INVALID_OUTPUT) { detect(negative, s) }
        // a huge shape never overflows a product
        val huge = ssdTensors + ("scores" to Tensor(listOf(Int.MAX_VALUE, Int.MAX_VALUE, Int.MAX_VALUE), doubleArrayOf(0.9)))
        assertKind(VisionErrorKind.INVALID_OUTPUT) { detect(huge, s) }
        val hugeWithZero = ssdTensors + ("scores" to Tensor(listOf(Int.MAX_VALUE, Int.MAX_VALUE, 0, Int.MAX_VALUE), doubleArrayOf()))
        assertKind(VisionErrorKind.INVALID_OUTPUT) { detect(hugeWithZero, s) }
    }

    @Test
    fun anEmptySsdOutputIsValid() {
        val out = detect(mapOf("boxes" to Tensor(listOf(1, 0, 4), doubleArrayOf()), "classes" to Tensor(listOf(1, 0), doubleArrayOf()), "scores" to Tensor(listOf(0), doubleArrayOf())))
        assertEquals(emptyList(), out)
    }

    @Test
    fun nmsDefaultsFollowTheFormat() {
        val overlapping = mapOf(
            "boxes" to tensor(listOf(2, 4), 0.0, 0.0, 10.0, 10.0, 0.0, 0.0, 10.0, 10.5),
            "classes" to tensor(listOf(2), 0.0, 0.0),
            "scores" to tensor(listOf(2), 0.9, 0.8),
        )
        assertEquals(2, detect(overlapping).size)
        assertEquals(1, detect(overlapping, options = DetectionOptions(nms = true)).size)
        val rows = detectorSpec(output = """{"format":"rows","boxFormat":"xyxy"}""")
        val rowTensor = mapOf("rows" to tensor(listOf(2, 5), 0.0, 0.0, 10.0, 10.0, 0.9, 0.0, 0.0, 10.0, 10.5, 0.8))
        assertEquals(1, detect(rowTensor, rows).size)
        assertEquals(2, detect(rowTensor, rows, DetectionOptions(nms = false)).size)
    }

    @Test
    fun aHandBuiltGeometryIsTrusted() {
        val s = detectorSpec()
        val g = Geometry(scaleX = 2.0, scaleY = 2.0, offsetX = 1.0, offsetY = 1.0, newWidth = 1, newHeight = 1)
        val out = postprocessDetections(ssdTensors, s, g, ImageSize(100, 100), DetectionOptions())
        assertEquals(Box(0.0 - 0.5, 0.0 - 0.5, (10.0 - 1.0) / 2.0, (10.0 - 1.0) / 2.0).copy(x1 = 0.0, y1 = 0.0), out[0].box)
    }

    @Test
    fun nmsOf100000BoxesOfOneClassIsQuick() {
        val n = 100_000
        val list = ArrayList<Detection>(n)
        for (i in 0 until n) {
            val cluster = (i % 100) * 20.0
            list.add(Detection(Box(cluster, cluster, cluster + 10.0, cluster + 10.0 + (i % 7) * 0.01), 3, "#3", 1.0 - (i / 100_000.0)))
        }
        val before = list.toList()
        val started = kotlin.time.TimeSource.Monotonic.markNow()
        val kept = nms(list, 0.5)
        val seconds = started.elapsedNow().inWholeMilliseconds / 1000.0
        assertEquals(100, kept.size)
        assertEquals(before, list)
        assertTrue(seconds < 5.0, "nms of 100000 boxes took $seconds s")
    }

    @Test
    fun nmsValidatesItsThresholdAndKeepsInputOrder() {
        val a = Detection(Box(0.0, 0.0, 10.0, 10.0), 0, "a", 0.5)
        val b = Detection(Box(100.0, 100.0, 110.0, 110.0), 1, "b", 0.9)
        assertEquals(listOf(a, b), nms(listOf(a, b), 0.5))
        for (bad in listOf(-0.1, 1.1, Double.NaN)) assertKind(VisionErrorKind.INVALID_OPTIONS) { nms(listOf(a), bad) }
    }

    @Test
    fun iouFollowsTheContract() {
        assertClose(25.0 / 175.0, iou(Box(0.0, 0.0, 10.0, 10.0), Box(5.0, 5.0, 15.0, 15.0)))
        assertEquals(0.0, iou(Box(10.0, 10.0, 0.0, 0.0), Box(10.0, 10.0, 0.0, 0.0)))
        for (v in listOf(Double.NaN, Double.POSITIVE_INFINITY)) {
            assertKind(VisionErrorKind.INVALID_OPTIONS) { iou(Box(0.0, 0.0, v, 1.0), Box(0.0, 0.0, 1.0, 1.0)) }
            assertKind(VisionErrorKind.INVALID_OPTIONS) { iou(Box(0.0, 0.0, 1.0, 1.0), Box(v, 0.0, 1.0, 1.0)) }
        }
    }
}
