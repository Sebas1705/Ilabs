package es.sebas1705.ilabs.demo

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

/** The Android resource compiler lets a locale miss a key or change a placeholder, so check the vision strings here. */
class VisionResourcesTest {
    private fun document(dir: String): org.w3c.dom.Document {
        val file = File("src/main/res/$dir/strings.xml")
        assertTrue("missing ${file.absolutePath}", file.exists())
        return DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file)
    }

    private fun isVision(name: String) = name.startsWith("vision_") || name.startsWith("home_vision_")

    private fun strings(dir: String): Map<String, String> {
        val nodes = document(dir).getElementsByTagName("string")
        return (0 until nodes.length).map { nodes.item(it) as Element }
            .filter { isVision(it.getAttribute("name")) }
            .associate { it.getAttribute("name") to it.textContent }
    }

    private val placeholder = Regex("%(\\d+)\\$[a-z]")

    @Test
    fun bothLocalesDefineTheSameVisionStrings() {
        val en = strings("values")
        val es = strings("values-es")
        assertTrue("expected the vision strings, got ${en.size}", en.size > 55)
        assertEquals(en.keys, es.keys)
        for ((key, text) in en) {
            assertTrue("$key is empty in en", text.isNotBlank())
            assertTrue("$key is empty in es", es.getValue(key).isNotBlank())
        }
    }

    /** `vision_*` plurals as name to (quantity to placeholders). */
    private fun plurals(dir: String): Map<String, Map<String, List<String>>> {
        val nodes = document(dir).getElementsByTagName("plurals")
        return (0 until nodes.length).map { nodes.item(it) as Element }
            .filter { it.getAttribute("name").startsWith("vision_") }
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
        assertTrue("expected the vision plurals, got ${en.size}", en.size >= 4)
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
    fun everyKeyTheScreenReadsExists() {
        val screen = File("src/main/kotlin/es/sebas1705/ilabs/demo/VisionScreen.kt").readText()
        val used = Regex("R\\.(?:string|plurals)\\.(vision_\\w+)").findAll(screen).map { it.groupValues[1] }.toSet()
        assertTrue("expected the screen to use many keys, got ${used.size}", used.size > 40)
        val defined = strings("values").keys + plurals("values").keys
        for (key in used) assertTrue("missing $key", key in defined)
    }

    @Test
    fun everyErrorKindTheViewModelProducesHasAString() {
        val en = strings("values")
        for (key in listOf(
            "vision_error_invalid_options", "vision_error_invalid_spec", "vision_error_invalid_output",
            "vision_error_image", "vision_error_run", "home_vision_title", "home_vision_description",
        )) assertTrue("missing $key", key in en)
    }
}
