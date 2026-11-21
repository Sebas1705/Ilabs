package es.sebas1705.ilabs.vision

import es.sebas1705.ilabs.structured.parseStrict
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.math.floor

/** Memory layout of the model input tensor. */
enum class TensorLayout { NHWC, NCHW }

/** Order of the channels the model expects. */
enum class ChannelOrder { RGB, BGR }

/** How the image is fitted to the model input. */
enum class ResizeMode { STRETCH, CENTER_CROP, LETTERBOX }

/** Resampling method of [resize]. */
enum class ResizeMethod { NEAREST, BILINEAR }

/** Element type of the input tensor: normalized doubles or the raw bytes. */
enum class InputDType { FLOAT, UINT8 }

/**
 * The input half of a [ModelSpec]. [scale], [mean] and [std] are absent (`null`) unless the spec sets them: they default to
 * `1`, `[0, 0, 0]` and `[1, 1, 1]` and are not allowed with [InputDType.UINT8].
 */
data class InputSpec(
    val width: Int,
    val height: Int,
    val layout: TensorLayout,
    val channels: ChannelOrder,
    val mode: ResizeMode,
    val resample: ResizeMethod,
    val dtype: InputDType,
    val padValue: Int = 114,
    val scale: Double? = null,
    val mean: List<Double>? = null,
    val std: List<Double>? = null,
)

/** Whether a classifier outputs logits or probabilities. */
enum class ScoreType { LOGITS, PROBABILITIES }

/** Order of the four box values of an `ssd` output. */
enum class BoxOrder { YXYX, XYXY }

/** Coordinates of an `ssd` output: fractions of the model input, or its pixels. */
enum class Coordinates { NORMALIZED, PIXELS }

/** Box encoding of a `rows` output: centre and size, or two corners. */
enum class BoxFormat { XYWH, XYXY }

/** Activation applied to the scores of a `rows` output. */
enum class ScoreActivation { NONE, SIGMOID }

/** The output half of a [ModelSpec]: a classifier or one of the two detector layouts. */
sealed class OutputSpec {
    data class Classifier(val type: ScoreType) : OutputSpec()

    data class Ssd(val boxOrder: BoxOrder = BoxOrder.YXYX, val coordinates: Coordinates = Coordinates.NORMALIZED) : OutputSpec()

    data class Rows(
        val boxFormat: BoxFormat = BoxFormat.XYWH,
        val transposed: Boolean = false,
        val objectness: Boolean = false,
        val scoreActivation: ScoreActivation = ScoreActivation.NONE,
    ) : OutputSpec()
}

/** A model card. Typed specs built by hand are validated at runtime by every operation that takes one. */
data class ModelSpec(
    val input: InputSpec,
    val output: OutputSpec,
    val labels: List<String>? = null,
    val labelOffset: Int = 0,
)

private const val MIN_LABEL_OFFSET = -1_000_000
private const val MAX_LABEL_OFFSET = 1_000_000

// ---- rule messages, shared by the JSON parser and the typed validation -----------------------------------------------

private fun badSize(path: String): Nothing = invalidSpec("$path must be an integer from 1 to $MAX_SIDE")

private fun badPadValue(): Nothing = invalidSpec("input.padValue must be an integer from 0 to 255")

private fun badScale(): Nothing = invalidSpec("input.scale must be a finite number")

private fun badTriple(key: String): Nothing = invalidSpec("input.$key must be an array of 3 finite numbers")

private fun badStdZero(): Nothing = invalidSpec("input.std entries must not be 0")

private fun badUint8(key: String): Nothing = invalidSpec("input.$key is not allowed with dtype uint8")

private fun badLabelOffset(): Nothing = invalidSpec("labelOffset must be an integer from $MIN_LABEL_OFFSET to $MAX_LABEL_OFFSET")


// ---- JSON value readers (judged by value: `224.0` is the integer 224) --------------------------------------------------

private fun JsonElement?.string(): String? = (this as? JsonPrimitive)?.takeIf { it !is JsonNull && it.isString }?.content

/**
 * The value of a JSON number primitive, or null for anything else (strings, booleans, null, and literals that are not JSON
 * numbers such as `NaN`, `1d` or hex floats: only the JSON number grammar is accepted before the text is converted).
 */
internal fun numberValue(p: JsonPrimitive): Double? {
    if (p is JsonNull || p.isString) return null
    return if (isJsonNumber(p.content)) p.content.toDouble() else null
}

private fun isJsonNumber(s: String): Boolean {
    var i = 0
    val n = s.length
    if (i < n && s[i] == '-') i++
    if (i >= n) return false
    if (s[i] == '0') {
        i++
    } else if (s[i] in '1'..'9') {
        while (i < n && s[i] in '0'..'9') i++
    } else {
        return false
    }
    if (i < n && s[i] == '.') {
        i++
        val start = i
        while (i < n && s[i] in '0'..'9') i++
        if (i == start) return false
    }
    if (i < n && (s[i] == 'e' || s[i] == 'E')) {
        i++
        if (i < n && (s[i] == '+' || s[i] == '-')) i++
        val start = i
        while (i < n && s[i] in '0'..'9') i++
        if (i == start) return false
    }
    return i == n
}

private fun JsonElement?.number(): Double? = (this as? JsonPrimitive)?.let { numberValue(it) }

private fun JsonElement?.finite(): Double? = number()?.takeIf { isFinite(it) }

/** An integer by value within `lo..hi`, or null. */
private fun JsonElement?.integerIn(lo: Int, hi: Int): Int? {
    val d = number() ?: return null
    if (!isFinite(d) || floor(d) != d) return null
    if (d < lo.toDouble() || d > hi.toDouble()) return null
    return d.toInt()
}

private fun JsonElement?.boolean(): Boolean? =
    when ((this as? JsonPrimitive)?.takeIf { it !is JsonNull && !it.isString }?.content) {
        "true" -> true
        "false" -> false
        else -> null
    }

private fun JsonElement?.triple(): List<Double>? {
    val array = this as? JsonArray ?: return null
    if (array.size != 3) return null
    val out = ArrayList<Double>(3)
    for (item in array) out.add(item.finite() ?: return null)
    return out
}

private val TOP_KEYS = setOf("input", "output", "labels", "labelOffset")

private val INPUT_KEYS = setOf("width", "height", "layout", "channels", "mode", "resample", "dtype", "padValue", "scale", "mean", "std")

private val REQUIRED_INPUT_KEYS = listOf("width", "height", "layout", "channels", "mode", "resample", "dtype")

private val LAYOUTS = mapOf("nhwc" to TensorLayout.NHWC, "nchw" to TensorLayout.NCHW)
private val CHANNELS = mapOf("rgb" to ChannelOrder.RGB, "bgr" to ChannelOrder.BGR)
private val MODES = mapOf("stretch" to ResizeMode.STRETCH, "centerCrop" to ResizeMode.CENTER_CROP, "letterbox" to ResizeMode.LETTERBOX)
private val RESAMPLES = mapOf("nearest" to ResizeMethod.NEAREST, "bilinear" to ResizeMethod.BILINEAR)
private val DTYPES = mapOf("float" to InputDType.FLOAT, "uint8" to InputDType.UINT8)
private val SCORE_TYPES = mapOf("logits" to ScoreType.LOGITS, "probabilities" to ScoreType.PROBABILITIES)
private val BOX_ORDERS = mapOf("yxyx" to BoxOrder.YXYX, "xyxy" to BoxOrder.XYXY)
private val COORDINATES = mapOf("normalized" to Coordinates.NORMALIZED, "pixels" to Coordinates.PIXELS)
private val BOX_FORMATS = mapOf("xywh" to BoxFormat.XYWH, "xyxy" to BoxFormat.XYXY)
private val ACTIVATIONS = mapOf("none" to ScoreActivation.NONE, "sigmoid" to ScoreActivation.SIGMOID)

private fun <T> enumValue(el: JsonElement?, table: Map<String, T>): T? = el.string()?.let { table[it] }

/**
 * Parses and validates a model spec from a parsed JSON value. Fails with `VisionException(invalid_spec)` whose message is
 * `invalid model spec: <reason>`; the first violated rule of the contract is the one reported.
 */
fun parseModelSpec(json: JsonElement): ModelSpec {
    val root = json as? JsonObject ?: invalidSpec("spec must be an object")
    root.keys.firstOrNull { it !in TOP_KEYS }?.let { invalidSpec("unknown key: $it") }
    if ("input" !in root) invalidSpec("missing key: input")
    if ("output" !in root) invalidSpec("missing key: output")
    val input = root["input"] as? JsonObject ?: invalidSpec("input must be an object")
    input.keys.firstOrNull { it !in INPUT_KEYS }?.let { invalidSpec("unknown key: input.$it") }
    REQUIRED_INPUT_KEYS.firstOrNull { it !in input }?.let { invalidSpec("missing key: input.$it") }
    val width = input["width"].integerIn(1, MAX_SIDE) ?: badSize("input.width")
    val height = input["height"].integerIn(1, MAX_SIDE) ?: badSize("input.height")
    val layout = enumValue(input["layout"], LAYOUTS) ?: invalidSpec("input.layout must be \"nhwc\" or \"nchw\"")
    val channels = enumValue(input["channels"], CHANNELS) ?: invalidSpec("input.channels must be \"rgb\" or \"bgr\"")
    val mode = enumValue(input["mode"], MODES) ?: invalidSpec("input.mode must be \"stretch\", \"centerCrop\" or \"letterbox\"")
    val resample = enumValue(input["resample"], RESAMPLES) ?: invalidSpec("input.resample must be \"nearest\" or \"bilinear\"")
    val dtype = enumValue(input["dtype"], DTYPES) ?: invalidSpec("input.dtype must be \"float\" or \"uint8\"")
    val padValue = if ("padValue" in input) input["padValue"].integerIn(0, 255) ?: badPadValue() else 114
    val scale = if ("scale" in input) input["scale"].finite() ?: badScale() else null
    val mean = if ("mean" in input) input["mean"].triple() ?: badTriple("mean") else null
    val std = if ("std" in input) input["std"].triple() ?: badTriple("std") else null
    if (std != null && std.any { it == 0.0 }) badStdZero()
    if (dtype == InputDType.UINT8) {
        if ("scale" in input) badUint8("scale")
        if ("mean" in input) badUint8("mean")
        if ("std" in input) badUint8("std")
    }
    val output = parseOutput(root["output"])
    val labels = if ("labels" in root) parseLabels(root["labels"]) else null
    val labelOffset = if ("labelOffset" in root) root["labelOffset"].integerIn(MIN_LABEL_OFFSET, MAX_LABEL_OFFSET) ?: badLabelOffset() else 0
    return ModelSpec(InputSpec(width, height, layout, channels, mode, resample, dtype, padValue, scale, mean, std), output, labels, labelOffset)
}

/** Parses [json] strictly first (a string that is not valid JSON fails with `spec must be valid JSON`), then as above. */
fun parseModelSpec(json: String): ModelSpec = parseModelSpec(parseStrict(json) ?: invalidSpec("spec must be valid JSON"))

private fun parseLabels(el: JsonElement?): List<String> {
    val array = el as? JsonArray ?: invalidSpec("labels must be an array of strings")
    return array.map { it.string() ?: invalidSpec("labels must be an array of strings") }
}

private fun parseOutput(el: JsonElement?): OutputSpec {
    val output = el as? JsonObject ?: invalidSpec("output must be an object")
    val hasType = "type" in output
    val hasFormat = "format" in output
    if (hasType == hasFormat) invalidSpec("output must have exactly one of \"type\" and \"format\"")
    if (hasType) {
        val type = enumValue(output["type"], SCORE_TYPES) ?: invalidSpec("output.type must be \"logits\" or \"probabilities\"")
        output.keys.firstOrNull { it != "type" }?.let { invalidSpec("unknown key: output.$it") }
        return OutputSpec.Classifier(type)
    }
    val format = output["format"].string()
    if (format != "ssd" && format != "rows") invalidSpec("output.format must be \"ssd\" or \"rows\"")
    val allowed = if (format == "ssd") setOf("format", "boxOrder", "coordinates") else setOf("format", "boxFormat", "transposed", "objectness", "scoreActivation")
    output.keys.firstOrNull { it !in allowed }?.let { invalidSpec("unknown key: output.$it") }
    if (format == "ssd") {
        val boxOrder = if ("boxOrder" in output) enumValue(output["boxOrder"], BOX_ORDERS) ?: invalidSpec("output.boxOrder must be \"yxyx\" or \"xyxy\"") else BoxOrder.YXYX
        val coordinates =
            if ("coordinates" in output) enumValue(output["coordinates"], COORDINATES) ?: invalidSpec("output.coordinates must be \"normalized\" or \"pixels\"") else Coordinates.NORMALIZED
        return OutputSpec.Ssd(boxOrder, coordinates)
    }
    val boxFormat = if ("boxFormat" in output) enumValue(output["boxFormat"], BOX_FORMATS) ?: invalidSpec("output.boxFormat must be \"xywh\" or \"xyxy\"") else BoxFormat.XYWH
    val transposed = if ("transposed" in output) output["transposed"].boolean() ?: invalidSpec("output.transposed must be a boolean") else false
    val objectness = if ("objectness" in output) output["objectness"].boolean() ?: invalidSpec("output.objectness must be a boolean") else false
    val activation =
        if ("scoreActivation" in output) enumValue(output["scoreActivation"], ACTIVATIONS) ?: invalidSpec("output.scoreActivation must be \"none\" or \"sigmoid\"") else ScoreActivation.NONE
    return OutputSpec.Rows(boxFormat, transposed, objectness, activation)
}

/** Runtime validation of a typed spec with the same rules and messages as [parseModelSpec]. */
internal fun validateModelSpec(spec: ModelSpec) {
    val input = spec.input
    if (!validSide(input.width)) badSize("input.width")
    if (!validSide(input.height)) badSize("input.height")
    if (input.padValue < 0 || input.padValue > 255) badPadValue()
    val scale = input.scale
    if (scale != null && !isFinite(scale)) badScale()
    val mean = input.mean
    if (mean != null && (mean.size != 3 || mean.any { !isFinite(it) })) badTriple("mean")
    val std = input.std
    if (std != null && (std.size != 3 || std.any { !isFinite(it) })) badTriple("std")
    if (std != null && std.any { it == 0.0 }) badStdZero()
    if (input.dtype == InputDType.UINT8) {
        if (scale != null) badUint8("scale")
        if (mean != null) badUint8("mean")
        if (std != null) badUint8("std")
    }
    if (spec.labelOffset < MIN_LABEL_OFFSET || spec.labelOffset > MAX_LABEL_OFFSET) badLabelOffset()
}

internal fun requireClassifier(spec: ModelSpec): OutputSpec.Classifier =
    spec.output as? OutputSpec.Classifier ?: invalidOptions("the spec describes a detector, not a classifier")

internal fun requireDetector(spec: ModelSpec): OutputSpec {
    val output = spec.output
    if (output is OutputSpec.Classifier) invalidOptions("the spec describes a classifier, not a detector")
    return output
}
