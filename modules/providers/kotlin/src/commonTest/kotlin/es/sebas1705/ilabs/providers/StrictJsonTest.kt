package es.sebas1705.ilabs.providers

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class StrictJsonTest {
    private fun obj(text: String): Map<String, JsonNode> = (parseStrictJson(text) as JsonNode.Obj).members

    @Test
    fun acceptsEveryJsonValueAndTheFourWhitespaceCharacters() {
        assertEquals(JsonNode.Null, parseStrictJson("null"))
        assertEquals(JsonNode.Bool(true), parseStrictJson("true"))
        assertEquals(JsonNode.Bool(false), parseStrictJson("false"))
        assertEquals(JsonNode.Str("a"), parseStrictJson("\"a\""))
        assertEquals(JsonNode.Num("-1.5E+3"), parseStrictJson("-1.5E+3"))
        assertEquals(JsonNode.Arr(emptyList()), parseStrictJson("[]"))
        assertEquals(JsonNode.Obj(emptyMap()), parseStrictJson("{}"))
        assertEquals(JsonNode.Arr(listOf(JsonNode.Num("1"), JsonNode.Null)), parseStrictJson(" \t\r\n[ 1 ,\n null ] \r\n"))
        assertEquals(mapOf("a" to JsonNode.Num("1")), obj(" { \"a\" : 1 } "))
    }

    @Test
    fun rejectsEverythingThatIsNotJson() {
        val bad = listOf(
            "", " ", "{", "[", "{\"a\":1", "[1,2", "{\"a\":1}x", "{} {}", "[1,]", "{\"a\":1,}", "[,1]", "{,}", "{\"a\"}", "{\"a\":}",
            "{a:1}", "{'a':1}", "'a'", "NaN", "Infinity", "-Infinity", "undefined", "+1", "01", "-01", "1.", ".5", "1e", "1e+", "0x10", "--1", "- 1",
            "// c\n1", "/* c */1", "{/* c */}", "[1 /* c */]", "tru", "nul", "True", "NULL", "\"a", "\"a\nb\"", "\"a\tb\"", "\"\u0000\"", "\"\\x\"", "\"\\u12\"",
            "\"\\u12G4\"", "\"\\\"", "\u00A01", "1\u00A0", "\u000C1", "1\u000B", "\u3000{}", "\uFEFF{}", "{}\uFEFF", "[1 2]", "[1;2]", "{\"a\" 1}", "{\"a\":1 \"b\":2}",
        )
        for (text in bad) assertNull(parseStrictJson(text), "must not parse: <${text.replace("\n", "\\n")}>")
    }

    @Test
    fun repeatedKeysKeepTheLastValue() {
        assertEquals(JsonNode.Num("2"), obj("{\"a\":1,\"a\":2}")["a"])
        assertEquals(JsonNode.Arr(emptyList()), obj("{\"a\":1,\"b\":2,\"a\":[]}")["a"])
    }

    @Test
    fun protoIsAnOrdinaryKey() {
        assertEquals(JsonNode.Num("1"), obj("{\"__proto__\":1}")["__proto__"])
    }

    @Test
    fun decodesEscapes() {
        assertEquals(JsonNode.Str("\"\\/\b\u000C\n\r\tA\u00E9\uD83D\uDE00"), parseStrictJson("\"\\\"\\\\\\/\\b\\f\\n\\r\\t\\u0041\\u00e9\\uD83D\\ude00\""))
        // A lone surrogate escape is kept as it is.
        assertEquals(JsonNode.Str("\uD800"), parseStrictJson("\"\\ud800\""))
        // Raw non-ASCII text is fine.
        assertEquals(JsonNode.Str("\u00A0\u3000\uFEFF"), parseStrictJson("\"\u00A0\u3000\uFEFF\""))
    }

    @Test
    fun everyRawControlCharacterInAStringIsRejected() {
        for (code in 0..0x1F) {
            val raw = code.toChar()
            assertNull(parseStrictJson("\"a${raw}b\""), "raw U+${code.toString(16).padStart(4, '0')} must not parse")
            assertNull(parseStrictJson("{\"a${raw}\":1}"), "raw U+${code.toString(16).padStart(4, '0')} in a key must not parse")
        }
        // The first character allowed raw is the space; DEL and U+2028 are allowed too.
        assertEquals(JsonNode.Str(" \u007F\u2028"), parseStrictJson("\" \u007F\u2028\""))
    }

    @Test
    fun aUnicodeEscapeThatRunsPastTheEndOfTheInputIsRejectedNotACrash() {
        for (text in listOf("\"\\u", "\"\\u1", "\"\\u12", "\"\\u123", "\"\\u1234", "\"\\u12345", "\"\\", "\"\\uD83D\\u")) {
            assertNull(parseStrictJson(text), "must not parse: <$text>")
        }
        assertEquals(JsonNode.Str("\u1234"), parseStrictJson("\"\\u1234\""))
    }

    @Test
    fun deepNestingNeitherOverflowsTheStackNorFails() {
        val depth = 200_000
        val deep = "[".repeat(depth) + "]".repeat(depth)
        assertNotNull(parseStrictJson(deep))
        assertNull(parseStrictJson("[".repeat(depth)))
        assertNull(parseStrictJson("[".repeat(depth) + "]".repeat(depth - 1)))
        val deepObject = "{\"a\":".repeat(depth) + "1" + "}".repeat(depth)
        assertNotNull(parseStrictJson(deepObject))
    }

    @Test
    fun serializesLikeJsonStringify() {
        val text = "q\"b\\s/\b\u000C\n\r\t\u0001\u001F\u007F\u2028\uD83D\uDE00 \uD800 \uDC00x \uD83D"
        val json = buildString { appendJsonString(text) }
        assertEquals("\"q\\\"b\\\\s/\\b\\f\\n\\r\\t\\u0001\\u001f\u007F\u2028\uD83D\uDE00 \\ud800 \\udc00x \\ud83d\"", json)
        assertEquals(JsonNode.Str(text), parseStrictJson(json))
    }

    @Test
    fun compactTextKeepsNumberLiterals() {
        val node = parseStrictJson(" { \"a\" : [ 1.0e5 , -0 , \"x\" , null , true ] , \"b\" : { } } ")!!
        assertEquals("{\"a\":[1.0e5,-0,\"x\",null,true],\"b\":{}}", node.toJsonText())
    }

    private val cap = 3_600_000L

    private fun int(literal: String): Long? = cappedNonNegativeInteger(literal, cap)

    @Test
    fun readsIntegersByExactDecimalValue() {
        assertEquals(1500L, int("1500.0"))
        assertEquals(1500L, int("1.5e3"))
        assertEquals(1000L, int("1E3"))
        assertEquals(256L, int("25.6e1"))
        assertEquals(0L, int("-0"))
        assertEquals(0L, int("-0.0"))
        assertEquals(0L, int("0e999999999999999999999"))
        assertEquals(0L, int("0"))
        assertEquals(7L, int("7"))
        assertEquals(7L, int("0.7e1"))
        assertEquals(100L, int("1e2"))
        assertEquals(1500L, int("15000e-1"))
        assertEquals(1L, int("1.000000000000000000000000e0"))
        assertEquals(1500L, int("1500.0000000000000000"))
    }

    @Test
    fun rejectsNonIntegersAndNegativeValues() {
        assertNull(int("1500.5"))
        assertNull(int("1500.0000000000000001"))
        assertNull(int("1e-400"))
        assertNull(int("5e-1"))
        assertNull(int("0.0000001"))
        assertNull(int("-1"))
        assertNull(int("-1e0"))
        assertNull(int("-1e400"))
        assertNull(int("15e-1"))
        assertNull(int("1e-99999999999999999999999"))
    }

    @Test
    fun capsAfterTheExactComputation() {
        assertEquals(cap, int("3600000"))
        assertEquals(cap, int("3600001"))
        assertEquals(3_599_999L, int("3599999"))
        assertEquals(cap, int("4294967297"))
        assertEquals(cap, int("4294967296"))
        assertEquals(cap, int("2147483648"))
        assertEquals(cap, int("9223372036854775808"))
        assertEquals(cap, int("18446744073709551617"))
        assertEquals(cap, int("12345678901234567890123"))
        assertEquals(cap, int("1e400"))
        assertEquals(cap, int("1e99999999999999999999999"))
        assertEquals(cap, int("1E+400"))
        assertEquals(cap, int("0.1e9999999999999999"))
        assertEquals(9_999_999L.coerceAtMost(cap), int("9999999"))
        assertEquals(3_600_000L, int("36e5"))
        assertEquals(3_599_000L, int("3599e3"))
        // A huge exponent costs nothing.
        assertEquals(cap, int("1e" + "9".repeat(100_000)))
        assertNull(int("1e-" + "9".repeat(100_000)))
        assertEquals(1000L, int("1e0000000000000000000000000000003"))
        // An exponent of 13 to 20 digits is decided from its text: it never reaches a fixed-width integer.
        for (digits in listOf("1000000000000", "9999999999999999", "9223372036854775807", "9223372036854775808", "9999999999999999999", "18446744073709551616")) {
            assertEquals(cap, int("1e$digits"), "1e$digits")
            assertEquals(cap, int("0.1e$digits"), "0.1e$digits")
            assertNull(int("1e-$digits"), "1e-$digits")
            assertEquals(0L, int("0e$digits"), "0e$digits")
        }
        // Twelve digits is still read as a number.
        assertEquals(cap, int("1e999999999999"))
        assertNull(int("1e-999999999999"))
    }

    @Test
    fun readsSecondsHeadersAsExactDigitsOnly() {
        assertEquals(3000L, cappedSecondsHeaderToMs("3", cap))
        assertEquals(3000L, cappedSecondsHeaderToMs("0003", cap))
        assertEquals(0L, cappedSecondsHeaderToMs("0", cap))
        assertEquals(0L, cappedSecondsHeaderToMs("0".repeat(23), cap))
        assertEquals(cap, cappedSecondsHeaderToMs("3600", cap))
        assertEquals(cap, cappedSecondsHeaderToMs("3601", cap))
        assertEquals(3_599_000L, cappedSecondsHeaderToMs("3599", cap))
        assertEquals(cap, cappedSecondsHeaderToMs("4294968", cap))
        assertEquals(cap, cappedSecondsHeaderToMs("9223372036854776", cap))
        assertEquals(cap, cappedSecondsHeaderToMs("9".repeat(40), cap))
        // 13 to 20 digits are above the cap by their length, whatever a Long could hold (Long.MAX_VALUE * 1000 overflows).
        for (digits in listOf("10000000", "9999999999999", "9223372036854775807", "9223372036854775808", "9999999999999999999", "18446744073709551616")) {
            assertEquals(cap, cappedSecondsHeaderToMs(digits, cap), digits)
        }
        assertEquals(1000L, cappedSecondsHeaderToMs("0".repeat(30) + "1", cap))
        for (bad in listOf("", " ", "-1", "+1", "1.5", "1e3", "1 ", " 1", "1\n", "1,2", "0x10", "\u0663", "\uFF11", "Wed, 21 Oct 2026 07:28:00 GMT")) {
            assertNull(cappedSecondsHeaderToMs(bad, cap), "must not be seconds: <$bad>")
        }
    }
}
