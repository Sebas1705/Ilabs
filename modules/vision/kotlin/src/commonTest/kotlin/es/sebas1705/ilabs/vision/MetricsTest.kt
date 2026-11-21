package es.sebas1705.ilabs.vision

import kotlin.test.Test
import kotlin.test.assertEquals

class MetricsTest {
    private val box = Box(0.0, 0.0, 10.0, 10.0)

    @Test
    fun topKAccuracyValidatesItsInputs() {
        for (k in listOf(0, -1, Int.MIN_VALUE)) assertKind(VisionErrorKind.INVALID_OPTIONS) { topKAccuracy(listOf(listOf(0)), listOf(0), k) }
        assertKind(VisionErrorKind.INVALID_OPTIONS) { topKAccuracy(listOf(listOf(0), listOf(1)), listOf(0), 1) }
        assertKind(VisionErrorKind.INVALID_OPTIONS) { topKAccuracy(listOf(listOf(0)), listOf(0, 1), 1) }
        assertEquals(0.0, topKAccuracy(emptyList(), emptyList(), 1))
        assertEquals(0.5, topKAccuracy(listOf(listOf(0, 1), listOf(1)), listOf(1, 0), 2))
        assertEquals(1.0, topKAccuracy(listOf(listOf(), listOf(3)), listOf(0, 3), Int.MAX_VALUE).let { it * 2 })
    }

    @Test
    fun topKAccuracyDoesNotMutateItsLists() {
        val predictions = listOf(mutableListOf(2, 1, 0))
        val truths = mutableListOf(1)
        topKAccuracy(predictions, truths, 2)
        assertEquals(listOf(listOf(2, 1, 0)), predictions)
        assertEquals(listOf(1), truths)
    }

    @Test
    fun averagePrecisionValidatesThresholdAndInputs() {
        val det = ScoredDetection("a", 0, 0.9, box)
        val truth = Truth("a", 0, box)
        for (t in listOf(-0.1, 1.1, Double.NaN, Double.POSITIVE_INFINITY)) {
            assertKind(VisionErrorKind.INVALID_OPTIONS) { averagePrecision(emptyList(), emptyList(), t) }
            assertKind(VisionErrorKind.INVALID_OPTIONS) { meanAveragePrecision(emptyList(), emptyList(), t) }
        }
        for (v in listOf(Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY)) {
            assertKind(VisionErrorKind.INVALID_OPTIONS) { averagePrecision(listOf(det.copy(score = v)), listOf(truth), 0.5) }
            assertKind(VisionErrorKind.INVALID_OPTIONS) { averagePrecision(listOf(det.copy(box = Box(0.0, 0.0, v, 1.0))), listOf(truth), 0.5) }
            assertKind(VisionErrorKind.INVALID_OPTIONS) { averagePrecision(listOf(det), listOf(truth.copy(box = Box(v, 0.0, 1.0, 1.0))), 0.5) }
            assertKind(VisionErrorKind.INVALID_OPTIONS) { meanAveragePrecision(listOf(det.copy(score = v)), listOf(truth), 0.5) }
        }
        assertKind(VisionErrorKind.INVALID_OPTIONS) { averagePrecision(listOf(det.copy(classIndex = -1)), listOf(truth), 0.5) }
        assertKind(VisionErrorKind.INVALID_OPTIONS) { averagePrecision(listOf(det), listOf(truth.copy(classIndex = -1)), 0.5) }
        // inputs are validated even for a class that has no truths
        assertKind(VisionErrorKind.INVALID_OPTIONS) { averagePrecision(listOf(det.copy(classIndex = 9, score = Double.NaN)), listOf(truth), 0.5) }
    }

    @Test
    fun averagePrecisionBasics() {
        val truths = listOf(Truth("a", 1, box), Truth("b", 1, box), Truth("a", 0, box))
        val detections = listOf(ScoredDetection("a", 1, 0.9, box), ScoredDetection("b", 1, 0.8, Box(50.0, 50.0, 60.0, 60.0)), ScoredDetection("a", 5, 0.7, box))
        val result = averagePrecision(detections, truths, 0.5)
        assertEquals(listOf(0, 1), result.byClass.map { it.classIndex })
        assertEquals(0.0, result.byClass[0].ap)
        assertClose(0.5, result.byClass[1].ap)
        val m = meanAveragePrecision(detections, truths, 0.5)
        assertClose(0.25, m.map)
        assertEquals(result.byClass, m.byClass)
        assertEquals(0.0, meanAveragePrecision(emptyList(), emptyList(), 0.5).map)
    }

    @Test
    fun inputListsAreNeverMutated() {
        val detections = mutableListOf(ScoredDetection("a", 0, 0.1, box), ScoredDetection("a", 0, 0.9, box))
        val truths = mutableListOf(Truth("a", 0, box))
        val d0 = detections.toList()
        averagePrecision(detections, truths, 0.5)
        meanAveragePrecision(detections, truths, 0.5)
        assertEquals(d0, detections)
        assertEquals(1, truths.size)
    }

    @Test
    fun anImageIdIsOpaque() {
        val truths = listOf(Truth("__proto__", 0, box), Truth("constructor", 0, box), Truth("", 0, box))
        val detections = listOf(ScoredDetection("__proto__", 0, 0.9, box), ScoredDetection("constructor", 0, 0.8, box), ScoredDetection("", 0, 0.7, box))
        assertClose(1.0, averagePrecision(detections, truths, 0.5).byClass[0].ap)
    }
}
