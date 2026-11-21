package es.sebas1705.ilabs.vision

import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** The sweep of `nms` against the quadratic scan it replaced (kept here as a test-only reference), cost guards and non-finite inputs. */
class NmsSweepTest {
    /** The previous implementation: every kept box is compared with every later candidate of its class. */
    private fun naiveKept(x1: DoubleArray, y1: DoubleArray, x2: DoubleArray, y2: DoubleArray, classIds: IntArray, scores: DoubleArray, threshold: Double): BooleanArray {
        val n = scores.size
        val byClass = LinkedHashMap<Int, MutableList<Int>>()
        for (i in 0 until n) byClass.getOrPut(classIds[i]) { ArrayList() }.add(i)
        val kept = BooleanArray(n)
        val suppressed = BooleanArray(n)
        for (positions in byClass.values) {
            val order = positions.sortedWith { a, b ->
                val sa = scores[a]
                val sb = scores[b]
                if (sa > sb) -1 else if (sa < sb) 1 else if (a < b) -1 else if (a > b) 1 else 0
            }.toIntArray()
            for (a in order.indices) {
                val p = order[a]
                if (suppressed[p]) continue
                kept[p] = true
                for (b in a + 1 until order.size) {
                    val q = order[b]
                    if (suppressed[q]) continue
                    if (iouOf(x1[p], y1[p], x2[p], y2[p], x1[q], y1[q], x2[q], y2[q]) > threshold) suppressed[q] = true
                }
            }
        }
        return kept
    }

    private fun check(rnd: Random, n: Int, classCount: Int, grid: Boolean, tiedScores: Boolean, threshold: Double, label: String, hugeBox: Boolean = false) {
        val x1 = DoubleArray(n)
        val y1 = DoubleArray(n)
        val x2 = DoubleArray(n)
        val y2 = DoubleArray(n)
        val classes = IntArray(n)
        val scores = DoubleArray(n)
        val span = if (grid) 6 else 100
        for (i in 0 until n) {
            val kind = rnd.nextDouble()
            val ax = if (grid) rnd.nextInt(span).toDouble() else rnd.nextDouble() * span
            val ay = if (grid) rnd.nextInt(span).toDouble() else rnd.nextDouble() * span
            var bx = ax + (if (grid) rnd.nextInt(4).toDouble() else rnd.nextDouble() * 40)
            var by = ay + (if (grid) rnd.nextInt(4).toDouble() else rnd.nextDouble() * 40)
            if (kind < 0.1) bx = ax - rnd.nextDouble() * 5 // inverted in x
            else if (kind < 0.15) by = ay - rnd.nextDouble() * 5 // inverted in y
            else if (kind < 0.25) bx = ax // zero width
            else if (kind < 0.3) by = ay // zero height
            x1[i] = ax
            y1[i] = ay
            x2[i] = bx
            y2[i] = by
            classes[i] = rnd.nextInt(classCount)
            scores[i] = if (tiedScores) rnd.nextInt(4) / 4.0 else rnd.nextDouble()
        }
        if (hugeBox && n > 0) {
            x1[0] = -5.0
            x2[0] = 5000.0
            y1[0] = 0.0
            y2[0] = 100.0
        }
        assertContentEquals(naiveKept(x1, y1, x2, y2, classes, scores, threshold), nmsKept(x1, y1, x2, y2, classes, scores, threshold), label)
    }

    @Test
    fun sweepGivesExactlyTheSurvivorsOfTheQuadraticScanOn30000RandomCases() {
        val rnd = Random(20261122)
        val thresholds = doubleArrayOf(0.0, 1e-12, 0.3, 0.5, 1.0)
        for (c in 0 until 30_000) {
            val n = rnd.nextInt(40)
            val classCount = 1 + rnd.nextInt(if (c % 7 == 0) 12 else 3)
            check(rnd, n, classCount, grid = c % 3 == 0, tiedScores = c % 2 == 0, threshold = thresholds[c % thresholds.size], label = "case $c")
        }
    }

    @Test
    fun sweepMatchesOnLargerInputsWithAHugeBoxAndOnSpreadOutBoxes() {
        val rnd = Random(7)
        for (round in 0 until 20) {
            val n = 1500
            val x1 = DoubleArray(n)
            val y1 = DoubleArray(n)
            val x2 = DoubleArray(n)
            val y2 = DoubleArray(n)
            val classes = IntArray(n)
            val scores = DoubleArray(n)
            for (i in 0 until n) {
                x1[i] = rnd.nextDouble() * 2000
                y1[i] = rnd.nextDouble() * 50
                x2[i] = x1[i] + 1 + rnd.nextDouble() * 30
                y2[i] = 60 + rnd.nextDouble() * 30
                classes[i] = rnd.nextInt(3)
                scores[i] = rnd.nextDouble()
            }
            if (round % 2 == 0) {
                x1[round] = -5.0
                x2[round] = 5000.0
                y1[round] = 0.0
                y2[round] = 100.0
            }
            for (t in doubleArrayOf(0.0, 0.3, 0.5, 1.0)) {
                assertContentEquals(naiveKept(x1, y1, x2, y2, classes, scores, t), nmsKept(x1, y1, x2, y2, classes, scores, t), "round $round threshold $t")
            }
        }
    }

    @Test
    fun nmsOf100000PairwiseDisjointBoxesOfOneClassAllSurviveWithinFiveSeconds() {
        val n = 100_000
        val list = ArrayList<Detection>(n)
        for (i in 0 until n) list.add(Detection(Box(i * 3.0, 0.0, i * 3.0 + 2.0, 2.0), 1, "#1", 1.0 - i / 200_000.0))
        val started = kotlin.time.TimeSource.Monotonic.markNow()
        val kept = nms(list, 0.5)
        val seconds = started.elapsedNow().inWholeMilliseconds / 1000.0
        assertEquals(n, kept.size)
        assertTrue(seconds < 5.0, "nms of $n disjoint boxes took $seconds s")
    }

    @Test
    fun nmsRejectsANonFiniteScoreOrCoordinateWithInvalidOptionsWhateverTheSize() {
        val good = Detection(Box(5.0, 5.0, 6.0, 6.0), 0, "a", 0.9)
        for (v in doubleArrayOf(Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY)) {
            assertKind(VisionErrorKind.INVALID_OPTIONS) { nms(listOf(Detection(Box(0.0, 0.0, 1.0, 1.0), 0, "a", v)), 0.5) }
            for (field in 0 until 4) {
                val c = doubleArrayOf(0.0, 0.0, 1.0, 1.0)
                c[field] = v
                assertKind(VisionErrorKind.INVALID_OPTIONS) { nms(listOf(good, Detection(Box(c[0], c[1], c[2], c[3]), 1, "b", 0.5)), 0.5) }
            }
        }
        // a NaN score on a list long enough for a JVM sort to detect a broken comparator never reaches the sort
        val many = ArrayList<Detection>()
        for (i in 0 until 3000) many.add(Detection(Box(i.toDouble(), 0.0, i + 1.0, 1.0), 0, "a", if (i % 5 == 0) Double.NaN else 0.5))
        assertKind(VisionErrorKind.INVALID_OPTIONS) { nms(many, 0.5) }
        // finite extremes are fine and cannot throw
        val extremes = listOf(
            Detection(Box(-Double.MAX_VALUE, -Double.MAX_VALUE, Double.MAX_VALUE, Double.MAX_VALUE), 0, "a", Double.MAX_VALUE),
            Detection(Box(0.0, 0.0, 1.0, 1.0), 0, "a", -Double.MAX_VALUE),
            Detection(Box(0.0, 0.0, 1.0, 1.0), 0, "a", -0.0),
            Detection(Box(0.0, 0.0, 1.0, 1.0), 0, "a", 0.0),
        )
        nms(extremes, 0.5)
    }
}
