package es.sebas1705.ilabs.demo

import es.sebas1705.ilabs.providers.HttpRequest
import es.sebas1705.ilabs.providers.HttpResponse
import es.sebas1705.ilabs.providers.HttpTransport
import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** A key-looking value the tests must never see leave the guardrails.
 */
const val SECRET_VALUE = "sk-test-1234567890abcdef"

/** The four mock replies the tests use, in script order. */
val TEST_REPLIES = listOf("reply one", "reply two", "reply three", "reply four")

/** One scripted answer of a [ScriptedTransport]: a response, or a failure to throw. */
sealed interface Step {
    data class Respond(val response: HttpResponse) : Step
    data class Fail(val error: Exception) : Step
}

fun ok(text: String, provider: String = "gateway") = Step.Respond(HttpResponse(200, emptyMap(), "{\"text\":${JsonPrimitive(text)},\"provider\":${JsonPrimitive(provider)}}"))

fun limited(retryAfterMs: Long? = null, header: String? = null) = Step.Respond(
    HttpResponse(
        429,
        if (header != null) mapOf("Retry-After" to header) else emptyMap(),
        "{\"error\":{\"kind\":\"rate_limit\"${if (retryAfterMs != null) ",\"retryAfterMs\":$retryAfterMs" else ""}}}",
    ),
)

fun status(code: Int, body: String = "") = Step.Respond(HttpResponse(code, emptyMap(), body))

/** Answers from a queue (the last step repeats once the queue is down to it) and records every request: no network. */
class ScriptedTransport(vararg steps: Step, private val repeatLast: Boolean = true) : HttpTransport {
    private val queue = ArrayDeque(steps.toList())
    val requests = ArrayList<HttpRequest>()

    override suspend fun send(req: HttpRequest): HttpResponse {
        requests += req
        val step = if (queue.size > 1 || (queue.size == 1 && !repeatLast)) queue.removeFirst() else queue.first()
        return when (step) {
            is Step.Respond -> step.response
            is Step.Fail -> throw step.error
        }
    }
}

/** A transport that waits for [gate] before it answers, so a test can change things while a call is in flight. */
class GatedTransport(private val gate: CompletableDeferred<Unit>, private val answer: Step = ok("late")) : HttpTransport {
    val requests = ArrayList<HttpRequest>()

    override suspend fun send(req: HttpRequest): HttpResponse {
        requests += req
        gate.await()
        return when (answer) {
            is Step.Respond -> answer.response
            is Step.Fail -> throw answer.error
        }
    }
}

/** The messages of a recorded request body as `(role, content)` pairs. */
fun HttpRequest.messages(): List<Pair<String, String>> =
    (Json.parseToJsonElement(body).jsonObject["messages"] as JsonArray).map {
        val o = it.jsonObject
        o.getValue("role").jsonPrimitive.content to o.getValue("content").jsonPrimitive.content
    }

fun HttpRequest.maxTokens(): Int? = (Json.parseToJsonElement(body) as JsonObject)["maxTokens"]?.jsonPrimitive?.content?.toInt()

fun HttpRequest.header(name: String): String? = headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value

val TraceEvent.text: String get() = "$kind:${args.joinToString(",")}"

val List<TraceEvent>.kinds: List<TraceKind> get() = map { it.kind }
