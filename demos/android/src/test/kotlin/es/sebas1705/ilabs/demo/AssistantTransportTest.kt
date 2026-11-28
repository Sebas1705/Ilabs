package es.sebas1705.ilabs.demo

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import es.sebas1705.ilabs.providers.CompletionRequest
import es.sebas1705.ilabs.providers.ErrorKind
import es.sebas1705.ilabs.providers.HttpProvider
import es.sebas1705.ilabs.providers.HttpRequest
import es.sebas1705.ilabs.providers.Message
import es.sebas1705.ilabs.providers.ProviderException
import es.sebas1705.ilabs.providers.Role
import es.sebas1705.ilabs.providers.TransportTimeoutException
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/** The transport against the JDK's own HTTP server on the loopback address: no real network. */
class AssistantTransportTest {
    private lateinit var server: HttpServer
    private val pool = Executors.newCachedThreadPool()
    private val transport = UrlConnectionTransport(Dispatchers.IO)

    @Before
    fun start() {
        server = HttpServer.create(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 0)
        server.executor = pool
    }

    @After
    fun stop() {
        server.stop(0)
        pool.shutdownNow()
    }

    private fun url(path: String = "/v1/complete") = "http://127.0.0.1:${server.address.port}$path"

    private fun handle(path: String = "/", block: (HttpExchange) -> Unit) {
        server.createContext(path) { ex ->
            try {
                block(ex)
            } catch (_: IOException) {
                // The client went away (a timeout or a cancel): nothing to answer.
            } finally {
                ex.close()
            }
        }
        server.start()
    }

    private fun HttpExchange.reply(status: Int, body: String, vararg headers: Pair<String, String>) {
        val bytes = body.toByteArray(Charsets.UTF_8)
        for ((k, v) in headers) responseHeaders.add(k, v)
        sendResponseHeaders(status, if (bytes.isEmpty() && status == 204) -1 else bytes.size.toLong())
        if (bytes.isNotEmpty()) responseBody.use { it.write(bytes) }
    }

    private fun request(body: String = "{}", timeoutMs: Long = 5_000, headers: Map<String, String> = mapOf("content-type" to "application/json")) =
        HttpRequest(url(), headers, body, timeoutMs)

    @Test
    fun postsTheBodyAsUtf8WithTheHeadersAndReturnsStatusHeadersAndBody() = runBlocking {
        var seenMethod = ""
        var seenBody = ""
        var seenKey: String? = null
        var seenType: String? = null
        handle { ex ->
            seenMethod = ex.requestMethod
            seenBody = ex.requestBody.readBytes().toString(Charsets.UTF_8)
            seenKey = ex.requestHeaders.getFirst("x-ilabs-api-key")
            seenType = ex.requestHeaders.getFirst("content-type")
            ex.reply(200, "{\"text\":\"¡hola ñ 😀!\"}", "X-Reply" to "yes")
        }
        val response = transport.send(request("{\"a\":\"ñ😀\"}", headers = mapOf("content-type" to "application/json", "x-ilabs-api-key" to "K-1")))
        assertEquals("POST", seenMethod)
        assertEquals("{\"a\":\"ñ😀\"}", seenBody)
        assertEquals("K-1", seenKey)
        assertEquals("application/json", seenType)
        assertEquals(200, response.status)
        assertEquals("{\"text\":\"¡hola ñ 😀!\"}", response.body)
        assertEquals("yes", response.headers.entries.first { it.key.equals("x-reply", ignoreCase = true) }.value)
        assertFalse("the status line has no name", response.headers.containsKey("null"))
    }

    @Test
    fun anErrorStatusKeepsItsBodyAndHeaders() = runBlocking {
        handle { it.reply(429, "{\"error\":{\"kind\":\"rate_limit\"}}", "Retry-After" to "7") }
        val response = transport.send(request())
        assertEquals(429, response.status)
        assertEquals("{\"error\":{\"kind\":\"rate_limit\"}}", response.body)
        assertEquals("7", response.headers.entries.first { it.key.equals("retry-after", ignoreCase = true) }.value)
    }

    @Test
    fun anEmptyBodyIsTheEmptyString() = runBlocking {
        handle { it.reply(204, "") }
        val response = transport.send(request())
        assertEquals(204, response.status)
        assertEquals("", response.body)
    }

    @Test
    fun theProviderMapsA429WithRetryAfterThroughThisTransport() = runBlocking {
        handle { it.reply(429, "{\"error\":{\"kind\":\"rate_limit\"}}", "Retry-After" to "7") }
        val provider = HttpProvider(endpoint = "http://127.0.0.1:${server.address.port}", transport = transport)
        try {
            provider.complete(CompletionRequest(listOf(Message(Role.USER, "hi"))))
            fail("expected a rate limit")
        } catch (e: ProviderException) {
            assertEquals(ErrorKind.RATE_LIMIT, e.kind)
            assertEquals(7_000L, e.retryAfterMs)
        }
    }

    @Test
    fun theProviderReadsASuccessThroughThisTransport() = runBlocking {
        handle { it.reply(200, "{\"text\":\"hello\",\"provider\":\"gateway\"}") }
        val provider = HttpProvider(endpoint = "http://127.0.0.1:${server.address.port}/", transport = transport)
        val response = provider.complete(CompletionRequest(listOf(Message(Role.USER, "hi")), 256))
        assertEquals("hello", response.text)
        assertEquals("gateway", response.provider)
    }

    @Test
    fun aReadTimeoutIsATransportTimeout() {
        val release = CountDownLatch(1)
        handle { ex ->
            ex.requestBody.readBytes()
            release.await(5, TimeUnit.SECONDS)
            ex.reply(200, "{}")
        }
        val started = System.nanoTime()
        try {
            runBlocking { transport.send(request(timeoutMs = 300)) }
            fail("expected a timeout")
        } catch (e: TransportTimeoutException) {
            // expected
        } finally {
            release.countDown()
        }
        assertTrue("the timeout took too long", System.nanoTime() - started < TimeUnit.SECONDS.toNanos(3))
    }

    @Test
    fun aSlowBodyHitsTheOverallDeadline() {
        handle { ex ->
            ex.requestBody.readBytes()
            ex.sendResponseHeaders(200, 0) // chunked
            ex.responseBody.use { out ->
                repeat(30) {
                    out.write('x'.code)
                    out.flush()
                    Thread.sleep(100)
                }
            }
        }
        try {
            runBlocking { transport.send(request(timeoutMs = 500)) }
            fail("expected a timeout")
        } catch (e: TransportTimeoutException) {
            // each read was fast; only the deadline stops it
        }
    }

    @Test
    fun aRedirectIsNotFollowed() = runBlocking {
        val hitsOnTarget = AtomicInteger()
        server.createContext("/target") { ex ->
            hitsOnTarget.incrementAndGet()
            ex.reply(200, "{\"text\":\"elsewhere\"}")
            ex.close()
        }
        handle("/v1") { ex -> ex.reply(302, "", "Location" to url("/target")) }
        val response = transport.send(request())
        assertEquals(302, response.status)
        assertEquals(0, hitsOnTarget.get())
        // Through the provider it is simply an unavailable gateway.
        val provider = HttpProvider(endpoint = "http://127.0.0.1:${server.address.port}", transport = transport)
        try {
            provider.complete(CompletionRequest(listOf(Message(Role.USER, "hi"))))
            fail("expected unavailable")
        } catch (e: ProviderException) {
            assertEquals(ErrorKind.UNAVAILABLE, e.kind)
        }
        assertEquals(0, hitsOnTarget.get())
    }

    @Test
    fun aBodyOverTheCapIsAnErrorAndABodyAtTheCapIsRead() = runBlocking {
        val cap = UrlConnectionTransport.DEFAULT_MAX_BODY_BYTES
        handle("/") { ex ->
            ex.requestBody.readBytes()
            ex.reply(200, "a".repeat(if (ex.requestURI.path.endsWith("big")) cap + 1 else cap))
        }
        val ok = transport.send(HttpRequest(url("/ok"), emptyMap(), "{}", 10_000))
        assertEquals(cap, ok.body.length)
        try {
            transport.send(HttpRequest(url("/big"), emptyMap(), "{}", 10_000))
            fail("expected an IOException")
        } catch (e: IOException) {
            assertEquals("response too large", e.message)
        }
    }

    @Test
    fun theCapAlsoGuardsAnErrorBody() = runBlocking {
        handle { it.reply(500, "b".repeat(100)) }
        try {
            UrlConnectionTransport(Dispatchers.IO, maxBodyBytes = 50).send(request())
            fail("expected an IOException")
        } catch (e: IOException) {
            // expected
        }
    }

    @Test
    fun cancellingTheCallerClosesTheConnectionAndPropagates() = runBlocking {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        handle { ex ->
            ex.requestBody.readBytes()
            entered.countDown()
            release.await(10, TimeUnit.SECONDS)
        }
        val call = async { transport.send(request(timeoutMs = 20_000)) }
        withTimeout(5_000) { while (entered.count > 0L) kotlinx.coroutines.delay(10) }
        val started = System.nanoTime()
        call.cancel()
        try {
            call.await()
            fail("expected a cancellation")
        } catch (e: CancellationException) {
            // A cancellation, not a timeout: the caller sees what it asked for.
        } finally {
            release.countDown()
        }
        assertTrue(call.isCancelled)
        assertTrue("the cancel took too long", System.nanoTime() - started < TimeUnit.SECONDS.toNanos(3))
    }

    @Test
    fun aRefusedConnectionIsNotATimeout() {
        val port = server.address.port
        server.start()
        server.stop(0)
        try {
            runBlocking { transport.send(HttpRequest("http://127.0.0.1:$port/v1/complete", emptyMap(), "{}", 2_000)) }
            fail("expected an IOException")
        } catch (e: TransportTimeoutException) {
            fail("a refused connection is not a timeout")
        } catch (e: IOException) {
            assertNotNull(e)
        }
    }

    @Test
    fun onlyAllowedUrlsAreSentWithoutTouchingTheNetwork() {
        for (bad in listOf("http://example.com/v1/complete", "ftp://127.0.0.1/x", "http://127.0.0.1@evil.example/x", "not a url", "")) {
            try {
                runBlocking { transport.send(HttpRequest(bad, emptyMap(), "{}", 1_000)) }
                fail("expected a refusal for $bad")
            } catch (e: IOException) {
                assertEquals("endpoint not allowed", e.message)
            }
        }
    }

    @Test
    fun aLeadingByteOrderMarkIsPreserved() = runBlocking {
        handle { ex ->
            val json = "{\"text\":\"bom\"}".toByteArray(Charsets.UTF_8)
            val bytes = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte()) + json
            ex.sendResponseHeaders(200, bytes.size.toLong())
            ex.responseBody.use { it.write(bytes) }
        }
        val response = transport.send(request())
        assertTrue(response.body.startsWith("\uFEFF"))
        assertEquals("\uFEFF{\"text\":\"bom\"}", response.body)
    }

    @Test
    fun aMultiByteCharacterAcrossTheChunkBoundaryIsDecodedWhole() = runBlocking {
        // The read chunk is 8 KiB: a 4-byte emoji starting 2 bytes before the boundary is split across two reads.
        val text = "a".repeat(8 * 1024 - 2) + "\uD83D\uDE00" + "z"
        handle { ex -> ex.reply(200, text) }
        assertEquals(text, transport.send(request()).body)
    }
}
