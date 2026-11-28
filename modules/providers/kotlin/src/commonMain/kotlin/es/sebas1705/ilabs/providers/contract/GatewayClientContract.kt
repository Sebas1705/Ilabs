package es.sebas1705.ilabs.providers.contract

import es.sebas1705.ilabs.providers.*

import kotlin.coroutines.cancellation.CancellationException

/*
 * Harness for the `client` fixtures of contracts/gateway (the client half of the gateway contract).
 * The fixtures are read over the raw JSON text with the strict reader, so number literals stay exact and
 * unknown keys, missing keys and wrong types are rejected before anything runs.
 */

private fun invalid(reason: String): Nothing = error("invalid fixture: $reason")

private val fixtureKinds = setOf("handler", "client", "limiter")

private class NetworkFailure : Exception("network failure")

private sealed interface Scripted {
    data class Reply(val status: Int, val headers: Map<String, String>, val body: String) : Scripted
    data class Throws(val timeout: Boolean) : Scripted
}

private data class ExpectedRequest(
    val url: String,
    val method: String,
    val headers: Map<String, String>,
    val body: JsonNode,
    val timeoutMs: Long,
)

private data class ClientFixture(
    val name: String,
    val endpoint: String,
    val id: String?,
    val apiKey: String?,
    val timeoutMs: Long?,
    val messages: List<Pair<String, String>>,
    val maxTokensLiteral: String?,
    val transport: Scripted,
    val expectedError: Pair<String, String?>?, // kind and the retryAfterMs literal, when the result is an error
    val expectedText: Pair<String, String>?, // text and provider, when the result is a success
    val expectedRequests: List<ExpectedRequest>,
)

private fun JsonNode.asObject(path: String): Map<String, JsonNode> =
    (this as? JsonNode.Obj)?.members ?: invalid("wrong type: $path")

private fun Map<String, JsonNode>.checkKeys(allowed: Set<String>, required: Set<String>) {
    for (key in keys) if (key !in allowed) invalid("unknown key: $key")
    for (key in required) if (key !in this) invalid("missing key: $key")
}

private fun JsonNode?.asString(path: String): String =
    (this as? JsonNode.Str)?.value ?: invalid("wrong type: $path")

private fun JsonNode?.asLong(path: String): Long =
    (this as? JsonNode.Num)?.literal?.toLongOrNull() ?: invalid("wrong type: $path")

private fun Map<String, JsonNode>.stringMap(key: String): Map<String, String> {
    val entries = getValue(key).asObject(key)
    val result = LinkedHashMap<String, String>()
    for ((name, value) in entries) result[name] = value.asString("$key.$name")
    return result
}

private fun parseClientFixture(root: Map<String, JsonNode>): ClientFixture {
    root.checkKeys(
        allowed = setOf("kind", "name", "endpoint", "id", "apiKey", "timeoutMs", "request", "transport", "expect"),
        required = setOf("kind", "name", "endpoint", "request", "transport", "expect"),
    )
    val request = root.getValue("request").asObject("request")
    request.checkKeys(allowed = setOf("messages", "maxTokens"), required = setOf("messages"))
    val messages = (request.getValue("messages") as? JsonNode.Arr)?.items ?: invalid("wrong type: messages")
    val wireMessages = messages.map { node ->
        val message = node.asObject("messages")
        message.checkKeys(allowed = setOf("role", "content"), required = setOf("role", "content"))
        message["role"].asString("role") to message["content"].asString("content")
    }
    val maxTokens = when (val node = request["maxTokens"]) {
        null, JsonNode.Null -> null // a null maxTokens is "not given", as it is for the client
        is JsonNode.Num -> node.literal
        else -> invalid("wrong type: maxTokens")
    }

    val entries = (root.getValue("transport") as? JsonNode.Arr)?.items ?: invalid("wrong type: transport")
    if (entries.size != 1) invalid("transport needs exactly one entry")
    val entry = entries[0].asObject("transport")
    entry.checkKeys(allowed = setOf("status", "body", "headers", "throws"), required = emptySet())
    val scripted: Scripted = if ("throws" in entry) {
        for (other in listOf("status", "body", "headers")) if (other in entry) invalid("unknown key: $other")
        when (val kind = entry["throws"].asString("throws")) {
            "timeout" -> Scripted.Throws(timeout = true)
            "network" -> Scripted.Throws(timeout = false)
            else -> invalid("unknown throw kind: $kind")
        }
    } else {
        if ("status" !in entry) invalid("missing key: status")
        val status = entry["status"].asLong("status")
        if (status !in 0..999) invalid("wrong type: status")
        val body = when (val node = entry["body"]) {
            null -> ""
            is JsonNode.Str -> node.value
            is JsonNode.Obj -> node.toJsonText()
            else -> invalid("wrong type: body")
        }
        val headers = if ("headers" in entry) entry.stringMap("headers") else emptyMap()
        Scripted.Reply(status.toInt(), headers, body)
    }

    val expect = root.getValue("expect").asObject("expect")
    expect.checkKeys(allowed = setOf("result", "requests"), required = setOf("result", "requests"))
    val result = expect.getValue("result").asObject("result")
    var expectedError: Pair<String, String?>? = null
    var expectedText: Pair<String, String>? = null
    if ("error" in result) {
        result.checkKeys(allowed = setOf("error"), required = setOf("error"))
        val error = result.getValue("error").asObject("error")
        error.checkKeys(allowed = setOf("kind", "retryAfterMs"), required = setOf("kind"))
        val retry = error["retryAfterMs"]?.let { (it as? JsonNode.Num)?.literal ?: invalid("wrong type: retryAfterMs") }
        expectedError = error["kind"].asString("kind") to retry
    } else {
        result.checkKeys(allowed = setOf("text", "provider"), required = setOf("text", "provider"))
        expectedText = result["text"].asString("text") to result["provider"].asString("provider")
    }
    val requests = (expect.getValue("requests") as? JsonNode.Arr)?.items ?: invalid("wrong type: requests")
    val expectedRequests = requests.map { node ->
        val call = node.asObject("requests")
        call.checkKeys(
            allowed = setOf("url", "method", "headers", "body", "timeoutMs"),
            required = setOf("url", "method", "headers", "body", "timeoutMs"),
        )
        ExpectedRequest(
            url = call["url"].asString("url"),
            method = call["method"].asString("method"),
            headers = call.stringMap("headers"),
            body = call.getValue("body"),
            timeoutMs = call["timeoutMs"].asLong("timeoutMs"),
        )
    }

    return ClientFixture(
        name = root["name"].asString("name"),
        endpoint = root["endpoint"].asString("endpoint"),
        id = root["id"]?.asString("id"),
        apiKey = root["apiKey"]?.asString("apiKey"),
        timeoutMs = root["timeoutMs"]?.asLong("timeoutMs"),
        messages = wireMessages,
        maxTokensLiteral = maxTokens,
        transport = scripted,
        expectedError = expectedError,
        expectedText = expectedText,
        expectedRequests = expectedRequests,
    )
}

/**
 * Runs one `client` fixture of `contracts/gateway` given as raw JSON [text] and returns the failures
 * (empty when it passes). When [fileName] is given (without `.json`), the fixture's `name` must equal it.
 *
 * @throws IllegalStateException `invalid fixture: <reason>` when the fixture itself is unusable.
 * @throws IllegalArgumentException when the fixture is well formed but is not a `client` fixture.
 */
suspend fun runGatewayClientFixture(text: String, fileName: String? = null): List<String> {
    val root = (parseStrictJson(text) ?: invalid("not JSON")).asObject("fixture")
    val kind = root["kind"]?.asString("kind") ?: invalid("missing key: kind")
    if (kind !in fixtureKinds) invalid("unknown fixture kind: $kind")
    require(kind == "client") { "not a client fixture: $kind" }
    val fixture = parseClientFixture(root)

    val failures = mutableListOf<String>()
    val label = fixture.name
    fun fail(what: String) {
        failures += "$label: $what"
    }
    if (fileName != null && fixture.name != fileName) fail("name differs from the file name <$fileName>")

    val recorded = mutableListOf<HttpRequest>()
    val transport = HttpTransport { req ->
        recorded += req
        when (val scripted = fixture.transport) {
            is Scripted.Reply -> HttpResponse(scripted.status, scripted.headers, scripted.body)
            is Scripted.Throws -> throw if (scripted.timeout) TransportTimeoutException() else NetworkFailure()
        }
    }

    val provider = try {
        when {
            fixture.id != null && fixture.timeoutMs != null ->
                HttpProvider(fixture.id, fixture.endpoint, transport, fixture.apiKey, fixture.timeoutMs)
            fixture.id != null ->
                HttpProvider(id = fixture.id, endpoint = fixture.endpoint, transport = transport, apiKey = fixture.apiKey)
            fixture.timeoutMs != null ->
                HttpProvider(endpoint = fixture.endpoint, transport = transport, apiKey = fixture.apiKey, timeoutMs = fixture.timeoutMs)
            else -> HttpProvider(endpoint = fixture.endpoint, transport = transport, apiKey = fixture.apiKey)
        }
    } catch (e: IllegalArgumentException) {
        fail("the provider could not be built: ${e.message}")
        return failures
    }

    // `complete` takes typed messages: a role outside the enum (a fixture that forwards a bogus role) goes
    // through the wire-level entry point that `complete` itself delegates to.
    val roles = fixture.messages.map { (role, _) -> Role.entries.firstOrNull { it.name.lowercase() == role } }
    val maxTokens = fixture.maxTokensLiteral?.let { if (it.toIntOrNull()?.toString() == it) it.toInt() else null }
    val typed = roles.all { it != null } && (fixture.maxTokensLiteral == null || maxTokens != null)

    var response: CompletionResponse? = null
    var error: ProviderException? = null
    try {
        response = if (typed) {
            provider.complete(
                CompletionRequest(fixture.messages.mapIndexed { i, (_, content) -> Message(roles[i]!!, content) }, maxTokens),
            )
        } else {
            provider.completeWire(fixture.messages, fixture.maxTokensLiteral)
        }
    } catch (e: ProviderException) {
        error = e
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        fail("unexpected exception: $e")
    }

    fixture.expectedText?.let { (text, providerId) ->
        if (response == null) {
            fail("expected a result but got ${error?.let { "error <${it.kind.wire}, ${it.retryAfterMs}>" } ?: "no outcome"}")
        } else {
            if (response.text != text) fail("text: expected <$text> but was <${response.text}>")
            if (response.provider != providerId) fail("provider: expected <$providerId> but was <${response.provider}>")
        }
    }
    fixture.expectedError?.let { (kind, retryLiteral) ->
        if (error == null) {
            fail("expected error <$kind> but got ${response?.let { "a result <${it.text}>" } ?: "no outcome"}")
        } else {
            if (error.kind.wire != kind) fail("error kind: expected <$kind> but was <${error.kind.wire}>")
            val wantRetry = retryLiteral?.let { it.toLongOrNull() ?: invalid("wrong type: retryAfterMs") }
            if (error.retryAfterMs != wantRetry) fail("retryAfterMs: expected <$wantRetry> but was <${error.retryAfterMs}>")
        }
    }

    if (recorded.size != fixture.expectedRequests.size) {
        fail("transport calls: expected <${fixture.expectedRequests.size}> but was <${recorded.size}>")
    } else {
        recorded.zip(fixture.expectedRequests).forEachIndexed { index, (actual, want) ->
            val at = "request ${index + 1}"
            if (want.method != "POST") fail("$at: the fixture's method is <${want.method}>, not POST")
            if (actual.url != want.url) fail("$at url: expected <${want.url}> but was <${actual.url}>")
            if (actual.headers != want.headers) fail("$at headers: expected <${want.headers}> but was <${actual.headers}>")
            if (actual.timeoutMs != want.timeoutMs) fail("$at timeoutMs: expected <${want.timeoutMs}> but was <${actual.timeoutMs}>")
            val body = parseStrictJson(actual.body)
            if (body != want.body) fail("$at body: expected <${want.body.toJsonText()}> but was <${actual.body}>")
        }
    }
    return failures
}
