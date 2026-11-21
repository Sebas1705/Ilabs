package es.sebas1705.ilabs.rag

import es.sebas1705.ilabs.rag.contract.parseFixture
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** `tokenize` is the `token` projection of `tokenizeSpans` on every shared `tokens-*` fixture. */
class TokenSpansContractTest {
    private fun contractsDir(): File {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            val candidate = File(dir, "contracts/rag")
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile
        }
        error("contracts/rag not found above ${System.getProperty("user.dir")}")
    }

    @Test
    fun tokenizeEqualsTheTokenProjectionOnEveryTokensFixture() {
        val files = contractsDir().listFiles { f -> f.name.startsWith("tokens-") && f.extension == "json" }!!.sortedBy { it.name }
        assertTrue(files.size >= 14, "expected the tokens-* fixtures, got ${files.size}")
        for (file in files) {
            val setup = parseFixture(file.readText()).root["setup"] as JsonObject
            val text = (setup["text"] as JsonPrimitive).content
            val spans = tokenizeSpans(text)
            assertEquals(tokenize(text), spans.map { it.token }, file.name)
            // every span is ordered, non-empty and inside the text (code points)
            val length = codePoints(text).size
            var previousEnd = 0
            for (span in spans) {
                assertTrue(span.start >= previousEnd && span.end > span.start && span.end <= length, "${file.name}: $span")
                previousEnd = span.end
            }
        }
    }
}
