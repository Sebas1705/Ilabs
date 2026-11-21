package es.sebas1705.ilabs.vision

import es.sebas1705.ilabs.vision.contract.Fixture
import es.sebas1705.ilabs.vision.contract.checkOutcome
import es.sebas1705.ilabs.vision.contract.parseFixture
import es.sebas1705.ilabs.vision.contract.runFixture
import kotlinx.coroutines.test.runTest
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ContractTest {
    private fun contractsDir(): File {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            val candidate = File(dir, "contracts/vision")
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile
        }
        error("contracts/vision not found above ${System.getProperty("user.dir")}")
    }

    private val files: List<File> by lazy {
        contractsDir().listFiles { f -> f.extension == "json" }!!.sortedBy { it.name }
    }

    private val fixtures: List<Pair<File, Fixture>> by lazy { files.map { it to parseFixture(it.readText()) } }

    @Test
    fun loadsAllFixtures() {
        assertTrue(fixtures.size >= 348, "expected at least 348 fixtures, got ${fixtures.size}")
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
            failures += try {
                checkOutcome(fx, out).map { "$name: $it" }
            } catch (e: Exception) {
                listOf("$name: checkOutcome threw $e")
            }
        }
        assertTrue(failures.isEmpty(), "${failures.size} contract check(s) failed:\n" + failures.joinToString("\n"))
    }

    @Test
    fun fixtureNamesMatchTheirFiles() {
        val problems = fixtures.filter { (file, fx) -> fx.name != file.nameWithoutExtension }.map { it.first.name }
        assertEquals(emptyList(), problems)
    }

    /** Every file is `JSON.stringify(fixture, null, 2) + "\n"`: LF only, 2-space indentation and a trailing newline. */
    @Test
    fun fixtureFilesUseLfTwoSpaceIndentAndATrailingNewline() {
        val problems = files.filter { f ->
            val text = f.readText()
            val lines = text.removeSuffix("\n").lines()
            '\r' in text || !text.endsWith("}\n") || text.endsWith("\n\n") || lines.any { it.startsWith("\t") } ||
                lines.drop(1).dropLast(1).any { it.isNotEmpty() && !it.startsWith("  ") } || lines.first() != "{"
        }.map { it.name }
        assertEquals(emptyList(), problems)
    }
}
