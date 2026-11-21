package es.sebas1705.ilabs.vision

// Wildcard imports of the vision package plus kotlinx.serialization.json and kotlinx.coroutines, as a consumer would
// write them. This file must compile without any import alias: the main package exposes only the library API (the
// fixture harness lives in `...vision.contract`), and no public name may clash with kotlinx (`Json` in particular).
import kotlinx.coroutines.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import kotlin.test.Test
import kotlin.test.assertEquals

class WildcardImportsTest {
    @Test
    fun visionAndKotlinxWildcardImportsDoNotClash() = runTest {
        val json = Json.parseToJsonElement("""{"input":{"width":1,"height":1,"layout":"nhwc","channels":"rgb","mode":"stretch","resample":"bilinear","dtype":"float"},"output":{"type":"logits"}}""")
        val spec: ModelSpec = parseModelSpec(json)
        val image: Image = Image(1, 1, byteArrayOf(1, 2, 3))
        val prepared: Prepared = toTensor(image, spec)
        val geometry: Geometry = preprocessGeometry(1, 1, spec)
        assertEquals(geometry, prepared.geometry)
        val model: ScriptedModel = scriptedModel(mapOf("output" to Tensor(listOf(2), doubleArrayOf(1.0, 2.0))))
        val clock: Clock = Clock { 0.0 }
        val result: ClassifyResult = classify(model, image, spec, clock = clock)
        val entry: ClassEntry = result.entries.first()
        assertEquals(1, entry.index)
        val timing: Timing = result.timing
        assertEquals(0.0, timing.inferenceMs)
        val box: Box = Box(0.0, 0.0, 1.0, 1.0)
        val detection: Detection = Detection(box, 0, "#0", 0.5)
        assertEquals(listOf(detection), nms(listOf(detection), 0.5))
        assertEquals(1.0, iou(box, box))
        val kind: VisionErrorKind = VisionErrorKind.INVALID_OPTIONS
        assertEquals("invalid_options", kind.wire)
        val deferred = async { resize(image, 1, 1, ResizeMethod.NEAREST) }
        assertEquals(1, deferred.await().width)
        val ap: ApResult = averagePrecision(emptyList(), emptyList(), 0.5)
        assertEquals(emptyList(), ap.byClass)
        val options: DetectionOptions = DetectionOptions()
        assertEquals(100, options.maxDetections)
        assertEquals(JsonPrimitive(1), JsonPrimitive(1))
    }
}
