package es.sebas1705.ilabs.vision

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Source-level rules of the vision module: the doubles contract forbids library rounding and `float32`. */
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
        upFrom("modules/vision/kotlin/src/commonMain").walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()

    private fun code(file: File): String {
        val text = file.readText()
        // drop block comments (KDoc included) and line comments, keep the code
        val noBlocks = Regex("/\\*.*?\\*/", RegexOption.DOT_MATCHES_ALL).replace(text, "")
        return noBlocks.lines().joinToString("\n") { it.substringBefore("//") }
    }

    private fun isHarness(file: File) = file.parentFile.name == "contract"

    @Test
    fun thereAreLibrarySources() {
        assertTrue(mainSources().size >= 12, mainSources().map { it.name }.toString())
    }

    @Test
    fun noSourceUsesLibraryRoundingOrFloatingPointOtherThanDoubles() {
        val forbidden = listOf(
            "roundToInt", "roundToLong", "Math.round", "rint(", ".round(", "toFloat", "Math.fround", "Math.fma", "StrictMath", "fma(", "kotlin.math.round",
            "Regex", "toRegex", "String.format", "lowercase", "uppercase", "toLowerCase", "toUpperCase", ".isLetter", ".isDigit", "isWhitespace",
            "toIntOrNull", "toDoubleOrNull", "intOrNull", "longOrNull", ".doubleOrNull", "toLongOrNull", "ignoreCase", "locale", "Locale",
        )
        val problems = mutableListOf<String>()
        val floatWord = Regex("\\bFloat(Array)?\\b|\\b\\d+(\\.\\d+)?[fF]\\b")
        for (file in mainSources()) {
            val text = code(file)
            for (token in forbidden) if (token in text && !(isHarness(file) && token in setOf("lowercase"))) problems += "${file.name}: $token"
            if (floatWord.containsMatchIn(text)) problems += "${file.name}: Float"
        }
        assertEquals(emptyList(), problems)
    }

    @Test
    fun theLibraryNeverUsesNotNullAssertionsOrJavaApis() {
        val problems = mutableListOf<String>()
        for (file in mainSources()) {
            val text = code(file)
            if ("!!" in text && !isHarness(file)) problems += "${file.name}: !!"
            if (Regex("\\bjava\\.|\\bjavax\\.").containsMatchIn(text)) problems += "${file.name}: java.*"
            if (Regex("\\bMath\\.").containsMatchIn(text)) problems += "${file.name}: Math."
        }
        assertEquals(emptyList(), problems)
    }

    @Test
    fun thePublicLibraryCatchesNothingAtAll() {
        val problems = mainSources().filter { !isHarness(it) }.filter { "catch (" in code(it) || "catch(" in code(it) || "runCatching" in code(it) }
        assertEquals(emptyList(), problems.map { it.name })
    }

    @Test
    fun theHarnessCatchesOnlyVisionAndItsOwnModelError() {
        val problems = mutableListOf<String>()
        for (file in mainSources().filter { isHarness(it) }) {
            for (line in code(file).lines()) {
                val at = line.indexOf("catch (")
                if (at < 0) continue
                val type = line.substring(at + "catch (".length).substringAfter(":").substringBefore(")").trim()
                if (type !in setOf("VisionException", "FixtureModelError")) problems += "${file.name}: $line"
            }
        }
        assertEquals(emptyList(), problems)
    }

    @Test
    fun onlyTheLibraryApiIsPublicInTheMainPackage() {
        val publicTopLevel = Regex("^(?:data |sealed |enum |fun |suspend )?(?:class|interface|object|fun|val|const val|typealias)\\s+([A-Za-z_]+)", RegexOption.MULTILINE)
        val names = mainSources().filter { !isHarness(it) }.flatMap { f ->
            code(f).lines().filter { line -> line.isNotEmpty() && !line.startsWith(" ") && !line.startsWith("private") && !line.startsWith("internal") && !line.startsWith("@") }
                .mapNotNull { publicTopLevel.find(it)?.groupValues?.get(1) }
        }.toSet()
        val api = setOf(
            "VisionErrorKind", "VisionException", "Image", "ImageSize", "TensorLayout", "ChannelOrder", "ResizeMode", "ResizeMethod", "InputDType", "InputSpec",
            "ScoreType", "BoxOrder", "Coordinates", "BoxFormat", "ScoreActivation", "OutputSpec", "ModelSpec", "parseModelSpec", "Box", "Geometry",
            "preprocessGeometry", "unmapBox", "Tensor", "Prepared", "toTensor", "ClassEntry", "postprocessClassification", "Detection", "DetectionOptions",
            "postprocessDetections", "iou", "nms", "ScoredDetection", "Truth", "ClassAp", "ApResult", "MapResult", "topKAccuracy", "averagePrecision",
            "meanAveragePrecision", "VisionModel", "Clock", "ScriptedModel", "scriptedModel", "Timing", "ClassifyResult", "DetectResult", "classify", "detect", "resize",
        )
        assertEquals(emptySet(), names - api)
        assertEquals(emptySet(), api - names)
    }

    @Test
    fun roundingGoesThroughFloorOfPlusOneHalf() {
        val all = mainSources().filter { !isHarness(it) }.joinToString("\n") { code(it) }
        assertTrue("floor(" in all)
        assertTrue("+ 0.5" in all)
    }
}
