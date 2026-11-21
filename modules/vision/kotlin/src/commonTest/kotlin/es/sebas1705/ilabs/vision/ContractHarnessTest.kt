package es.sebas1705.ilabs.vision

import es.sebas1705.ilabs.vision.contract.Fixture
import es.sebas1705.ilabs.vision.contract.FixtureError
import es.sebas1705.ilabs.vision.contract.ScriptedClock
import es.sebas1705.ilabs.vision.contract.checkOutcome
import es.sebas1705.ilabs.vision.contract.parseFixture
import es.sebas1705.ilabs.vision.contract.runFixture
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Tests of the shared fixture harness itself, mirroring the TypeScript harness tests message by message: every malformed
 * fixture reason is pinned, and the comparators must fail when they should (the systematic mutation tests over the real
 * fixtures are in the JVM tests).
 */
class ContractHarnessTest {
    private val spec = """{"input":{"width":1,"height":1,"layout":"nhwc","channels":"rgb","mode":"stretch","resample":"nearest","dtype":"float"},"output":{"type":"logits"}}"""
    private val probSpec = spec.replace("logits", "probabilities")
    private val detSpec = """{"input":{"width":1,"height":1,"layout":"nhwc","channels":"rgb","mode":"stretch","resample":"nearest","dtype":"float"},"output":{"format":"ssd","boxOrder":"xyxy","coordinates":"pixels"}}"""
    private val box = """{"x1":0,"y1":0,"x2":1,"y2":1}"""
    private val geo = """{"scaleX":1,"scaleY":1,"offsetX":0,"offsetY":0,"newWidth":1,"newHeight":1}"""
    private val img = """{"width":1,"height":1,"data":[1,2,3]}"""
    private val det = """{"box":$box,"classIndex":0,"label":"#0","score":0.9}"""
    private val mdet = """{"image":"a","classIndex":0,"score":0.9,"box":$box}"""
    private val mtruth = """{"image":"a","classIndex":0,"box":$box}"""
    private val ssdOut = """{"boxes":{"shape":[1,1,4],"data":[0,0,1,1]},"classes":{"shape":[1,1],"data":[0]},"scores":{"shape":[1,1],"data":[0.9]}}"""
    private val tm = """{"preprocessMs":1,"inferenceMs":1,"postprocessMs":1}"""
    private val input = """{"shape":[1,1,1,3],"data":[1,2,3]}"""

    private fun fx(setup: String, expect: String) = """{"name":"t","setup":$setup,"expect":$expect}"""

    private val bases: Map<String, String> = mapOf(
        "resize" to fx("""{"kind":"resize","image":$img,"width":1,"height":1,"method":"nearest"}""", """{"image":$img}"""),
        "geometry" to fx(
            """{"kind":"geometry","srcWidth":2,"srcHeight":2,"spec":$spec,"boxes":[$box]}""",
            """{"geometry":{"scaleX":0.5,"scaleY":0.5,"offsetX":0,"offsetY":0,"newWidth":1,"newHeight":1},"unmapped":[{"x1":0,"y1":0,"x2":2,"y2":2}]}""",
        ),
        "tensor" to fx("""{"kind":"tensor","image":$img,"spec":$spec}""", input),
        "classify" to fx(
            """{"kind":"classify","output":[0.5,0.25],"spec":$probSpec,"options":{"topK":1,"minScore":0}}""",
            """{"entries":[{"index":0,"label":"#0","score":0.5}]}""",
        ),
        "decode" to fx(
            """{"kind":"decode","outputs":$ssdOut,"spec":$detSpec,"srcWidth":1,"srcHeight":1,"options":{"scoreThreshold":0.1,"iouThreshold":0.5,"maxDetections":5,"nms":false}}""",
            """{"detections":[$det]}""",
        ),
        "nms" to fx("""{"kind":"nms","detections":[$det],"iouThreshold":0.5}""", """{"detections":[$det]}"""),
        "iou" to fx("""{"kind":"metrics","op":"iou","a":$box,"b":$box}""", """{"value":1}"""),
        "topk" to fx("""{"kind":"metrics","op":"topk","predictions":[[1,2]],"truths":[2],"k":2}""", """{"value":1}"""),
        "ap" to fx("""{"kind":"metrics","op":"ap","detections":[$mdet],"truths":[$mtruth],"iouThreshold":0.5}""", """{"byClass":[{"classIndex":0,"ap":1}]}"""),
        "map" to fx("""{"kind":"metrics","op":"map","detections":[$mdet],"truths":[$mtruth],"iouThreshold":0.5}""", """{"map":1,"byClass":[{"classIndex":0,"ap":1}]}"""),
        "classifyPipeline" to fx(
            """{"kind":"pipeline","image":$img,"spec":$probSpec,"task":"classify","scripted":{"outputs":{"output":{"shape":[2],"data":[0.5,0.25]}}},"options":{"topK":1,"minScore":0},"clock":[0,1,2,3]}""",
            """{"results":[{"index":0,"label":"#0","score":0.5}],"timing":$tm,"modelCalls":1,"clockReads":4,"input":$input}""",
        ),
        "detectPipeline" to fx(
            """{"kind":"pipeline","image":$img,"spec":$detSpec,"task":"detect","scripted":{"outputs":$ssdOut},"options":{"scoreThreshold":0.1,"iouThreshold":0.5,"maxDetections":5,"nms":false},"clock":[0,1,2,3]}""",
            """{"results":[$det],"timing":$tm,"modelCalls":1,"clockReads":4,"input":$input,"geometry":$geo}""",
        ),
        "modelError" to fx(
            """{"kind":"pipeline","image":$img,"spec":$spec,"task":"classify","scripted":{"error":"boom"},"clock":[0,1,2,3]}""",
            """{"modelError":"boom","modelCalls":1,"clockReads":2}""",
        ),
        "pipelineError" to fx(
            """{"kind":"pipeline","image":$img,"spec":$spec,"task":"classify","scripted":{"outputs":{}},"clock":[0,1,2,3]}""",
            """{"error":{"kind":"invalid_output"},"modelCalls":1,"clockReads":3}""",
        ),
        "spec" to fx("""{"kind":"spec","spec":$spec}""", """{"valid":true}"""),
        "specError" to fx("""{"kind":"spec","spec":1}""", """{"error":{"kind":"invalid_spec","message":"invalid model spec: spec must be an object"}}"""),
        "error" to fx("""{"kind":"resize","image":{"width":0,"height":1,"data":[1,2,3]},"width":1,"height":1,"method":"nearest"}""", """{"error":{"kind":"invalid_options"}}"""),
    )

    private suspend fun failures(f: Fixture): List<String> = checkOutcome(f, runFixture(f))

    private suspend fun messageOf(f: Fixture): String {
        val e = try {
            runFixture(f)
            null
        } catch (e: IllegalStateException) {
            e
        }
        return e?.message ?: "no error"
    }

    /** Applies [mutate] to a fresh base fixture and asserts the exact malformed-fixture message. */
    private suspend fun bad(base: String, reason: String, mutate: Doc.() -> Unit) {
        val doc = Doc(parseJson(bases.getValue(base)))
        doc.mutate()
        assertEquals("invalid fixture: $reason", messageOf(Fixture(doc.root)), "$base: $reason")
    }

    private suspend fun passing(doc: Doc) {
        val f = Fixture(doc.root)
        assertEquals(emptyList(), failures(f))
    }

    @Test
    fun theBaseFixturesAreValid() = runTest {
        for ((name, text) in bases) assertEquals(emptyList(), failures(fixtureOf(text)), name)
    }

    @Test
    fun unknownSetupKindIncludingPrototypeNames() = runTest {
        for (kind in listOf("bogus", "constructor", "__proto__", "toString", "hasOwnProperty")) bad("resize", "unknown setup kind: $kind") { put("setup.kind", "\"$kind\"") }
    }

    @Test
    fun unknownKeysAtEveryLevelOfTheStructures() = runTest {
        val u = "unknown key: bogus"
        bad("resize", u) { put("bogus", "1") }
        bad("resize", u) { put("setup.bogus", "1") }
        bad("resize", u) { put("setup.image.bogus", "1") }
        bad("resize", u) { put("setup.image.data", """{"fill":1,"length":3,"bogus":1}""") }
        bad("resize", u) { put("expect.bogus", "1") }
        bad("tensor", u) { put("expect.bogus", "1") }
        bad("decode", u) { put("setup.outputs.boxes.bogus", "1") }
        bad("decode", u) { put("setup.options.bogus", "1") }
        bad("decode", u) { put("expect.detections.0.bogus", "1") }
        bad("decode", u) { put("expect.detections.0.box.bogus", "1") }
        bad("nms", u) { put("setup.detections.0.bogus", "1") }
        bad("classify", u) { put("expect.entries.0.bogus", "1") }
        bad("classify", u) { put("setup.options.bogus", "1") }
        bad("geometry", u) { put("expect.geometry.bogus", "1") }
        bad("geometry", u) { put("setup.boxes.0.bogus", "1") }
        bad("ap", u) { put("setup.detections.0.bogus", "1") }
        bad("ap", u) { put("setup.truths.0.bogus", "1") }
        bad("ap", u) { put("expect.byClass.0.bogus", "1") }
        bad("classifyPipeline", u) { put("setup.scripted.bogus", "1") }
        bad("classifyPipeline", u) { put("setup.options.bogus", "1") }
        bad("classifyPipeline", u) { put("expect.timing.bogus", "1") }
        bad("detectPipeline", u) { put("expect.geometry.bogus", "1") }
        bad("error", u) { put("expect.error.bogus", "1") }
    }

    @Test
    fun classifierOptionsAreNotTheOptionsOfADetector() = runTest {
        bad("classifyPipeline", "unknown key: scoreThreshold") { put("setup.options", """{"scoreThreshold":0.5}""") }
        bad("detectPipeline", "unknown key: topK") { put("setup.options", """{"topK":1}""") }
        bad("classify", "unknown key: nms") { put("setup.options", """{"nms":true}""") }
        bad("decode", "unknown key: minScore") { put("setup.options", """{"minScore":0}""") }
    }

    @Test
    fun missingKeys() = runTest {
        bad("resize", "missing key: method") { remove("setup.method") }
        bad("resize", "missing key: data") { remove("setup.image.data") }
        bad("resize", "missing key: width") { remove("setup.image.width") }
        bad("resize", "missing key: kind") { remove("setup.kind") }
        bad("resize", "missing key: name") { remove("name") }
        bad("resize", "missing key: setup") { remove("setup") }
        bad("resize", "missing key: expect") { remove("expect") }
        bad("resize", "missing key: length") { put("setup.image.data", """{"fill":1}""") }
        bad("resize", "missing key: height") { remove("expect.image.height") }
        bad("tensor", "missing key: shape") { remove("expect.shape") }
        bad("decode", "missing key: data") { remove("setup.outputs.boxes.data") }
        bad("decode", "missing key: spec") { remove("setup.spec") }
        bad("decode", "missing key: srcWidth") { remove("setup.srcWidth") }
        bad("decode", "missing key: label") { remove("expect.detections.0.label") }
        bad("decode", "missing key: y2") { remove("expect.detections.0.box.y2") }
        bad("nms", "missing key: iouThreshold") { remove("setup.iouThreshold") }
        bad("classify", "missing key: score") { remove("expect.entries.0.score") }
        bad("geometry", "missing key: unmapped") { remove("expect.unmapped") }
        bad("geometry", "missing key: scaleY") { remove("expect.geometry.scaleY") }
        bad("map", "missing key: map") { remove("expect.map") }
        bad("map", "missing key: op") { remove("setup.op") }
        bad("ap", "missing key: image") { remove("setup.detections.0.image") }
        bad("ap", "missing key: box") { remove("setup.truths.0.box") }
        bad("ap", "missing key: ap") { remove("expect.byClass.0.ap") }
        bad("iou", "missing key: b") { remove("setup.b") }
        bad("topk", "missing key: k") { remove("setup.k") }
        bad("classifyPipeline", "missing key: clock") { remove("setup.clock") }
        bad("classifyPipeline", "missing key: scripted") { remove("setup.scripted") }
        bad("classifyPipeline", "missing key: outputs") { put("setup.scripted", "{}") }
        bad("classifyPipeline", "missing key: task") { remove("setup.task") }
        bad("classifyPipeline", "missing key: clockReads") { remove("expect.clockReads") }
        bad("classifyPipeline", "missing key: modelCalls") { remove("expect.modelCalls") }
        bad("classifyPipeline", "missing key: input") { remove("expect.input") }
        bad("classifyPipeline", "missing key: inferenceMs") { remove("expect.timing.inferenceMs") }
        bad("detectPipeline", "missing key: geometry") { remove("expect.geometry") }
        bad("pipelineError", "missing key: clockReads") { remove("expect.clockReads") }
        bad("modelError", "missing key: modelCalls") { remove("expect.modelCalls") }
        bad("specError", "missing key: message") { remove("expect.error.message") }
        bad("error", "missing key: kind") { remove("expect.error.kind") }
        bad("spec", "missing key: spec") { remove("setup.spec") }
    }

    @Test
    fun rulingMissingKeyInsideAPartialExpectationAndForeignOnlyKeys() = runTest {
        // some but not all keys of the kind: the first missing one
        bad("map", "missing key: byClass") { remove("expect.byClass") }
        bad("tensor", "missing key: data") { remove("expect.data") }
        bad("classifyPipeline", "missing key: timing") { remove("expect.timing") }
        // only keys of other kinds: unknown key
        bad("resize", "unknown key: shape") { put("expect", """{"shape":[1]}""") }
        bad("tensor", "unknown key: image") { put("expect", """{"image":$img}""") }
        // metrics without `op`
        bad("iou", "missing key: op") { remove("setup.op") }
        bad("ap", "missing key: op") { remove("setup.op") }
    }

    @Test
    fun wrongTypes() = runTest {
        for (v in listOf("1", "null", "true", "{}", "[]")) {
            bad("resize", "wrong type: name") { put("name", v) }
            bad("resize", "wrong type: kind") { put("setup.kind", v) }
        }
        bad("resize", "wrong type: setup") { put("setup", "1") }
        bad("resize", "wrong type: expect") { put("expect", "[]") }
        bad("resize", "wrong type: method") { put("setup.method", "3") }
        bad("resize", "wrong type: image") { put("setup.image", "\"x\"") }
        bad("resize", "wrong type: width") { put("setup.width", "\"1\"") }
        bad("resize", "wrong type: height") { put("setup.height", "{}") }
        bad("resize", "wrong type: width") { put("setup.image.width", "\"1\"") }
        bad("resize", "wrong type: height") { put("setup.image.height", "[1]") }
        bad("resize", "wrong type: data") { put("setup.image.data", "\"abc\"") }
        for (byte in listOf("256", "-1", "1.5", "\"3\"", "null")) bad("resize", "wrong type: data") { put("setup.image.data", "[1,2,$byte]") }
        bad("resize", "wrong type: fill") { put("setup.image.data", """{"fill":1.5,"length":3}""") }
        bad("resize", "wrong type: fill") { put("setup.image.data", """{"fill":256,"length":3}""") }
        bad("resize", "wrong type: length") { put("setup.image.data", """{"fill":1,"length":"3"}""") }
        bad("resize", "wrong type: length") { put("setup.image.data", """{"fill":1,"length":2.5}""") }
        bad("resize", "wrong type: length") { put("setup.image.data", """{"fill":1,"length":-1}""") }
        bad("resize", "wrong type: length") { put("setup.image.data", """{"fill":1,"length":1073741825}""") }
        bad("tensor", "wrong type: shape") { put("expect.shape", "4") }
        bad("tensor", "wrong type: data") { put("expect.data", "{}") }
        bad("tensor", "wrong type: data") { put("expect.data", """[1,"x"]""") }
        bad("tensor", "wrong type: data") { put("expect.data", "[1,null]") }
        bad("classify", "wrong type: output") { put("setup.output", "\"x\"") }
        bad("classify", "wrong type: output") { put("setup.output", """[1,"inf"]""") }
        bad("classify", "wrong type: topK") { put("setup.options.topK", "\"1\"") }
        bad("classify", "wrong type: minScore") { put("setup.options.minScore", "true") }
        bad("classify", "wrong type: entries") { put("expect.entries", "{}") }
        bad("classify", "wrong type: index") { put("expect.entries.0.index", "0.5") }
        bad("classify", "wrong type: label") { put("expect.entries.0.label", "1") }
        bad("classify", "wrong type: score") { put("expect.entries.0.score", "\"x\"") }
        // non-finite strings are allowed only in tensor data, box coordinates and detection / metric scores
        bad("classify", "wrong type: score") { put("expect.entries.0.score", "\"NaN\"") }
        bad("geometry", "wrong type: scaleX") { put("expect.geometry.scaleX", "\"Infinity\"") }
        bad("iou", "wrong type: value") { put("expect.value", "\"-Infinity\"") }
        bad("tensor", "wrong type: shape") { put("expect.shape", """["NaN"]""") }
        bad("classifyPipeline", "wrong type: preprocessMs") { put("expect.timing.preprocessMs", "\"NaN\"") }
        bad("ap", "wrong type: ap") { put("expect.byClass.0.ap", "\"NaN\"") }
        bad("decode", "wrong type: nms") { put("setup.options.nms", "\"true\"") }
        bad("decode", "wrong type: maxDetections") { put("setup.options.maxDetections", "\"1\"") }
        bad("decode", "wrong type: srcWidth") { put("setup.srcWidth", "\"1\"") }
        bad("decode", "wrong type: classIndex") { put("expect.detections.0.classIndex", "0.5") }
        bad("decode", "wrong type: score") { put("expect.detections.0.score", "\"high\"") }
        bad("decode", "wrong type: x1") { put("expect.detections.0.box.x1", "\"left\"") }
        bad("decode", "wrong type: detections") { put("expect.detections", "1") }
        bad("decode", "wrong type: shape") { put("setup.outputs.boxes.shape", "\"x\"") }
        bad("decode", "wrong type: boxes") { put("setup.outputs.boxes", "1") }
        bad("nms", "wrong type: detections") { put("setup.detections", "\"x\"") }
        bad("nms", "wrong type: iouThreshold") { put("setup.iouThreshold", "\"0.5\"") }
        bad("nms", "wrong type: classIndex") { put("setup.detections.0.classIndex", "0.5") }
        bad("geometry", "wrong type: boxes") { put("setup.boxes", "{}") }
        bad("geometry", "wrong type: srcHeight") { put("setup.srcHeight", "\"2\"") }
        bad("geometry", "wrong type: scaleX") { put("expect.geometry.scaleX", "null") }
        bad("geometry", "wrong type: unmapped") { put("expect.unmapped", "1") }
        bad("iou", "wrong type: a") { put("setup.a", "1") }
        bad("iou", "wrong type: value") { put("expect.value", "\"1\"") }
        bad("topk", "wrong type: predictions") { put("setup.predictions", "\"x\"") }
        bad("topk", "wrong type: predictions") { put("setup.predictions", "[1]") }
        bad("topk", "wrong type: truths") { put("setup.truths", "1") }
        bad("topk", "wrong type: k") { put("setup.k", "\"2\"") }
        bad("ap", "wrong type: detections") { put("setup.detections", "1") }
        bad("ap", "wrong type: truths") { put("setup.truths", "1") }
        bad("ap", "wrong type: image") { put("setup.detections.0.image", "1") }
        bad("ap", "wrong type: score") { put("setup.detections.0.score", "{}") }
        bad("ap", "wrong type: classIndex") { put("setup.truths.0.classIndex", "\"0\"") }
        bad("ap", "wrong type: iouThreshold") { put("setup.iouThreshold", "\"0.5\"") }
        bad("ap", "wrong type: byClass") { put("expect.byClass", "{}") }
        bad("ap", "wrong type: classIndex") { put("expect.byClass.0.classIndex", "0.5") }
        bad("map", "wrong type: map") { put("expect.map", "null") }
        bad("classifyPipeline", "wrong type: task") { put("setup.task", "1") }
        bad("classifyPipeline", "wrong type: task") { put("setup.task", "\"segment\"") }
        bad("classifyPipeline", "wrong type: clock") { put("setup.clock", "\"x\"") }
        bad("classifyPipeline", "wrong type: clock") { put("setup.clock", "[0,1,2]") }
        bad("classifyPipeline", "wrong type: clock") { put("setup.clock", "[0,1,2,3,4]") }
        bad("classifyPipeline", "wrong type: clock") { put("setup.clock", """[0,1,2,"3"]""") }
        bad("classifyPipeline", "wrong type: scripted") { put("setup.scripted", "1") }
        bad("classifyPipeline", "wrong type: outputs") { put("setup.scripted.outputs", "[]") }
        bad("classifyPipeline", "wrong type: data") { put("setup.scripted.outputs.output.data", "\"x\"") }
        bad("modelError", "wrong type: error") { put("setup.scripted.error", "1") }
        bad("modelError", "wrong type: modelError") { put("expect.modelError", "1") }
        bad("classifyPipeline", "wrong type: modelCalls") { put("expect.modelCalls", "1.5") }
        bad("classifyPipeline", "wrong type: clockReads") { put("expect.clockReads", "\"4\"") }
        bad("classifyPipeline", "wrong type: timing") { put("expect.timing", "[]") }
        bad("classifyPipeline", "wrong type: shape") { put("expect.input.shape", "1") }
        bad("classifyPipeline", "wrong type: results") { put("expect.results", "1") }
        bad("classifyPipeline", "wrong type: topK") { put("setup.options.topK", "[]") }
        bad("spec", "wrong type: valid") { put("expect.valid", "\"yes\"") }
        bad("error", "wrong type: kind") { put("expect.error.kind", "1") }
        bad("error", "wrong type: error") { put("expect.error", "\"x\"") }
        bad("error", "wrong type: message") { put("expect.error.message", "1") }
    }

    @Test
    fun theFixtureItselfMustBeAJsonObject() = runTest {
        for (text in listOf("[]", "1", "null", "\"x\"", "true")) assertEquals("invalid fixture: wrong type: fixture", messageOf(parseFixture(text)), text)
        for (text in listOf("", "{", "{\"a\":1,}", "'a'")) {
            val e = assertFailsWith<IllegalStateException> { parseFixture(text) }
            assertTrue(e.message?.startsWith("invalid fixture: ") == true, e.message)
        }
    }

    @Test
    fun scriptedWithBothOutputsAndErrorIsAnUnknownOutputsKey() = runTest {
        bad("modelError", "unknown key: outputs") { put("setup.scripted.outputs", "{}") }
        bad("classifyPipeline", "unknown key: outputs") { put("setup.scripted.error", "\"x\"") }
    }

    @Test
    fun opAndTaskAreCheckedBeforeKeySets() = runTest {
        bad("iou", "unknown metrics op: recall") { put("setup.op", "\"recall\""); put("setup.bogus", "1") }
        bad("iou", "wrong type: op") { put("setup.op", "5"); put("setup.bogus", "1") }
        bad("classifyPipeline", "wrong type: task") { put("setup.task", "\"x\""); put("setup.bogus", "1") }
        bad("classifyPipeline", "missing key: task") { remove("setup.task"); put("setup.bogus", "1") }
        bad("iou", "unknown metrics op: constructor") { put("setup.op", "\"constructor\"") }
    }

    @Test
    fun theAllowedExceptionsNullAndRepresentableValues() = runTest {
        suspend fun expectError(base: String, kind: String, mutate: Doc.() -> Unit) {
            val doc = Doc(parseJson(bases.getValue(base)))
            doc.mutate()
            doc.put("expect", """{"error":{"kind":"$kind"}}""")
            passing(doc)
        }
        expectError("resize", "invalid_options") { put("setup.width", "null") }
        expectError("resize", "invalid_options") { put("setup.height", "2.5") }
        expectError("resize", "invalid_options") { put("setup.method", "null") }
        expectError("resize", "invalid_options") { put("setup.image.width", "null") }
        expectError("classify", "invalid_output") { put("setup.output", """[0.5,"NaN"]""") }
        expectError("decode", "invalid_options") { put("setup.options", """{"scoreThreshold":null,"iouThreshold":null,"maxDetections":null,"nms":null}""") }
        expectError("nms", "invalid_options") { put("setup.iouThreshold", "null") }
        expectError("geometry", "invalid_options") { put("setup.boxes", """[{"x1":0,"y1":"NaN","x2":"Infinity","y2":"-Infinity"}]""") }
        expectError("ap", "invalid_options") { put("setup.detections.0.score", "\"NaN\"") }
        expectError("ap", "invalid_options") { put("setup.truths.0.classIndex", "1.5") }
        expectError("ap", "invalid_options") { put("setup.iouThreshold", "null") }
        expectError("topk", "invalid_options") { put("setup.k", "null") }
        // a fractional shape entry is an invalid output, a huge one too; neither is malformed
        expectError("decode", "invalid_output") { put("setup.outputs.boxes.shape", "[1,1.5,4]") }
        expectError("decode", "invalid_output") { put("setup.outputs.scores.shape", "[3000000000]") }
        // a class index above Int range is invalid_options in metrics and nms
        expectError("ap", "invalid_options") { put("setup.detections.0.classIndex", "3000000000") }
        expectError("nms", "invalid_options") { put("setup.detections.0.classIndex", "3000000000") }
        expectError("nms", "invalid_options") { put("setup.detections.0.classIndex", "-1") }
    }

    @Test
    fun integerOptionsAboveIntRangeAreValidValues() = runTest {
        // topK 3e9 and maxDetections 3e9 are valid integers (the library keeps everything), k 3e9 is valid too
        val classify = Doc(parseJson(bases.getValue("classify")))
        classify.put("setup.options.topK", "3000000000")
        classify.put("expect", """{"entries":[{"index":0,"label":"#0","score":0.5},{"index":1,"label":"#1","score":0.25}]}""")
        passing(classify)
        val decode = Doc(parseJson(bases.getValue("decode")))
        decode.put("setup.options.maxDetections", "3000000000")
        passing(decode)
        val topk = Doc(parseJson(bases.getValue("topk")))
        topk.put("setup.k", "3000000000")
        passing(topk)
        // a fractional k is not
        val fraction = Doc(parseJson(bases.getValue("topk")))
        fraction.put("setup.k", "1.5")
        fraction.put("expect", """{"error":{"kind":"invalid_options"}}""")
        passing(fraction)
        // topk predictions and truths with fractions are passed to the library, not malformed
        val fractional = Doc(parseJson(bases.getValue("topk")))
        fractional.put("setup.predictions", "[[1.5,2]]")
        fractional.put("expect", """{"value":1}""")
        passing(fractional)
        // newWidth / newHeight of an expectation may be fractional (the comparison fails, the fixture is not malformed)
        val geometry = fixtureOf(bases.getValue("geometry").replace("\"newWidth\":1", "\"newWidth\":1.5"))
        assertEquals(1, failures(geometry).size)
    }

    @Test
    fun anExpectationWithNeitherTheKeysOfItsKindNorError() = runTest {
        val neither = "expect has neither the keys of its kind nor error"
        for (base in listOf("resize", "tensor", "classify", "decode", "nms", "iou", "ap", "geometry", "classifyPipeline", "spec")) bad(base, neither) { put("expect", "{}") }
        bad("classifyPipeline", neither) { put("expect", """{"modelCalls":1,"clockReads":4}""") }
    }

    @Test
    fun expectationsOfTheWrongKindAreUnknownKeys() = runTest {
        bad("resize", "unknown key: entries") { put("expect", """{"entries":[]}""") }
        bad("iou", "unknown key: byClass") { put("expect", """{"byClass":[]}""") }
        bad("ap", "unknown key: map") { put("expect", """{"map":1,"byClass":[]}""") }
        bad("spec", "unknown key: value") { put("expect", """{"value":1}""") }
        bad("geometry", "unknown key: unmapped") { remove("setup.boxes") }
        bad("classifyPipeline", "unknown key: geometry") { put("expect.geometry", geo) }
        bad("resize", "unknown key: image") { put("expect", """{"error":{"kind":"invalid_options"},"image":$img}""") }
        bad("resize", "unknown key: modelCalls") { put("expect", """{"modelCalls":1}""") }
    }

    @Test
    fun theScriptedClockFailsOnAFifthRead() {
        val clock = ScriptedClock(doubleArrayOf(1.0, 2.0, 3.0, 4.0))
        assertEquals(listOf(1.0, 2.0, 3.0, 4.0), List(4) { clock.nowMs() })
        assertEquals(4, clock.reads)
        val e = assertFailsWith<IllegalStateException> { clock.nowMs() }
        assertEquals("invalid fixture: clock called more than four times", e.message)
        assertEquals(4, clock.reads)
    }

    @Test
    fun theHarnessRunsTheLibraryAsTheContractDescribes() = runTest {
        val ok = runFixture(fixtureOf(bases.getValue("classifyPipeline")))
        val run = assertNotNull(ok.pipeline)
        assertEquals(1, run.modelCalls)
        assertEquals(4, run.clockReads)
        assertEquals(listOf(2), run.readsAtRun)
        assertEquals(listOf(1, 1, 1, 3), run.input?.shape)
        // a validation error leaves zero reads and zero calls; an invalid output three reads
        val doc = Doc(parseJson(bases.getValue("classifyPipeline")))
        doc.put("setup.options", """{"topK":null}""")
        val validation = runFixture(Fixture(doc.root))
        assertEquals("invalid_options", validation.error?.kind)
        assertEquals(0, validation.pipeline?.modelCalls)
        assertEquals(0, validation.pipeline?.clockReads)
        val badOutput = assertNotNull(runFixture(fixtureOf(bases.getValue("pipelineError"))).pipeline)
        assertEquals(1, badOutput.modelCalls)
        assertEquals(3, badOutput.clockReads)
        val failing = assertNotNull(runFixture(fixtureOf(bases.getValue("modelError"))).pipeline)
        assertEquals(failing.scriptedError, failing.modelError)
        assertEquals("boom", failing.modelError?.message)
        assertEquals(2, failing.clockReads)
    }

    @Test
    fun runningDoesNotMutateTheFixture() = runTest {
        for ((name, text) in bases) {
            val f = fixtureOf(text)
            val before = f.root.toString()
            runFixture(f)
            assertEquals(before, f.root.toString(), name)
        }
    }

    @Test
    fun anErrorOutcomeKeepsTheLibraryMessage() = runTest {
        val outcome = runFixture(fixtureOf(bases.getValue("specError")))
        assertEquals(FixtureError("invalid_spec", "invalid model spec: spec must be an object"), outcome.error)
    }
}
