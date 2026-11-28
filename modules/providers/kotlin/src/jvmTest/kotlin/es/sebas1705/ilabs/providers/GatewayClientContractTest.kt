package es.sebas1705.ilabs.providers

import es.sebas1705.ilabs.providers.contract.runGatewayClientFixture

import kotlinx.coroutines.test.runTest
import java.io.File
import kotlin.test.Test
import kotlin.test.assertTrue

/** Runs every `client-*.json` fixture of contracts/gateway against [HttpProvider]. */
class GatewayClientContractTest {
    private fun gatewayDir(): File {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            val candidate = File(dir, "contracts/gateway")
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile
        }
        error("contracts/gateway not found above ${System.getProperty("user.dir")}")
    }

    private val allFiles: List<File> by lazy {
        gatewayDir().listFiles { f -> f.extension == "json" }!!.sortedBy { it.name }
    }

    private val clientFiles: List<File> by lazy { allFiles.filter { it.name.startsWith("client-") } }

    @Test
    fun theGatewayFolderHasAllItsFixtures() {
        assertTrue(allFiles.size >= 549, "expected at least 549 fixtures, got ${allFiles.size}")
    }

    @Test
    fun loadsAllClientFixtures() {
        assertTrue(clientFiles.size >= 149, "expected at least 149 client fixtures, got ${clientFiles.size}")
    }

    @Test
    fun everyClientFixtureMatchesItsExpectation() = runTest {
        val failures = mutableListOf<String>()
        for (file in clientFiles) {
            try {
                failures += runGatewayClientFixture(file.readText(Charsets.UTF_8), file.nameWithoutExtension)
            } catch (e: IllegalStateException) {
                failures += "${file.name}: ${e.message}"
            }
        }
        assertTrue(failures.isEmpty(), "${failures.size} gateway client check(s) failed:\n" + failures.joinToString("\n"))
    }
}
