package es.sebas1705.ilabs.demo

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

/** The Android resource compiler lets a locale miss a key or change a placeholder, so check the assistant strings here. */
class AssistantResourcesTest {
    private fun document(dir: String): org.w3c.dom.Document {
        val file = File("src/main/res/$dir/strings.xml")
        assertTrue("missing ${file.absolutePath}", file.exists())
        return DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file)
    }

    private fun isAssistant(name: String) = name.startsWith("assistant_") || name.startsWith("home_assistant_")

    private fun strings(dir: String): Map<String, String> {
        val nodes = document(dir).getElementsByTagName("string")
        return (0 until nodes.length).map { nodes.item(it) as Element }
            .filter { isAssistant(it.getAttribute("name")) }
            .associate { it.getAttribute("name") to it.textContent }
    }

    private val placeholder = Regex("%(\\d+)\\$[a-z]")

    @Test
    fun bothLocalesDefineTheSameAssistantStringsAndNoneIsBlank() {
        val en = strings("values")
        val es = strings("values-es")
        assertTrue("expected the assistant strings, got ${en.size}", en.size > 70)
        assertEquals(en.keys, es.keys)
        for ((key, text) in en) {
            assertTrue("$key is empty in en", text.isNotBlank())
            assertTrue("$key is empty in es", es.getValue(key).isNotBlank())
        }
    }

    @Test
    fun bothLocalesUseTheSamePlaceholdersInEachString() {
        val en = strings("values")
        val es = strings("values-es")
        for ((key, text) in en) {
            val a = placeholder.findAll(text).map { it.value }.sorted().toList()
            val b = placeholder.findAll(es.getValue(key)).map { it.value }.sorted().toList()
            assertEquals(key, a, b)
        }
    }

    private fun plurals(dir: String): Map<String, Map<String, List<String>>> {
        val nodes = document(dir).getElementsByTagName("plurals")
        return (0 until nodes.length).map { nodes.item(it) as Element }
            .filter { it.getAttribute("name").startsWith("assistant_") }
            .associate { el ->
                val items = el.getElementsByTagName("item")
                el.getAttribute("name") to (0 until items.length).map { items.item(it) as Element }.associate {
                    it.getAttribute("quantity") to placeholder.findAll(it.textContent).map { m -> m.value }.sorted().toList()
                }
            }
    }

    @Test
    fun bothLocalesUseTheSamePluralsAndEveryItemShowsItsNumbers() {
        val en = plurals("values")
        assertEquals(setOf("assistant_trace_redactions"), en.keys)
        assertEquals(en, plurals("values-es"))
        for ((name, items) in en) {
            assertEquals("$name quantities", setOf("one", "other"), items.keys)
            for ((quantity, ph) in items) assertTrue("$name/$quantity", "%1\$d" in ph)
        }
    }

    @Test
    fun everyKindCaseAndMockReplyTheCodeNamesHasAString() {
        val en = strings("values")
        val keys = buildList {
            for (kind in listOf("rate_limit", "timeout", "unavailable", "invalid_output", "blocked", "budget")) add("assistant_kind_$kind")
            for (kind in listOf("rate_limit", "timeout", "unavailable", "invalid_output", "blocked", "budget")) add("assistant_error_$kind")
            for (case in listOf("greeting", "capabilities", "email_not_echoed", "phone_not_echoed", "followup", "leaked")) add("assistant_eval_$case")
            for (i in 1..4) add("assistant_mock_reply_$i")
            addAll(listOf("home_assistant_title", "home_assistant_description", "assistant_blocked_text", "assistant_thinking", "assistant_input_hint"))
        }
        for (key in keys) assertNotNull("missing $key", en[key])
        assertEquals(AssistantEvals.suite.cases.size, 5)
    }

    @Test
    fun theKeyNoteSaysItIsSentButNeverStored() {
        assertTrue(strings("values").getValue("assistant_key_note").contains("never stored"))
        assertTrue(strings("values-es").getValue("assistant_key_note").contains("nunca se guarda"))
    }

    @Test
    fun theManifestAllowsTheNetworkAndCleartextOnlyForTheDevelopmentHosts() {
        val manifest = File("src/main/AndroidManifest.xml").readText()
        assertTrue(manifest.contains("android.permission.INTERNET"))
        assertTrue(manifest.contains("@xml/network_security_config"))
        val config = File("src/main/res/xml/network_security_config.xml").readText()
        assertTrue(config.contains("<base-config cleartextTrafficPermitted=\"false\""))
        val allowed = Regex("<domain[^>]*>([^<]+)</domain>").findAll(config).map { it.groupValues[1] }.toSet()
        assertEquals(AssistantEndpoint.DEV_HOSTS, allowed)
    }
}

class AssistantEndpointTest {
    private fun check(text: String) = AssistantEndpoint.check(text)

    @Test
    fun emptyIsEmpty() {
        assertEquals(EndpointCheck.Empty, check(""))
        assertEquals(EndpointCheck.Empty, check("   "))
    }

    @Test
    fun httpsIsAcceptedForAnyHost() {
        for (url in listOf("https://gateway.example.com", "https://gateway.example.com/", "https://g.example.com:8443/base", "HTTPS://Gateway.Example.com")) {
            assertEquals(url, EndpointCheck.Ok(url), check(url))
        }
        assertEquals(EndpointCheck.Ok("https://g.example.com"), check("  https://g.example.com  "))
    }

    @Test
    fun plainHttpIsAcceptedOnlyForTheThreeDevelopmentHosts() {
        for (url in listOf("http://localhost", "http://localhost:8787", "http://127.0.0.1:8787/x", "http://10.0.2.2:8787", "http://LOCALHOST:1")) {
            assertEquals(url, EndpointCheck.Ok(url), check(url))
        }
        for (url in listOf(
            "http://example.com", "http://192.168.1.5:8787", "http://10.0.2.3", "http://localhost.evil.example", "http://127.0.0.1.evil.example",
            "http://[::1]:8787",
        )) {
            assertEquals(url, EndpointCheck.Invalid, check(url))
        }
    }

    @Test
    fun aQueryOrAFragmentIsRefused() {
        for (url in listOf("https://g.example.com/p?x=1", "https://g.example.com?", "https://g.example.com/p#frag", "https://g.example.com/#", "http://localhost:8787/p?a=b")) {
            assertEquals(url, EndpointCheck.Invalid, check(url))
        }
        assertEquals(EndpointCheck.Ok("https://g.example.com/p"), check("https://g.example.com/p"))
    }

    @Test
    fun otherSchemesHostlessOrTrickyAddressesAreRefused() {
        for (url in listOf(
            "ftp://example.com", "file:///etc/passwd", "javascript:alert(1)", "example.com", "//example.com", "https://", "https:///x",
            "http://localhost@evil.example", "https://user:pw@example.com", "https://exa mple.com", "https://example.com\nHost: x", "gateway",
        )) {
            assertEquals(url, EndpointCheck.Invalid, check(url))
        }
    }

    // The same table of accept/reject cases as the web twin (`backends.test.ts`).
    @Test
    fun theSharedAcceptRejectTable() {
        val table = listOf(
            "https://gw.example.test" to true, "  https://gw.example.test/prefix/  " to true, "https://gw.example.test:8443" to true,
            "http://localhost" to true, "http://localhost:8787" to true, "http://127.0.0.1:8787/" to true, "http://10.0.2.2:8787" to true,
            "http://gw.example.test" to false, "http://localhost.evil.test" to false, "http://192.168.1.5:8787" to false,
            "ftp://gw.example.test" to false, "gw.example.test" to false, "https://" to false,
            "https://user:pass@gw.example.test" to false, "https://gw.example.test/?a=1" to false, "https://gw.example.test/#x" to false,
            "https://gw.example.test/a b" to false, "https:\\\\gw.example.test" to false, "javascript:alert(1)" to false,
            "HTTPS://gw.example.test" to true, "Https://gw.example.test/prefix" to true, "HTTP://localhost:8787" to true,
            "HtTp://127.0.0.1:8787" to true, "HTTP://gw.example.test" to false, "HTTP://localhost.evil.test" to false,
            "FTP://gw.example.test" to false, "HTTPS://user:pass@gw.example.test" to false,
            "http://localhost:99999" to false, "http://localhost:0" to false, "http://localhost:" to false,
            "http://127.1" to false, "https://127.1" to false, "https://256.1.1.1" to false, "https://1.2.3.4" to true,
            "https://exa_mple.com" to false, "HTTPS://Example.com" to true, "https://a.b:443/" to true,
            "https://a.b:65535" to true, "https://a.b:65536" to false, "https://a.b///" to true,
            "https://u@h" to false, "https://h?x=1" to false, "https://h#f" to false,
            "https://[::1]:8443" to true, "http://[::1]:8787" to false, "https://[zz]" to false,
            "https://-a.com" to false, "https://a..com" to false,
        )
        for ((url, accepted) in table) {
            val expected: EndpointCheck = if (accepted) EndpointCheck.Ok(url.trim()) else EndpointCheck.Invalid
            assertEquals(url, expected, check(url))
        }
    }

    @Test
    fun theSameRuleDecidesWhatTheTransportMayOpen() {
        assertTrue(AssistantEndpoint.isAllowed("http://10.0.2.2:8787/v1/complete"))
        assertFalse(AssistantEndpoint.isAllowed("http://example.com/v1/complete"))
    }
}

class AssistantTraceTest {
    @Test
    fun everyEventSurvivesEncodeAndDecode() {
        val events = listOf(
            TraceEvent(TraceKind.WINDOW, listOf("4", "3", "120", "600")),
            TraceEvent(TraceKind.REDACTIONS, listOf("email", "2", "secret", "1")),
            TraceEvent(TraceKind.REDACTIONS, listOf(AssistantEngine.REDACTION_OFF)),
            TraceEvent(TraceKind.ATTEMPT, listOf("gateway", "1")),
            TraceEvent(TraceKind.FAILURE, listOf("gateway", "rate_limit")),
            TraceEvent(TraceKind.WAIT, listOf("1500", "rate_limit")),
            TraceEvent(TraceKind.FALLBACK, listOf("timeout")),
            TraceEvent(TraceKind.ANSWERED, listOf("mock", "timeout")),
            TraceEvent(TraceKind.BLOCKED),
        )
        assertEquals(TraceKind.entries.toSet(), events.map { it.kind }.toSet())
        for (e in events) assertEquals(e, TraceEvent.decode(e.encode()))
    }

    @Test
    fun anUnknownKindDecodesToNothing() {
        assertNull(TraceEvent.decode("NOPE"))
        assertNull(TraceEvent.decode(""))
    }

    @Test
    fun aChatEntrySurvivesEncodeAndDecodeWithAnyText() {
        for (entry in listOf(
            ChatEntry(ChatRole.USER, "multi\nline ¿qué? 😀"),
            ChatEntry(ChatRole.ASSISTANT, "", inHistory = false),
            ChatEntry(ChatRole.BLOCKED, inHistory = false),
        )) {
            assertEquals(entry, ChatEntry.decode(entry.encode()))
        }
        assertNull(ChatEntry.decode("U"))
        assertNull(ChatEntry.decode("X1text"))
    }
}
