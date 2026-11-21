package es.sebas1705.ilabs.vision

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ImageOpsTest {
    @Test
    fun bytesAreReadAsUnsigned() {
        // 255 is a byte -1 and 200 a byte -56: every operation must see 255 and 200
        val image = img(1, 1, 255, 200, 128)
        assertEquals(listOf(255, 200, 128), unsigned(resize(image, 1, 1, ResizeMethod.NEAREST)))
        assertEquals(listOf(255, 200, 128), unsigned(resize(image, 1, 1, ResizeMethod.BILINEAR)))
        assertEquals(listOf(255, 200, 128, 255, 200, 128), unsigned(resize(image, 2, 1, ResizeMethod.BILINEAR)))
        // bilinear average of 255 and 1 is 128, never the average of -1 and 1
        assertEquals(listOf(128, 128, 128), unsigned(resize(img(2, 1, 255, 255, 255, 1, 1, 1), 1, 1, ResizeMethod.BILINEAR)))
        val t = toTensor(image, spec(input = INPUT_JSON.replace("\"width\":2", "\"width\":1").replace("\"height\":2", "\"height\":1"))).tensor
        assertContentEquals(doubleArrayOf(255.0, 200.0, 128.0), t.data)
        val u8 = toTensor(image, spec(input = """{"width":1,"height":1,"layout":"nhwc","channels":"bgr","mode":"stretch","resample":"nearest","dtype":"uint8"}""")).tensor
        assertContentEquals(doubleArrayOf(128.0, 200.0, 255.0), u8.data)
    }

    @Test
    fun resultBytesAreWrittenBackWithExplicitConversion() {
        val out = resize(img(2, 1, 255, 0, 255, 255, 0, 255), 1, 1, ResizeMethod.BILINEAR)
        // (255 + 255) / 2 = 255, (0 + 0) / 2 = 0
        assertEquals(listOf(255, 0, 255), unsigned(out))
        assertEquals(-1, out.data[0].toInt())
    }

    @Test
    fun inputsAreNeverMutated() {
        val image = img(3, 2, *IntArray(18) { it * 13 })
        val before = image.data.copyOf()
        resize(image, 5, 4, ResizeMethod.BILINEAR)
        resize(image, 2, 1, ResizeMethod.NEAREST)
        toTensor(image, spec(input = """{"width":4,"height":4,"layout":"nchw","channels":"bgr","mode":"letterbox","resample":"bilinear","dtype":"float"}"""))
        assertContentEquals(before, image.data)
        val resized = resize(image, 3, 2, ResizeMethod.NEAREST)
        assertTrue(resized.data !== image.data)
        assertContentEquals(before, resized.data)
    }

    @Test
    fun theWorkedBilinearExample() {
        // resize-bilinear-downscale: the red block 10 20 / 12 18 averages to 15
        val data = IntArray(48)
        data[0] = 10
        data[3] = 20
        data[12] = 12
        data[15] = 18
        val out = resize(img(4, 4, *data), 2, 2, ResizeMethod.BILINEAR)
        assertEquals(15, unsigned(out)[0])
    }

    @Test
    fun imageValidationOrderAndLimits() {
        val e1 = assertKind(VisionErrorKind.INVALID_OPTIONS) { resize(Image(0, 1, ByteArray(0)), 1, 1, ResizeMethod.NEAREST) }
        assertEquals(VisionErrorKind.INVALID_OPTIONS, e1.kind)
        assertKind(VisionErrorKind.INVALID_OPTIONS) { resize(Image(1, 0, ByteArray(0)), 1, 1, ResizeMethod.NEAREST) }
        assertKind(VisionErrorKind.INVALID_OPTIONS) { resize(Image(-1, 1, ByteArray(3)), 1, 1, ResizeMethod.NEAREST) }
        assertKind(VisionErrorKind.INVALID_OPTIONS) { resize(Image(1, 1, ByteArray(2)), 1, 1, ResizeMethod.NEAREST) }
        assertKind(VisionErrorKind.INVALID_OPTIONS) { resize(Image(1, 1, ByteArray(4)), 1, 1, ResizeMethod.NEAREST) }
        assertKind(VisionErrorKind.INVALID_OPTIONS) { resize(Image(16385, 1, ByteArray(16385 * 3)), 1, 1, ResizeMethod.NEAREST) }
        assertKind(VisionErrorKind.INVALID_OPTIONS) { resize(Image(1, 16385, ByteArray(16385 * 3)), 1, 1, ResizeMethod.NEAREST) }
        // targets
        val image = img(1, 1, 1, 2, 3)
        for (bad in listOf(0, -1, 16385, Int.MIN_VALUE, Int.MAX_VALUE)) {
            assertKind(VisionErrorKind.INVALID_OPTIONS) { resize(image, bad, 1, ResizeMethod.NEAREST) }
            assertKind(VisionErrorKind.INVALID_OPTIONS) { resize(image, 1, bad, ResizeMethod.BILINEAR) }
        }
    }

    @Test
    fun intOverflowIsGuardedInEveryImageCheck() {
        // 65536 * 65536 * 3 and Int.MAX_VALUE * 3 overflow a 32-bit Int: the size limit rejects them before any product
        assertKind(VisionErrorKind.INVALID_OPTIONS) { resize(Image(65536, 65536, ByteArray(12)), 1, 1, ResizeMethod.NEAREST) }
        assertKind(VisionErrorKind.INVALID_OPTIONS) { resize(Image(Int.MAX_VALUE, Int.MAX_VALUE, ByteArray(3)), 1, 1, ResizeMethod.NEAREST) }
        assertKind(VisionErrorKind.INVALID_OPTIONS) { resize(Image(715827883, 1, ByteArray(3)), 1, 1, ResizeMethod.NEAREST) }
        // 1431655766 * 3 wraps to a small positive Int; the length check must not be fooled
        assertKind(VisionErrorKind.INVALID_OPTIONS) { resize(Image(1431655766, 1, ByteArray(2)), 1, 1, ResizeMethod.NEAREST) }
        // the largest legal image size with the wrong length
        assertKind(VisionErrorKind.INVALID_OPTIONS) { resize(Image(16384, 16384, ByteArray(3)), 1, 1, ResizeMethod.NEAREST) }
        assertKind(VisionErrorKind.INVALID_OPTIONS) { preprocessGeometry(Int.MAX_VALUE, 1, spec()) }
        assertKind(VisionErrorKind.INVALID_OPTIONS) { unmapBox(Box(0.0, 0.0, 1.0, 1.0), preprocessGeometry(1, 1, spec()), 70000, 70000) }
    }

    @Test
    fun aMaximalSideIsAccepted() {
        val wide = Image(16384, 1, ByteArray(16384 * 3) { 9 })
        val out = resize(wide, 2, 1, ResizeMethod.BILINEAR)
        assertEquals(listOf(9, 9, 9, 9, 9, 9), unsigned(out))
        val tall = Image(1, 16384, ByteArray(16384 * 3) { 9 })
        assertEquals(16384, resize(tall, 1, 16384, ResizeMethod.NEAREST).height)
    }

    @Test
    fun resizeOf4096By4096CompletesQuickly() {
        val size = 4096
        val image = Image(size, size, ByteArray(size * size * 3) { (it * 31 + it / 7).toByte() })
        val started = kotlin.time.TimeSource.Monotonic.markNow()
        val down = resize(image, 1024, 1024, ResizeMethod.BILINEAR)
        val same = resize(image, size, size, ResizeMethod.BILINEAR)
        val seconds = started.elapsedNow().inWholeMilliseconds / 1000.0
        assertEquals(1024 * 1024 * 3, down.data.size)
        assertContentEquals(image.data, same.data)
        assertTrue(seconds < 30.0, "resize of a 4096x4096 image took $seconds s")
    }

    @Test
    fun centerCropOfAHugeScaledSizeNeedsNoWholeImage() {
        // a 1x16384 source to a 16384x1 target scales by 16384: the scaled image would be 16384 x 268,435,456
        val src = Image(1, 16384, ByteArray(16384 * 3) { (it % 251).toByte() })
        val s = spec(input = """{"width":16384,"height":1,"layout":"nhwc","channels":"rgb","mode":"centerCrop","resample":"bilinear","dtype":"float"}""")
        val prepared = toTensor(src, s)
        assertEquals(listOf(1, 1, 16384, 3), prepared.tensor.shape)
        assertEquals(16384 * 3, prepared.tensor.data.size)
        assertEquals(268_435_456, prepared.geometry.newHeight)
        assertEquals(16384, prepared.geometry.newWidth)
        assertEquals(-134_217_727.0, prepared.geometry.offsetY)
        val nearest = toTensor(src, spec(input = """{"width":16384,"height":1,"layout":"nchw","channels":"bgr","mode":"centerCrop","resample":"nearest","dtype":"uint8"}"""))
        assertEquals(listOf(1, 3, 1, 16384), nearest.tensor.shape)
    }

    @Test
    fun geometrySourceSizesAreValidated() {
        for (bad in listOf(0, -5, 16385)) {
            assertKind(VisionErrorKind.INVALID_OPTIONS) { preprocessGeometry(bad, 1, spec()) }
            assertKind(VisionErrorKind.INVALID_OPTIONS) { preprocessGeometry(1, bad, spec()) }
        }
        // both spec kinds are accepted by the geometry
        assertEquals(10.0, preprocessGeometry(2, 2, detectorSpec()).scaleX)
        assertEquals(1.0, preprocessGeometry(2, 2, spec()).scaleX)
    }

    @Test
    fun unmapBoxValidatesSizesAndCoordinates() {
        val g = preprocessGeometry(10, 10, spec())
        val box = Box(1.0, 1.0, 2.0, 2.0)
        for (bad in listOf(0, -1, 16385)) {
            assertKind(VisionErrorKind.INVALID_OPTIONS) { unmapBox(box, g, bad, 10) }
            assertKind(VisionErrorKind.INVALID_OPTIONS) { unmapBox(box, g, 10, bad) }
        }
        for (v in listOf(Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY)) {
            assertKind(VisionErrorKind.INVALID_OPTIONS) { unmapBox(Box(v, 1.0, 2.0, 2.0), g, 10, 10) }
            assertKind(VisionErrorKind.INVALID_OPTIONS) { unmapBox(Box(1.0, v, 2.0, 2.0), g, 10, 10) }
            assertKind(VisionErrorKind.INVALID_OPTIONS) { unmapBox(Box(1.0, 1.0, v, 2.0), g, 10, 10) }
            assertKind(VisionErrorKind.INVALID_OPTIONS) { unmapBox(Box(1.0, 1.0, 2.0, v), g, 10, 10) }
        }
        assertNotNull(unmapBox(box, g, 10, 10))
        // a swapped box is dropped, never reordered
        assertNull(unmapBox(Box(2.0, 1.0, 1.0, 2.0), g, 10, 10))
    }

    @Test
    fun negativeZeroIsAcceptedWhereZeroIs() {
        val g = preprocessGeometry(10, 10, spec())
        val box = unmapBox(Box(-0.0, -0.0, 1.0, 1.0), g, 10, 10)
        assertNotNull(box)
        assertTrue(box.x1 == 0.0 && box.y1 == 0.0)
        // 0 / negative std is -0 in a tensor and equals 0
        val s = spec(input = INPUT_JSON.removeSuffix("}") + ",\"std\":[-2,-2,-2]}")
        val t = toTensor(img(2, 2, *IntArray(12)), s).tensor
        assertTrue(t.data.all { it == 0.0 })
    }

    @Test
    fun toTensorValidatesItsImage() {
        assertKind(VisionErrorKind.INVALID_OPTIONS) { toTensor(Image(2, 2, ByteArray(11)), spec()) }
        assertKind(VisionErrorKind.INVALID_OPTIONS) { toTensor(Image(0, 2, ByteArray(0)), spec()) }
    }

    @Test
    fun theTensorHasTheDocumentedLayoutAndNormalization() {
        val s = spec(input = """{"width":2,"height":1,"layout":"nchw","channels":"bgr","mode":"stretch","resample":"nearest","dtype":"float","scale":0.5,"mean":[1,2,3],"std":[2,4,8]}""")
        val t = toTensor(img(2, 1, 10, 20, 30, 40, 50, 60), s).tensor
        assertEquals(listOf(1, 3, 1, 2), t.shape)
        // bgr: first output channel is blue; value = (v * 0.5 - mean[c]) / std[c]
        assertContentEquals(doubleArrayOf((30 * 0.5 - 1) / 2, (60 * 0.5 - 1) / 2, (20 * 0.5 - 2) / 4, (50 * 0.5 - 2) / 4, (10 * 0.5 - 3) / 8, (40 * 0.5 - 3) / 8), t.data)
    }

    @Test
    fun aTensorHandedBackIsANewValue() {
        val image = img(1, 1, 1, 2, 3)
        val a = toTensor(image, spec(input = INPUT_JSON.replace("\"width\":2", "\"width\":1").replace("\"height\":2", "\"height\":1"))).tensor
        val b = toTensor(image, spec(input = INPUT_JSON.replace("\"width\":2", "\"width\":1").replace("\"height\":2", "\"height\":1"))).tensor
        assertTrue(a.data !== b.data)
    }
}
