package es.sebas1705.ilabs.providers

/*
 * A small strict JSON reader for the gateway client.
 *
 * kotlinx.serialization's `Json` cannot be made strict enough for the gateway contract: it does not keep the
 * literal text of a number (integers are decided from the exact decimal text, never through a double or a
 * Long), it accepts or rejects whitespace, comments, trailing commas and unquoted literals depending on
 * lenient flags, and a stray byte order mark or no-break space is not something it lets us pin. This reader
 * works over the raw text, follows RFC 8259 exactly and keeps every number as its literal text.
 */

/** A parsed JSON value. Numbers keep their literal text. */
internal sealed interface JsonNode {
    data object Null : JsonNode
    data class Bool(val value: Boolean) : JsonNode
    data class Num(val literal: String) : JsonNode
    data class Str(val value: String) : JsonNode
    data class Arr(val items: List<JsonNode>) : JsonNode
    data class Obj(val members: Map<String, JsonNode>) : JsonNode
}

private class JsonSyntaxException : Exception("not JSON")

private sealed interface Frame
private class ArrFrame(val items: ArrayList<JsonNode> = ArrayList()) : Frame
private class ObjFrame(val members: LinkedHashMap<String, JsonNode> = LinkedHashMap(), var key: String = "") : Frame

/**
 * Parses [text] as exactly one JSON value (RFC 8259), strictly: only space, tab, LF and CR are whitespace
 * (no trimming of anything else, a byte order mark included), no comments, no trailing commas, no single
 * quotes, no `NaN`, no leading zeros, no raw control characters in strings. A repeated key keeps its last
 * value. Returns `null` when [text] is not JSON. Nesting is not recursive, so no input can overflow the stack.
 */
internal fun parseStrictJson(text: String): JsonNode? =
    try {
        StrictReader(text).parseDocument()
    } catch (_: JsonSyntaxException) {
        null
    }

private class StrictReader(private val s: String) {
    private var i = 0

    private fun fail(): Nothing = throw JsonSyntaxException()

    private fun skipWhitespace() {
        while (i < s.length) {
            val c = s[i]
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') i++ else return
        }
    }

    fun parseDocument(): JsonNode {
        val value = parseValue()
        skipWhitespace()
        if (i != s.length) fail()
        return value
    }

    private fun parseValue(): JsonNode {
        val stack = ArrayList<Frame>()
        while (true) {
            // A value starts here.
            skipWhitespace()
            if (i >= s.length) fail()
            var done: JsonNode? = null
            val c = s[i]
            when {
                c == '{' -> {
                    i++
                    skipWhitespace()
                    if (i < s.length && s[i] == '}') {
                        i++
                        done = JsonNode.Obj(emptyMap())
                    } else {
                        val frame = ObjFrame()
                        frame.key = readKey()
                        stack.add(frame)
                    }
                }
                c == '[' -> {
                    i++
                    skipWhitespace()
                    if (i < s.length && s[i] == ']') {
                        i++
                        done = JsonNode.Arr(emptyList())
                    } else {
                        stack.add(ArrFrame())
                    }
                }
                c == '"' -> done = JsonNode.Str(readString())
                c == 't' -> { expectWord("true"); done = JsonNode.Bool(true) }
                c == 'f' -> { expectWord("false"); done = JsonNode.Bool(false) }
                c == 'n' -> { expectWord("null"); done = JsonNode.Null }
                c == '-' || c in '0'..'9' -> done = JsonNode.Num(readNumber())
                else -> fail()
            }
            // A container was opened: its first element comes next.
            var value: JsonNode = done ?: continue

            // A value is complete: attach it to its parents and close the containers that end here.
            while (true) {
                if (stack.isEmpty()) return value
                val top = stack[stack.lastIndex]
                when (top) {
                    is ArrFrame -> top.items.add(value)
                    is ObjFrame -> top.members[top.key] = value
                }
                skipWhitespace()
                if (i >= s.length) fail()
                val next = s[i]
                if (next == ',') {
                    i++
                    if (top is ObjFrame) top.key = readKey()
                    break
                }
                val closer = if (top is ArrFrame) ']' else '}'
                if (next != closer) fail()
                i++
                stack.removeAt(stack.lastIndex)
                value = when (top) {
                    is ArrFrame -> JsonNode.Arr(top.items)
                    is ObjFrame -> JsonNode.Obj(top.members)
                }
            }
        }
    }

    private fun readKey(): String {
        skipWhitespace()
        if (i >= s.length || s[i] != '"') fail()
        val key = readString()
        skipWhitespace()
        if (i >= s.length || s[i] != ':') fail()
        i++
        return key
    }

    private fun expectWord(word: String) {
        if (!s.startsWith(word, i)) fail()
        i += word.length
    }

    private fun readString(): String {
        i++ // opening quote
        var sb: StringBuilder? = null
        var start = i
        while (true) {
            if (i >= s.length) fail()
            val c = s[i]
            when {
                c == '"' -> {
                    val result = if (sb == null) s.substring(start, i) else sb.append(s.substring(start, i)).toString()
                    i++
                    return result
                }
                c < ' ' -> fail()
                c == '\\' -> {
                    val out = sb ?: StringBuilder().also { sb = it }
                    out.append(s.substring(start, i))
                    i++
                    if (i >= s.length) fail()
                    when (s[i]) {
                        '"' -> out.append('"')
                        '\\' -> out.append('\\')
                        '/' -> out.append('/')
                        'b' -> out.append('\b')
                        'f' -> out.append('\u000C')
                        'n' -> out.append('\n')
                        'r' -> out.append('\r')
                        't' -> out.append('\t')
                        'u' -> {
                            if (i + 4 >= s.length) fail()
                            var code = 0
                            for (k in 1..4) {
                                val h = hexValue(s[i + k])
                                if (h < 0) fail()
                                code = code * 16 + h
                            }
                            out.append(code.toChar())
                            i += 4
                        }
                        else -> fail()
                    }
                    i++
                    start = i
                }
                else -> i++
            }
        }
    }

    private fun hexValue(c: Char): Int = when (c) {
        in '0'..'9' -> c - '0'
        in 'a'..'f' -> c - 'a' + 10
        in 'A'..'F' -> c - 'A' + 10
        else -> -1
    }

    private fun readNumber(): String {
        val start = i
        if (s[i] == '-') i++
        if (i >= s.length) fail()
        if (s[i] == '0') {
            i++
        } else if (s[i] in '1'..'9') {
            while (i < s.length && s[i] in '0'..'9') i++
        } else {
            fail()
        }
        if (i < s.length && s[i] == '.') {
            i++
            val digitsStart = i
            while (i < s.length && s[i] in '0'..'9') i++
            if (i == digitsStart) fail()
        }
        if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
            i++
            if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
            val digitsStart = i
            while (i < s.length && s[i] in '0'..'9') i++
            if (i == digitsStart) fail()
        }
        return s.substring(start, i)
    }
}

/** Appends [value] as a JSON string literal the way `JSON.stringify` writes it (lone surrogates are escaped). */
internal fun StringBuilder.appendJsonString(value: String) {
    append('"')
    var k = 0
    while (k < value.length) {
        val c = value[k]
        when {
            c == '"' -> append("\\\"")
            c == '\\' -> append("\\\\")
            c == '\b' -> append("\\b")
            c == '\u000C' -> append("\\f")
            c == '\n' -> append("\\n")
            c == '\r' -> append("\\r")
            c == '\t' -> append("\\t")
            c < ' ' -> appendEscapedUnit(c)
            c.isHighSurrogate() && k + 1 < value.length && value[k + 1].isLowSurrogate() -> {
                append(c)
                append(value[k + 1])
                k++
            }
            c.isSurrogate() -> appendEscapedUnit(c)
            else -> append(c)
        }
        k++
    }
    append('"')
}

private fun StringBuilder.appendEscapedUnit(c: Char) {
    val hex = "0123456789abcdef"
    val code = c.code
    append("\\u")
    append(hex[(code shr 12) and 0xF])
    append(hex[(code shr 8) and 0xF])
    append(hex[(code shr 4) and 0xF])
    append(hex[code and 0xF])
}

/** The compact JSON text of this value (numbers keep their literal text). */
internal fun JsonNode.toJsonText(): String = buildString { appendJsonNode(this@toJsonText) }

private fun StringBuilder.appendJsonNode(node: JsonNode) {
    when (node) {
        JsonNode.Null -> append("null")
        is JsonNode.Bool -> append(if (node.value) "true" else "false")
        is JsonNode.Num -> append(node.literal)
        is JsonNode.Str -> appendJsonString(node.value)
        is JsonNode.Arr -> {
            append('[')
            node.items.forEachIndexed { index, item ->
                if (index > 0) append(',')
                appendJsonNode(item)
            }
            append(']')
        }
        is JsonNode.Obj -> {
            append('{')
            var first = true
            for ((key, item) in node.members) {
                if (!first) append(',')
                first = false
                appendJsonString(key)
                append(':')
                appendJsonNode(item)
            }
            append('}')
        }
    }
}

/**
 * Reads the JSON number [literal] (valid JSON number text) as an exact decimal and returns it capped at
 * [cap], or `null` when it is not an integer `>= 0`. No floating-point or fixed-width integer is used to
 * decide: `1500.0`, `1.5e3`, `1E3` and `-0` are integers, `1500.5`, `1500.0000000000000001` and `1e-400` are
 * not, and an integer of any size (`1e400`, 23 digits) is above the cap. A non-zero negative integer is
 * `null` as well.
 */
internal fun cappedNonNegativeInteger(literal: String, cap: Long): Long? {
    var p = 0
    val negative = literal.startsWith("-")
    if (negative) p++
    var intEnd = p
    while (intEnd < literal.length && literal[intEnd] in '0'..'9') intEnd++
    val intPart = literal.substring(p, intEnd)
    var q = intEnd
    var frac = ""
    if (q < literal.length && literal[q] == '.') {
        var e = q + 1
        while (e < literal.length && literal[e] in '0'..'9') e++
        frac = literal.substring(q + 1, e)
        q = e
    }
    var exponentNegative = false
    var exponentDigits = ""
    if (q < literal.length && (literal[q] == 'e' || literal[q] == 'E')) {
        q++
        if (q < literal.length && (literal[q] == '+' || literal[q] == '-')) {
            exponentNegative = literal[q] == '-'
            q++
        }
        exponentDigits = literal.substring(q)
    }

    val all = intPart + frac
    val firstNonZero = all.indexOfFirst { it != '0' }
    if (firstNonZero < 0) return 0L // zero, `-0` included, whatever the exponent
    if (negative) return null
    val lastNonZero = all.indexOfLast { it != '0' }
    val significantDigits = lastNonZero - firstNonZero + 1
    val trailingZeros = all.length - 1 - lastNonZero

    // The exponent is read as text: a literal may carry thousands of digits and must cost nothing.
    val exponentTrimmed = exponentDigits.trimStart('0')
    if (exponentTrimmed.length > 12) return if (exponentNegative) null else cap
    val exponent = if (exponentTrimmed.isEmpty()) 0L else exponentTrimmed.toLong()
    val exp10 = (if (exponentNegative) -exponent else exponent) - frac.length + trailingZeros
    if (exp10 < 0) return null // the last significant digit is non-zero: a fractional part remains
    if (significantDigits + exp10 > cap.toString().length) return cap
    var value = all.substring(firstNonZero, lastNonZero + 1).toLong()
    repeat(exp10.toInt()) { value *= 10 }
    return minOf(value, cap)
}

/**
 * Reads a `retry-after` header [value] (exactly `^[0-9]+$`, ASCII digits only) as seconds and returns
 * `seconds * 1000` computed exactly, capped at [cap]; `null` when the value is not of that form.
 */
internal fun cappedSecondsHeaderToMs(value: String, cap: Long): Long? {
    if (value.isEmpty() || value.any { it !in '0'..'9' }) return null
    val seconds = value.trimStart('0')
    if (seconds.isEmpty()) return 0L
    if (seconds.length > cap.toString().length) return cap
    return minOf(seconds.toLong() * 1000, cap)
}
