package es.sebas1705.ilabs.demo

import es.sebas1705.ilabs.vision.Image
import es.sebas1705.ilabs.vision.ScriptedModel
import es.sebas1705.ilabs.vision.Tensor
import es.sebas1705.ilabs.vision.VisionModel
import java.io.File
import javax.imageio.ImageIO

/** The shared vision assets of the repo (`demos/vision-assets`), found from the working directory upward. */
internal val VISION_ASSETS_DIR: File = generateSequence(File("").absoluteFile) { it.parentFile }
    .map { File(it, "demos/vision-assets") }
    .first { it.isDirectory }

/**
 * The shared assets as files. Model files are hidden (a developer may have downloaded them) unless named in [models];
 * [overrides] replaces a text file by path.
 */
internal class FileVisionAssets(
    private val root: File = VISION_ASSETS_DIR,
    private val models: Set<String> = emptySet(),
    private val overrides: Map<String, String> = emptyMap(),
) : VisionAssets {
    override fun text(path: String): String? = overrides[path] ?: file(path)?.readText()

    override fun bytes(path: String): ByteArray? = file(path)?.readBytes()

    override fun exists(path: String): Boolean = if (path.startsWith("models/")) path.removePrefix("models/") in models else file(path) != null

    private fun file(path: String): File? = if (path.startsWith("models/")) null else File(root, path).takeIf { it.isFile }
}

/** Decodes the bundled samples with ImageIO; a `file:` reference is a path. */
internal class ImageIoPlatform(private val root: File = VISION_ASSETS_DIR) : VisionPlatform {
    override fun decode(ref: String): Image {
        val file = when {
            ref.startsWith("asset:") -> File(root, ref.removePrefix("asset:"))
            ref.startsWith("file:") -> File(ref.removePrefix("file:"))
            else -> throw VisionImageException("unknown image reference")
        }
        val picture = try {
            ImageIO.read(file)
        } catch (e: java.io.IOException) {
            null
        } ?: throw VisionImageException("the file is not an image")
        val rgb = ByteArray(picture.width * picture.height * 3)
        var at = 0
        for (y in 0 until picture.height) {
            for (x in 0 until picture.width) {
                val p = picture.getRGB(x, y)
                rgb[at++] = (p shr 16).toByte()
                rgb[at++] = (p shr 8).toByte()
                rgb[at++] = p.toByte()
            }
        }
        return Image(picture.width, picture.height, rgb)
    }
}

/** A stand-in for LiteRT: scripted outputs by decoder name for each task, and a record of the opened cards and the calls. */
internal class FakeModels(
    private val classification: Map<String, Tensor> = FAKE_CLASSIFICATION,
    private val detection: Map<String, Tensor> = FAKE_DETECTION,
) : VisionModels {
    val opened = mutableListOf<String>()
    val models = mutableListOf<ScriptedModel>()

    override fun open(card: ModelCard): VisionModel {
        opened += card.id
        return ScriptedModel(if (card.task == VisionTask.CLASSIFICATION) classification else detection).also { models += it }
    }

    override fun close() = Unit

    val calls: Int get() = models.sumOf { it.calls.size }
}

/** 1000 probabilities with a tabby (281) and a tiger cat (282) on top. */
internal val FAKE_CLASSIFICATION: Map<String, Tensor> = mapOf(
    VISION_CLASSIFIER_OUTPUT to Tensor(listOf(1, 1000), DoubleArray(1000) { if (it == 281) 0.7 else if (it == 282) 0.2 else 0.0001 }),
)

/** One cat (class 16 of the 0-based TFLite numbering) at [0.1, 0.2, 0.9, 0.8] (yxyx, normalized), score 0.9, count 1. */
internal val FAKE_DETECTION: Map<String, Tensor> = mapOf(
    "boxes" to Tensor(listOf(1, 10, 4), DoubleArray(40).also { it[0] = 0.1; it[1] = 0.2; it[2] = 0.9; it[3] = 0.8 }),
    "classes" to Tensor(listOf(1, 10), DoubleArray(10).also { it[0] = 16.0 }),
    "scores" to Tensor(listOf(1, 10), DoubleArray(10).also { it[0] = 0.9 }),
    "count" to Tensor(listOf(1), doubleArrayOf(1.0)),
)

/** The model files of the two TFLite cards of `models.json`. */
internal val TFLITE_FILES = setOf("efficientnet_lite0.tflite", "lite-model_ssd_mobilenet_v1_1_metadata_2.tflite")
