package es.sebas1705.ilabs.demo

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

/** The Android resource compiler lets a locale miss a key or change a placeholder, so check the rag strings here. */
class RagResourcesTest {
    private fun document(dir: String): org.w3c.dom.Document {
        val file = File("src/main/res/$dir/strings.xml")
        assertTrue("missing ${file.absolutePath}", file.exists())
        return DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file)
    }

    private fun isRag(name: String) = name.startsWith("rag_") || name.startsWith("home_rag_")

    private fun strings(dir: String): Map<String, String> {
        val nodes = document(dir).getElementsByTagName("string")
        return (0 until nodes.length).map { nodes.item(it) as Element }
            .filter { isRag(it.getAttribute("name")) }
            .associate { it.getAttribute("name") to it.textContent }
    }

    private val placeholder = Regex("%(\\d+)\\$[a-z]")

    @Test
    fun bothLocalesDefineTheSameRagStrings() {
        val en = strings("values")
        val es = strings("values-es")
        assertTrue("expected the rag strings, got ${en.size}", en.size > 60)
        assertEquals(en.keys, es.keys)
        for ((key, text) in en) {
            assertTrue("$key is empty in en", text.isNotBlank())
            assertTrue("$key is empty in es", es.getValue(key).isNotBlank())
        }
    }

    /** `rag_*` plurals as name to (quantity to placeholders). */
    private fun plurals(dir: String): Map<String, Map<String, List<String>>> {
        val nodes = document(dir).getElementsByTagName("plurals")
        return (0 until nodes.length).map { nodes.item(it) as Element }
            .filter { it.getAttribute("name").startsWith("rag_") }
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
        assertTrue("expected the rag plurals, got ${en.size}", en.size >= 6)
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
    fun everyGroupAndErrorKindHasAString() {
        val en = strings("values")
        for (key in listOf(
            "rag_group_search", "rag_group_context", "rag_group_answers", "rag_group_evaluation",
            "rag_error_invalid_options", "rag_error_no_embedder", "rag_error_invalid_embedding",
            "rag_error_rate_limit", "rag_error_timeout", "rag_error_invalid_output", "rag_error_unavailable",
            "home_rag_title", "home_rag_description",
        )) assertTrue("missing $key", key in en)
    }
}
