package es.sebas1705.ilabs.demo

import es.sebas1705.ilabs.providers.HttpRequest
import es.sebas1705.ilabs.providers.HttpResponse
import es.sebas1705.ilabs.providers.HttpTransport
import es.sebas1705.ilabs.providers.TransportTimeoutException
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.util.Locale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.isActive

/** What the endpoint field holds, checked by [AssistantEndpoint.check]. */
sealed interface EndpointCheck {
    /** Nothing typed yet. */
    data object Empty : EndpointCheck

    /** Typed, but not allowed: not a URL, not `https`, `http` for a host other than the development hosts, or a query or fragment. */
    data object Invalid : EndpointCheck

    /** Allowed; [url] is the trimmed text that goes to the provider. */
    data class Ok(val url: String) : EndpointCheck
}

/** The one place that decides which gateway URLs the demo talks to. */
object AssistantEndpoint {
    /** The hosts that may use plain `http`, for development only (`10.0.2.2` is the host machine seen from the emulator). */
    val DEV_HOSTS: Set<String> = setOf("localhost", "127.0.0.1", "10.0.2.2")

    fun check(raw: String): EndpointCheck {
        val text = raw.trim()
        if (text.isEmpty()) return EndpointCheck.Empty
        // A query or a fragment would land in the middle of the request URL, because the path is appended to the endpoint.
        if ('?' in text || '#' in text) return EndpointCheck.Invalid
        return if (isAllowed(text)) EndpointCheck.Ok(text) else EndpointCheck.Invalid
    }

    private val SHAPE = Regex("""(https?)://(\[[^\]/?#@\s\\]*\]|[^/:?#@\s\\\[\]]*)(?::([0-9]*))?(/[^?#\s\\]*)?""", RegexOption.IGNORE_CASE)
    private val DNS_LABEL = Regex("""[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?""")
    private val IPV4 = Regex("""([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})""")
    private val IPV6 = Regex("""\[[0-9A-Fa-f:]*:[0-9A-Fa-f:]*(?:\.[0-9.]+)?]""")
    private val DIGITS_AND_DOTS = Regex("""[0-9.]+""")

    /**
     * The one endpoint rule, identical to the web twin (`checkEndpoint`): the scheme is case-insensitive; `https://` takes
     * any valid host, `http://` only [DEV_HOSTS]. A host is a DNS name (letters, digits, hyphens and dots), a dotted-quad
     * IPv4 or a bracketed IPv6. The port is optional (1 to 65535). No user info, query, fragment or whitespace. Trailing
     * slashes are fine: the provider trims them.
     */
    fun isAllowed(url: String): Boolean {
        if (url.any { it.isWhitespace() || it.isISOControl() }) return false
        val m = SHAPE.matchEntire(url) ?: return false
        val scheme = m.groupValues[1].lowercase(Locale.ROOT)
        val host = m.groupValues[2]
        val port = m.groups[3]?.value
        if (host.isEmpty() || !validHost(host)) return false
        if (port != null && (port.isEmpty() || port.length > 5 || port.toInt() !in 1..65535)) return false
        return scheme == "https" || host.lowercase(Locale.ROOT) in DEV_HOSTS
    }

    private fun validHost(host: String): Boolean {
        if (host.startsWith("[")) return IPV6.matches(host)
        // Anything made only of digits and dots must be a dotted quad: `127.1` is not a host here.
        if (DIGITS_AND_DOTS.matches(host)) {
            val m = IPV4.matches(host)
            return m && host.split('.').all { it.toInt() <= 255 }
        }
        return host.length <= 253 && host.split('.').all { DNS_LABEL.matches(it) }
    }
}

/**
 * An [HttpTransport] over `HttpURLConnection`. It never follows a redirect, caps the body at [maxBodyBytes] (an
 * [IOException] when exceeded: a cut JSON text would only be misread), runs on [io], maps a socket or connect timeout to
 * [TransportTimeoutException] and never swallows a cancellation: cancelling the caller closes the connection. It only
 * talks to URLs that [AssistantEndpoint.isAllowed] accepts. Nothing here logs and no message carries a header or body.
 *
 * `timeoutMs` bounds the connect, each read and, as a deadline checked between reads, the whole body.
 */
class UrlConnectionTransport(
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val maxBodyBytes: Int = DEFAULT_MAX_BODY_BYTES,
) : HttpTransport {
    override suspend fun send(req: HttpRequest): HttpResponse {
        if (!AssistantEndpoint.isAllowed(req.url)) throw IOException("endpoint not allowed")
        val timeout = req.timeoutMs.coerceIn(1L, Int.MAX_VALUE.toLong()).toInt()
        val connection = URL(req.url).openConnection() as HttpURLConnection
        return coroutineScope {
            val call = async(io) {
                try {
                    exchange(connection, req, timeout)
                } catch (e: Exception) {
                    // Closing the connection to cancel makes the blocked read fail: that is the cancellation, not a network error.
                    if (!isActive) throw CancellationException("cancelled")
                    throw e
                }
            }
            try {
                call.await()
            } catch (e: CancellationException) {
                // Wakes the blocked read of the worker thread; the cancellation itself goes on. On Android disconnect() also
                // aborts a connect that is still going; on a plain JVM it does not, so there a cancel during the connect phase
                // can linger up to the timeout. The caller's result is dropped by its token either way.
                connection.disconnect()
                throw e
            }
        }
    }

    private fun exchange(connection: HttpURLConnection, req: HttpRequest, timeout: Int): HttpResponse {
        val deadline = System.nanoTime() + timeout * 1_000_000L
        try {
            connection.instanceFollowRedirects = false
            connection.requestMethod = "POST"
            connection.connectTimeout = timeout
            connection.readTimeout = timeout
            connection.useCaches = false
            connection.doOutput = true
            for ((name, value) in req.headers) connection.setRequestProperty(name, value)
            val payload = req.body.toByteArray(Charsets.UTF_8)
            connection.setFixedLengthStreamingMode(payload.size)
            connection.outputStream.use { it.write(payload) }
            val status = connection.responseCode
            val body = (if (status >= 400) connection.errorStream else connection.inputStream)
                ?.use { readCapped(it, deadline) }
                ?: ""
            return HttpResponse(status, headersOf(connection), body)
        } catch (e: SocketTimeoutException) {
            throw TransportTimeoutException("timeout")
        } finally {
            connection.disconnect()
        }
    }

    private fun readCapped(input: InputStream, deadline: Long): String {
        val out = ByteArrayOutputStream()
        val chunk = ByteArray(8 * 1024)
        while (true) {
            if (System.nanoTime() - deadline > 0) throw SocketTimeoutException("deadline")
            val n = input.read(chunk)
            if (n < 0) break
            if (out.size() + n > maxBodyBytes) throw IOException("response too large")
            out.write(chunk, 0, n)
        }
        return out.toString(Charsets.UTF_8.name())
    }

    /** One value per header name (the last one when repeated); the status line, which has no name, is left out. */
    private fun headersOf(connection: HttpURLConnection): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        for ((name, values) in connection.headerFields) {
            if (name == null || values.isNullOrEmpty()) continue
            out[name] = values.last()
        }
        return out
    }

    companion object {
        /** 1 MiB. */
        const val DEFAULT_MAX_BODY_BYTES = 1024 * 1024
    }
}
