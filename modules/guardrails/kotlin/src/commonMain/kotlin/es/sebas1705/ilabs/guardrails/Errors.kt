package es.sebas1705.ilabs.guardrails

/** The kinds of [GuardrailException], with their contract wire names. */
enum class GuardrailErrorKind(val wire: String) {
    INVALID_POLICY("invalid_policy"),
    INVALID_OPTIONS("invalid_options"),
    NO_CLASSIFIER("no_classifier"),
}

/** Failure of a `guardrails` operation. A policy failure message starts with `invalid policy: `. */
class GuardrailException(val kind: GuardrailErrorKind, message: String? = null) : Exception(message ?: kind.wire)

internal fun invalidOptions(reason: String): Nothing =
    throw GuardrailException(GuardrailErrorKind.INVALID_OPTIONS, "invalid options: $reason")

internal fun invalidPolicy(reason: String): Nothing =
    throw GuardrailException(GuardrailErrorKind.INVALID_POLICY, "invalid policy: $reason")
