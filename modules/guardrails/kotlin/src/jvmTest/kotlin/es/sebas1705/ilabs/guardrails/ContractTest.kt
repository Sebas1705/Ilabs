package es.sebas1705.ilabs.guardrails

import es.sebas1705.ilabs.guardrails.contract.Fixture
import es.sebas1705.ilabs.guardrails.contract.checkOutcome
import es.sebas1705.ilabs.guardrails.contract.parseFixture
import es.sebas1705.ilabs.guardrails.contract.runFixture
import kotlinx.coroutines.test.runTest
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ContractTest {
    private fun contractsDir(): File {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            val candidate = File(dir, "contracts/guardrails")
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile
        }
        error("contracts/guardrails not found above ${System.getProperty("user.dir")}")
    }

    private val files: List<File> by lazy {
        contractsDir().listFiles { f -> f.extension == "json" }!!.sortedBy { it.name }
    }

    private val fixtures: List<Pair<File, Fixture>> by lazy { files.map { it to parseFixture(it.readText()) } }

    @Test
    fun loadsAllFixtures() {
        assertTrue(fixtures.size >= 265, "expected at least 265 fixtures, got ${fixtures.size}")
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

    /** Every file is `JSON.stringify(fixture, null, 2) + "\n"`: LF only and a trailing newline. */
    @Test
    fun fixtureFilesUseLfAndATrailingNewline() {
        val problems = files.filter { f ->
            val text = f.readText()
            '\r' in text || !text.endsWith("}\n")
        }.map { it.name }
        assertEquals(emptyList(), problems)
    }
}
