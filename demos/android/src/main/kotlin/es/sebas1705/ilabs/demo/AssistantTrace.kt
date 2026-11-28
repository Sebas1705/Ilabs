package es.sebas1705.ilabs.demo

/** The kinds of line the trace under the chat can hold. The text of each is a translated string; the values travel as [TraceEvent.args]. */
enum class TraceKind {
    /** args: messages kept (without the persona), messages dropped, tokens kept, the budget. */
    WINDOW,

    /** args: `off` when redaction is disabled; otherwise pairs of PII kind wire name and count (none when nothing was found). */
    REDACTIONS,

    /** args: the provider label (`gateway` or `mock`), the attempt number on that provider, starting at 1. */
    ATTEMPT,

    /** args: the provider label, the error kind of the failed attempt. */
    FAILURE,

    /** args: the wait in milliseconds, the error kind that caused it. */
    WAIT,

    /** args: the error kind of the backend that failed. */
    FALLBACK,

    /** args: the provider id; and, when the mock answered for a failed gateway, the error kind of the gateway. */
    ANSWERED,

    /** No args: the input policy blocked the message and nothing was sent. */
    BLOCKED,
}

/**
 * One line of the trace. It only holds counts, kinds, ids and numbers: never message text and never the user's key.
 * [encode] and [decode] keep it in the saved state.
 */
data class TraceEvent(val kind: TraceKind, val args: List<String> = emptyList()) {
    fun encode(): String = (listOf(kind.name) + args).joinToString(SEPARATOR.toString())

    companion object {
        private const val SEPARATOR = '\u0001'

        fun decode(text: String): TraceEvent? {
            val parts = text.split(SEPARATOR)
            val kind = TraceKind.entries.firstOrNull { it.name == parts.first() } ?: return null
            return TraceEvent(kind, parts.drop(1))
        }

        /** The most lines kept: the oldest go first (the web twin keeps the same number). */
        const val MAX_EVENTS = 200
    }
}

/** Collects the lines of one turn. Providers and the engine write to it in the order things happen. */
class TraceSink {
    private val events = ArrayList<TraceEvent>()

    fun add(kind: TraceKind, vararg args: String) {
        events += TraceEvent(kind, args.toList())
    }

    fun events(): List<TraceEvent> = events.toList()
}
