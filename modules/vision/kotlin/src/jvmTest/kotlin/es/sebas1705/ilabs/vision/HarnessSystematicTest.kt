package es.sebas1705.ilabs.vision

import es.sebas1705.ilabs.vision.contract.Fixture
import es.sebas1705.ilabs.vision.contract.FixtureError
import es.sebas1705.ilabs.vision.contract.FixtureModelError
import es.sebas1705.ilabs.vision.contract.FixtureOutcome
import es.sebas1705.ilabs.vision.contract.PipelineRun
import es.sebas1705.ilabs.vision.contract.checkOutcome
import es.sebas1705.ilabs.vision.contract.parseFixture
import es.sebas1705.ilabs.vision.contract.runFixture
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/** Systematic harness self-tests over every real fixture (the same ones as the TypeScript harness tests). */
class HarnessSystematicTest {
    private fun contractsDir(): File {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            val candidate = File(dir, "contracts/vision")
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile
        }
        error("contracts/vision not found")
    }

    private val fixtures: List<Fixture> by lazy {
        contractsDir().listFiles { f -> f.extension == "json" }!!.sortedBy { it.name }.map { parseFixture(it.readText()) }
    }

    private fun byName(name: String) = fixtures.first { it.name == name }

    private suspend fun allRuns(): Map<String, FixtureOutcome> = fixtures.associate { it.name to runFixture(it) }

    private fun expectOf(fx: Fixture): JsonElement = (fx.root as JsonObject).getValue("expect")

    private fun withExpect(fx: Fixture, expect: JsonElement): Fixture = Fixture(fx.root.edit(listOf("expect")) { expect })

    private fun mutantMessage(fx: Fixture): String = try {
        kotlinx.coroutines.runBlocking { runFixture(fx) }
        "no error"
    } catch (e: IllegalStateException) {
        e.message ?: ""
    }

    @Test
    fun unknownKeysAreRejectedAtEveryClosedObjectOfEveryFixture() {
        var checked = 0
        for (fx in fixtures) {
            for (path in closedObjects(fx.root)) {
                val mutated = Fixture(fx.root.edit(path) { node -> JsonObject(LinkedHashMap((node as JsonObject)).also { it["bogusKey"] = JsonPrimitive(1) }) })
                assertEquals("invalid fixture: unknown key: bogusKey", mutantMessage(mutated), "${fx.name} at ${path.joinToString(".")}")
                checked++
            }
        }
        assertTrue(checked > 1000, "checked $checked sites")
    }

    @Test
    fun aSpecsOwnUnknownKeysGoToParseModelSpec() = runTest {
        val base = byName("spec-valid-minimal")
        val root = base.root.edit(listOf("setup", "spec")) { JsonObject(LinkedHashMap((it as JsonObject)).also { m -> m["bogusKey"] = JsonPrimitive(1) }) }
            .edit(listOf("expect")) { parseJson("""{"error":{"kind":"invalid_spec","message":"invalid model spec: unknown key: bogusKey"}}""") }
        val fx = Fixture(root)
        assertEquals(emptyList(), checkOutcome(fx, runFixture(fx)))
    }

    @Test
    fun theRealRunsAreAccepted() = runTest {
        val runs = allRuns()
        for (fx in fixtures) assertTrue(passes(fx, runs.getValue(fx.name)), fx.name)
    }

    @Test
    fun everyNumberMovedBeyondTheToleranceEveryStringChangedEveryBooleanFlippedIsRejected() = runTest {
        val runs = allRuns()
        var mutations = 0
        for (fx in fixtures) {
            val expect = expectOf(fx)
            for (path in sample(leafPaths(expect), 60)) {
                val leaf = expect.at(path) as JsonPrimitive
                val replacement: JsonElement = when {
                    leaf is JsonNull -> continue
                    leaf.isString -> JsonPrimitive(leaf.content + "x")
                    leaf.content == "true" -> JsonPrimitive(false)
                    leaf.content == "false" -> JsonPrimitive(true)
                    else -> {
                        val value = leaf.content.toDouble()
                        if (value + 1e-6 == value) continue
                        JsonPrimitive(value + 1e-6)
                    }
                }
                val mutated = withExpect(fx, expect.edit(path) { replacement })
                assertTrue(!passes(mutated, runs.getValue(fx.name)), "${fx.name}: ${path.joinToString(".")} mutated")
                mutations++
            }
        }
        assertTrue(mutations > 2000, "mutations: $mutations")
    }

    @Test
    fun everyListThatLosesItsLastElementOrGetsAnExtraOneIsRejected() = runTest {
        val runs = allRuns()
        var mutations = 0
        for (fx in fixtures) {
            val expect = expectOf(fx)
            for (path in arrayPaths(expect)) {
                val shorter = withExpect(fx, expect.edit(path) { JsonArray((it as JsonArray).dropLast(1)) })
                assertTrue(!passes(shorter, runs.getValue(fx.name)), "${fx.name}: ${path.joinToString(".")} shortened")
                val longer = withExpect(fx, expect.edit(path) { JsonArray((it as JsonArray) + it[0]) })
                assertTrue(!passes(longer, runs.getValue(fx.name)), "${fx.name}: ${path.joinToString(".")} lengthened")
                mutations += 2
            }
        }
        assertTrue(mutations > 250, "mutations: $mutations")
    }

    @Test
    fun anExpectationThatLostATopLevelKeyIsRejected() = runTest {
        val runs = allRuns()
        var mutations = 0
        for (fx in fixtures) {
            val expect = expectOf(fx) as JsonObject
            for (key in expect.keys) {
                val mutated = withExpect(fx, JsonObject(LinkedHashMap(expect).also { it.remove(key) }))
                assertTrue(!passes(mutated, runs.getValue(fx.name)), "${fx.name}: $key removed")
                mutations++
            }
        }
        assertTrue(mutations > 400, "mutations: $mutations")
    }

    @Test
    fun theToleranceIs1e9AbsoluteAndIntegersAreExact() = runTest {
        val fx = byName("classify-logits-softmax")
        val run = runFixture(fx)
        val score = (expectOf(fx).at(listOf("entries", 0, "score")) as JsonPrimitive).content.toDouble()
        fun withScore(v: Double) = withExpect(fx, expectOf(fx).edit(listOf("entries", 0, "score")) { JsonPrimitive(v) })
        assertTrue(passes(withScore(score + 5e-10), run))
        assertTrue(!passes(withScore(score + 1.5e-9), run))
        val indexValue = (expectOf(fx).at(listOf("entries", 0, "index")) as JsonPrimitive).content.toDouble()
        val index = withExpect(fx, expectOf(fx).edit(listOf("entries", 0, "index")) { JsonPrimitive(indexValue + 5e-10) })
        assertTrue(!passes(index, run))
    }

    @Test
    fun minusZeroIsAcceptedWhereZeroIsAndNaNNeverMatches() = runTest {
        val fx = byName("geometry-centercrop-even")
        val real = runFixture(fx)
        val g = assertNotNull(real.geometry)
        fun with(geometry: Geometry) = FixtureOutcome("geometry", geometry = geometry)
        assertTrue(passes(fx, with(g.copy(offsetY = -0.0))))
        assertTrue(!passes(fx, with(g.copy(offsetY = Double.NaN))))
        assertTrue(!passes(fx, with(g.copy(newWidth = g.newWidth + 1))))
    }

    @Test
    fun equalNonFiniteValuesCompareEqual() = runTest {
        val fx = fixtureOf(
            """{"name":"t","setup":{"kind":"tensor","image":{"width":1,"height":1,"data":[1,2,3]},"spec":{"input":{"width":1,"height":1,"layout":"nhwc","channels":"rgb","mode":"stretch","resample":"nearest","dtype":"float"},"output":{"type":"logits"}}},"expect":{"shape":[1,1,1,3],"data":["Infinity","-Infinity","NaN"]}}""",
        )
        val inf = Double.POSITIVE_INFINITY
        // NaN never matches NaN
        assertTrue(!passes(fx, FixtureOutcome("tensor", tensor = Tensor(listOf(1, 1, 1, 3), doubleArrayOf(inf, -inf, Double.NaN)))))
        assertTrue(!passes(fx, FixtureOutcome("tensor", tensor = Tensor(listOf(1, 1, 1, 3), doubleArrayOf(inf, inf, 0.0)))))
        val finiteOnly = fixtureOf(fx.root.toString().replace("\"NaN\"", "0"))
        assertTrue(passes(finiteOnly, FixtureOutcome("tensor", tensor = Tensor(listOf(1, 1, 1, 3), doubleArrayOf(inf, -inf, 0.0)))))
    }

    @Test
    fun anImageMustMatchByteForByte() = runTest {
        val fx = byName("resize-nearest-upscale")
        val real = runFixture(fx)
        val image = assertNotNull(real.image)
        val flipped = image.data.copyOf().also { it[5] = (it[5].toInt() xor 1).toByte() }
        assertTrue(!passes(fx, FixtureOutcome("resize", image = Image(image.width, image.height, flipped))))
        assertTrue(!passes(fx, FixtureOutcome("resize", image = Image(image.width + 1, image.height, image.data))))
        assertTrue(!passes(fx, FixtureOutcome("resize", image = Image(image.width, image.height + 1, image.data))))
        assertTrue(passes(fx, real))
    }

    @Test
    fun anUnexpectedErrorAMissingErrorAWrongKindAndAWrongMessageAllFail() = runTest {
        val withError = byName("spec-invalid-not-object")
        val run = runFixture(withError)
        assertTrue(passes(withError, run))
        assertTrue(!passes(withError, FixtureOutcome("spec", error = FixtureError("invalid_options", run.error?.message))))
        assertTrue(!passes(withError, FixtureOutcome("spec", error = FixtureError("invalid_spec", run.error?.message + "."))))
        assertTrue(!passes(withError, FixtureOutcome("spec", valid = true)))
        val success = byName("resize-nearest-upscale")
        assertTrue(!passes(success, FixtureOutcome("resize", error = FixtureError("invalid_options", "x"))))
        val expectsError = byName("invalid-topk-zero")
        assertTrue(!passes(expectsError, runFixture(byName("classify-logits-softmax"))))
        // the message is compared only when the expectation has one
        assertTrue(passes(expectsError, FixtureOutcome("classify", error = FixtureError("invalid_options", "another wording"))))
    }

    @Test
    fun aPipelineModelErrorMustBeTheVeryErrorObjectAndTheModelMustRunAfterTwoReads() = runTest {
        val fx = byName("pipeline-model-error-propagates")
        val real = runFixture(fx)
        val p = assertNotNull(real.pipeline)
        assertTrue(passes(fx, real))
        fun with(run: PipelineRun) = FixtureOutcome("pipeline", pipeline = run)
        fun copy(modelError: Throwable?, scripted: Throwable?, readsAtRun: List<Int> = p.readsAtRun, reads: Int = p.clockReads, calls: Int = p.modelCalls) =
            PipelineRun(p.task, modelError = modelError, scriptedError = scripted, readsAtRun = readsAtRun, clockReads = reads, modelCalls = calls)
        assertTrue(!passes(fx, with(copy(FixtureModelError("model failed"), p.scriptedError))))
        assertTrue(!passes(fx, with(copy(IllegalStateException("model failed"), p.scriptedError))))
        assertTrue(!passes(fx, with(copy(p.modelError, p.scriptedError, readsAtRun = listOf(1)))))
        val ok = byName("pipeline-clock-timings")
        val okRun = assertNotNull(runFixture(ok).pipeline)
        fun okWith(reads: Int = okRun.clockReads, calls: Int = okRun.modelCalls, readsAtRun: List<Int> = okRun.readsAtRun) =
            FixtureOutcome("pipeline", pipeline = PipelineRun(okRun.task, okRun.entries, okRun.detections, okRun.timing, okRun.geometry, okRun.input, calls, reads, readsAtRun))
        assertTrue(passes(ok, okWith()))
        assertTrue(!passes(ok, okWith(reads = 3)))
        assertTrue(!passes(ok, okWith(calls = 2, readsAtRun = listOf(2, 2))))
    }

    @Test
    fun detectionsMustBeInOrderWithTheSameLabelsAndBoxes() = runTest {
        val fx = byName("decode-ssd-sorted-before-cut")
        val real = runFixture(fx)
        val detections = assertNotNull(real.detections)
        assertTrue(!passes(fx, FixtureOutcome("decode", detections = detections.reversed())))
        assertTrue(!passes(fx, FixtureOutcome("decode", detections = listOf(detections[0].copy(box = detections[0].box.copy(x2 = detections[0].box.x2 + 1e-6))) + detections.drop(1))))
        assertTrue(!passes(fx, FixtureOutcome("decode", detections = listOf(detections[0].copy(label = "other")) + detections.drop(1))))
    }
}
