package es.sebas1705.ilabs.demo

import es.sebas1705.ilabs.vision.Box
import es.sebas1705.ilabs.vision.Detection
import es.sebas1705.ilabs.vision.Tensor
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.nio.ByteBuffer
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** The parts of the Android image handling that are plain Kotlin: sampling, compositing, the picker copy, the memory limit. */
class VisionImageTest {
    @get:Rule
    val folder = TemporaryFolder()

    private var locale: Locale = Locale.getDefault()

    @Before
    fun fixLocale() {
        locale = Locale.getDefault()
        Locale.setDefault(Locale.US)
    }

    @After
    fun restoreLocale() = Locale.setDefault(locale)

    // ---- the sample size of a large image ----

    @Test
    fun anImageWithinTheCapIsNotSampled() {
        assertEquals(1, sampleSizeFor(100, 50, VISION_MAX_DECODE_SIDE))
        assertEquals(1, sampleSizeFor(4096, 3000, VISION_MAX_DECODE_SIDE))
        assertEquals(1, sampleSizeFor(1, 1, VISION_MAX_DECODE_SIDE))
    }

    @Test
    fun theSampleSizeIsThePowerOfTwoThatKeepsTheLongestSideUnderTheCap() {
        assertEquals(2, sampleSizeFor(4097, 10, VISION_MAX_DECODE_SIDE))
        assertEquals(2, sampleSizeFor(8192, 100, VISION_MAX_DECODE_SIDE))
        assertEquals(4, sampleSizeFor(8193, 100, VISION_MAX_DECODE_SIDE))
        assertEquals(4, sampleSizeFor(10, 16384, VISION_MAX_DECODE_SIDE))
        assertEquals(8, sampleSizeFor(16385, 16385, VISION_MAX_DECODE_SIDE))
        for ((w, h) in listOf(4097 to 1, 5000 to 7000, 12000 to 3, 20000 to 20000)) {
            val s = sampleSizeFor(w, h, VISION_MAX_DECODE_SIDE)
            assertTrue("$w x $h sampled by $s", (maxOf(w, h) + s - 1) / s <= VISION_MAX_DECODE_SIDE)
            assertEquals("a power of two", 1, Integer.bitCount(s))
        }
    }

    @Test
    fun theDisplaySampleUsesItsOwnCap() {
        assertEquals(4, sampleSizeFor(4096, 2000, 1024))
    }

    // ---- alpha on white ----

    @Test
    fun aTransparentPixelBecomesWhiteAndAnOpaqueOneKeepsItsColour() {
        assertEquals(255, over(0, 0))
        assertEquals(255, over(200, 0))
        assertEquals(0, over(0, 255))
        assertEquals(37, over(37, 255))
        assertEquals(255, over(255, 255))
    }

    @Test
    fun aHalfTransparentPixelIsRoundedTowardsTheNearestLevel() {
        // black at alpha 128 over white: (0*128 + 255*127 + 127) / 255 = 127
        assertEquals(127, over(0, 128))
        // white stays white at any alpha
        for (a in 0..255) assertEquals(255, over(255, a))
        // red channel 255 over a transparent hole never goes below the channel
        for (a in 0..255) assertTrue(over(100, a) in 100..255)
    }

    @Test
    fun rowsAreConvertedToRgbWithTheAlphaOnWhite() {
        val argb = arrayOf(
            intArrayOf(0xFFFF0000.toInt(), 0x00123456, 0x80000000.toInt()),
            intArrayOf(0xFF010203.toInt(), 0xFFFFFFFF.toInt(), 0xFF00FF00.toInt()),
        )
        val rgb = rgbOfRows(3, 2) { y, row -> argb[y].copyInto(row) }
        assertArrayEquals(
            byteArrayOf(
                -1, 0, 0, -1, -1, -1, 127, 127, 127,
                1, 2, 3, -1, -1, -1, 0, -1, 0,
            ),
            rgb,
        )
    }

    // ---- memory ----

    @Test
    fun aPictureTooBigToHoldIsAnImageErrorNotACrash() {
        try {
            rgbOfRows(30_000, 30_000) { _, _ -> fail("nothing may be read for a picture that cannot fit") }
            fail("too big")
        } catch (e: VisionImageException) {
            assertTrue(e.message!!, e.message!!.contains("too large"))
        }
    }

    @Test
    fun anOutOfMemoryErrorWhileReadingIsAnImageError() {
        try {
            rgbOfRows(4, 4) { _, _ -> throw OutOfMemoryError("simulated") }
            fail("an OutOfMemoryError must become an image error")
        } catch (e: VisionImageException) {
            assertTrue(e.message!!, e.message!!.contains("too large"))
        }
    }

    @Test
    fun theRowsAreReadOneAtATime() {
        var widest = 0
        rgbOfRows(7, 5) { _, row ->
            widest = maxOf(widest, row.size)
        }
        assertEquals("the pixel buffer is one row, never the whole picture", 7, widest)
    }

    // ---- the picker copy ----

    private fun bytes(n: Int, fill: Byte = 7) = ByteArray(n) { fill }

    private fun picked(dir: File) = dir.listFiles { f -> f.name.startsWith("vision-picked-") }!!.sortedBy { it.name }

    @Test
    fun aPickedImageIsCopiedAndTheOlderOnesAreDeleted() {
        val dir = folder.newFolder()
        val first = importPickedFile(dir, now = 1) { ByteArrayInputStream(bytes(10, 1)) }
        assertArrayEquals(bytes(10, 1), first.readBytes())
        val second = importPickedFile(dir, now = 2) { ByteArrayInputStream(bytes(20, 2)) }
        assertEquals(listOf(second), picked(dir))
        assertArrayEquals(bytes(20, 2), second.readBytes())
    }

    @Test
    fun aFailedImportKeepsThePreviousImage() {
        val dir = folder.newFolder()
        val kept = importPickedFile(dir, now = 1) { ByteArrayInputStream(bytes(10, 1)) }
        val failures = listOf<() -> InputStream?>(
            { null },
            { throw IOException("gone") },
            {
                object : InputStream() {
                    override fun read(): Int = throw IOException("broken half way")

                    override fun read(b: ByteArray, off: Int, len: Int): Int = throw IOException("broken half way")
                }
            },
        )
        for (open in failures) {
            try {
                importPickedFile(dir, now = 2, open = open)
                fail("the import must fail")
            } catch (e: VisionImageException) {
                // expected
            }
            assertEquals("the image in use and no partial file", listOf(kept), picked(dir))
            assertArrayEquals(bytes(10, 1), kept.readBytes())
        }
    }

    @Test
    fun anImageOverTheLimitFailsAndKeepsThePreviousImage() {
        val dir = folder.newFolder()
        val kept = importPickedFile(dir, limit = 100, now = 1) { ByteArrayInputStream(bytes(100)) }
        try {
            importPickedFile(dir, limit = 100, now = 2) { ByteArrayInputStream(bytes(101)) }
            fail("over the limit")
        } catch (e: VisionImageException) {
            assertTrue(e.message!!, e.message!!.contains("larger than"))
        }
        assertEquals(listOf(kept), picked(dir))
    }

    @Test
    fun theLimitIsSixtyFourMegabytes() {
        assertEquals(64L * 1024 * 1024, MAX_PICKED_BYTES)
    }

    @Test
    fun filesThatAreNotPickedImagesAreLeftAlone() {
        val dir = folder.newFolder()
        val other = File(dir, "other.bin").apply { writeBytes(bytes(3)) }
        importPickedFile(dir, now = 1) { ByteArrayInputStream(bytes(2)) }
        importPickedFile(dir, now = 2) { ByteArrayInputStream(bytes(2)) }
        assertTrue(other.exists())
        assertEquals(1, picked(dir).size)
    }

    // ---- the model lock ----

    private class SlowRunner(val started: CountDownLatch, val release: CountDownLatch) : TfLiteRunner {
        @Volatile var closed = false
        @Volatile var closedWhileRunning = false
        @Volatile var running = false
        override val inputShape = listOf(1, 224, 224, 3)
        override val inputIsFloat = true

        override fun outputShape(index: Int) = listOf(1, 3)

        override fun outputIsFloat(index: Int) = true

        override fun run(input: ByteBuffer, outputs: Map<Int, ByteBuffer>) {
            running = true
            started.countDown()
            release.await(5, TimeUnit.SECONDS)
            for (b in outputs.values) repeat(3) { b.putFloat(0.1f) }
            running = false
        }

        override fun close() {
            if (running) closedWhileRunning = true
            closed = true
        }
    }

    private val classifierCard get() = loadVisionCatalog(FileVisionAssets()).realCard(VisionTask.CLASSIFICATION)!!

    @Test
    fun closingDuringARunWaitsForTheRunToEnd() = runBlocking {
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val runner = SlowRunner(started, release)
        val model = LiteRtModel(classifierCard, runner)
        val run = async(Dispatchers.Default) { model.run(Tensor(listOf(1, 224, 224, 3), DoubleArray(224 * 224 * 3))) }
        assertTrue("the run started", started.await(5, TimeUnit.SECONDS))
        model.close()
        assertFalse("the interpreter is not closed under a running inference", runner.closed)
        release.countDown()
        run.await()
        assertTrue("it is closed once the run is over", runner.closed)
        assertFalse(runner.closedWhileRunning)
    }

    @Test
    fun aClosedModelRefusesToRunAndIsClosedOnce() = runBlocking {
        val runner = SlowRunner(CountDownLatch(0), CountDownLatch(0))
        val model = LiteRtModel(classifierCard, runner)
        model.close()
        model.close()
        assertTrue(runner.closed)
        try {
            model.run(Tensor(listOf(1, 224, 224, 3), DoubleArray(224 * 224 * 3)))
            fail("a closed model must not run")
        } catch (e: IllegalStateException) {
            assertTrue(e.message!!, e.message!!.contains("closed"))
        }
        Unit
    }

    // ---- the text the screen builds ----

    @Test
    fun scalesAndOffsetsShowWholeNumbersAsTheyAreAndTheRestWithFourDecimals() {
        assertEquals("1", fixed(1.0))
        assertEquals("0", fixed(0.0))
        assertEquals("-12", fixed(-12.0))
        assertEquals("0.3333", fixed(1.0 / 3.0))
        assertEquals("0.7000", fixed(0.7))
        assertEquals("2.5000", fixed(2.5))
    }

    @Test
    fun percentsHaveTheRequestedDecimals() {
        assertEquals("87%", percent(0.873, 0))
        assertEquals("87.3%", percent(0.873, 1))
    }

    private fun detections(n: Int) = List(n) { Detection(Box(0.0, 0.0, 1.0, 1.0), it % 3, "c$it", 0.5) }

    @Test
    fun theCanvasTextListsAtMostTwentyAndCountsTheRest() {
        val (twenty, none) = altChips(detections(20))
        assertEquals(20, twenty.size)
        assertEquals(0, none)
        val (capped, more) = altChips(detections(100))
        assertEquals(20, capped.size)
        assertEquals(80, more)
        assertEquals("c0 50%", capped.first())
        val (few, zero) = altChips(detections(2))
        assertEquals(listOf("c0 50%", "c1 50%"), few)
        assertEquals(0, zero)
        assertTrue(altChips(emptyList()).first.isEmpty())
    }
}
