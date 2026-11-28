package es.sebas1705.ilabs.providers

import kotlin.coroutines.cancellation.CancellationException

/** What an [HttpProvider] hands to its transport: always a `POST` of a JSON body. */
data class HttpRequest(val url: String, val headers: Map<String, String>, val body: String, val timeoutMs: Long) {
    /** Header values (the `x-ilabs-api-key` one among them) and the body never show: a log line or a failed assertion must not leak them. */
    override fun toString(): String = "HttpRequest(url=$url, headerNames=${headers.keys}, bodyLength=${body.length}, timeoutMs=$timeoutMs)"
}

/** What a transport returns. `body` is text, never null (no body is the empty string); header values are never trimmed. */
data class HttpResponse(val status: Int, val headers: Map<String, String>, val body: String)

/** Sends one request. Throws [TransportTimeoutException] on a timeout and anything else on a network failure. */
fun interface HttpTransport {
    suspend fun send(req: HttpRequest): HttpResponse
}

/** The one error that means `timeout`: any other transport failure is `unavailable`. */
class TransportTimeoutException(message: String? = null) : Exception(message)

/**
 * A [Provider] that talks to the iLabs gateway (`POST {endpoint}/v1/complete`) through an injected [transport].
 * The mapping of replies to results and errors is pinned by `contracts/gateway` (the client half).
 *
 * @throws IllegalArgumentException when [id] is empty, [endpoint] is empty or only slashes, or [timeoutMs] is not positive.
 */
class HttpProvider(
    override val id: String = "gateway",
    endpoint: String,
    private val transport: HttpTransport,
    apiKey: String? = null,
    private val timeoutMs: Long = DEFAULT_TIMEOUT_MS,
) : Provider {
    private val url: String
    private val sendsKey: Boolean
    private val key: String

    init {
        require(id.isNotEmpty()) { "id must not be empty" }
        val base = endpoint.trimEnd('/')
        require(base.isNotEmpty()) { "endpoint must not be empty" }
        require(timeoutMs > 0) { "timeoutMs must be positive" }
        url = "$base/v1/complete"
        // An empty or whitespace-only key counts as absent; any other key is sent exactly as given.
        sendsKey = apiKey != null && apiKey.any { it != ' ' && it != '\t' && it != '\r' && it != '\n' }
        key = apiKey ?: ""
    }

    override suspend fun complete(req: CompletionRequest): CompletionResponse =
        completeWire(req.messages.map { it.role.wire() to it.content }, req.maxTokens?.toString())

    /**
     * The same call over raw wire values, so a conformance harness can forward what [Role] cannot represent
     * (a bogus role). [maxTokensLiteral] is the JSON number text of `maxTokens`, or `null` for none.
     */
    internal suspend fun completeWire(messages: List<Pair<String, String>>, maxTokensLiteral: String?): CompletionResponse {
        val headers = LinkedHashMap<String, String>()
        headers["content-type"] = "application/json"
        if (sendsKey) headers["x-ilabs-api-key"] = key
        val body = buildString {
            append("{\"messages\":[")
            messages.forEachIndexed { index, (role, content) ->
                if (index > 0) append(',')
                append("{\"role\":")
                appendJsonString(role)
                append(",\"content\":")
                appendJsonString(content)
                append('}')
            }
            append(']')
            if (maxTokensLiteral != null) append(",\"maxTokens\":").append(maxTokensLiteral)
            append('}')
        }

        val response = try {
            transport.send(HttpRequest(url, headers, body, timeoutMs))
        } catch (e: TransportTimeoutException) {
            throw ProviderException(ErrorKind.TIMEOUT)
        } catch (e: CancellationException) {
            throw e // never mapped: the caller's coroutine is being cancelled
        } catch (e: Exception) {
            throw ProviderException(ErrorKind.UNAVAILABLE)
        }

        val json = parseStrictJson(response.body)
        if (response.status == 200) return success(json)

        val error = ((json as? JsonNode.Obj)?.members?.get("error") as? JsonNode.Obj)?.members
        val kind = (error?.get("kind") as? JsonNode.Str)?.value
            ?.let { wire -> ErrorKind.entries.firstOrNull { it.wire == wire } }
            ?: ErrorKind.UNAVAILABLE
        if (kind != ErrorKind.RATE_LIMIT) throw ProviderException(kind)

        val fromBody = (error?.get("retryAfterMs") as? JsonNode.Num)?.let { cappedNonNegativeInteger(it.literal, DELAY_CAP_MS) }
        val retryAfterMs = fromBody ?: headerValue(response.headers, "retry-after")?.let { cappedSecondsHeaderToMs(it, DELAY_CAP_MS) }
        throw ProviderException(kind, retryAfterMs)
    }

    private fun success(json: JsonNode?): CompletionResponse {
        val members = (json as? JsonNode.Obj)?.members ?: throw ProviderException(ErrorKind.INVALID_OUTPUT)
        val text = (members["text"] as? JsonNode.Str)?.value ?: throw ProviderException(ErrorKind.INVALID_OUTPUT)
        val provider = (members["provider"] as? JsonNode.Str)?.value
            ?.takeIf { value -> value.any { it != ' ' && it != '\t' && it != '\r' && it != '\n' } }
        return CompletionResponse(text, provider ?: id)
    }

    private fun Role.wire(): String = when (this) {
        Role.SYSTEM -> "system"
        Role.USER -> "user"
        Role.ASSISTANT -> "assistant"
    }

    private companion object {
        const val DEFAULT_TIMEOUT_MS = 25_000L
        const val DELAY_CAP_MS = 3_600_000L
    }
}

/** The value of header [name] (lowercase): ASCII case-insensitive, and the last matching entry of the map wins. */
private fun headerValue(headers: Map<String, String>, name: String): String? {
    var found: String? = null
    for ((headerName, value) in headers) {
        if (asciiLowercase(headerName) == name) found = value
    }
    return found
}

// Header names are ASCII: only A-Z fold, never a non-ASCII letter (`equals(ignoreCase = true)` folds those too).
private fun asciiLowercase(s: String): String {
    if (s.none { it in 'A'..'Z' }) return s
    return buildString(s.length) { for (c in s) append(if (c in 'A'..'Z') c + 32 else c) }
}
