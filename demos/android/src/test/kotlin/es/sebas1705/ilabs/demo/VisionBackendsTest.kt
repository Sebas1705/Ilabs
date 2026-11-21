package es.sebas1705.ilabs.demo

import es.sebas1705.ilabs.vision.ChannelOrder
import es.sebas1705.ilabs.vision.Image
import es.sebas1705.ilabs.vision.InputDType
import es.sebas1705.ilabs.vision.InputSpec
import es.sebas1705.ilabs.vision.ModelSpec
import es.sebas1705.ilabs.vision.OutputSpec
import es.sebas1705.ilabs.vision.ResizeMethod
import es.sebas1705.ilabs.vision.ResizeMode
import es.sebas1705.ilabs.vision.ScoreType
import es.sebas1705.ilabs.vision.Tensor
import es.sebas1705.ilabs.vision.TensorLayout
import es.sebas1705.ilabs.vision.toTensor
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class VisionBackendsTest {
    private val catalog = loadVisionCatalog(FileVisionAssets())

    // ---- the catalog ----

    @Test
    fun readsTheFourCardsAndTheLabels() {
        assertEquals(4, catalog.cards.size)
        assertTrue(catalog.problems.toString(), catalog.problems.isEmpty())
        val mobilenet = catalog.recordedCard(VisionTask.CLASSIFICATION)!!
        assertEquals("mobilenet-v2-onnx", mobilenet.id)
        assertEquals(1000, mobilenet.spec.labels!!.size)
        assertEquals(mapOf("scores" to "output"), mobilenet.outputs)
        val ssd = catalog.recordedCard(VisionTask.DETECTION)!!
        assertEquals(90, ssd.spec.labels!!.size)
        assertEquals(1, ssd.spec.labelOffset)
        assertEquals("person", ssd.spec.labels!!.first())
        val tflite = catalog.realCard(VisionTask.DETECTION)!!
        assertEquals(0, tflite.spec.labelOffset)
        assertEquals(mapOf("boxes" to 0, "classes" to 1, "scores" to 2, "count" to 3), tflite.outputIndex)
        assertEquals("efficientnet_lite0.tflite", catalog.realCard(VisionTask.CLASSIFICATION)!!.file)
    }

    @Test
    fun labelLinesAcceptEitherLineEndingAndIgnoreAFinalNewline() {
        assertEquals(listOf("a", "b c", "d"), parseLabelLines("a\r\nb c\r\nd\r\n"))
        assertEquals(listOf("a", "b"), parseLabelLines("a\nb"))
        assertEquals(listOf("a", "", "b"), parseLabelLines("a\n\nb\n"))
    }

    @Test
    fun theRecordedOutputsAreMappedToTheDecoderNames() {
        val card = catalog.recordedCard(VisionTask.DETECTION)!!
        val recorded = parseRecorded(java.io.File(VISION_ASSETS_DIR, "recorded/cat.detection.json").readText())
        assertEquals(card.id, recorded.model)
        assertEquals(listOf(1, 300, 300, 3), recorded.inputShape)
        assertEquals(setOf("boxes", "classes", "scores", "count"), decoderOutputs(card, recorded.tensors).keys)
        val classifier = catalog.recordedCard(VisionTask.CLASSIFICATION)!!
        val scores = parseRecorded(java.io.File(VISION_ASSETS_DIR, "recorded/cat.classification.json").readText())
        assertEquals(setOf(VISION_CLASSIFIER_OUTPUT), decoderOutputs(classifier, scores.tensors).keys)
        try {
            decoderOutputs(card, mapOf("detection_boxes" to Tensor(listOf(1), doubleArrayOf(0.0))))
            fail("a missing tensor must fail")
        } catch (e: IllegalStateException) {
            assertTrue(e.message!!.contains("detection_classes") || e.message!!.contains("detection_scores") || e.message!!.contains("num_detections"))
        }
    }

    // ---- the preview undoes the normalization ----

    private fun spec(
        layout: TensorLayout,
        channels: ChannelOrder,
        dtype: InputDType,
        scale: Double? = null,
        mean: List<Double>? = null,
        std: List<Double>? = null,
    ) = ModelSpec(
        InputSpec(2, 2, layout, channels, ResizeMode.STRETCH, ResizeMethod.NEAREST, dtype, 114, scale, mean, std),
        OutputSpec.Classifier(ScoreType.LOGITS),
    )

    private val image2x2 = Image(
        2, 2,
        byteArrayOf(10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120),
    )

    private fun pixels(p: PreviewImage): List<Int> = p.argb.map { it and 0xFFFFFF }

    private val expected = listOf(0x0A141E, 0x28323C, 0x46505A, 0x646E78)

    @Test
    fun thePreviewRestoresThePixelsForEveryLayoutOrderAndNormalization() {
        val specs = listOf(
            spec(TensorLayout.NHWC, ChannelOrder.RGB, InputDType.UINT8),
            spec(TensorLayout.NCHW, ChannelOrder.BGR, InputDType.UINT8),
            spec(TensorLayout.NCHW, ChannelOrder.RGB, InputDType.FLOAT, 1.0 / 255, listOf(0.485, 0.456, 0.406), listOf(0.229, 0.224, 0.225)),
            spec(TensorLayout.NHWC, ChannelOrder.BGR, InputDType.FLOAT, 1.0, listOf(127.0, 127.0, 127.0), listOf(128.0, 128.0, 128.0)),
            spec(TensorLayout.NHWC, ChannelOrder.RGB, InputDType.FLOAT),
        )
        for (s in specs) {
            val tensor = toTensor(image2x2, s).tensor
            val preview = previewOf(tensor, s)
            assertEquals(2, preview.width)
            assertEquals(expected, pixels(preview))
            assertTrue(preview.argb.all { (it ushr 24) == 0xFF })
        }
    }

    @Test
    fun thePreviewClampsOutOfRangeValues() {
        val s = spec(TensorLayout.NHWC, ChannelOrder.RGB, InputDType.UINT8)
        val tensor = Tensor(listOf(1, 2, 2, 3), DoubleArray(12) { if (it < 6) -5.0 else 300.0 })
        assertEquals(listOf(0x000000, 0x000000, 0xFFFFFF, 0xFFFFFF), pixels(previewOf(tensor, s)))
    }

    @Test(expected = IllegalStateException::class)
    fun aTensorOfTheWrongSizeIsRefused() {
        previewOf(Tensor(listOf(1), doubleArrayOf(1.0)), spec(TensorLayout.NHWC, ChannelOrder.RGB, InputDType.UINT8))
    }

    // ---- the LiteRT adapter, on a fake runner ----

    private class FakeRunner(
        override val inputShape: List<Int>,
        override val inputIsFloat: Boolean,
        private val outputs: Map<Int, Pair<List<Int>, FloatArray>>,
        private val float: Boolean = true,
    ) : TfLiteRunner {
        var received: ByteBuffer? = null
        var closed = false

        override fun outputShape(index: Int): List<Int> = outputs.getValue(index).first

        override fun outputIsFloat(index: Int): Boolean = float

        override fun run(input: ByteBuffer, outputs: Map<Int, ByteBuffer>) {
            received = input
            for ((index, buffer) in outputs) {
                buffer.order(ByteOrder.nativeOrder())
                this.outputs.getValue(index).second.forEach { buffer.putFloat(it) }
            }
        }

        override fun close() {
            closed = true
        }
    }

    @Test
    fun aFloatInputIsCopiedAsFloat32AndAUint8InputAsBytes() {
        val tensor = Tensor(listOf(1, 1, 2, 3), doubleArrayOf(0.5, -1.0, 2.0, 0.0, 1.0, 255.0))
        val floats = inputBuffer(tensor, true)
        assertTrue(floats.isDirect)
        assertEquals(24, floats.remaining())
        val back = FloatArray(6).also { floats.order(ByteOrder.nativeOrder()).asFloatBuffer().get(it) }
        assertArrayEquals(floatArrayOf(0.5f, -1f, 2f, 0f, 1f, 255f), back, 0f)
        val bytes = inputBuffer(tensor, false)
        assertEquals(6, bytes.remaining())
        assertEquals(listOf<Byte>(0, -1, 2, 0, 1, -1), List(6) { bytes.get() })
    }

    @Test
    fun theAdapterReturnsTheOutputsUnderTheDecoderNames() = runBlocking {
        val card = catalog.realCard(VisionTask.DETECTION)!!
        val runner = FakeRunner(
            listOf(1, 300, 300, 3), false,
            mapOf(
                0 to (listOf(1, 2, 4) to floatArrayOf(0.1f, 0.2f, 0.3f, 0.4f, 0f, 0f, 0f, 0f)),
                1 to (listOf(1, 2) to floatArrayOf(16f, 0f)),
                2 to (listOf(1, 2) to floatArrayOf(0.5f, 0f)),
                3 to (listOf(1) to floatArrayOf(1f)),
            ),
        )
        val model = LiteRtModel(card, runner)
        val outputs = model.run(Tensor(listOf(1, 300, 300, 3), DoubleArray(300 * 300 * 3) { 7.0 }))
        assertEquals(setOf("boxes", "classes", "scores", "count"), outputs.keys)
        assertEquals(listOf(1, 2, 4), outputs.getValue("boxes").shape)
        assertEquals(0.4, outputs.getValue("boxes").data[3], 1e-6)
        assertEquals(16.0, outputs.getValue("classes").data[0], 0.0)
        assertEquals(1.0, outputs.getValue("count").data[0], 0.0)
        assertEquals(300 * 300 * 3, runner.received!!.remaining())
        model.close()
        assertTrue(runner.closed)
    }

    @Test
    fun aClassifierOutputIsNamedForTheLibrary() = runBlocking {
        val card = catalog.realCard(VisionTask.CLASSIFICATION)!!
        val runner = FakeRunner(listOf(1, 224, 224, 3), true, mapOf(0 to (listOf(1, 3) to floatArrayOf(0.1f, 0.8f, 0.1f))))
        val outputs = LiteRtModel(card, runner).run(Tensor(listOf(1, 224, 224, 3), DoubleArray(224 * 224 * 3)))
        assertEquals(setOf(VISION_CLASSIFIER_OUTPUT), outputs.keys)
        assertEquals(listOf(1, 3), outputs.getValue(VISION_CLASSIFIER_OUTPUT).shape)
        assertEquals(224 * 224 * 3 * 4, runner.received!!.remaining())
    }

    @Test
    fun aMismatchedInputShapeOrAnOutputThatIsNotFloatIsRefused() {
        val card = catalog.realCard(VisionTask.CLASSIFICATION)!!
        val ok = mapOf(0 to (listOf(1, 3) to floatArrayOf(0f, 0f, 0f)))
        try {
            runBlocking { LiteRtModel(card, FakeRunner(listOf(1, 224, 224, 3), true, ok)).run(Tensor(listOf(1, 3, 224, 224), DoubleArray(3 * 224 * 224))) }
            fail("a wrong input shape must fail")
        } catch (e: IllegalStateException) {
            assertTrue(e.message!!, e.message!!.contains("does not match"))
        }
        try {
            runBlocking { LiteRtModel(card, FakeRunner(listOf(1, 224, 224, 3), true, ok, float = false)).run(Tensor(listOf(1, 224, 224, 3), DoubleArray(224 * 224 * 3))) }
            fail("a quantized output must fail")
        } catch (e: IllegalStateException) {
            assertTrue(e.message!!, e.message!!.contains("not float32"))
        }
    }

    @Test
    fun anEngineRunWithTheRealBackendTimesTheInference() = runBlocking {
        val models = FakeModels()
        val engine = VisionEngine(FileVisionAssets(models = TFLITE_FILES), ImageIoPlatform(), models, kotlinx.coroutines.Dispatchers.Unconfined)
        val card = catalog.realCard(VisionTask.CLASSIFICATION)!!
        val sample = catalog.samples.first { it.id == "cat" }
        val real = engine.infer(InferRequest(VisionTask.CLASSIFICATION, sample.ref, sample.id, VisionBackend.REAL, card))
        assertNotNull(real.inferenceMs)
        assertEquals(1, models.calls)
        val recorded = engine.infer(InferRequest(VisionTask.CLASSIFICATION, sample.ref, sample.id, VisionBackend.RECORDED, catalog.recordedCard(VisionTask.CLASSIFICATION)!!))
        assertNull(recorded.inferenceMs)
        assertEquals("a recording never opens a model", 1, models.calls)
        assertFalse(recorded.outputs.isEmpty())
    }
}
