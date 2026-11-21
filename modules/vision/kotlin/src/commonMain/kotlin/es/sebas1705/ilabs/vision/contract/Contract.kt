package es.sebas1705.ilabs.vision.contract

import es.sebas1705.ilabs.structured.parseStrict
import es.sebas1705.ilabs.vision.Box
import es.sebas1705.ilabs.vision.ClassAp
import es.sebas1705.ilabs.vision.ClassEntry
import es.sebas1705.ilabs.vision.Clock
import es.sebas1705.ilabs.vision.Detection
import es.sebas1705.ilabs.vision.DetectionOptions
import es.sebas1705.ilabs.vision.Geometry
import es.sebas1705.ilabs.vision.Image
import es.sebas1705.ilabs.vision.ImageSize
import es.sebas1705.ilabs.vision.ResizeMethod
import es.sebas1705.ilabs.vision.ScoredDetection
import es.sebas1705.ilabs.vision.Tensor
import es.sebas1705.ilabs.vision.Timing
import es.sebas1705.ilabs.vision.Truth
import es.sebas1705.ilabs.vision.VisionErrorKind
import es.sebas1705.ilabs.vision.VisionException
import es.sebas1705.ilabs.vision.VisionModel
import es.sebas1705.ilabs.vision.averagePrecision
import es.sebas1705.ilabs.vision.classify
import es.sebas1705.ilabs.vision.detect
import es.sebas1705.ilabs.vision.iou
import es.sebas1705.ilabs.vision.meanAveragePrecision
import es.sebas1705.ilabs.vision.nms
import es.sebas1705.ilabs.vision.numberValue
import es.sebas1705.ilabs.vision.parseModelSpec
import es.sebas1705.ilabs.vision.postprocessClassification
import es.sebas1705.ilabs.vision.postprocessDetections
import es.sebas1705.ilabs.vision.preprocessGeometry
import es.sebas1705.ilabs.vision.resize
import es.sebas1705.ilabs.vision.scriptedModel
import es.sebas1705.ilabs.vision.toTensor
import es.sebas1705.ilabs.vision.topKAccuracy
import es.sebas1705.ilabs.vision.unmapBox
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.math.abs
import kotlin.math.floor

// The fixture harness of `contracts/vision/README.md` (Fixture format, Comparison and harness, Malformed fixtures), written
// to mirror the TypeScript harness message by message: a small schema language validates the raw JSON (unknown keys first,
// then missing keys, then value types), then the validated JSON is converted into library arguments. Common code: no
// java.*. Outside the library only `VisionException` and the harness's own scripted model error are caught.

/** A contract fixture as raw JSON (any JSON value: [runFixture] and [checkOutcome] reject malformed ones). */
class Fixture(val root: JsonElement) {
    val name: String get() = (root as? JsonObject)?.get("name")?.let { (it as? JsonPrimitive)?.takeIf { p -> p !is JsonNull && p.isString }?.content } ?: ""

    /** `setup.kind`, or "" when absent. */
    val kind: String
        get() = ((root as? JsonObject)?.get("setup") as? JsonObject)?.get("kind")?.let { (it as? JsonPrimitive)?.takeIf { p -> p !is JsonNull && p.isString }?.content } ?: ""
}

/** An error a run reported: the `vision` error kind and its message. */
data class FixtureError(val kind: String, val message: String? = null)

/** The error a scripted model throws (a fresh one per run, never a `VisionException`). */
class FixtureModelError(message: String) : RuntimeException(message)

/** What a `pipeline` run did: the counts of the recording wrapper and scripted clock, and its result or failure. */
class PipelineRun(
    val task: String,
    val entries: List<ClassEntry>? = null,
    val detections: List<Detection>? = null,
    val timing: Timing? = null,
    val geometry: Geometry? = null,
    val input: Tensor? = null,
    val modelCalls: Int = 0,
    val clockReads: Int = 0,
    val readsAtRun: List<Int> = emptyList(),
    val modelError: Throwable? = null,
    val scriptedError: Throwable? = null,
)

/** What a run produced: [error] when the library failed; otherwise the field of the fixture's kind. */
class FixtureOutcome(
    val kind: String,
    val error: FixtureError? = null,
    val image: Image? = null,
    val geometry: Geometry? = null,
    val unmapped: List<Box?>? = null,
    val tensor: Tensor? = null,
    val entries: List<ClassEntry>? = null,
    val detections: List<Detection>? = null,
    val value: Double? = null,
    val byClass: List<ClassAp>? = null,
    val map: Double? = null,
    val valid: Boolean = false,
    val pipeline: PipelineRun? = null,
)

private fun invalid(reason: String): Nothing = throw IllegalStateException("invalid fixture: $reason")

/** Parses a fixture file with the strict JSON parser; text that is not strict JSON is malformed. */
fun parseFixture(json: String): Fixture = Fixture(parseStrict(json) ?: invalid("not valid strict JSON"))

/** A clock that returns the given numbers in order and fails the fixture on a fifth read. */
internal class ScriptedClock(private val values: DoubleArray) : Clock {
    var reads = 0
        private set

    override fun nowMs(): Double {
        if (reads >= values.size) invalid("clock called more than four times")
        return values[reads++]
    }
}

// ---- raw JSON validation: a small schema language ---------------------------------------------------------------------

private fun isStr(v: JsonElement?): Boolean = v is JsonPrimitive && v !is JsonNull && v.isString

private fun isNum(v: JsonElement?): Boolean = v is JsonPrimitive && numberValue(v) != null

private fun isInt(v: JsonElement?): Boolean {
    val d = ((v as? JsonPrimitive)?.let { numberValue(it) }) ?: return false
    return d.isFinite() && floor(d) == d
}

private fun isBool(v: JsonElement?): Boolean = v is JsonPrimitive && v !is JsonNull && !v.isString && (v.content == "true" || v.content == "false")

private val NON_FINITE = setOf("NaN", "Infinity", "-Infinity")

private sealed interface Schema

private enum class Leaf : Schema { STR, STR_NULL, INT, NUM, NUM_NULL, NUM_NF, BOOL, ANY, IMAGE_DATA, BOX_OR_NULL }

private class Arr(val of: Schema, val len: Int? = null) : Schema

private class MapOf(val of: Schema) : Schema

private class Obj(val req: List<Pair<String, Schema>>, val opt: List<Pair<String, Schema>> = emptyList()) : Schema

private fun wrong(key: String): Nothing = invalid("wrong type: $key")

/** Unknown keys first (in the document's key order), then missing required keys (in schema order). */
private fun checkKeys(o: JsonObject, req: List<String>, opt: List<String>) {
    for (k in o.keys) if (k !in req && k !in opt) invalid("unknown key: $k")
    for (k in req) if (k !in o) invalid("missing key: $k")
}

private const val MAX_FILL_LENGTH = 1_073_741_824.0

private fun check(s: Schema, v: JsonElement?, key: String) {
    when (s) {
        is Leaf -> checkLeaf(s, v, key)
        is Arr -> {
            val list = v as? JsonArray ?: wrong(key)
            if (s.len != null && list.size != s.len) wrong(key)
            for (e in list) check(s.of, e, key)
        }
        is MapOf -> {
            val o = v as? JsonObject ?: wrong(key)
            for ((k, e) in o) check(s.of, e, k)
        }
        is Obj -> {
            val o = v as? JsonObject ?: wrong(key)
            checkKeys(o, s.req.map { it.first }, s.opt.map { it.first })
            for ((k, sub) in s.req) check(sub, o[k], k)
            for ((k, sub) in s.opt) if (k in o) check(sub, o[k], k)
        }
    }
}

private fun checkLeaf(s: Leaf, v: JsonElement?, key: String) {
    when (s) {
        Leaf.STR -> if (!isStr(v)) wrong(key)
        Leaf.STR_NULL -> if (!isStr(v) && v !is JsonNull) wrong(key)
        Leaf.INT -> if (!isInt(v)) wrong(key)
        Leaf.NUM -> if (!isNum(v)) wrong(key)
        Leaf.NUM_NULL -> if (!isNum(v) && v !is JsonNull) wrong(key)
        Leaf.NUM_NF -> if (!isNum(v) && !(isStr(v) && (v as JsonPrimitive).content in NON_FINITE)) wrong(key)
        Leaf.BOOL -> if (!isBool(v)) wrong(key)
        Leaf.ANY -> Unit
        Leaf.BOX_OR_NULL -> if (v !is JsonNull) check(BOX, v, key)
        Leaf.IMAGE_DATA -> when (v) {
            is JsonArray -> for (b in v) if (!isInt(b) || d(b) < 0.0 || d(b) > 255.0) wrong(key)
            is JsonObject -> {
                checkKeys(v, listOf("fill", "length"), emptyList())
                val fill = v["fill"]
                if (!isInt(fill) || d(fill) < 0.0 || d(fill) > 255.0) wrong("fill")
                val length = v["length"]
                if (!isInt(length) || d(length) < 0.0 || d(length) > MAX_FILL_LENGTH) wrong("length")
            }
            else -> wrong(key)
        }
    }
}

private val BOX: Schema = Obj(listOf("x1" to Leaf.NUM_NF, "y1" to Leaf.NUM_NF, "x2" to Leaf.NUM_NF, "y2" to Leaf.NUM_NF))
private val TENSOR: Schema = Obj(listOf("shape" to Arr(Leaf.NUM), "data" to Arr(Leaf.NUM_NF)))
private val IMAGE: Schema = Obj(listOf("width" to Leaf.NUM_NULL, "height" to Leaf.NUM_NULL, "data" to Leaf.IMAGE_DATA))
private val DETECTION: Schema = Obj(listOf("box" to BOX, "classIndex" to Leaf.INT, "label" to Leaf.STR, "score" to Leaf.NUM_NF))
private val ENTRY: Schema = Obj(listOf("index" to Leaf.INT, "label" to Leaf.STR, "score" to Leaf.NUM))
private val METRIC_DETECTION: Schema = Obj(listOf("image" to Leaf.STR, "classIndex" to Leaf.NUM, "score" to Leaf.NUM_NF, "box" to BOX))
private val METRIC_TRUTH: Schema = Obj(listOf("image" to Leaf.STR, "classIndex" to Leaf.NUM, "box" to BOX))
private val BY_CLASS: Schema = Obj(listOf("classIndex" to Leaf.INT, "ap" to Leaf.NUM))
private val GEOMETRY: Schema = Obj(
    listOf("scaleX" to Leaf.NUM, "scaleY" to Leaf.NUM, "offsetX" to Leaf.NUM, "offsetY" to Leaf.NUM, "newWidth" to Leaf.NUM, "newHeight" to Leaf.NUM),
)
private val TIMING: Schema = Obj(listOf("preprocessMs" to Leaf.NUM, "inferenceMs" to Leaf.NUM, "postprocessMs" to Leaf.NUM))

private val CLASSIFY_OPTION_KEYS = listOf("topK", "minScore")
private val DETECT_OPTION_KEYS = listOf("scoreThreshold", "iouThreshold", "maxDetections", "nms")

/** Checks an options object of a pipeline, classify or decode fixture: numbers or null, `nms` a boolean or null. */
private fun checkOptions(v: JsonElement?, allowed: List<String>) {
    val o = v as? JsonObject ?: wrong("options")
    checkKeys(o, emptyList(), allowed)
    for (k in allowed) {
        if (k !in o) continue
        val value = o[k]
        if (k == "nms") {
            if (!isBool(value) && value !is JsonNull) wrong(k)
        } else if (!isNum(value) && value !is JsonNull) {
            wrong(k)
        }
    }
}

private class SetupSchema(val req: List<Pair<String, Schema>>, val opt: List<Pair<String, Schema>> = emptyList())

private fun setupSchema(kind: String, setup: JsonObject): SetupSchema = when (kind) {
    "resize" -> SetupSchema(listOf("image" to IMAGE, "width" to Leaf.NUM_NULL, "height" to Leaf.NUM_NULL, "method" to Leaf.STR_NULL))
    "geometry" -> SetupSchema(listOf("srcWidth" to Leaf.NUM_NULL, "srcHeight" to Leaf.NUM_NULL, "spec" to Leaf.ANY), listOf("boxes" to Arr(BOX)))
    "tensor" -> SetupSchema(listOf("image" to IMAGE, "spec" to Leaf.ANY))
    "classify" -> SetupSchema(listOf("output" to Arr(Leaf.NUM_NF), "spec" to Leaf.ANY), listOf("options" to Leaf.ANY))
    "decode" -> SetupSchema(
        listOf("outputs" to MapOf(TENSOR), "spec" to Leaf.ANY, "srcWidth" to Leaf.NUM_NULL, "srcHeight" to Leaf.NUM_NULL),
        listOf("options" to Leaf.ANY),
    )
    "nms" -> SetupSchema(listOf("detections" to Arr(DETECTION), "iouThreshold" to Leaf.NUM_NULL))
    "metrics" -> metricsSchema(setup)
    "pipeline" -> SetupSchema(
        listOf("image" to IMAGE, "spec" to Leaf.ANY, "task" to Leaf.STR, "scripted" to Leaf.ANY, "clock" to Arr(Leaf.NUM, 4)),
        listOf("options" to Leaf.ANY),
    )
    else -> SetupSchema(listOf("spec" to Leaf.ANY))
}

private val METRIC_OPS = listOf("iou", "topk", "ap", "map")

private fun metricsSchema(setup: JsonObject): SetupSchema = when (opOf(setup)) {
    "iou" -> SetupSchema(listOf("op" to Leaf.STR, "a" to BOX, "b" to BOX))
    "topk" -> SetupSchema(listOf("op" to Leaf.STR, "predictions" to Arr(Arr(Leaf.NUM)), "truths" to Arr(Leaf.NUM), "k" to Leaf.NUM_NULL))
    else -> SetupSchema(listOf("op" to Leaf.STR, "detections" to Arr(METRIC_DETECTION), "truths" to Arr(METRIC_TRUTH), "iouThreshold" to Leaf.NUM_NULL))
}

private fun opOf(setup: JsonObject): String? = (setup["op"] as? JsonPrimitive)?.takeIf { isStr(it) }?.content

private val KINDS = listOf("resize", "geometry", "tensor", "classify", "decode", "nms", "metrics", "pipeline", "spec")

private fun checkScripted(v: JsonElement?) {
    val o = v as? JsonObject ?: wrong("scripted")
    for (k in o.keys) if (k != "outputs" && k != "error") invalid("unknown key: $k")
    if ("error" in o) {
        if ("outputs" in o) invalid("unknown key: outputs")
        check(Leaf.STR, o["error"], "error")
        return
    }
    if ("outputs" !in o) invalid("missing key: outputs")
    check(MapOf(TENSOR), o["outputs"], "outputs")
}

private class Checked(val kind: String, val setup: JsonObject, val expect: Expected)

private fun checkFixture(fixture: Fixture): Checked {
    val fx = fixture.root as? JsonObject ?: wrong("fixture")
    checkKeys(fx, listOf("name", "setup", "expect"), emptyList())
    check(Leaf.STR, fx["name"], "name")
    val setup = fx["setup"] as? JsonObject ?: wrong("setup")
    if ("kind" !in setup) invalid("missing key: kind")
    if (!isStr(setup["kind"])) wrong("kind")
    val kind = (setup["kind"] as JsonPrimitive).content
    if (kind !in KINDS) invalid("unknown setup kind: $kind")
    if (kind == "metrics") {
        if ("op" !in setup) invalid("missing key: op")
        if (!isStr(setup["op"])) wrong("op")
        val op = opOf(setup)
        if (op !in METRIC_OPS) invalid("unknown metrics op: $op")
    }
    if (kind == "pipeline") {
        if ("task" !in setup) invalid("missing key: task")
        val task = setup["task"]
        if (!isStr(task) || ((task as JsonPrimitive).content != "classify" && task.content != "detect")) wrong("task")
    }
    val schema = setupSchema(kind, setup)
    checkKeys(setup, listOf("kind") + schema.req.map { it.first }, schema.opt.map { it.first })
    for ((k, s) in schema.req) if (k == "scripted") checkScripted(setup[k]) else check(s, setup[k], k)
    for ((k, s) in schema.opt) {
        if (k !in setup) continue
        if (k == "options") {
            val classifyOptions = (kind == "pipeline" && taskOf(setup) == "classify") || kind == "classify"
            checkOptions(setup[k], if (classifyOptions) CLASSIFY_OPTION_KEYS else DETECT_OPTION_KEYS)
        } else {
            check(s, setup[k], k)
        }
    }
    val expect = checkExpect(kind, setup, fx["expect"])
    return Checked(kind, setup, expect)
}

private fun taskOf(setup: JsonObject): String? = (setup["task"] as? JsonPrimitive)?.takeIf { isStr(it) }?.content

private fun successSchema(kind: String, setup: JsonObject): List<Pair<String, Schema>> = when (kind) {
    "resize" -> listOf("image" to IMAGE)
    "geometry" -> listOf("geometry" to GEOMETRY) + (if ("boxes" in setup) listOf("unmapped" to Arr(Leaf.BOX_OR_NULL)) else emptyList())
    "tensor" -> listOf("shape" to Arr(Leaf.NUM), "data" to Arr(Leaf.NUM_NF))
    "classify" -> listOf("entries" to Arr(ENTRY))
    "decode", "nms" -> listOf("detections" to Arr(DETECTION))
    "metrics" -> when (opOf(setup)) {
        "iou", "topk" -> listOf("value" to Leaf.NUM)
        "ap" -> listOf("byClass" to Arr(BY_CLASS))
        else -> listOf("map" to Leaf.NUM, "byClass" to Arr(BY_CLASS))
    }
    "pipeline" -> listOf(
        "results" to Arr(if (taskOf(setup) == "classify") ENTRY else DETECTION),
        "timing" to TIMING,
        "modelCalls" to Leaf.INT,
        "clockReads" to Leaf.INT,
        "input" to TENSOR,
    ) + (if (taskOf(setup) == "detect") listOf("geometry" to GEOMETRY) else emptyList())
    else -> listOf("valid" to Leaf.BOOL)
}

private fun checkExpect(kind: String, setup: JsonObject, expect: JsonElement?): Expected {
    val e = expect as? JsonObject ?: wrong("expect")
    val success = successSchema(kind, setup)
    val successKeys = success.map { it.first }.filter { !(kind == "pipeline" && (it == "modelCalls" || it == "clockReads")) }
    val pipelineKeys = if (kind == "pipeline") listOf("modelCalls", "clockReads", "modelError") else emptyList()
    val allowed = successKeys + "error" + pipelineKeys
    for (k in e.keys) if (k !in allowed) invalid("unknown key: $k")

    fun only(keys: List<String>) {
        for (k in e.keys) if (k !in keys) invalid("unknown key: $k")
    }
    if (kind == "pipeline" && "modelError" in e) {
        only(listOf("modelError", "modelCalls", "clockReads"))
        for (k in listOf("modelCalls", "clockReads")) if (k !in e) invalid("missing key: $k")
        check(Leaf.STR, e["modelError"], "modelError")
        check(Leaf.INT, e["modelCalls"], "modelCalls")
        check(Leaf.INT, e["clockReads"], "clockReads")
        return Expected(modelError = str(e["modelError"]), modelCalls = d(e["modelCalls"]), clockReads = d(e["clockReads"]))
    }
    if ("error" in e) {
        only(if (kind == "pipeline") listOf("error", "modelCalls", "clockReads") else listOf("error"))
        if (kind == "pipeline") for (k in listOf("modelCalls", "clockReads")) if (k !in e) invalid("missing key: $k")
        check(if (kind == "spec") Obj(listOf("kind" to Leaf.STR, "message" to Leaf.STR)) else Obj(listOf("kind" to Leaf.STR), listOf("message" to Leaf.STR)), e["error"], "error")
        if (kind == "pipeline") {
            check(Leaf.INT, e["modelCalls"], "modelCalls")
            check(Leaf.INT, e["clockReads"], "clockReads")
        }
        val error = e["error"] as JsonObject
        return Expected(
            errorKind = str(error["kind"]), errorMessage = if ("message" in error) str(error["message"]) else null,
            modelCalls = if (kind == "pipeline") d(e["modelCalls"]) else null, clockReads = if (kind == "pipeline") d(e["clockReads"]) else null,
        )
    }
    if (successKeys.none { it in e }) invalid("expect has neither the keys of its kind nor error")
    for ((k, _) in success) if (k !in e) invalid("missing key: $k")
    for ((k, s) in success) check(s, e[k], k)
    return expectedOf(kind, setup, e)
}

// ---- conversion of validated JSON ------------------------------------------------------------------------------------

private fun str(v: JsonElement?): String = (v as JsonPrimitive).content

/** A JSON number, or one of the three non-finite strings, as a double. */
private fun d(v: JsonElement?): Double {
    val p = v as JsonPrimitive
    if (p.isString) {
        return when (p.content) {
            "NaN" -> Double.NaN
            "Infinity" -> Double.POSITIVE_INFINITY
            else -> Double.NEGATIVE_INFINITY
        }
    }
    return numberValue(p) ?: Double.NaN
}

private fun clampInt(v: Double): Int = if (v >= Int.MAX_VALUE.toDouble()) Int.MAX_VALUE else if (v <= Int.MIN_VALUE.toDouble()) Int.MIN_VALUE else v.toInt()

private fun isIntegral(v: Double) = v.isFinite() && floor(v) == v

/**
 * An integer argument of a typed API: JSON `null` and fractions have no integer form and reach the library as `0` (invalid
 * for every size, `topK`, `maxDetections` and `k`); an integer beyond `Int` is a VALID value and saturates.
 */
private fun intArg(v: JsonElement?): Int {
    if (v is JsonNull) return 0
    val x = d(v)
    return if (isIntegral(x)) clampInt(x) else 0
}

/** A number argument: JSON `null` reaches the library as NaN, which every range check rejects. */
private fun numArg(v: JsonElement?): Double = if (v is JsonNull) Double.NaN else d(v)

/** A shape entry: a fraction or a negative number is an invalid dimension (`-1`); a huge integer saturates. */
private fun shapeEntry(v: JsonElement?): Int {
    val x = d(v)
    return if (isIntegral(x)) clampInt(x) else -1
}

/** A class index: an integer from 0 to 2147483647, anything else reaches the library as `-1`. */
private fun classArg(v: JsonElement?): Int {
    val x = d(v)
    return if (isIntegral(x) && x >= 0.0 && x <= Int.MAX_VALUE.toDouble()) x.toInt() else -1
}

private fun imageOf(v: JsonElement?): Image {
    val o = v as JsonObject
    val data = o["data"]
    val bytes: ByteArray = if (data is JsonObject) {
        ByteArray(d(data["length"]).toInt()).also { it.fill(d(data["fill"]).toInt().toByte()) }
    } else {
        val list = data as JsonArray
        ByteArray(list.size) { d(list[it]).toInt().toByte() }
    }
    return Image(intArg(o["width"]), intArg(o["height"]), bytes)
}

private fun boxOf(v: JsonElement?): Box {
    val o = v as JsonObject
    return Box(d(o["x1"]), d(o["y1"]), d(o["x2"]), d(o["y2"]))
}

private fun tensorOf(v: JsonElement?): Tensor {
    val o = v as JsonObject
    val shape = (o["shape"] as JsonArray).map { shapeEntry(it) }
    val data = (o["data"] as JsonArray).let { list -> DoubleArray(list.size) { d(list[it]) } }
    return Tensor(shape, data)
}

private fun tensorsOf(v: JsonElement?): Map<String, Tensor> {
    val out = LinkedHashMap<String, Tensor>()
    for ((name, value) in v as JsonObject) out[name] = tensorOf(value)
    return out
}

private fun detectionOf(v: JsonElement?): Detection {
    val o = v as JsonObject
    return Detection(boxOf(o["box"]), classArg(o["classIndex"]), str(o["label"]), d(o["score"]))
}

private fun optionsOf(setup: JsonObject): JsonObject? = setup["options"] as? JsonObject

private fun optInt(o: JsonObject?, key: String, default: Int): Int = if (o != null && key in o) intArg(o[key]) else default

private fun optDouble(o: JsonObject?, key: String, default: Double): Double = if (o != null && key in o) numArg(o[key]) else default

/** `nms`: absent is the format's default; JSON `null` has no typed form, so the harness raises the library's error itself. */
private fun optNms(o: JsonObject?): Boolean? {
    if (o == null || "nms" !in o) return null
    if (o["nms"] is JsonNull) throw VisionException(VisionErrorKind.INVALID_OPTIONS, "invalid options: nms must be a boolean")
    return str(o["nms"]) == "true"
}

private fun detectionOptionsOf(o: JsonObject?): DetectionOptions {
    val defaults = DetectionOptions()
    return DetectionOptions(
        scoreThreshold = optDouble(o, "scoreThreshold", defaults.scoreThreshold),
        iouThreshold = optDouble(o, "iouThreshold", defaults.iouThreshold),
        maxDetections = optInt(o, "maxDetections", defaults.maxDetections),
        nms = optNms(o),
    )
}

/** A class index of a prediction or truth list: a fraction has no integer form and never equals a class. */
private fun rankArg(v: JsonElement?): Int {
    val x = d(v)
    return if (isIntegral(x)) clampInt(x) else Int.MIN_VALUE
}

// ---- expectations -----------------------------------------------------------------------------------------------------

private class ExpImage(val width: Double, val height: Double, val data: ByteArray)

private class ExpGeometry(val scaleX: Double, val scaleY: Double, val offsetX: Double, val offsetY: Double, val newWidth: Double, val newHeight: Double)

private class ExpTensor(val shape: List<Double>, val data: DoubleArray)

private class ExpEntry(val index: Double, val label: String, val score: Double)

private class ExpDetection(val box: Box, val classIndex: Double, val label: String, val score: Double)

private class ExpClass(val classIndex: Double, val ap: Double)

/** A parsed expectation: the error forms, or the values of the fixture's kind. */
private class Expected(
    val errorKind: String? = null,
    val errorMessage: String? = null,
    val modelError: String? = null,
    val image: ExpImage? = null,
    val geometry: ExpGeometry? = null,
    val unmapped: List<Box?>? = null,
    val tensor: ExpTensor? = null,
    val entries: List<ExpEntry>? = null,
    val detections: List<ExpDetection>? = null,
    val value: Double? = null,
    val byClass: List<ExpClass>? = null,
    val map: Double? = null,
    val valid: Boolean? = null,
    val timing: Timing? = null,
    val modelCalls: Double? = null,
    val clockReads: Double? = null,
    val input: ExpTensor? = null,
) {
    val isError: Boolean get() = errorKind != null
}

private fun expImage(v: JsonElement?): ExpImage {
    val o = v as JsonObject
    val data = o["data"]
    val bytes: ByteArray = if (data is JsonObject) {
        ByteArray(d(data["length"]).toInt()).also { it.fill(d(data["fill"]).toInt().toByte()) }
    } else {
        val list = data as JsonArray
        ByteArray(list.size) { d(list[it]).toInt().toByte() }
    }
    val w = o["width"]
    val h = o["height"]
    return ExpImage(if (w is JsonNull) Double.NaN else d(w), if (h is JsonNull) Double.NaN else d(h), bytes)
}

private fun expGeometry(v: JsonElement?): ExpGeometry {
    val o = v as JsonObject
    return ExpGeometry(d(o["scaleX"]), d(o["scaleY"]), d(o["offsetX"]), d(o["offsetY"]), d(o["newWidth"]), d(o["newHeight"]))
}

private fun expTensor(v: JsonElement?): ExpTensor {
    val o = v as JsonObject
    return ExpTensor((o["shape"] as JsonArray).map { d(it) }, (o["data"] as JsonArray).let { list -> DoubleArray(list.size) { d(list[it]) } })
}

private fun expEntries(v: JsonElement?): List<ExpEntry> = (v as JsonArray).map {
    val o = it as JsonObject
    ExpEntry(d(o["index"]), str(o["label"]), d(o["score"]))
}

private fun expDetections(v: JsonElement?): List<ExpDetection> = (v as JsonArray).map {
    val o = it as JsonObject
    ExpDetection(boxOf(o["box"]), d(o["classIndex"]), str(o["label"]), d(o["score"]))
}

private fun expByClass(v: JsonElement?): List<ExpClass> = (v as JsonArray).map {
    val o = it as JsonObject
    ExpClass(d(o["classIndex"]), d(o["ap"]))
}

private fun expectedOf(kind: String, setup: JsonObject, e: JsonObject): Expected = when (kind) {
    "resize" -> Expected(image = expImage(e["image"]))
    "geometry" -> Expected(
        geometry = expGeometry(e["geometry"]),
        unmapped = if ("boxes" in setup) (e["unmapped"] as JsonArray).map { if (it is JsonNull) null else boxOf(it) } else null,
    )
    "tensor" -> Expected(tensor = expTensor(e))
    "classify" -> Expected(entries = expEntries(e["entries"]))
    "decode", "nms" -> Expected(detections = expDetections(e["detections"]))
    "metrics" -> when (opOf(setup)) {
        "iou", "topk" -> Expected(value = d(e["value"]))
        "ap" -> Expected(byClass = expByClass(e["byClass"]))
        else -> Expected(map = d(e["map"]), byClass = expByClass(e["byClass"]))
    }
    "pipeline" -> {
        val classify = taskOf(setup) == "classify"
        val t = e["timing"] as JsonObject
        Expected(
            entries = if (classify) expEntries(e["results"]) else null,
            detections = if (classify) null else expDetections(e["results"]),
            timing = Timing(d(t["preprocessMs"]), d(t["inferenceMs"]), d(t["postprocessMs"])),
            modelCalls = d(e["modelCalls"]),
            clockReads = d(e["clockReads"]),
            input = expTensor(e["input"]),
            geometry = if (classify) null else expGeometry(e["geometry"]),
        )
    }
    else -> Expected(valid = (e["valid"] as JsonPrimitive).content == "true")
}

// ---- running --------------------------------------------------------------------------------------------------------

private fun methodOf(el: JsonElement?): ResizeMethod =
    when ((el as? JsonPrimitive)?.takeIf { isStr(it) }?.content) {
        "nearest" -> ResizeMethod.NEAREST
        "bilinear" -> ResizeMethod.BILINEAR
        else -> throw VisionException(VisionErrorKind.INVALID_OPTIONS, "invalid options: method must be \"nearest\" or \"bilinear\"")
    }

/** Wraps the scripted model: records its calls and the number of clock reads at the moment `run` is called. */
private class RecordingModel(private val inner: VisionModel, private val clock: ScriptedClock) : VisionModel {
    val calls = ArrayList<Tensor>()
    val readsAtRun = ArrayList<Int>()

    override suspend fun run(input: Tensor): Map<String, Tensor> {
        calls.add(input)
        readsAtRun.add(clock.reads)
        return inner.run(input)
    }
}

private suspend fun runPipeline(setup: JsonObject): FixtureOutcome {
    val task = taskOf(setup) ?: ""
    val image = imageOf(setup["image"])
    val scripted = setup["scripted"] as JsonObject
    val clock = ScriptedClock((setup["clock"] as JsonArray).map { d(it) }.toDoubleArray())
    val options = optionsOf(setup)
    var scriptedError: FixtureModelError? = null
    val inner: VisionModel = if ("outputs" in scripted) {
        scriptedModel(tensorsOf(scripted["outputs"]))
    } else {
        val error = FixtureModelError(str(scripted["error"]))
        scriptedError = error
        VisionModel { throw error }
    }
    val recorder = RecordingModel(inner, clock)

    fun finished(
        error: Throwable? = null,
        entries: List<ClassEntry>? = null,
        detections: List<Detection>? = null,
        timing: Timing? = null,
        geometry: Geometry? = null,
    ) = PipelineRun(
        task = task,
        entries = entries,
        detections = detections,
        timing = timing,
        geometry = geometry,
        input = recorder.calls.firstOrNull(),
        modelCalls = recorder.calls.size,
        clockReads = clock.reads,
        readsAtRun = recorder.readsAtRun,
        modelError = error,
        scriptedError = scriptedError,
    )
    return try {
        val spec = parseModelSpec(setup.getValue("spec"))
        if (task == "classify") {
            val r = classify(recorder, image, spec, optInt(options, "topK", 5), optDouble(options, "minScore", 0.0), clock)
            FixtureOutcome("pipeline", pipeline = finished(entries = r.entries, timing = r.timing))
        } else {
            val r = detect(recorder, image, spec, detectionOptionsOf(options), clock)
            FixtureOutcome("pipeline", pipeline = finished(detections = r.detections, timing = r.timing, geometry = r.geometry))
        }
    } catch (e: FixtureModelError) {
        FixtureOutcome("pipeline", pipeline = finished(error = e))
    } catch (e: VisionException) {
        FixtureOutcome("pipeline", error = FixtureError(e.kind.wire, e.message), pipeline = finished())
    }
}

private suspend fun runSetup(checked: Checked): FixtureOutcome {
    val kind = checked.kind
    val setup = checked.setup
    return when (kind) {
        "resize" -> {
            val image = imageOf(setup["image"])
            FixtureOutcome(kind, image = resize(image, intArg(setup["width"]), intArg(setup["height"]), methodOf(setup["method"])))
        }
        "geometry" -> {
            val srcW = intArg(setup["srcWidth"])
            val srcH = intArg(setup["srcHeight"])
            val geometry = preprocessGeometry(srcW, srcH, parseModelSpec(setup.getValue("spec")))
            val unmapped = (setup["boxes"] as? JsonArray)?.map { unmapBox(boxOf(it), geometry, srcW, srcH) }
            FixtureOutcome(kind, geometry = geometry, unmapped = unmapped)
        }
        "tensor" -> FixtureOutcome(kind, tensor = toTensor(imageOf(setup["image"]), parseModelSpec(setup.getValue("spec"))).tensor)
        "classify" -> {
            val options = optionsOf(setup)
            val output = (setup["output"] as JsonArray).let { list -> DoubleArray(list.size) { d(list[it]) } }
            FixtureOutcome(kind, entries = postprocessClassification(output, parseModelSpec(setup.getValue("spec")), optInt(options, "topK", 5), optDouble(options, "minScore", 0.0)))
        }
        "decode" -> {
            val spec = parseModelSpec(setup.getValue("spec"))
            val srcW = intArg(setup["srcWidth"])
            val srcH = intArg(setup["srcHeight"])
            val geometry = preprocessGeometry(srcW, srcH, spec)
            FixtureOutcome(kind, detections = postprocessDetections(tensorsOf(setup["outputs"]), spec, geometry, ImageSize(srcW, srcH), detectionOptionsOf(optionsOf(setup))))
        }
        "nms" -> FixtureOutcome(kind, detections = nms((setup["detections"] as JsonArray).map { detectionOf(it) }, numArg(setup["iouThreshold"])))
        "metrics" -> runMetrics(setup)
        "pipeline" -> runPipeline(setup)
        else -> {
            parseModelSpec(setup.getValue("spec"))
            FixtureOutcome(kind, valid = true)
        }
    }
}

private fun runMetrics(setup: JsonObject): FixtureOutcome {
    val kind = "metrics"
    return when (opOf(setup)) {
        "iou" -> FixtureOutcome(kind, value = iou(boxOf(setup["a"]), boxOf(setup["b"])))
        "topk" -> {
            val predictions = (setup["predictions"] as JsonArray).map { list -> (list as JsonArray).map { rankArg(it) } }
            val truths = (setup["truths"] as JsonArray).map { rankArg(it) }
            FixtureOutcome(kind, value = topKAccuracy(predictions, truths, intArg(setup["k"])))
        }
        "ap" -> FixtureOutcome(kind, byClass = averagePrecision(metricDetections(setup), metricTruths(setup), numArg(setup["iouThreshold"])).byClass)
        else -> {
            val r = meanAveragePrecision(metricDetections(setup), metricTruths(setup), numArg(setup["iouThreshold"]))
            FixtureOutcome(kind, map = r.map, byClass = r.byClass)
        }
    }
}

private fun metricDetections(setup: JsonObject): List<ScoredDetection> = (setup["detections"] as JsonArray).map {
    val o = it as JsonObject
    ScoredDetection(str(o["image"]), classArg(o["classIndex"]), d(o["score"]), boxOf(o["box"]))
}

private fun metricTruths(setup: JsonObject): List<Truth> = (setup["truths"] as JsonArray).map {
    val o = it as JsonObject
    Truth(str(o["image"]), classArg(o["classIndex"]), boxOf(o["box"]))
}

/**
 * Runs the fixture's setup. A malformed fixture fails with `IllegalStateException("invalid fixture: <reason>")` before
 * anything runs; a library failure is reported as the outcome's [FixtureOutcome.error].
 */
suspend fun runFixture(fixture: Fixture): FixtureOutcome {
    val checked = checkFixture(fixture)
    return try {
        runSetup(checked)
    } catch (e: VisionException) {
        FixtureOutcome(checked.kind, error = FixtureError(e.kind.wire, e.message))
    }
}

// ---- comparison -----------------------------------------------------------------------------------------------------

private const val TOLERANCE = 1e-9

/** Within the absolute tolerance; equal values (infinities included, `-0` and `0`) match, NaN never does. */
private fun close(a: Double, b: Double): Boolean = a == b || abs(a - b) <= TOLERANCE

private fun compareDouble(key: String, want: Double, got: Double?, out: MutableList<String>) {
    if (got == null || !close(want, got)) out += "$key: expected <$want> but was <$got>"
}

/** An integer, a byte or an index: exact. */
private fun compareExact(key: String, want: Double, got: Int?, out: MutableList<String>) {
    if (got == null || want != got.toDouble()) out += "$key: expected <$want> but was <$got>"
}

private fun compareBox(key: String, want: Box, got: Box?, out: MutableList<String>) {
    if (got == null) {
        out += "$key: expected <$want> but was <null>"
        return
    }
    compareDouble("$key.x1", want.x1, got.x1, out)
    compareDouble("$key.y1", want.y1, got.y1, out)
    compareDouble("$key.x2", want.x2, got.x2, out)
    compareDouble("$key.y2", want.y2, got.y2, out)
}

private fun compareImage(want: ExpImage, got: Image?, out: MutableList<String>) {
    if (got == null) {
        out += "image: expected an image but there was none"
        return
    }
    compareExact("image.width", want.width, got.width, out)
    compareExact("image.height", want.height, got.height, out)
    if (!want.data.contentEquals(got.data)) {
        val at = (0 until minOf(want.data.size, got.data.size)).firstOrNull { want.data[it] != got.data[it] }
        out += "image.data: expected ${want.data.size} bytes, got ${got.data.size}; first difference at ${at ?: "the end"}"
    }
}

private fun compareGeometry(want: ExpGeometry, got: Geometry?, out: MutableList<String>) {
    if (got == null) {
        out += "geometry: expected a geometry but there was none"
        return
    }
    compareExact("geometry.newWidth", want.newWidth, got.newWidth, out)
    compareExact("geometry.newHeight", want.newHeight, got.newHeight, out)
    compareDouble("geometry.scaleX", want.scaleX, got.scaleX, out)
    compareDouble("geometry.scaleY", want.scaleY, got.scaleY, out)
    compareDouble("geometry.offsetX", want.offsetX, got.offsetX, out)
    compareDouble("geometry.offsetY", want.offsetY, got.offsetY, out)
}

private fun compareTensor(key: String, want: ExpTensor, got: Tensor?, out: MutableList<String>) {
    if (got == null) {
        out += "$key: expected a tensor but there was none"
        return
    }
    if (want.shape.size != got.shape.size || want.shape.indices.any { want.shape[it] != got.shape[it].toDouble() }) out += "$key.shape: expected <${want.shape}> but was <${got.shape}>"
    if (want.data.size != got.data.size) {
        out += "$key.data: expected ${want.data.size} values but got ${got.data.size}"
        return
    }
    for (i in want.data.indices) {
        if (!close(want.data[i], got.data[i])) {
            out += "$key.data[$i]: expected <${want.data[i]}> but was <${got.data[i]}>"
            return
        }
    }
}

private fun compareEntries(key: String, want: List<ExpEntry>, got: List<ClassEntry>?, out: MutableList<String>) {
    if (got == null || want.size != got.size) {
        out += "$key: expected ${want.size} entries but got ${got?.size}"
        return
    }
    for (i in want.indices) {
        compareExact("$key[$i].index", want[i].index, got[i].index, out)
        if (want[i].label != got[i].label) out += "$key[$i].label: expected <${want[i].label}> but was <${got[i].label}>"
        compareDouble("$key[$i].score", want[i].score, got[i].score, out)
    }
}

private fun compareDetections(key: String, want: List<ExpDetection>, got: List<Detection>?, out: MutableList<String>) {
    if (got == null || want.size != got.size) {
        out += "$key: expected ${want.size} detections but got ${got?.size}"
        return
    }
    for (i in want.indices) {
        compareExact("$key[$i].classIndex", want[i].classIndex, got[i].classIndex, out)
        if (want[i].label != got[i].label) out += "$key[$i].label: expected <${want[i].label}> but was <${got[i].label}>"
        compareDouble("$key[$i].score", want[i].score, got[i].score, out)
        compareBox("$key[$i].box", want[i].box, got[i].box, out)
    }
}

private fun compareByClass(want: List<ExpClass>, got: List<ClassAp>?, out: MutableList<String>) {
    if (got == null || want.size != got.size) {
        out += "byClass: expected ${want.size} entries but got ${got?.size}"
        return
    }
    for (i in want.indices) {
        compareExact("byClass[$i].classIndex", want[i].classIndex, got[i].classIndex, out)
        compareDouble("byClass[$i].ap", want[i].ap, got[i].ap, out)
    }
}

private fun compareTiming(want: Timing, got: Timing?, out: MutableList<String>) {
    compareDouble("timing.preprocessMs", want.preprocessMs, got?.preprocessMs, out)
    compareDouble("timing.inferenceMs", want.inferenceMs, got?.inferenceMs, out)
    compareDouble("timing.postprocessMs", want.postprocessMs, got?.postprocessMs, out)
}

private fun compareError(want: Expected, got: FixtureError?, out: MutableList<String>) {
    if (got == null) {
        out += "expected error <${want.errorKind}> but the run succeeded"
        return
    }
    if (want.errorKind != got.kind) out += "error kind: expected <${want.errorKind}> but was <${got.kind}>"
    if (want.errorMessage != null && want.errorMessage != got.message) out += "error message: expected <${want.errorMessage}> but was <${got.message}>"
}

private fun comparePipeline(want: Expected, run: PipelineRun?, error: FixtureError?, out: MutableList<String>) {
    val calls = run?.modelCalls ?: 0
    val reads = run?.clockReads ?: 0
    if (want.isError) {
        compareError(want, error, out)
    } else if (want.modelError != null) {
        val thrown = run?.modelError
        if (error != null) {
            out += "expected the model error <${want.modelError}> but the run failed with <${error.kind}>"
        } else if (thrown == null) {
            out += "expected the model error <${want.modelError}> but the run succeeded"
        } else {
            if (thrown !== run.scriptedError) out += "the model error was wrapped or replaced: <$thrown>"
            if (thrown.message != want.modelError) out += "model error message: expected <${want.modelError}> but was <${thrown.message}>"
        }
    } else {
        if (error != null) {
            out += "unexpected error <${error.kind}>"
            return
        }
        if (run == null || run.modelError != null) {
            out += "the model failed: ${run?.modelError}"
            return
        }
        want.timing?.let { compareTiming(it, run.timing, out) }
        want.entries?.let { compareEntries("results", it, run.entries, out) }
        want.detections?.let { compareDetections("results", it, run.detections, out) }
        want.input?.let { compareTensor("input", it, run.input, out) }
        if (want.geometry != null) compareGeometry(want.geometry, run.geometry, out) else if (run.geometry != null) out += "geometry: expected none but was <${run.geometry}>"
    }
    want.modelCalls?.let { if (it != calls.toDouble()) out += "modelCalls: expected <$it> but was <$calls>" }
    want.clockReads?.let { if (it != reads.toDouble()) out += "clockReads: expected <$it> but was <$reads>" }
    if (run != null && run.readsAtRun.any { it != 2 }) out += "the model ran after ${run.readsAtRun} clock reads, expected 2"
    if (run != null && run.modelError == null && error == null && (reads != 4 || calls != 1)) out += "a successful run reads the clock 4 times and calls the model once, got $reads reads and $calls calls"
}

/** Compares a run with the fixture's expectation; returns the failures (empty when the fixture passes). */
fun checkOutcome(fixture: Fixture, outcome: FixtureOutcome): List<String> {
    val checked = checkFixture(fixture)
    val want = checked.expect
    val out = mutableListOf<String>()
    if (checked.kind == "pipeline") {
        comparePipeline(want, outcome.pipeline, outcome.error, out)
        return out
    }
    if (want.isError) {
        compareError(want, outcome.error, out)
        return out
    }
    val error = outcome.error
    if (error != null) {
        out += "unexpected error <${error.kind}>: ${error.message}"
        return out
    }
    when (checked.kind) {
        "resize" -> want.image?.let { compareImage(it, outcome.image, out) }
        "geometry" -> {
            want.geometry?.let { compareGeometry(it, outcome.geometry, out) }
            val wantBoxes = want.unmapped
            val gotBoxes = outcome.unmapped
            if (wantBoxes == null) {
                if (gotBoxes != null) out += "unmapped: expected none but was <$gotBoxes>"
            } else if (gotBoxes == null || gotBoxes.size != wantBoxes.size) {
                out += "unmapped: expected ${wantBoxes.size} entries but got ${gotBoxes?.size}"
            } else {
                for (i in wantBoxes.indices) {
                    val w = wantBoxes[i]
                    val g = gotBoxes[i]
                    if (w == null) {
                        if (g != null) out += "unmapped[$i]: expected <null> but was <$g>"
                    } else {
                        compareBox("unmapped[$i]", w, g, out)
                    }
                }
            }
        }
        "tensor" -> want.tensor?.let { compareTensor("tensor", it, outcome.tensor, out) }
        "classify" -> want.entries?.let { compareEntries("entries", it, outcome.entries, out) }
        "decode", "nms" -> want.detections?.let { compareDetections("detections", it, outcome.detections, out) }
        "metrics" -> {
            want.value?.let { compareDouble("value", it, outcome.value, out) }
            if (want.map != null) compareDouble("map", want.map, outcome.map, out) else if (outcome.map != null) out += "map: expected none but was <${outcome.map}>"
            want.byClass?.let { compareByClass(it, outcome.byClass, out) }
        }
        else -> if (want.valid != outcome.valid) out += "valid: expected <${want.valid}> but was <${outcome.valid}>"
    }
    return out
}
