package es.sebas1705.ilabs.vision

import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

internal const val INPUT_JSON =
    """{"width":2,"height":2,"layout":"nhwc","channels":"rgb","mode":"stretch","resample":"nearest","dtype":"float"}"""

internal fun specJson(input: String = INPUT_JSON, output: String = """{"type":"logits"}""", rest: String = ""): String =
    """{"input":$input,"output":$output$rest}"""

internal fun spec(input: String = INPUT_JSON, output: String = """{"type":"logits"}""", rest: String = ""): ModelSpec =
    parseModelSpec(specJson(input, output, rest))

internal const val INPUT_20_JSON =
    """{"width":20,"height":20,"layout":"nhwc","channels":"rgb","mode":"stretch","resample":"nearest","dtype":"float"}"""

internal fun detectorSpec(output: String = """{"format":"ssd","boxOrder":"xyxy","coordinates":"pixels"}""", input: String = INPUT_20_JSON, rest: String = ""): ModelSpec =
    spec(input, output, rest)

/** An image from unsigned byte values (given as Ints so that 200 and 255 can be written). */
internal fun img(width: Int, height: Int, vararg bytes: Int): Image =
    Image(width, height, ByteArray(bytes.size) { bytes[it].toByte() })

internal fun unsigned(image: Image): List<Int> = image.data.map { it.toInt() and 0xFF }

internal fun tensor(shape: List<Int>, vararg data: Double): Tensor = Tensor(shape, data)

internal fun assertKind(kind: VisionErrorKind, block: () -> Unit): VisionException {
    val e = assertFailsWith<VisionException> { block() }
    assertEquals(kind, e.kind)
    return e
}

internal suspend fun assertKindSuspending(kind: VisionErrorKind, block: suspend () -> Unit): VisionException {
    val e = try {
        block()
        null
    } catch (e: VisionException) {
        e
    }
    assertTrue(e != null, "expected a VisionException of kind $kind")
    assertEquals(kind, e.kind)
    return e
}

internal fun assertClose(expected: Double, actual: Double, message: String = "") {
    assertTrue(expected == actual || kotlin.math.abs(expected - actual) <= 1e-9, "$message expected <$expected> but was <$actual>")
}

/** A clock that returns the given values in order and counts its reads. */
internal class CountingClock(private vararg val values: Double) : Clock {
    var reads = 0
        private set

    override fun nowMs(): Double = values[reads++]
}
