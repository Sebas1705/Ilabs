package es.sebas1705.ilabs.providers

import es.sebas1705.ilabs.providers.contract.runGatewayClientFixture
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** The client harness must fail on a wrong expectation and reject a malformed fixture with the contract's reasons. */
class GatewayClientHarnessTest {
    private val entry = """{ "status": 200, "body": { "text": "Hi", "provider": "gateway" } }"""
    private val success = """{ "text": "Hi", "provider": "gateway" }"""
    private val message = """{ "role": "user", "content": "hello" }"""

    /** A client fixture built from JSON pieces; every piece can be replaced to build a variant. */
    private fun fixture(
        kind: String = "\"client\"",
        name: String = "\"client-x\"",
        top: String = "",
        messageJson: String = message,
        requestExtra: String = "",
        transport: String = "[$entry]",
        result: String = "{ \"text\": \"Hi\", \"provider\": \"gateway\" }",
        url: String = "https://gateway.example.test/v1/complete",
        headers: String = """{ "content-type": "application/json" }""",
        bodyJson: String = """{ "messages": [$message] }""",
        timeoutMs: String = "25000",
        callExtra: String = "",
        expectExtra: String = "",
    ) = """
        {
          "kind": $kind, "name": $name, "endpoint": "https://gateway.example.test/", $top
          "request": { "messages": [$messageJson]$requestExtra },
          "transport": $transport,
          "expect": {
            $expectExtra
            "result": $result,
            "requests": [{ "url": "$url", "method": "POST", "headers": $headers, "body": $bodyJson, "timeoutMs": $timeoutMs$callExtra }]
          }
        }
    """.trimIndent()

    private suspend fun invalidReason(text: String): String {
        val e = assertFailsWith<IllegalStateException> { runGatewayClientFixture(text) }
        val reason = e.message ?: ""
        assertTrue(reason.startsWith("invalid fixture: "), reason)
        return reason.removePrefix("invalid fixture: ")
    }

    private suspend fun failures(text: String) = runGatewayClientFixture(text, "client-x")

    @Test
    fun aGoodFixturePasses() = runTest {
        assertEquals(emptyList(), failures(fixture()))
    }

    @Test
    fun aWrongExpectationIsReported() = runTest {
        assertTrue(failures(fixture(result = """{ "text": "Ho", "provider": "gateway" }""")).any { "text" in it })
        assertTrue(failures(fixture(result = """{ "text": "Hi", "provider": "other" }""")).any { "provider" in it })
        assertTrue(failures(fixture(url = "https://gateway.example.test/v2/complete")).any { "url" in it })
        assertTrue(failures(fixture(timeoutMs = "25001")).any { "timeoutMs" in it })
        assertTrue(failures(fixture(headers = """{ "content-type": "text/plain" }""")).any { "headers" in it })
        assertTrue(failures(fixture(headers = """{ "content-type": "application/json", "x-ilabs-api-key": "k" }""")).any { "headers" in it })
        assertTrue(failures(fixture(bodyJson = """{ "messages": [{ "role": "user", "content": "bye" }] }""")).any { "body" in it })
        assertTrue(failures(fixture(bodyJson = """{ "messages": [$message], "maxTokens": 1 }""")).any { "body" in it })
        assertTrue(failures(fixture(name = "\"client-y\"")).any { "name differs" in it })
        assertTrue(failures(fixture(result = """{ "error": { "kind": "timeout" } }""")).any { "expected error" in it })
        assertTrue(failures(fixture(transport = """[{ "status": 200, "body": {} }]""")).any { "expected a result" in it })
    }

    @Test
    fun anErrorIsComparedByKindAndDelay() = runTest {
        val rateLimited = """[{ "status": 429, "body": { "error": { "kind": "rate_limit", "retryAfterMs": 1500 } } }]"""
        fun result(kind: String, delay: String) = """{ "error": { "kind": "$kind"$delay } }"""
        assertEquals(emptyList(), failures(fixture(transport = rateLimited, result = result("rate_limit", ", \"retryAfterMs\": 1500"))))
        assertTrue(failures(fixture(transport = rateLimited, result = result("rate_limit", ", \"retryAfterMs\": 1501"))).any { "retryAfterMs" in it })
        assertTrue(failures(fixture(transport = rateLimited, result = result("rate_limit", ""))).any { "retryAfterMs" in it })
        assertTrue(failures(fixture(transport = rateLimited, result = result("timeout", ", \"retryAfterMs\": 1500"))).any { "error kind" in it })
    }

    @Test
    fun numbersInABodyObjectKeepTheirLiteralText() = runTest {
        val transport = """[{ "status": 429, "body": { "error": { "kind": "rate_limit", "retryAfterMs": 1.5e3 } } }]"""
        assertEquals(emptyList(), failures(fixture(transport = transport, result = """{ "error": { "kind": "rate_limit", "retryAfterMs": 1500 } }""")))
    }

    @Test
    fun anUnknownKindIsRejected() = runTest {
        assertEquals("unknown fixture kind: nope", invalidReason(fixture(kind = "\"nope\"")))
    }

    @Test
    fun anUnknownKeyIsRejected() = runTest {
        assertEquals("unknown key: extra", invalidReason(fixture(top = "\"extra\": 1,")))
        assertEquals("unknown key: extra", invalidReason(fixture(callExtra = ", \"extra\": 1")))
        assertEquals("unknown key: extra", invalidReason(fixture(messageJson = """{ "role": "user", "content": "hello", "extra": 1 }""")))
        assertEquals("unknown key: extra", invalidReason(fixture(requestExtra = ", \"extra\": 1")))
        assertEquals("unknown key: extra", invalidReason(fixture(expectExtra = "\"extra\": 1,")))
        assertEquals("unknown key: extra", invalidReason(fixture(transport = """[{ "status": 200, "extra": 1 }]""")))
        assertEquals("unknown key: extra", invalidReason(fixture(result = """{ "text": "Hi", "provider": "gateway", "extra": 1 }""")))
        assertEquals("unknown key: extra", invalidReason(fixture(result = """{ "error": { "kind": "timeout", "extra": 1 } }""")))
    }

    @Test
    fun aMissingKeyIsRejected() = runTest {
        assertEquals("missing key: status", invalidReason(fixture(transport = """[{ "body": "x" }]""")))
        assertEquals("missing key: content", invalidReason(fixture(messageJson = """{ "role": "user" }""")))
        assertEquals("missing key: timeoutMs", invalidReason(fixture().replace(", \"timeoutMs\": 25000", "")))
        assertEquals("missing key: endpoint", invalidReason(fixture().replace("\"endpoint\": \"https://gateway.example.test/\",", "")))
        assertEquals("missing key: kind", invalidReason(fixture().replace("\"kind\": \"client\",", "")))
        assertEquals("missing key: provider", invalidReason(fixture(result = """{ "text": "Hi" }""")))
        assertEquals("missing key: kind", invalidReason(fixture(result = """{ "error": {} }""")))
    }

    @Test
    fun aWrongTypeIsRejected() = runTest {
        assertEquals("wrong type: status", invalidReason(fixture(transport = """[{ "status": "200" }]""")))
        assertEquals("wrong type: status", invalidReason(fixture(transport = """[{ "status": 200.5 }]""")))
        assertEquals("wrong type: body", invalidReason(fixture(transport = """[{ "status": 200, "body": 7 }]""")))
        assertEquals("wrong type: timeoutMs", invalidReason(fixture(timeoutMs = "\"25000\"")))
        assertEquals("wrong type: kind", invalidReason(fixture(kind = "1")))
        assertEquals("wrong type: maxTokens", invalidReason(fixture(requestExtra = ", \"maxTokens\": \"5\"")))
        assertEquals("wrong type: retryAfterMs", invalidReason(fixture(result = """{ "error": { "kind": "rate_limit", "retryAfterMs": "5" } }""")))
        assertEquals("wrong type: transport", invalidReason(fixture(transport = "{}")))
        assertEquals("wrong type: headers", invalidReason(fixture(headers = "[]")))
        assertEquals("wrong type: headers.x", invalidReason(fixture(transport = """[{ "status": 200, "headers": { "x": 1 } }]""")))
    }

    @Test
    fun theTransportNeedsExactlyOneEntry() = runTest {
        assertEquals("transport needs exactly one entry", invalidReason(fixture(transport = "[]")))
        assertEquals("transport needs exactly one entry", invalidReason(fixture(transport = "[$entry, $entry]")))
    }

    @Test
    fun anUnknownThrowKindIsRejected() = runTest {
        assertEquals("unknown throw kind: boom", invalidReason(fixture(transport = """[{ "throws": "boom" }]""")))
        assertEquals("wrong type: throws", invalidReason(fixture(transport = """[{ "throws": 1 }]""")))
    }

    @Test
    fun aFixtureThatIsNotJsonOrNotAClientFixtureIsRefused() = runTest {
        assertEquals("not JSON", invalidReason("{"))
        assertEquals("not JSON", invalidReason("﻿" + fixture()))
        assertEquals("wrong type: fixture", invalidReason("[]"))
        assertFailsWith<IllegalArgumentException> { runGatewayClientFixture(fixture(kind = "\"handler\"")) }
        assertFailsWith<IllegalArgumentException> { runGatewayClientFixture(fixture(kind = "\"limiter\"")) }
    }

    @Test
    fun theThrowsEntriesMapToTheTimeoutAndNetworkFailures() = runTest {
        for ((throws, kind) in listOf("timeout" to "timeout", "network" to "unavailable")) {
            val text = fixture(transport = """[{ "throws": "$throws" }]""", result = """{ "error": { "kind": "$kind" } }""")
            assertEquals(emptyList(), failures(text), throws)
        }
    }

    @Test
    fun aRoleOutsideTheEnumAndAnOutOfRangeMaxTokensAreForwardedAsGiven() = runTest {
        val bogus = """{ "role": "bogus", "content": "" }"""
        val text = fixture(
            messageJson = bogus,
            requestExtra = ", \"maxTokens\": 99999999999",
            bodyJson = """{ "messages": [$bogus], "maxTokens": 99999999999 }""",
        )
        assertEquals(emptyList(), failures(text))
        val other = fixture(
            messageJson = bogus,
            requestExtra = ", \"maxTokens\": 99999999999",
            bodyJson = """{ "messages": [$bogus], "maxTokens": 99999999998 }""",
        )
        assertTrue(failures(other).any { "body" in it })
    }

    @Test
    fun aNullMaxTokensIsNotGiven() = runTest {
        assertEquals(emptyList(), failures(fixture(requestExtra = ", \"maxTokens\": null")))
    }

    @Test
    fun theProviderOptionsOfAFixtureAreApplied() = runTest {
        val text = fixture(
            top = """"id": "mine", "apiKey": " k ", "timeoutMs": 40000,""",
            transport = """[{ "status": 200, "body": { "text": "Hi" } }]""",
            result = """{ "text": "Hi", "provider": "mine" }""",
            headers = """{ "content-type": "application/json", "x-ilabs-api-key": " k " }""",
            timeoutMs = "40000",
        )
        assertEquals(emptyList(), failures(text))
    }
}
