package es.sebas1705.ilabs.demo

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import es.sebas1705.ilabs.vision.ChannelOrder
import es.sebas1705.ilabs.vision.Geometry
import es.sebas1705.ilabs.vision.Image
import es.sebas1705.ilabs.vision.ImageSize
import es.sebas1705.ilabs.vision.InputDType
import es.sebas1705.ilabs.vision.ModelSpec
import es.sebas1705.ilabs.vision.ScriptedModel
import es.sebas1705.ilabs.vision.Tensor
import es.sebas1705.ilabs.vision.TensorLayout
import es.sebas1705.ilabs.vision.VisionModel
import es.sebas1705.ilabs.vision.parseModelSpec
import es.sebas1705.ilabs.vision.toTensor
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import org.tensorflow.lite.DataType
import org.tensorflow.lite.Interpreter
import java.io.File
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.max
import kotlin.time.DurationUnit
import kotlin.time.TimeSource

/** The two things the demo runs. */
enum class VisionTask(val wire: String) { CLASSIFICATION("classification"), DETECTION("detection") }

/** Where the raw model outputs come from: the recording of the ONNX models, or the TFLite models run by LiteRT. */
enum class VisionBackend { RECORDED, REAL }

/** The name the demo gives the classifier's output tensor: the one `classify` of the library reads. */
const val VISION_CLASSIFIER_OUTPUT = "output"

/** A sample image of `samples.json`. */
data class VisionSample(val id: String, val file: String, val titleEs: String, val titleEn: String, val width: Int, val height: Int) {
    val ref: String get() = "asset:samples/$file"

    fun title(language: String): String = if (language == "es") titleEs else titleEn
}

/**
 * A model card of `models.json`. [spec] already carries the labels of [labelsFile]; [outputs] maps the decoder names
 * (`scores` for a classifier; `boxes`, `classes`, `scores`, `count` for `ssd`) to the model's tensor names, and
 * [outputIndex] to the output tensor index (TFLite only).
 */
data class ModelCard(
    val id: String,
    val task: VisionTask,
    val runtime: String,
    val file: String,
    val spec: ModelSpec,
    val inputName: String,
    val outputs: Map<String, String>,
    val outputIndex: Map<String, Int>,
)

/** Samples and cards read from the assets; [problems] lists what could not be read (the valid rest is kept). */
class VisionCatalog(val samples: List<VisionSample>, val cards: List<ModelCard>, val problems: List<String>) {
    /** The card of the recorded ONNX outputs for [task]. */
    fun recordedCard(task: VisionTask): ModelCard? = cards.firstOrNull { it.task == task && it.runtime == "onnx" }

    /** The card of the model LiteRT runs for [task]. */
    fun realCard(task: VisionTask): ModelCard? = cards.firstOrNull { it.task == task && it.runtime == "tflite" }
}

/** The demo's read access to its assets (Android assets in the app, plain files in unit tests). Paths are relative to `vision/`. */
interface VisionAssets {
    fun text(path: String): String?

    fun bytes(path: String): ByteArray?

    fun exists(path: String): Boolean
}

/** The platform pieces a run needs: decoding an image reference to RGB bytes. A reference is `asset:<path>` or `file:<path>`. */
fun interface VisionPlatform {
    /** Decodes [ref] to at most 4096 pixels per side; throws [VisionImageException] when it is not an image. */
    fun decode(ref: String): Image
}

/** A picked or bundled image that cannot be opened or decoded. */
class VisionImageException(message: String) : Exception(message)

/** Opens the model of a card. The adapter behind [VisionModel]; the app uses [LiteRtModels]. */
interface VisionModels : AutoCloseable {
    fun open(card: ModelCard): VisionModel
}

// ---- reading the assets ---------------------------------------------------------------------------------------------

private fun JsonElement?.obj(): JsonObject? = this as? JsonObject

private fun JsonElement?.str(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun JsonElement?.integer(): Int? = (this as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toIntOrNull()

/** Labels file: one label per line, either line ending, no label for a final empty line. */
internal fun parseLabelLines(text: String): List<String> {
    val lines = text.split('\n').map { it.trimEnd('\r') }
    return if (lines.lastOrNull() == "") lines.dropLast(1) else lines
}

private fun parseSample(element: JsonElement): VisionSample {
    val o = element.obj() ?: error("must be an object")
    val id = o["id"].str()?.takeIf { it.isNotBlank() } ?: error("missing id")
    val file = o["file"].str()?.takeIf { it.isNotBlank() && '/' !in it && '\\' !in it } ?: error("$id: missing file")
    val width = o["width"].integer()?.takeIf { it >= 1 } ?: error("$id: width must be a positive integer")
    val height = o["height"].integer()?.takeIf { it >= 1 } ?: error("$id: height must be a positive integer")
    val title = o["title"].obj() ?: error("$id: missing title")
    return VisionSample(
        id, file,
        title["es"].str()?.takeIf { it.isNotBlank() } ?: error("$id: missing title.es"),
        title["en"].str()?.takeIf { it.isNotBlank() } ?: error("$id: missing title.en"),
        width, height,
    )
}

private fun parseCard(element: JsonElement, assets: VisionAssets): ModelCard {
    val o = element.obj() ?: error("must be an object")
    val id = o["id"].str() ?: error("missing id")
    val task = VisionTask.entries.firstOrNull { it.wire == o["task"].str() } ?: error("$id: unknown task")
    val labelsPath = o["labels"].str() ?: error("$id: missing labels")
    val labels = parseLabelLines(assets.text(labelsPath) ?: error("$id: missing $labelsPath"))
    val spec = o["spec"].obj() ?: error("$id: missing spec")
    val withLabels = JsonObject(spec + ("labels" to JsonArray(labels.map { JsonPrimitive(it) })))
    val io = o["io"].obj() ?: error("$id: missing io")
    return ModelCard(
        id = id,
        task = task,
        runtime = o["runtime"].str() ?: error("$id: missing runtime"),
        file = o["file"].str() ?: error("$id: missing file"),
        spec = parseModelSpec(withLabels),
        inputName = io["input"].str() ?: error("$id: missing io.input"),
        outputs = io["outputs"].obj().orEmpty().mapValues { it.value.str() ?: error("$id: io.outputs must map to names") },
        outputIndex = io["outputIndex"].obj().orEmpty().mapValues { it.value.integer() ?: error("$id: io.outputIndex must map to integers") },
    )
}

/** Reads `samples.json` and `models.json`; a malformed sample or card is reported in `problems` and the valid ones are kept. */
fun loadVisionCatalog(assets: VisionAssets): VisionCatalog {
    val problems = mutableListOf<String>()
    val samples = mutableListOf<VisionSample>()
    val cards = mutableListOf<ModelCard>()
    try {
        val root = Json.parseToJsonElement(assets.text("samples.json") ?: error("samples.json is missing")).obj() ?: error("samples.json must be an object")
        (root["samples"] as? JsonArray ?: error("samples.json: samples must be an array")).forEachIndexed { index, element ->
            try {
                val sample = parseSample(element)
                if (samples.any { it.id == sample.id }) error("${sample.id}: duplicate id")
                samples += sample
            } catch (e: Exception) {
                problems += "sample #${index + 1}: ${e.message ?: e::class.simpleName}"
            }
        }
    } catch (e: Exception) {
        problems += e.message ?: e::class.simpleName.orEmpty()
    }
    try {
        val root = Json.parseToJsonElement(assets.text("models.json") ?: error("models.json is missing")).obj() ?: error("models.json must be an object")
        (root["models"] as? JsonArray ?: error("models.json: models must be an array")).forEachIndexed { index, element ->
            try {
                cards += parseCard(element, assets)
            } catch (e: Exception) {
                problems += "model #${index + 1}: ${e.message ?: e::class.simpleName}"
            }
        }
    } catch (e: Exception) {
        problems += e.message ?: e::class.simpleName.orEmpty()
    }
    return VisionCatalog(samples, cards, problems)
}

/** A recorded run: the raw tensors of the model (by the model's own tensor names) and what they were captured on. */
class RecordedOutputs(val model: String, val inputShape: List<Int>, val source: ImageSize, val tensors: Map<String, Tensor>)

internal fun parseRecorded(text: String): RecordedOutputs {
    val root = Json.parseToJsonElement(text) as? JsonObject ?: error("a recording must be an object")
    val source = root["source"].obj() ?: error("a recording needs a source size")
    val tensors = (root["outputs"].obj() ?: error("a recording needs outputs")).mapValues { (name, value) ->
        val tensor = value.obj() ?: error("output $name must be an object")
        Tensor(
            (tensor["shape"] as? JsonArray ?: error("output $name needs a shape")).map { it.integer() ?: error("output $name: bad shape") },
            (tensor["data"] as? JsonArray ?: error("output $name needs data")).map { (it as JsonPrimitive).double }.toDoubleArray(),
        )
    }
    return RecordedOutputs(
        model = root["model"].str() ?: error("a recording needs its model id"),
        inputShape = (root["inputShape"] as? JsonArray ?: error("a recording needs its input shape")).map { (it as JsonPrimitive).int },
        source = ImageSize(source["width"].integer() ?: error("bad source width"), source["height"].integer() ?: error("bad source height")),
        tensors = tensors,
    )
}

/** The decoder name of a card's output tensor: a classifier's `scores` is the library's `output`; detector names are kept. */
internal fun decoderKey(card: ModelCard, name: String): String =
    if (card.task == VisionTask.CLASSIFICATION && name == "scores") VISION_CLASSIFIER_OUTPUT else name

/** Renames the model's raw tensors to the decoder names through the card's `io.outputs`. */
internal fun decoderOutputs(card: ModelCard, raw: Map<String, Tensor>): Map<String, Tensor> =
    card.outputs.entries.associate { (decoder, rawName) ->
        decoderKey(card, decoder) to (raw[rawName] ?: error("the recording has no tensor named $rawName"))
    }

// ---- the preprocessing preview ----------------------------------------------------------------------------------------

/** The model input drawn as an image: [argb] holds `width * height` opaque pixels, row-major. */
class PreviewImage(val width: Int, val height: Int, val argb: IntArray)

/**
 * Draws the library's input tensor back as pixels: normalization is undone (`value * std + mean`, then `/ scale`), the
 * layout and the channel order are undone, and values are clamped to bytes. Drawing only: the tensor is the library's.
 */
internal fun previewOf(tensor: Tensor, spec: ModelSpec): PreviewImage {
    val input = spec.input
    val w = input.width
    val h = input.height
    check(tensor.data.size == w * h * 3) { "the input tensor does not match the model input size" }
    val float = input.dtype == InputDType.FLOAT
    val scale = input.scale ?: 1.0
    val mean = input.mean ?: listOf(0.0, 0.0, 0.0)
    val std = input.std ?: listOf(1.0, 1.0, 1.0)
    val pixels = IntArray(w * h)
    val channel = IntArray(3)
    for (y in 0 until h) {
        for (x in 0 until w) {
            for (c in 0 until 3) {
                val at = if (input.layout == TensorLayout.NHWC) (y * w + x) * 3 + c else (c * h + y) * w + x
                val v = tensor.data[at]
                val byte = if (float) (v * std[c] + mean[c]) / scale else v
                channel[c] = Math.round(byte).toInt().coerceIn(0, 255)
            }
            val r = if (input.channels == ChannelOrder.BGR) channel[2] else channel[0]
            val b = if (input.channels == ChannelOrder.BGR) channel[0] else channel[2]
            pixels[y * w + x] = (0xFF shl 24) or (r shl 16) or (channel[1] shl 8) or b
        }
    }
    return PreviewImage(w, h, pixels)
}

// ---- the inference step -------------------------------------------------------------------------------------------------

/** What one inference is asked: the task, the image, and where the raw outputs come from. */
data class InferRequest(
    val task: VisionTask,
    val imageRef: String,
    /** The sample whose recording is replayed (recorded backend only). */
    val sampleId: String?,
    val backend: VisionBackend,
    val card: ModelCard,
)

/**
 * The raw side of a run: everything the postprocessing needs and the model is never asked again for. [inferenceMs] is
 * null for a recording (nothing ran).
 */
class Inference(
    val task: VisionTask,
    val backend: VisionBackend,
    val card: ModelCard,
    val source: ImageSize,
    val preview: PreviewImage,
    val geometry: Geometry,
    /** By decoder name (`output`, or `boxes`, `classes`, `scores`, `count`). */
    val outputs: Map<String, Tensor>,
    val preprocessMs: Double,
    val inferenceMs: Double?,
)

private fun elapsedMs(mark: TimeSource.Monotonic.ValueTimeMark): Double = mark.elapsedNow().toDouble(DurationUnit.MILLISECONDS)

/**
 * Decodes the image, builds the model input with the library's `toTensor` and obtains the raw outputs exactly once, from
 * the recording or from LiteRT. Runs off the main thread. Nothing here resizes, normalizes, ranks or suppresses.
 */
class VisionEngine(
    private val assets: VisionAssets,
    private val platform: VisionPlatform,
    private val models: VisionModels,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
) {
    suspend fun infer(request: InferRequest): Inference = withContext(dispatcher) {
        val card = request.card
        val image = platform.decode(request.imageRef)
        val start = TimeSource.Monotonic.markNow()
        val prepared = toTensor(image, card.spec)
        val preprocessMs = elapsedMs(start)
        val recorded = request.backend == VisionBackend.RECORDED
        val model: VisionModel = if (recorded) {
            val id = request.sampleId ?: error("the recorded backend needs a sample")
            val path = "recorded/$id.${card.task.wire}.json"
            val recording = parseRecorded(assets.text(path) ?: error("no recording: $path"))
            check(recording.model == card.id) { "$path was captured with ${recording.model}, not ${card.id}" }
            check(recording.inputShape == prepared.tensor.shape) { "$path does not match the input of ${card.id}" }
            ScriptedModel(decoderOutputs(card, recording.tensors))
        } else {
            models.open(card)
        }
        val ran = TimeSource.Monotonic.markNow()
        val outputs = model.run(prepared.tensor)
        val inferenceMs = if (recorded) null else elapsedMs(ran)
        Inference(
            request.task, request.backend, card, ImageSize(image.width, image.height),
            previewOf(prepared.tensor, card.spec), prepared.geometry, outputs, preprocessMs, inferenceMs,
        )
    }
}

// ---- LiteRT ----------------------------------------------------------------------------------------------------------------

/** What the adapter needs of a loaded TFLite model; [InterpreterRunner] is the LiteRT one. */
internal interface TfLiteRunner : AutoCloseable {
    val inputShape: List<Int>

    /** True for a float32 input, false for a uint8 one; any other type is refused. */
    val inputIsFloat: Boolean

    fun outputShape(index: Int): List<Int>

    fun outputIsFloat(index: Int): Boolean

    /** Runs the model once with [input] and fills the direct [outputs] buffers by output index. */
    fun run(input: ByteBuffer, outputs: Map<Int, ByteBuffer>)
}

private fun directBuffer(bytes: Int): ByteBuffer = ByteBuffer.allocateDirect(bytes).order(ByteOrder.nativeOrder())

/** The model input bytes of the library's tensor: float32, or the raw bytes of a uint8 model. Drawing no conclusions: a copy. */
internal fun inputBuffer(tensor: Tensor, float: Boolean): ByteBuffer {
    val buffer = directBuffer(if (float) tensor.data.size * 4 else tensor.data.size)
    if (float) {
        val floats = buffer.asFloatBuffer()
        for (v in tensor.data) floats.put(v.toFloat())
    } else {
        for (v in tensor.data) buffer.put(v.toInt().toByte())
    }
    buffer.rewind()
    return buffer
}

/**
 * Runs a TFLite model through [runner] and returns its output tensors under the decoder names of the card's
 * `outputIndex`. The first call may load nothing lazily: the runner is already open. Calls are serialized.
 */
internal class LiteRtModel(private val card: ModelCard, private val runner: TfLiteRunner) : VisionModel, AutoCloseable {
    private val lock = Mutex()

    @Volatile
    private var closeRequested = false
    private var closed = false

    override suspend fun run(input: Tensor): Map<String, Tensor> {
        try {
            return lock.withLock {
                check(!closed) { "the model is closed" }
                withContext(Dispatchers.Default) {
                    check(input.shape == runner.inputShape) { "the input tensor ${input.shape} does not match the model input ${runner.inputShape}" }
                    check(card.outputIndex.isNotEmpty()) { "${card.id} has no outputIndex" }
                    val buffers = HashMap<Int, ByteBuffer>()
                    for ((_, index) in card.outputIndex) {
                        check(runner.outputIsFloat(index)) { "output $index is not float32" }
                        buffers[index] = directBuffer(runner.outputShape(index).fold(1) { a, b -> a * b } * 4)
                    }
                    runner.run(inputBuffer(input, runner.inputIsFloat), buffers)
                    card.outputIndex.entries.associate { (decoder, index) ->
                        val floats = buffers.getValue(index).also { it.rewind() }.asFloatBuffer()
                        val data = DoubleArray(floats.remaining()) { floats.get().toDouble() }
                        decoderKey(card, decoder) to Tensor(runner.outputShape(index), data)
                    }
                }
            }
        } finally {
            // A close asked for during the run happens now, never under a native inference that cannot be cancelled.
            if (closeRequested) closeNow()
        }
    }

    /** Closes the runner as soon as no run holds the lock: at once when idle, otherwise when the running call ends. */
    override fun close() {
        closeRequested = true
        closeNow()
    }

    private fun closeNow() {
        if (!lock.tryLock()) return
        try {
            if (!closed) {
                closed = true
                runner.close()
            }
        } finally {
            lock.unlock()
        }
    }
}

private class InterpreterRunner(private val interpreter: Interpreter) : TfLiteRunner {
    override val inputShape: List<Int> = interpreter.getInputTensor(0).shape().toList()
    override val inputIsFloat: Boolean = when (interpreter.getInputTensor(0).dataType()) {
        DataType.FLOAT32 -> true
        DataType.UINT8 -> false
        else -> error("unsupported model input type")
    }

    override fun outputShape(index: Int): List<Int> = interpreter.getOutputTensor(index).shape().toList()

    override fun outputIsFloat(index: Int): Boolean = interpreter.getOutputTensor(index).dataType() == DataType.FLOAT32

    override fun run(input: ByteBuffer, outputs: Map<Int, ByteBuffer>) {
        interpreter.runForMultipleInputsOutputs(arrayOf<Any>(input), outputs.mapValues { it.value as Any })
    }

    override fun close() = interpreter.close()
}

/** The LiteRT models of the app: a model is read from the assets and opened the first time its card is asked for. */
class LiteRtModels(private val assets: VisionAssets) : VisionModels {
    private val open = HashMap<String, LiteRtModel>()

    @Synchronized
    override fun open(card: ModelCard): VisionModel = open.getOrPut(card.id) {
        val bytes = assets.bytes("models/${card.file}") ?: error("the model file ${card.file} is not in this build")
        val model = directBuffer(bytes.size).put(bytes)
        model.rewind()
        LiteRtModel(card, InterpreterRunner(Interpreter(model, Interpreter.Options().setNumThreads(4))))
    }

    @Synchronized
    override fun close() {
        open.values.forEach { it.close() }
        open.clear()
    }
}

// ---- Android assets and images ------------------------------------------------------------------------------------------------

/** The `vision/` folder of the app assets, where the copyVisionAssets task puts the shared assets and the models. */
class AssetVisionAssets(context: Context) : VisionAssets {
    // Never an Activity: this object lives as long as the view model, across rotations.
    private val context: Context = context.applicationContext

    private fun path(p: String) = "vision/$p"

    override fun text(path: String): String? = bytes(path)?.toString(Charsets.UTF_8)

    override fun bytes(path: String): ByteArray? = try {
        context.assets.open(path(path)).use { it.readBytes() }
    } catch (e: java.io.FileNotFoundException) {
        null
    }

    override fun exists(path: String): Boolean = try {
        context.assets.open(path(path)).use { true }
    } catch (e: java.io.FileNotFoundException) {
        false
    }
}

/** The largest side the demo ever decodes for a model (a bigger image is sampled down while decoding). */
const val VISION_MAX_DECODE_SIDE = 4096

private const val DISPLAY_SIDE = 1024
internal const val MAX_PICKED_BYTES = 64L * 1024 * 1024
private const val PICKED_PREFIX = "vision-picked-"
private const val IMAGE_TOO_LARGE = "the image is too large for this device"

/** The power-of-two `inSampleSize` that brings the longest side (rounded up, as the decoders do) of a [width] by [height] image to at most [maxSide]. */
internal fun sampleSizeFor(width: Int, height: Int, maxSide: Int): Int {
    var sample = 1
    while ((max(width, height) + sample - 1) / sample > maxSide) sample *= 2
    return sample
}

/** One 8-bit channel over white: a transparent pixel becomes white, an opaque one keeps its colour. */
internal fun over(channel: Int, alpha: Int): Int = (channel * alpha + 255 * (255 - alpha) + 127) / 255

/**
 * RGB bytes of a [width] by [height] picture, read one row at a time through [readRow] (ARGB, not premultiplied) so
 * that only the result is allocated; a transparent pixel is composited on white. A picture too big for the device is a
 * [VisionImageException], never an OutOfMemoryError.
 */
internal fun rgbOfRows(width: Int, height: Int, readRow: (y: Int, row: IntArray) -> Unit): ByteArray {
    if (width.toLong() * height * 3 > Int.MAX_VALUE) throw VisionImageException(IMAGE_TOO_LARGE)
    try {
        val rgb = ByteArray(width * height * 3)
        val row = IntArray(width)
        var at = 0
        for (y in 0 until height) {
            readRow(y, row)
            for (p in row) {
                val a = p ushr 24
                rgb[at++] = over((p shr 16) and 0xFF, a).toByte()
                rgb[at++] = over((p shr 8) and 0xFF, a).toByte()
                rgb[at++] = over(p and 0xFF, a).toByte()
            }
        }
        return rgb
    } catch (e: OutOfMemoryError) {
        throw VisionImageException(IMAGE_TOO_LARGE)
    }
}

/**
 * Copies the stream [open] returns into a new `vision-picked-*` file of [dir] (at most [limit] bytes) and only then
 * deletes the older ones, so a failed import leaves the image in use alone. A failure leaves no partial file.
 */
internal fun importPickedFile(dir: File, limit: Long = MAX_PICKED_BYTES, now: Long = System.currentTimeMillis(), open: () -> InputStream?): File {
    val target = File(dir, PICKED_PREFIX + now)
    try {
        val input = open() ?: throw VisionImageException("the image cannot be opened")
        input.use { source ->
            target.outputStream().use { out ->
                val buffer = ByteArray(64 * 1024)
                var total = 0L
                while (true) {
                    val read = source.read(buffer)
                    if (read < 0) break
                    total += read
                    if (total > limit) throw VisionImageException("the image file is larger than ${limit / (1024 * 1024)} MB")
                    out.write(buffer, 0, read)
                }
            }
        }
    } catch (e: Exception) {
        target.delete()
        throw e as? VisionImageException ?: VisionImageException(e.message ?: "the image cannot be read")
    }
    dir.listFiles { f -> f.name.startsWith(PICKED_PREFIX) && f != target }?.forEach { it.delete() }
    return target
}

/** Image decoding and the photo picker import, on top of the Android framework. */
class AndroidVisionPlatform(context: Context) : VisionPlatform {
    // Never an Activity: this object lives as long as the view model, across rotations.
    private val context: Context = context.applicationContext

    override fun decode(ref: String): Image {
        val bitmap = decodeBitmap(ref, VISION_MAX_DECODE_SIDE)
        try {
            val w = bitmap.width
            val h = bitmap.height
            val rgb = rgbOfRows(w, h) { y, row -> bitmap.getPixels(row, 0, w, 0, y, w, 1) }
            return Image(w, h, rgb)
        } finally {
            bitmap.recycle()
        }
    }

    /** A bitmap of [ref] for showing, at most [DISPLAY_SIDE] pixels per side. */
    fun displayBitmap(ref: String): ImageBitmap = decodeBitmap(ref, DISPLAY_SIDE).asImageBitmap()

    /**
     * Copies a picked image into the app cache and returns its reference, so it survives the end of the picker's
     * permission and a process death. The previous picked file is deleted only after the copy succeeded.
     */
    fun importPicked(uri: String): String {
        val target = importPickedFile(context.cacheDir) { context.contentResolver.openInputStream(Uri.parse(uri)) }
        return "file:${target.absolutePath}"
    }

    private fun open(ref: String): InputStream = when {
        ref.startsWith("asset:") -> context.assets.open("vision/${ref.removePrefix("asset:")}")
        ref.startsWith("file:") -> File(ref.removePrefix("file:")).inputStream()
        else -> throw VisionImageException("unknown image reference")
    }

    /** Decodes [ref] sampled so no side exceeds [maxSide], turned upright by its EXIF orientation. */
    private fun decodeBitmap(ref: String, maxSide: Int): Bitmap {
        try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            open(ref).use { BitmapFactory.decodeStream(it, null, bounds) }
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw VisionImageException("the file is not an image")
            val options = BitmapFactory.Options().apply {
                inSampleSize = sampleSizeFor(bounds.outWidth, bounds.outHeight, maxSide)
                inPreferredConfig = Bitmap.Config.ARGB_8888
            }
            val decoded = open(ref).use { BitmapFactory.decodeStream(it, null, options) } ?: throw VisionImageException("the image cannot be decoded")
            try {
                val orientation = if (ref.startsWith("file:")) {
                    open(ref).use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) }
                } else {
                    ExifInterface.ORIENTATION_NORMAL
                }
                return upright(decoded, orientation)
            } catch (e: Throwable) {
                if (!decoded.isRecycled) decoded.recycle()
                throw e
            }
        } catch (e: VisionImageException) {
            throw e
        } catch (e: java.io.IOException) {
            throw VisionImageException(e.message ?: "the image cannot be read")
        } catch (e: OutOfMemoryError) {
            throw VisionImageException(IMAGE_TOO_LARGE)
        }
    }

    private fun upright(bitmap: Bitmap, orientation: Int): Bitmap {
        val matrix = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> {
                matrix.postRotate(90f)
                matrix.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_TRANSVERSE -> {
                matrix.postRotate(270f)
                matrix.postScale(-1f, 1f)
            }
            else -> return bitmap
        }
        val turned = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
        if (turned !== bitmap) bitmap.recycle()
        return turned
    }
}
