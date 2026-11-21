package es.sebas1705.ilabs.vision

import kotlin.time.DurationUnit
import kotlin.time.TimeSource

/** A model: takes the input tensor, returns its named output tensors. Its errors (cancellation included) propagate unchanged. */
fun interface VisionModel {
    suspend fun run(input: Tensor): Map<String, Tensor>
}

/** A source of milliseconds, read exactly four times per [classify] or [detect]. */
fun interface Clock {
    fun nowMs(): Double
}

/** A model that ignores its input values, records every call and returns the scripted tensors each time. */
class ScriptedModel(private val outputs: Map<String, Tensor>) : VisionModel {
    private val recorded = ArrayList<Tensor>()

    /** The input tensors received so far, in order. */
    val calls: List<Tensor> get() = recorded.toList()

    override suspend fun run(input: Tensor): Map<String, Tensor> {
        recorded.add(input)
        return outputs
    }
}

/** A [ScriptedModel] returning [outputs] on every call. */
fun scriptedModel(outputs: Map<String, Tensor>): ScriptedModel = ScriptedModel(outputs)

/** The three phases of a run, in milliseconds (plain differences of the clock reads: no clamping). */
data class Timing(val preprocessMs: Double, val inferenceMs: Double, val postprocessMs: Double)

/** The result of [classify]. */
data class ClassifyResult(val entries: List<ClassEntry>, val timing: Timing)

/** The result of [detect]: [geometry] maps model-input coordinates back to the image. */
data class DetectResult(val detections: List<Detection>, val timing: Timing, val geometry: Geometry)

private class RealClock : Clock {
    private val start = TimeSource.Monotonic.markNow()

    override fun nowMs(): Double = start.elapsedNow().toDouble(DurationUnit.MILLISECONDS)
}

/** A real, monotonic clock (not part of the contract). */
private fun defaultClock(): Clock = RealClock()

/** The classifier output vector of [outputs]: the tensor `output` with shape `[C]` or `[1, C]`, `C >= 1`. */
private fun classifierVector(outputs: Map<String, Tensor>): DoubleArray {
    val tensor = outputs["output"] ?: invalidOutput("missing tensor: output")
    if (!tensor.isConsistent()) invalidOutput("tensor output: the data length must equal the product of the shape")
    val shape = tensor.shape
    val count = if (shape.size == 1) shape[0] else if (shape.size == 2 && shape[0] == 1) shape[1] else invalidOutput("output must have shape [C] or [1, C]")
    if (count < 1) invalidOutput("output must have at least one class")
    return tensor.data
}

/**
 * Preprocesses [image], runs [model] exactly once and reads its `output` tensor as a classification. Everything is
 * validated before the first clock read or model call (`invalid_options`, `invalid_spec`); the clock is read four times.
 * Errors thrown by the model or the clock propagate unchanged.
 */
suspend fun classify(
    model: VisionModel,
    image: Image,
    spec: ModelSpec,
    topK: Int = DEFAULT_TOP_K,
    minScore: Double = DEFAULT_MIN_SCORE,
    clock: Clock = defaultClock(),
): ClassifyResult {
    validateImage(image)
    validateModelSpec(spec)
    requireClassifier(spec)
    validateClassifyOptions(topK, minScore)
    val t0 = clock.nowMs()
    val prepared = toTensor(image, spec)
    val t1 = clock.nowMs()
    val outputs = model.run(prepared.tensor)
    val t2 = clock.nowMs()
    val entries = postprocessClassification(classifierVector(outputs), spec, topK, minScore)
    val t3 = clock.nowMs()
    return ClassifyResult(entries, Timing(t1 - t0, t2 - t1, t3 - t2))
}

/** Like [classify] for a detector: step 7 is [postprocessDetections] with the geometry of [image]. */
suspend fun detect(
    model: VisionModel,
    image: Image,
    spec: ModelSpec,
    options: DetectionOptions = DetectionOptions(),
    clock: Clock = defaultClock(),
): DetectResult {
    validateImage(image)
    validateModelSpec(spec)
    requireDetector(spec)
    validateDetectionOptions(options)
    val t0 = clock.nowMs()
    val prepared = toTensor(image, spec)
    val t1 = clock.nowMs()
    val outputs = model.run(prepared.tensor)
    val t2 = clock.nowMs()
    val detections = postprocessDetections(outputs, spec, prepared.geometry, ImageSize(image.width, image.height), options)
    val t3 = clock.nowMs()
    return DetectResult(detections, Timing(t1 - t0, t2 - t1, t3 - t2), prepared.geometry)
}
