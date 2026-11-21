package es.sebas1705.ilabs.vision

/** The kinds of [VisionException], with their contract wire names. */
enum class VisionErrorKind(val wire: String) {
    INVALID_SPEC("invalid_spec"),
    INVALID_OPTIONS("invalid_options"),
    INVALID_OUTPUT("invalid_output"),
}

/** Failure of a `vision` operation. A spec failure message starts with `invalid model spec: `. */
class VisionException(val kind: VisionErrorKind, message: String? = null) : Exception(message ?: kind.wire)

internal fun invalidOptions(reason: String): Nothing =
    throw VisionException(VisionErrorKind.INVALID_OPTIONS, "invalid options: $reason")

internal fun invalidOutput(reason: String): Nothing =
    throw VisionException(VisionErrorKind.INVALID_OUTPUT, "invalid output: $reason")

internal fun invalidSpec(reason: String): Nothing =
    throw VisionException(VisionErrorKind.INVALID_SPEC, "invalid model spec: $reason")

/** Whether a double is neither NaN nor infinite. */
internal fun isFinite(v: Double): Boolean = !v.isNaN() && !v.isInfinite()
