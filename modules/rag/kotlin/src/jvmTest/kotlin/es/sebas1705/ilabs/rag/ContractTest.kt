package es.sebas1705.ilabs.rag

import es.sebas1705.ilabs.rag.contract.Fixture
import es.sebas1705.ilabs.rag.contract.checkOutcome
import es.sebas1705.ilabs.rag.contract.parseFixture
import es.sebas1705.ilabs.rag.contract.runFixture
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ContractTest {
    private fun contractsDir(): File {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            val candidate = File(dir, "contracts/rag")
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile
        }
        error("contracts/rag not found above ${System.getProperty("user.dir")}")
    }

    private val files: List<File> by lazy {
        contractsDir().listFiles { f -> f.extension == "json" }!!.sortedBy { it.name }
    }

    private val fixtures: List<Pair<File, Fixture>> by lazy { files.map { it to parseFixture(it.readText()) } }

    @Test
    fun loadsAllFixtures() {
        assertTrue(fixtures.size >= 144, "expected at least 144 fixtures, got ${fixtures.size}")
    }

    @Test
    fun everyFixtureMatchesItsExpectation() = runTest {
        val failures = mutableListOf<String>()
        for ((file, fx) in fixtures) {
            val name = file.nameWithoutExtension
            val out = try {
                runFixture(fx)
            } catch (e: Exception) {
                failures += "$name: threw $e"
                continue
            }
            failures += checkOutcome(fx, out).map { "$name: $it" }
        }
        assertTrue(failures.isEmpty(), "${failures.size} contract check(s) failed:\n" + failures.joinToString("\n"))
    }

    @Test
    fun fixtureNamesMatchTheirFiles() {
        val problems = fixtures.filter { (file, fx) -> fx.name != file.nameWithoutExtension }.map { it.first.name }
        assertEquals(emptyList(), problems)
    }

    /** Every file is `JSON.stringify(fixture, null, 2) + "\n"`: LF only and a trailing newline. */
    @Test
    fun fixtureFilesUseLfAndATrailingNewline() {
        val problems = files.filter { f ->
            val text = f.readText()
            '\r' in text || !text.endsWith("}\n")
        }.map { it.name }
        assertEquals(emptyList(), problems)
    }

    @Test
    fun loneSurrogateEscapesSurviveParsing() {
        val setup = fixtures.first { it.first.nameWithoutExtension == "tokens-lone-surrogate" }.second.root["setup"] as JsonObject
        val text = (setup["text"] as JsonPrimitive).content
        assertTrue(text.any { it in '\uD800'..'\uDFFF' })
        assertEquals(listOf("a\uD800b", "\uDC00", "x\uD83D", "\uDE00\uD83D"), tokenize(text))
    }
}
