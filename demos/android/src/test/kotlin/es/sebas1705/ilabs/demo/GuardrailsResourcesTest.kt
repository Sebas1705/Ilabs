package es.sebas1705.ilabs.demo

import es.sebas1705.ilabs.guardrails.InjectionCategory
import es.sebas1705.ilabs.guardrails.PiiKind
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

/** The Android resource compiler lets a locale miss a key or change a placeholder, so check the guardrails strings here. */
class GuardrailsResourcesTest {
    private fun document(dir: String): org.w3c.dom.Document {
        val file = File("src/main/res/$dir/strings.xml")
        assertTrue("missing ${file.absolutePath}", file.exists())
        return DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file)
    }

    private fun isGuard(name: String) = name.startsWith("guard_") || name.startsWith("home_guard")

    private fun strings(dir: String): Map<String, String> {
        val nodes = document(dir).getElementsByTagName("string")
        return (0 until nodes.length).map { nodes.item(it) as Element }
            .filter { isGuard(it.getAttribute("name")) }
            .associate { it.getAttribute("name") to it.textContent }
    }

    private val placeholder = Regex("%(\\d+)\\$[a-z]")

    @Test
    fun bothLocalesDefineTheSameGuardrailsStrings() {
        val en = strings("values")
        val es = strings("values-es")
        assertTrue("expected the guardrails strings, got ${en.size}", en.size > 80)
        assertEquals(en.keys, es.keys)
        for ((key, text) in en) {
            assertTrue("$key is empty in en", text.isNotBlank())
            assertTrue("$key is empty in es", es.getValue(key).isNotBlank())
        }
    }

    /** `guard_*` plurals as name to (quantity to placeholders). */
    private fun plurals(dir: String): Map<String, Map<String, List<String>>> {
        val nodes = document(dir).getElementsByTagName("plurals")
        return (0 until nodes.length).map { nodes.item(it) as Element }
            .filter { it.getAttribute("name").startsWith("guard_") }
            .associate { el ->
                val items = el.getElementsByTagName("item")
                el.getAttribute("name") to (0 until items.length).map { items.item(it) as Element }.associate {
                    it.getAttribute("quantity") to placeholder.findAll(it.textContent).map { m -> m.value }.sorted().toList()
                }
            }
    }

    @Test
    fun bothLocalesUseTheSamePluralsAndPlaceholders() {
        val en = plurals("values")
        assertTrue("expected the guardrails plurals, got ${en.size}", en.size >= 5)
        assertEquals(en, plurals("values-es"))
        for ((name, items) in en) {
            assertEquals("$name quantities", setOf("one", "other"), items.keys)
            // Every item shows the count, so no quantity can drop it.
            for ((quantity, ph) in items) assertTrue("$name/$quantity", "%1\$d" in ph)
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

    @Test
    fun everyGroupActionKindAndErrorHasAString() {
        val en = strings("values")
        val keys = listOf(
            "guard_group_pii", "guard_group_injection", "guard_group_checks",
            "guard_action_off", "guard_action_flag", "guard_action_redact", "guard_action_block",
            "guard_status_ok", "guard_status_blocked_input", "guard_status_blocked_output",
            "guard_error_invalid_policy", "guard_error_invalid_options", "guard_error_no_classifier",
            "guard_error_rate_limit", "guard_error_timeout", "guard_error_invalid_output", "guard_error_unavailable",
            "guard_check_pii", "guard_check_injection", "guard_check_denyterms", "guard_check_maxlength",
            "guard_check_canary", "guard_check_classifier",
            "home_guardrails_title", "home_guardrails_description",
        ) + PiiKind.entries.map { "guard_kind_${it.wire}" } + InjectionCategory.entries.map { "guard_category_${it.wire}" }
        for (key in keys) assertTrue("missing $key", key in en)
    }

    @Test
    fun guardedStatusAndCapWordingMatchesTheWebPage() {
        val en = strings("values")
        val es = strings("values-es")
        assertEquals("Blocked: an input check blocked the request.", en["guard_status_line_blocked_input"])
        assertEquals("Blocked: an output check blocked the reply.", en["guard_status_line_blocked_output"])
        assertEquals("Bloqueada: una comprobación de entrada bloqueó la petición.", es["guard_status_line_blocked_input"])
        assertEquals("Bloqueada: una comprobación de salida bloqueó la respuesta.", es["guard_status_line_blocked_output"])
        assertEquals("+%1\$d more", en["guard_more_findings"])
        assertEquals("+%1\$d más", es["guard_more_findings"])
        for (locale in listOf("values", "values-es")) {
            val items = document(locale).getElementsByTagName("plurals").let { nodes ->
                (0 until nodes.length).map { nodes.item(it) as Element }.first { it.getAttribute("name") == "guard_status_ok_calls" }
            }.textContent
            assertTrue(locale, if (locale == "values") items.contains("Completed, %1\$d model call") else items.contains("Completado, %1\$d llamada"))
        }
        // The large-text note states both the character preview and the list cap.
        assertTrue(en.getValue("guard_large_text").contains("%1\$d characters") && en.getValue("guard_large_text").contains("%2\$d entries"))
    }

    @Test
    fun everyGuardStringIsReferencedByTheCode() {
        val sources = File("src/main/kotlin/es/sebas1705/ilabs/demo").listFiles { f -> f.extension == "kt" }!!.joinToString("\n") { it.readText() }
        val names = strings("values").keys + plurals("values").keys
        val unused = names.filter { !sources.contains("R.string.$it") && !sources.contains("R.plurals.$it") && !it.startsWith("home_guard") }
        assertTrue("unused strings: $unused", unused.isEmpty())
    }
}
