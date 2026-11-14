package es.sebas1705.ilabs.rag

/** The kinds of [RagException], with their contract wire names. */
enum class RagErrorKind(val wire: String) {
    INVALID_OPTIONS("invalid_options"),
    NO_EMBEDDER("no_embedder"),
    INVALID_EMBEDDING("invalid_embedding"),
    BUDGET_TOO_SMALL("budget_too_small"),
}

/** Failure of a `rag` operation. [required] is the cost of the smallest message for `budget_too_small` only, else null. */
class RagException(val kind: RagErrorKind, val required: Int? = null) :
    Exception(if (required == null) kind.wire else "${kind.wire} (required $required)")

internal fun invalidOptions(): Nothing = throw RagException(RagErrorKind.INVALID_OPTIONS)

// Library parse functions for option values a typed API cannot represent. The fixture harness converts JSON values
// through them, so these cases surface as the library's `invalid_options`. `null` stands for a JSON `null` given as
// the value of an option (an ABSENT option never reaches these functions: the caller applies the default).

/**
 * Converts a JSON number to an `Int` by VALUE (`2.0` and `1e2` are integers, `2.5` is not); `null` (JSON `null`), a
 * non-integer and values outside the `Int` range (out of the contract's scope) are `invalid_options`.
 */
internal fun parseIntOption(value: Double?): Int {
    if (value == null || value.isNaN() || value.isInfinite() || value % 1.0 != 0.0) invalidOptions()
    if (value < Int.MIN_VALUE.toDouble() || value > Int.MAX_VALUE.toDouble()) invalidOptions()
    return value.toInt()
}

/** Parses a mode wire name (`bm25`, `dense`, `hybrid`, exact); anything else, `null` included, is `invalid_options`. */
internal fun parseMode(wire: String?): Mode = Mode.entries.firstOrNull { it.wire == wire } ?: invalidOptions()

/**
 * Builds a [Chunking] from its wire `type` and its JSON numbers (judged by value): an unknown type, and a `null` or
 * non-integer number, are `invalid_options`. A `type` that is not a string (`null` included) never reaches this
 * function: the harness reports it as a malformed fixture.
 */
internal fun parseChunking(type: String, size: Double?, overlap: Double?, maxSize: Double?): Chunking = when (type) {
    "fixed" -> Chunking.Fixed(parseIntOption(size), parseIntOption(overlap))
    "paragraph" -> Chunking.Paragraph(parseIntOption(maxSize))
    else -> invalidOptions()
}

/** Parses a metrics level wire name (`chunk`, `doc`, exact); anything else, `null` included, is `invalid_options`. */
internal fun parseLevel(wire: String?): Level = Level.entries.firstOrNull { it.wire == wire } ?: invalidOptions()
