package es.sebas1705.ilabs.guardrails

import es.sebas1705.ilabs.guardrails.contract.checkOutcome
import es.sebas1705.ilabs.guardrails.contract.parseFixture
import es.sebas1705.ilabs.guardrails.contract.runFixture
import kotlinx.coroutines.test.runTest
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Source-level rules of the contract logic, and the `table` fixture's sensitivity to a one-character slip. */
class SourceRulesTest {
    private fun upFrom(path: String): File {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            val candidate = File(dir, path)
            if (candidate.exists()) return candidate
            dir = dir.parentFile
        }
        error("$path not found above ${System.getProperty("user.dir")}")
    }

    private fun mainSources(): List<File> =
        upFrom("modules/guardrails/kotlin/src/commonMain").walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()

    private fun code(file: File): String =
        file.readLines().filterNot { it.trimStart().startsWith("//") || it.trimStart().startsWith("*") || it.trimStart().startsWith("/**") }.joinToString("\n")

    @Test
    fun contractLogicAvoidsUnicodeAwareAndRegexCalls() {
        val forbidden = listOf(
            "lowercase(", "uppercase(", ".isLetter", ".isDigit", ".isWhitespace", ".isLetterOrDigit", "Regex", "toRegex", "String.format",
            "ignoreCase", ".trim(", "trim()", ".split(", "toIntOrNull", "intOrNull", "encodeToByteArray", "toLowerCase", "toUpperCase", "!!",
        )
        val problems = mutableListOf<String>()
        for (file in mainSources()) {
            val text = code(file)
            // the harness may use `!!` only after its own shape checks; the library never does
            for (token in forbidden) if (token in text && !(token == "!!" && file.name == "Contract.kt")) problems += "${file.name}: $token"
        }
        assertEquals(emptyList(), problems)
    }

    @Test
    fun noCatchSwallowsCancellationOrErrors() {
        val allowed = setOf("GuardrailException", "ProviderException")
        val problems = mutableListOf<String>()
        for (file in mainSources()) {
            for (line in code(file).lines()) {
                val at = line.indexOf("catch (")
                if (at < 0) continue
                val type = line.substring(at + "catch (".length).substringAfter(":").substringBefore(")").trim()
                if (type !in allowed) problems += "${file.name}: $line"
            }
        }
        assertEquals(emptyList(), problems)
        // and the library itself catches nothing at all
        assertTrue(mainSources().filter { it.parentFile.name != "contract" }.none { "catch (" in code(it) })
    }

    @Test
    fun onlyTheLibraryApiAndPinnedConstantsArePublicInTheMainPackage() {
        val publicTopLevel = Regex("^(?:data |sealed |enum |fun )?(?:class|interface|object|fun|val|const val|typealias)\\s+([A-Za-z_]+)", RegexOption.MULTILINE)
        val names = mainSources().filter { it.parentFile.name != "contract" }.flatMap { f ->
            code(f).lines().filter { line -> line.isNotEmpty() && !line.startsWith(" ") && !line.startsWith("private") && !line.startsWith("internal") }
                .mapNotNull { publicTopLevel.find(it)?.groupValues?.get(1) }
        }.toSet()
        val constants = setOf("PII_KINDS", "PLACEHOLDER_NAMES", "SECRET_PREFIXES", "DNI_LETTERS", "CANARY_PREFIX", "CANARY_SUFFIX", "CANARY_WHITESPACE", "DEFAULT_BLOCKED_TEXT", "METRIC_KINDS", "INJECTION_TABLE")
        assertTrue(names.containsAll(constants), "missing constants: ${constants - names}")
        val api = setOf(
            "GuardrailErrorKind", "GuardrailException", "PiiKind", "PiiFinding", "detectPii", "Mapping", "Redacted", "redact", "restore",
            "InjectionCategory", "InjectionSignal", "InjectionResult", "InjectionEntry", "detectInjection", "Action", "CheckKind", "Check",
            "Policy", "parsePolicy", "Classification", "Classifier", "DenyMatch", "CheckDetails", "CheckFinding", "CheckVerdict", "CheckResult",
            "checkText", "GuardedStatus", "GuardedResult", "guardedComplete", "GuardedProvider", "withCanary", "MetricSpan", "KindMetrics",
            "Metrics", "detectionMetrics",
        )
        assertEquals(emptySet(), names - constants - api)
    }

    @Test
    fun theTableFixtureNoticesATranscriptionSlip() = runTest {
        val raw = upFrom("contracts/guardrails/table-pinned-constants.json").readText()
        suspend fun failures(text: String) = parseFixture(text).let { checkOutcome(it, runFixture(it)) }
        assertEquals(emptyList(), failures(raw))
        assertTrue(failures(raw.replaceFirst("\"maxGap\": 3", "\"maxGap\": 2")).isNotEmpty())
        assertTrue(failures(raw.replaceFirst("\"weight\": 50", "\"weight\": 51")).isNotEmpty())
        assertTrue(failures(raw.replaceFirst("\"disregard\",", "")).isNotEmpty())
        assertTrue(failures(raw.replaceFirst("TRWAG", "TRWAH")).isNotEmpty())
        assertTrue(failures(raw.replaceFirst("\"lineStart\": true", "\"lineStart\": false")).isNotEmpty())
    }
}
