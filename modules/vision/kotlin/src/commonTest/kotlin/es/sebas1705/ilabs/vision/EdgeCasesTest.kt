package es.sebas1705.ilabs.vision

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonUnquotedLiteral
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertSame
import kotlin.test.assertTrue

/** Clarification 33 (cases no fixture can express) and the ordering / cost rulings. */
class EdgeCasesTest {
    @Test
    fun minusZeroIsAcceptedForPadValueLabelOffsetMinScoreAndAClassId() {
        val padded = spec(input = INPUT_JSON.removeSuffix("}") + ",\"padValue\":-0}")
        assertEquals(0, padded.input.padValue)
        assertEquals(0, spec(rest = ""","labelOffset":-0""").labelOffset)
        assertEquals(1, postprocessClassification(doubleArrayOf(1.0), spec(), minScore = -0.0).size)
        // a class id of -0 is the class 0
        val s = detectorSpec(rest = ""","labels":["a"]""")
        val outputs = mapOf("boxes" to tensor(listOf(1, 4), 0.0, 0.0, 5.0, 5.0), "classes" to tensor(listOf(1), -0.0), "scores" to tensor(listOf(1), 0.9))
        val out = postprocessDetections(outputs, s, preprocessGeometry(20, 20, s), ImageSize(20, 20), DetectionOptions())
        assertEquals("a", out.single().label)
        assertEquals(0, out.single().classIndex)
    }

    @Test
    fun theLiteral1e999IsRejectedAndTheIntegerLiteral224Point0IsAccepted() {
        val reasonOf = { json: String -> assertKind(VisionErrorKind.INVALID_SPEC) { parseModelSpec(json) }.message }
        assertEquals("invalid model spec: input.width must be an integer from 1 to 16384", reasonOf(specJson(input = INPUT_JSON.replace("\"width\":2", "\"width\":1e999"))))
        assertEquals("invalid model spec: input.scale must be a finite number", reasonOf(specJson(input = INPUT_JSON.removeSuffix("}") + ",\"scale\":1e999}")))
        assertEquals(224, spec(input = INPUT_JSON.replace("\"width\":2", "\"width\":224.0")).input.width)
    }

    @OptIn(ExperimentalSerializationApi::class)
    @Test
    fun onlyJsonNumberLiteralsAreNumbers() {
        fun specWith(width: kotlinx.serialization.json.JsonElement) = parseModelSpec(
            JsonObject(
                mapOf(
                    "input" to JsonObject(
                        mapOf(
                            "width" to width, "height" to JsonPrimitive(2), "layout" to JsonPrimitive("nhwc"), "channels" to JsonPrimitive("rgb"),
                            "mode" to JsonPrimitive("stretch"), "resample" to JsonPrimitive("nearest"), "dtype" to JsonPrimitive("float"),
                        ),
                    ),
                    "output" to JsonObject(mapOf("type" to JsonPrimitive("logits"))),
                    "labels" to JsonArray(emptyList()),
                ),
            ),
        )
        for (text in listOf("1d", "0x10", "NaN", "Infinity", "1_000", "+5", ".5", "5.", "01", "1e", "--1")) {
            val e = assertKind(VisionErrorKind.INVALID_SPEC) { specWith(JsonUnquotedLiteral(text)) }
            assertEquals("invalid model spec: input.width must be an integer from 1 to 16384", e.message, text)
        }
        assertEquals(5, specWith(JsonUnquotedLiteral("5")).input.width)
        assertEquals(50, specWith(JsonUnquotedLiteral("5E1")).input.width)
        assertEquals(5, specWith(JsonUnquotedLiteral("5.0e0")).input.width)
        assertEquals(7, specWith(JsonPrimitive(7)).input.width)
    }

    @Test
    fun detectionOptionsAreValidatedBeforeTheSourceSize() {
        val s = detectorSpec()
        val e = assertKind(VisionErrorKind.INVALID_OPTIONS) {
            postprocessDetections(emptyMap(), s, preprocessGeometry(20, 20, s), ImageSize(0, 0), DetectionOptions(scoreThreshold = 2.0))
        }
        assertTrue("scoreThreshold" in (e.message ?: ""), e.message)
        val sourceFirst = assertKind(VisionErrorKind.INVALID_OPTIONS) {
            postprocessDetections(emptyMap(), s, preprocessGeometry(20, 20, s), ImageSize(0, 0), DetectionOptions())
        }
        assertTrue("source" in (sourceFirst.message ?: ""), sourceFirst.message)
    }

    @Test
    fun nmsRejectsANegativeClassIndex() {
        assertKind(VisionErrorKind.INVALID_OPTIONS) { nms(listOf(Detection(Box(0.0, 0.0, 1.0, 1.0), -1, "x", 0.5)), 0.5) }
        assertEquals(1, nms(listOf(Detection(Box(0.0, 0.0, 1.0, 1.0), Int.MAX_VALUE, "x", 0.5)), 0.5).size)
    }

    @Test
    fun scriptedModelCallsIsAReadOnlyCopy() = runTest {
        val model = scriptedModel(emptyMap())
        val input = tensor(listOf(1), 1.0)
        model.run(input)
        val snapshot = model.calls
        model.run(tensor(listOf(1), 2.0))
        assertEquals(1, snapshot.size)
        assertEquals(2, model.calls.size)
        assertSame(input, model.calls[0])
    }

    @Test
    fun nmsOf20000PairwiseDisjointBoxesOfOneClassIsQuick() {
        val n = 20_000
        val list = ArrayList<Detection>(n)
        for (i in 0 until n) {
            val x = (i % 200) * 20.0
            val y = (i / 200) * 20.0
            list.add(Detection(Box(x, y, x + 10.0, y + 10.0), 1, "#1", 1.0 - i / 100_000.0))
        }
        val started = kotlin.time.TimeSource.Monotonic.markNow()
        val kept = nms(list, 0.5)
        val seconds = started.elapsedNow().inWholeMilliseconds / 1000.0
        assertEquals(n, kept.size)
        assertTrue(seconds < 5.0, "nms of $n disjoint boxes took $seconds s")
    }
}
