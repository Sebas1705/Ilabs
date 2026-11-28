package es.sebas1705.ilabs.providers

import kotlinx.coroutines.test.runTest
import kotlin.coroutines.cancellation.CancellationException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/** The unit cases of the client half of contracts/gateway (the ones a fixture cannot express). */
class HttpProviderTest {
    private val request = CompletionRequest(listOf(Message(Role.USER, "hello")))

    private class Recorder(private val reply: suspend (HttpRequest) -> HttpResponse) : HttpTransport {
        val requests = mutableListOf<HttpRequest>()
        override suspend fun send(req: HttpRequest): HttpResponse {
            requests += req
            return reply(req)
        }
    }

    private fun ok(body: String = "{\"text\":\"Hi\"}") = Recorder { HttpResponse(200, emptyMap(), body) }

    private fun provider(
        transport: HttpTransport,
        endpoint: String = "https://gw.example.test",
        id: String = "gateway",
        apiKey: String? = null,
        timeoutMs: Long = 25_000,
    ) = HttpProvider(id, endpoint, transport, apiKey, timeoutMs)

    private suspend fun failure(p: Provider, req: CompletionRequest = request): ProviderException =
        assertFailsWith<ProviderException> { p.complete(req) }

    @Test
    fun theDefaultsAreTheGatewayIdAndTwentyFiveSeconds() = runTest {
        val transport = ok()
        val p = HttpProvider(endpoint = "https://gw.example.test", transport = transport)
        assertEquals("gateway", p.id)
        assertEquals(CompletionResponse("Hi", "gateway"), p.complete(request))
        assertEquals(25_000L, transport.requests.single().timeoutMs)
    }

    @Test
    fun theTextOfARequestNeverShowsTheKeyNorTheBody() = runTest {
        val transport = ok()
        provider(transport, apiKey = "USER-KEY-9f3a").complete(CompletionRequest(listOf(Message(Role.USER, "private words"))))
        val req = transport.requests.single()
        assertEquals("USER-KEY-9f3a", req.headers["x-ilabs-api-key"])
        val text = req.toString()
        assertTrue("USER-KEY-9f3a" !in text, text)
        assertTrue("private words" !in text, text)
        assertTrue("x-ilabs-api-key" in text, text)
        assertTrue("https://gw.example.test/v1/complete" in text, text)
    }

    @Test
    fun rejectsBadOptionsAtConstruction() {
        val t = ok()
        assertFailsWith<IllegalArgumentException> { provider(t, endpoint = "") }
        assertFailsWith<IllegalArgumentException> { provider(t, endpoint = "/") }
        assertFailsWith<IllegalArgumentException> { provider(t, endpoint = "///") }
        assertFailsWith<IllegalArgumentException> { provider(t, timeoutMs = 0) }
        assertFailsWith<IllegalArgumentException> { provider(t, timeoutMs = -1) }
        assertFailsWith<IllegalArgumentException> { provider(t, id = "") }
        provider(t, timeoutMs = 1)
    }

    @Test
    fun buildsTheUrlFromTheEndpointWithoutItsTrailingSlashes() = runTest {
        for ((endpoint, url) in listOf(
            "https://gw.example.test" to "https://gw.example.test/v1/complete",
            "https://gw.example.test/" to "https://gw.example.test/v1/complete",
            "https://gw.example.test///" to "https://gw.example.test/v1/complete",
            "https://gw.example.test/api/" to "https://gw.example.test/api/v1/complete",
            "https://gw.example.test//api" to "https://gw.example.test//api/v1/complete",
        )) {
            val t = ok()
            provider(t, endpoint = endpoint).complete(request)
            assertEquals(url, t.requests.single().url)
        }
    }

    @Test
    fun sendsExactlyTheContentTypeAndTheKeyWhenItHasAVisibleCharacter() = runTest {
        for ((key, expected) in listOf<Pair<String?, Map<String, String>>>(
            null to mapOf("content-type" to "application/json"),
            "" to mapOf("content-type" to "application/json"),
            " " to mapOf("content-type" to "application/json"),
            " \t\r\n " to mapOf("content-type" to "application/json"),
            "k" to mapOf("content-type" to "application/json", "x-ilabs-api-key" to "k"),
            " k " to mapOf("content-type" to "application/json", "x-ilabs-api-key" to " k "),
            "\u00A0" to mapOf("content-type" to "application/json", "x-ilabs-api-key" to "\u00A0"),
            "\u000B" to mapOf("content-type" to "application/json", "x-ilabs-api-key" to "\u000B"),
        )) {
            val t = ok()
            provider(t, apiKey = key).complete(request)
            assertEquals(expected, t.requests.single().headers, "apiKey <$key>")
        }
    }

    @Test
    fun theBodyHasTheMessagesAndOnlyAGivenMaxTokens() = runTest {
        val t = ok()
        val p = provider(t, apiKey = "FIXTURE_USER_KEY")
        p.complete(CompletionRequest(listOf(Message(Role.SYSTEM, "s\"\n"), Message(Role.ASSISTANT, "\uD83D\uDE00\u00E9"), Message(Role.USER, "u"))))
        p.complete(CompletionRequest(listOf(Message(Role.USER, "x")), maxTokens = -3))
        p.complete(CompletionRequest(listOf(Message(Role.USER, "x")), maxTokens = 5000))
        p.complete(CompletionRequest(emptyList()))
        p.complete(CompletionRequest(listOf(Message(Role.USER, ""))))
        assertEquals(
            listOf(
                "{\"messages\":[{\"role\":\"system\",\"content\":\"s\\\"\\n\"},{\"role\":\"assistant\",\"content\":\"\uD83D\uDE00\u00E9\"},{\"role\":\"user\",\"content\":\"u\"}]}",
                "{\"messages\":[{\"role\":\"user\",\"content\":\"x\"}],\"maxTokens\":-3}",
                "{\"messages\":[{\"role\":\"user\",\"content\":\"x\"}],\"maxTokens\":5000}",
                "{\"messages\":[]}",
                "{\"messages\":[{\"role\":\"user\",\"content\":\"\"}]}",
            ),
            t.requests.map { it.body },
        )
        assertTrue(t.requests.none { "FIXTURE_USER_KEY" in it.body })
    }

    @Test
    fun theTimeoutIsPassedThroughUnchanged() = runTest {
        for (timeout in listOf(1L, 25_000L, 40_000L, Long.MAX_VALUE)) {
            val t = ok()
            provider(t, timeoutMs = timeout).complete(request)
            assertEquals(timeout, t.requests.single().timeoutMs)
        }
    }

    @Test
    fun makesExactlyOneTransportCallAndNeverMutatesTheRequest() = runTest {
        val messages = mutableListOf(Message(Role.USER, "hello"))
        val req = CompletionRequest(messages, 10)
        val t = Recorder { HttpResponse(503, emptyMap(), "") }
        failure(provider(t), req)
        assertEquals(1, t.requests.size)
        assertEquals(listOf(Message(Role.USER, "hello")), messages)
        assertEquals(CompletionRequest(listOf(Message(Role.USER, "hello")), 10), req)
    }

    @Test
    fun aTimeoutExceptionIsTimeoutAndNothingElseIs() = runTest {
        val timeout = failure(provider(Recorder { throw TransportTimeoutException() }))
        assertEquals(ErrorKind.TIMEOUT, timeout.kind)
        assertNull(timeout.retryAfterMs)

        class Slow : Exception()
        for (e in listOf(RuntimeException("timeout"), IllegalStateException("timed out"), Exception("fetch failed: connect timeout"), Slow(), IllegalArgumentException())) {
            val error = failure(provider(Recorder { throw e }))
            assertEquals(ErrorKind.UNAVAILABLE, error.kind, "for ${e::class.simpleName}: ${e.message}")
            assertNull(error.retryAfterMs)
        }
    }

    @Test
    fun cancellationPropagatesUnchangedAndIsNeverMapped() = runTest {
        val cancellation = CancellationException("cancelled")
        val thrown = assertFailsWith<CancellationException> { provider(Recorder { throw cancellation }).complete(request) }
        assertSame(cancellation, thrown)
    }

    @Test
    fun errorsThatAreNotExceptionsPropagate() = runTest {
        class Fatal : Error()
        val error = Fatal()
        val thrown = assertFailsWith<Fatal> { provider(Recorder { throw error }).complete(request) }
        assertSame(error, thrown)
    }

    @Test
    fun onlyAStatusOf200IsASuccess() = runTest {
        for (status in listOf(0, 100, 199, 201, 202, 204, 206, 301, 302, 400, 500)) {
            val error = failure(provider(Recorder { HttpResponse(status, emptyMap(), "{\"text\":\"Hi\"}") }))
            assertEquals(ErrorKind.UNAVAILABLE, error.kind, "status $status")
        }
    }

    @Test
    fun theResultKeepsTextVerbatimAndTakesTheProviderFromTheBodyOnlyWhenUsable() = runTest {
        val cases = listOf(
            "{\"text\":\"\"}" to CompletionResponse("", "gw"),
            "{\"text\":\" \\n \",\"provider\":\"p\"}" to CompletionResponse(" \n ", "p"),
            "{\"text\":\"a\",\"provider\":\" p \"}" to CompletionResponse("a", " p "),
            "{\"text\":\"a\",\"provider\":\"\u00A0\"}" to CompletionResponse("a", "\u00A0"),
            "{\"text\":\"a\",\"provider\":\"\"}" to CompletionResponse("a", "gw"),
            "{\"text\":\"a\",\"provider\":\" \\t\\r\\n\"}" to CompletionResponse("a", "gw"),
            "{\"text\":\"a\",\"provider\":null}" to CompletionResponse("a", "gw"),
            "{\"text\":\"a\",\"provider\":1}" to CompletionResponse("a", "gw"),
            "{\"text\":\"a\",\"provider\":[\"p\"]}" to CompletionResponse("a", "gw"),
            "{\"text\":\"a\",\"provider\":{\"x\":1}}" to CompletionResponse("a", "gw"),
            "{\"text\":\"a\",\"text\":\"b\"}" to CompletionResponse("b", "gw"),
            "{\"text\":\"a\",\"error\":{\"kind\":\"rate_limit\"},\"x\":[1]}" to CompletionResponse("a", "gw"),
        )
        for ((body, expected) in cases) {
            assertEquals(expected, provider(ok(body), id = "gw").complete(request), body)
        }
        for (body in listOf("", "null", "[]", "\"a\"", "1", "{}", "{\"text\":null}", "{\"text\":1}", "{\"text\":[]}", "{\"error\":{\"kind\":\"rate_limit\"}}", "{\"text\":\"a\",}", "\uFEFF{\"text\":\"a\"}", "{\"text\":\"a\"} x")) {
            assertEquals(ErrorKind.INVALID_OUTPUT, failure(provider(ok(body))).kind, "body <$body>")
        }
    }

    private suspend fun errorFor(status: Int, body: String, headers: Map<String, String> = emptyMap()): ProviderException =
        failure(provider(Recorder { HttpResponse(status, headers, body) }))

    @Test
    fun theKindComesFromTheBodyWhateverTheStatus() = runTest {
        for (kind in ErrorKind.entries) {
            for (status in listOf(400, 429, 500, 502, 504)) {
                assertEquals(kind, errorFor(status, "{\"error\":{\"kind\":\"${kind.wire}\"}}").kind)
            }
        }
        for (body in listOf("", "null", "[]", "{}", "\"x\"", "7", "{\"kind\":\"rate_limit\"}", "{\"error\":\"rate_limit\"}", "{\"error\":null}", "{\"error\":[{\"kind\":\"rate_limit\"}]}", "{\"error\":{}}", "{\"error\":{\"kind\":\"Rate_Limit\"}}", "{\"error\":{\"kind\":\"RATE_LIMIT\"}}", "{\"error\":{\"kind\":\"rate_limit \"}}", "{\"error\":{\"kind\":1}}", "{\"error\":{\"kind\":null}}", "{\"error\":{\"kind\":\"nope\"}}", "{\"error\":{\"kind\":\"rate_limit\",}}", "\uFEFF{\"error\":{\"kind\":\"rate_limit\"}}")) {
            val error = errorFor(500, body, mapOf("retry-after" to "3"))
            assertEquals(ErrorKind.UNAVAILABLE, error.kind, "body <$body>")
            assertNull(error.retryAfterMs)
        }
    }

    @Test
    fun retryAfterIsOnlyForRateLimit() = runTest {
        for (kind in listOf("timeout", "invalid_output", "unavailable")) {
            val error = errorFor(500, "{\"error\":{\"kind\":\"$kind\",\"retryAfterMs\":5}}", mapOf("retry-after" to "3"))
            assertNull(error.retryAfterMs, kind)
        }
        assertEquals(5L, errorFor(429, "{\"error\":{\"kind\":\"rate_limit\",\"retryAfterMs\":5}}", mapOf("retry-after" to "3")).retryAfterMs)
        assertEquals(3000L, errorFor(503, "{\"error\":{\"kind\":\"rate_limit\"}}", mapOf("retry-after" to "3")).retryAfterMs)
        assertEquals(0L, errorFor(429, "{\"error\":{\"kind\":\"rate_limit\",\"retryAfterMs\":0}}", mapOf("retry-after" to "3")).retryAfterMs)
        assertEquals(0L, errorFor(429, "{\"error\":{\"kind\":\"rate_limit\"}}", mapOf("retry-after" to "0")).retryAfterMs)
    }

    @Test
    fun theRetryAfterHeaderNameIsMatchedByAsciiCaseOnly() = runTest {
        val body = "{\"error\":{\"kind\":\"rate_limit\"}}"
        assertEquals(3000L, errorFor(429, body, mapOf("RETRY-AFTER" to "3")).retryAfterMs)
        assertEquals(3000L, errorFor(429, body, mapOf("Retry-After" to "3")).retryAfterMs)
        // A dotless i, a long s or a Kelvin sign would match under Unicode case folding; none is a `retry-after`.
        assertNull(errorFor(429, body, mapOf("retry-aft\u0065r " to "3")).retryAfterMs)
        assertNull(errorFor(429, body, mapOf("retry-\u0061fter\u0131" to "3")).retryAfterMs)
        assertNull(errorFor(429, body, mapOf("retry-after\u212A" to "3")).retryAfterMs)
        assertNull(errorFor(429, body, mapOf("retry\u2011after" to "3")).retryAfterMs)
        // The last of two names that differ only in case wins, in the order of the map.
        assertEquals(4000L, errorFor(429, body, linkedMapOf("Retry-After" to "3", "retry-after" to "4")).retryAfterMs)
        assertEquals(3000L, errorFor(429, body, linkedMapOf("retry-after" to "4", "Retry-After" to "3")).retryAfterMs)
        // A non-matching last entry does not hide an earlier match.
        assertEquals(3000L, errorFor(429, body, linkedMapOf("retry-after" to "3", "x-other" to "9")).retryAfterMs)
    }

    @Test
    fun theRetryAfterHeaderValueIsNeverTrimmedOrReadLeniently() = runTest {
        val body = "{\"error\":{\"kind\":\"rate_limit\"}}"
        for (value in listOf("", " ", " 3", "3 ", "3\n", "+3", "-3", "3.0", "3e0", "3,4", "0x3", "\u0663", "\uFF13", "\u09E9", "Wed, 21 Oct 2026 07:28:00 GMT")) {
            assertNull(errorFor(429, body, mapOf("retry-after" to value)).retryAfterMs, "value <$value>")
        }
        assertEquals(3000L, errorFor(429, body, mapOf("retry-after" to "0003")).retryAfterMs)
        assertEquals(3_600_000L, errorFor(429, body, mapOf("retry-after" to "9223372036854776")).retryAfterMs)
    }

    @Test
    fun anIntegerBodyDelayBeatsTheHeaderAndAnUnusableOneFallsBackToIt() = runTest {
        fun body(delay: String) = "{\"error\":{\"kind\":\"rate_limit\",\"retryAfterMs\":$delay}}"
        val header = mapOf("retry-after" to "7")
        assertEquals(1500L, errorFor(429, body("1500.0"), header).retryAfterMs)
        assertEquals(1500L, errorFor(429, body("1.5e3"), header).retryAfterMs)
        assertEquals(0L, errorFor(429, body("-0"), header).retryAfterMs)
        assertEquals(3_600_000L, errorFor(429, body("1e400"), header).retryAfterMs)
        assertEquals(3_600_000L, errorFor(429, body("4294967297"), header).retryAfterMs)
        assertEquals(3_600_000L, errorFor(429, body("12345678901234567890123"), header).retryAfterMs)
        assertEquals(3_600_000L, errorFor(429, body("3600001"), header).retryAfterMs)
        for (unusable in listOf("1500.5", "1500.0000000000000001", "1e-400", "-1", "null", "true", "\"1500\"", "[1500]", "{\"a\":1}", "\"\"")) {
            assertEquals(7000L, errorFor(429, body(unusable), header).retryAfterMs, unusable)
            assertNull(errorFor(429, body(unusable)).retryAfterMs, unusable)
        }
    }
}
