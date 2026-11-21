package es.sebas1705.ilabs.vision

import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** One test per validation rule of `parseModelSpec` (in addition to the `spec-*` fixtures). */
class SpecTest {
    private fun reason(json: String): String {
        val e = assertFailsWith<VisionException> { parseModelSpec(json) }
        assertEquals(VisionErrorKind.INVALID_SPEC, e.kind)
        val message = e.message ?: ""
        assertTrue(message.startsWith("invalid model spec: "), message)
        return message.removePrefix("invalid model spec: ")
    }

    private fun inputWith(old: String, new: String): String {
        assertTrue(old in INPUT_JSON, old)
        return INPUT_JSON.replace(old, new)
    }

    private fun inputWithout(key: String): String {
        val parts = INPUT_JSON.removePrefix("{").removeSuffix("}").split(",").filterNot { it.startsWith("\"$key\"") }
        return "{" + parts.joinToString(",") + "}"
    }

    private fun inputPlus(extra: String) = INPUT_JSON.removeSuffix("}") + ",$extra}"

    @Test
    fun rule1SpecMustBeAnObject() {
        for (text in listOf("[]", "5", "null", "\"x\"", "true")) assertEquals("spec must be an object", reason(text))
    }

    @Test
    fun rule2UnknownTopLevelKey() {
        assertEquals("unknown key: extra", reason(specJson(rest = ""","extra":1""")))
        assertEquals("unknown key: labelsX", reason(specJson(rest = ""","labelsX":[]""")))
    }

    @Test
    fun rule3MissingInputAndOutput() {
        assertEquals("missing key: input", reason("""{"output":{"type":"logits"}}"""))
        assertEquals("missing key: output", reason("""{"input":$INPUT_JSON}"""))
    }

    @Test
    fun rule4InputMustBeAnObject() {
        assertEquals("input must be an object", reason("""{"input":[],"output":{"type":"logits"}}"""))
        assertEquals("input must be an object", reason("""{"input":null,"output":{"type":"logits"}}"""))
    }

    @Test
    fun rule5UnknownInputKey() {
        assertEquals("unknown key: input.extra", reason(specJson(input = inputPlus("\"extra\":1"))))
    }

    @Test
    fun rule6RequiredInputKeysInOrder() {
        for (key in listOf("width", "height", "layout", "channels", "mode", "resample", "dtype")) {
            assertEquals("missing key: input.$key", reason(specJson(input = inputWithout(key))), key)
        }
        // the order of the missing keys is the listed one
        assertEquals("missing key: input.width", reason(specJson(input = "{}")))
        assertEquals("missing key: input.dtype", reason(specJson(input = """{"width":1,"height":1,"layout":"nhwc","channels":"rgb","mode":"stretch","resample":"nearest"}""")))
    }

    @Test
    fun rule7SizesAreIntegersFrom1To16384() {
        for (bad in listOf("0", "-1", "16385", "224.5", "\"224\"", "null", "true", "[]", "1e999", "1e300")) {
            assertEquals("input.width must be an integer from 1 to 16384", reason(specJson(input = inputWith("\"width\":2", "\"width\":$bad"))), bad)
            assertEquals("input.height must be an integer from 1 to 16384", reason(specJson(input = inputWith("\"height\":2", "\"height\":$bad"))), bad)
        }
        assertEquals(16384, spec(input = inputWith("\"width\":2", "\"width\":16384")).input.width)
        assertEquals(1, spec(input = inputWith("\"height\":2", "\"height\":1")).input.height)
    }

    @Test
    fun integersAreJudgedByValue() {
        val parsed = spec(input = inputWith("\"width\":2", "\"width\":224.0").replace("\"height\":2", "\"height\":2e2"))
        assertEquals(224, parsed.input.width)
        assertEquals(200, parsed.input.height)
        assertEquals(255, spec(input = inputPlus("\"padValue\":255.0")).input.padValue)
        assertEquals(5, spec(rest = ""","labelOffset":5.0""").labelOffset)
    }

    @Test
    fun rules8To12EnumerationsAreExactStrings() {
        for (bad in listOf("\"NHWC\"", "\"\"", "1", "null", "[]")) {
            assertEquals("input.layout must be \"nhwc\" or \"nchw\"", reason(specJson(input = inputWith("\"layout\":\"nhwc\"", "\"layout\":$bad"))), bad)
            assertEquals("input.channels must be \"rgb\" or \"bgr\"", reason(specJson(input = inputWith("\"channels\":\"rgb\"", "\"channels\":$bad"))), bad)
            assertEquals(
                "input.mode must be \"stretch\", \"centerCrop\" or \"letterbox\"",
                reason(specJson(input = inputWith("\"mode\":\"stretch\"", "\"mode\":$bad"))),
                bad,
            )
            assertEquals("input.resample must be \"nearest\" or \"bilinear\"", reason(specJson(input = inputWith("\"resample\":\"nearest\"", "\"resample\":$bad"))), bad)
            assertEquals("input.dtype must be \"float\" or \"uint8\"", reason(specJson(input = inputWith("\"dtype\":\"float\"", "\"dtype\":$bad"))), bad)
        }
    }

    @Test
    fun rule13PadValue() {
        for (bad in listOf("256", "-1", "1.5", "null", "\"1\"", "true")) {
            assertEquals("input.padValue must be an integer from 0 to 255", reason(specJson(input = inputPlus("\"padValue\":$bad"))), bad)
        }
        assertEquals(0, spec(input = inputPlus("\"padValue\":0")).input.padValue)
        assertEquals(114, spec().input.padValue)
        // accepted (and ignored) in every mode
        assertEquals(7, spec(input = inputWith("\"mode\":\"stretch\"", "\"mode\":\"centerCrop\"").removeSuffix("}") + ",\"padValue\":7}").input.padValue)
    }

    @Test
    fun rule14Scale() {
        for (bad in listOf("\"1\"", "null", "1e999", "-1e999", "true", "[]")) {
            assertEquals("input.scale must be a finite number", reason(specJson(input = inputPlus("\"scale\":$bad"))), bad)
        }
        assertEquals(0.0, spec(input = inputPlus("\"scale\":0")).input.scale)
        assertEquals(-2.5, spec(input = inputPlus("\"scale\":-2.5")).input.scale)
        assertNull(spec().input.scale)
    }

    @Test
    fun rules15And16MeanAndStd() {
        for (bad in listOf("[1,2]", "[1,2,3,4]", "[1,2,\"3\"]", "[1,2,null]", "\"x\"", "null", "[1,2,1e999]", "{}")) {
            assertEquals("input.mean must be an array of 3 finite numbers", reason(specJson(input = inputPlus("\"mean\":$bad"))), bad)
            assertEquals("input.std must be an array of 3 finite numbers", reason(specJson(input = inputPlus("\"std\":$bad"))), bad)
        }
        assertEquals(listOf(-1.0, 0.0, 2.5), spec(input = inputPlus("\"mean\":[-1,0,2.5]")).input.mean)
        assertEquals(listOf(-1.0, 2.0, 3.0), spec(input = inputPlus("\"std\":[-1,2,3]")).input.std)
    }

    @Test
    fun rule17StdEntriesMustNotBeZeroIncludingNegativeZero() {
        assertEquals("input.std entries must not be 0", reason(specJson(input = inputPlus("\"std\":[1,0,1]"))))
        assertEquals("input.std entries must not be 0", reason(specJson(input = inputPlus("\"std\":[1,1,-0]"))))
        assertEquals("input.std entries must not be 0", reason(specJson(input = inputPlus("\"std\":[0.0,1,1]"))))
        // the length rule comes first
        assertEquals("input.std must be an array of 3 finite numbers", reason(specJson(input = inputPlus("\"std\":[0,1]"))))
    }

    @Test
    fun rule18Uint8AllowsNoNormalization() {
        val uint8 = inputWith("\"dtype\":\"float\"", "\"dtype\":\"uint8\"")
        assertEquals("input.scale is not allowed with dtype uint8", reason(specJson(input = uint8.removeSuffix("}") + ",\"scale\":1}")))
        assertEquals("input.mean is not allowed with dtype uint8", reason(specJson(input = uint8.removeSuffix("}") + ",\"mean\":[0,0,0]}")))
        assertEquals("input.std is not allowed with dtype uint8", reason(specJson(input = uint8.removeSuffix("}") + ",\"std\":[1,1,1]}")))
        assertEquals("input.scale is not allowed with dtype uint8", reason(specJson(input = uint8.removeSuffix("}") + ",\"std\":[1,1,1],\"mean\":[0,0,0],\"scale\":1}")))
        assertEquals(InputDType.UINT8, spec(input = uint8).input.dtype)
    }

    @Test
    fun rule19OutputMustBeAnObject() {
        assertEquals("output must be an object", reason("""{"input":$INPUT_JSON,"output":"logits"}"""))
        assertEquals("output must be an object", reason("""{"input":$INPUT_JSON,"output":null}"""))
    }

    @Test
    fun rule20ExactlyOneOfTypeAndFormat() {
        val message = "output must have exactly one of \"type\" and \"format\""
        assertEquals(message, reason(specJson(output = "{}")))
        assertEquals(message, reason(specJson(output = """{"type":"logits","format":"ssd"}""")))
        assertEquals(message, reason(specJson(output = """{"type":null,"format":null}""")))
    }

    @Test
    fun rules21And22TypeAndFormat() {
        assertEquals("output.type must be \"logits\" or \"probabilities\"", reason(specJson(output = """{"type":"softmax"}""")))
        assertEquals("output.type must be \"logits\" or \"probabilities\"", reason(specJson(output = """{"type":null}""")))
        assertEquals("output.format must be \"ssd\" or \"rows\"", reason(specJson(output = """{"format":"yolo"}""")))
        assertEquals("output.format must be \"ssd\" or \"rows\"", reason(specJson(output = """{"format":null}""")))
    }

    @Test
    fun rule23UnknownOutputKeysDependOnTheKind() {
        assertEquals("unknown key: output.boxOrder", reason(specJson(output = """{"type":"logits","boxOrder":"yxyx"}""")))
        assertEquals("unknown key: output.transposed", reason(specJson(output = """{"format":"ssd","transposed":true}""")))
        assertEquals("unknown key: output.boxFormat", reason(specJson(output = """{"format":"ssd","boxFormat":"xywh"}""")))
        assertEquals("unknown key: output.boxOrder", reason(specJson(output = """{"format":"rows","boxOrder":"yxyx"}""")))
        assertEquals("unknown key: output.coordinates", reason(specJson(output = """{"format":"rows","coordinates":"pixels"}""")))
    }

    @Test
    fun rules24To28OutputOptionValues() {
        assertEquals("output.boxOrder must be \"yxyx\" or \"xyxy\"", reason(specJson(output = """{"format":"ssd","boxOrder":"xxyy"}""")))
        assertEquals("output.boxOrder must be \"yxyx\" or \"xyxy\"", reason(specJson(output = """{"format":"ssd","boxOrder":null}""")))
        assertEquals("output.coordinates must be \"normalized\" or \"pixels\"", reason(specJson(output = """{"format":"ssd","coordinates":"abs"}""")))
        assertEquals("output.coordinates must be \"normalized\" or \"pixels\"", reason(specJson(output = """{"format":"ssd","coordinates":null}""")))
        assertEquals("output.boxFormat must be \"xywh\" or \"xyxy\"", reason(specJson(output = """{"format":"rows","boxFormat":"cxcy"}""")))
        assertEquals("output.boxFormat must be \"xywh\" or \"xyxy\"", reason(specJson(output = """{"format":"rows","boxFormat":null}""")))
        for (bad in listOf("1", "\"true\"", "null", "0")) {
            assertEquals("output.transposed must be a boolean", reason(specJson(output = """{"format":"rows","transposed":$bad}""")), bad)
            assertEquals("output.objectness must be a boolean", reason(specJson(output = """{"format":"rows","objectness":$bad}""")), bad)
        }
        assertEquals("output.scoreActivation must be \"none\" or \"sigmoid\"", reason(specJson(output = """{"format":"rows","scoreActivation":"softmax"}""")))
        assertEquals("output.scoreActivation must be \"none\" or \"sigmoid\"", reason(specJson(output = """{"format":"rows","scoreActivation":null}""")))
    }

    @Test
    fun rule29Labels() {
        for (bad in listOf("\"a\"", "null", "[1]", "[null]", "[\"a\",2]", "{}")) {
            assertEquals("labels must be an array of strings", reason(specJson(rest = ""","labels":$bad""")), bad)
        }
        assertEquals(emptyList(), spec(rest = ""","labels":[]""").labels)
        assertNull(spec().labels)
        assertEquals(listOf("a", "b"), spec(rest = ""","labels":["a","b"]""").labels)
    }

    @Test
    fun rule30LabelOffset() {
        for (bad in listOf("1000001", "-1000001", "1.5", "\"1\"", "null", "1e999")) {
            assertEquals("labelOffset must be an integer from -1000000 to 1000000", reason(specJson(rest = ""","labelOffset":$bad""")), bad)
        }
        assertEquals(1000000, spec(rest = ""","labelOffset":1000000""").labelOffset)
        assertEquals(-1000000, spec(rest = ""","labelOffset":-1000000""").labelOffset)
        assertEquals(0, spec().labelOffset)
        // accepted (and ignored) without labels
        assertEquals(3, spec(rest = ""","labelOffset":3""").labelOffset)
    }

    @Test
    fun theFirstViolatedRuleIsTheReportedOne() {
        // unknown key before missing key
        assertEquals("unknown key: z", reason("""{"z":1}"""))
        // missing key before value rules
        assertEquals("missing key: output", reason("""{"input":{"width":0}}"""))
        // padValue before scale, std length before zero, scale type before uint8
        assertEquals("input.padValue must be an integer from 0 to 255", reason(specJson(input = inputPlus("\"scale\":\"x\",\"padValue\":300"))))
        assertEquals(
            "input.scale must be a finite number",
            reason(specJson(input = inputWith("\"dtype\":\"float\"", "\"dtype\":\"uint8\"").removeSuffix("}") + ",\"scale\":\"x\"}")),
        )
        // labels before labelOffset
        assertEquals("labels must be an array of strings", reason(specJson(rest = ""","labelOffset":1.5,"labels":1""")))
        // width before height, width before layout
        assertEquals("input.width must be an integer from 1 to 16384", reason(specJson(input = INPUT_JSON.replace("\"width\":2", "\"width\":0").replace("\"height\":2", "\"height\":0"))))
        assertEquals("input.width must be an integer from 1 to 16384", reason(specJson(input = INPUT_JSON.replace("\"width\":2", "\"width\":0").replace("\"nhwc\"", "\"x\""))))
        // a spec with several problems reports the input before the output
        assertEquals("input.layout must be \"nhwc\" or \"nchw\"", reason(specJson(input = INPUT_JSON.replace("\"nhwc\"", "\"x\""), output = "{}")))
    }

    @Test
    fun aStringThatIsNotJsonIsInvalidSpecWithItsOwnReason() {
        for (text in listOf("", "{", "not json", "{'a':1}", "{\"input\":1,}", "[1,]", "NaN")) {
            assertEquals("spec must be valid JSON", reason(text), text)
        }
    }

    @Test
    fun defaultsAreFilledIn() {
        val s = spec()
        assertEquals(114, s.input.padValue)
        assertNull(s.input.scale)
        assertNull(s.input.mean)
        assertNull(s.input.std)
        assertEquals(OutputSpec.Classifier(ScoreType.LOGITS), s.output)
        assertEquals(OutputSpec.Ssd(BoxOrder.YXYX, Coordinates.NORMALIZED), detectorSpec(output = """{"format":"ssd"}""").output)
        assertEquals(OutputSpec.Rows(BoxFormat.XYWH, false, false, ScoreActivation.NONE), detectorSpec(output = """{"format":"rows"}""").output)
    }

    @Test
    fun parseModelSpecAcceptsAParsedJsonValueToo() {
        val element = Json.parseToJsonElement(specJson())
        assertEquals(spec(), parseModelSpec(element))
        assertNotNull(parseModelSpec(Json.parseToJsonElement(specJson(output = """{"format":"rows","transposed":true}"""))))
    }

    @Test
    fun handBuiltTypedSpecsAreValidatedAtRuntimeWithTheSameRules() {
        val ok = spec()
        fun bad(s: ModelSpec): String {
            val e = assertFailsWith<VisionException> { preprocessGeometry(4, 4, s) }
            assertEquals(VisionErrorKind.INVALID_SPEC, e.kind)
            return e.message ?: ""
        }
        assertEquals("invalid model spec: input.width must be an integer from 1 to 16384", bad(ok.copy(input = ok.input.copy(width = 0))))
        assertEquals("invalid model spec: input.width must be an integer from 1 to 16384", bad(ok.copy(input = ok.input.copy(width = 16385))))
        assertEquals("invalid model spec: input.height must be an integer from 1 to 16384", bad(ok.copy(input = ok.input.copy(height = -3))))
        assertEquals("invalid model spec: input.padValue must be an integer from 0 to 255", bad(ok.copy(input = ok.input.copy(padValue = 256))))
        assertEquals("invalid model spec: input.scale must be a finite number", bad(ok.copy(input = ok.input.copy(scale = Double.NaN))))
        assertEquals("invalid model spec: input.scale must be a finite number", bad(ok.copy(input = ok.input.copy(scale = Double.POSITIVE_INFINITY))))
        assertEquals("invalid model spec: input.mean must be an array of 3 finite numbers", bad(ok.copy(input = ok.input.copy(mean = listOf(1.0, 2.0)))))
        assertEquals("invalid model spec: input.mean must be an array of 3 finite numbers", bad(ok.copy(input = ok.input.copy(mean = listOf(1.0, 2.0, Double.NaN)))))
        assertEquals("invalid model spec: input.std must be an array of 3 finite numbers", bad(ok.copy(input = ok.input.copy(std = listOf(1.0, 2.0, 3.0, 4.0)))))
        assertEquals("invalid model spec: input.std entries must not be 0", bad(ok.copy(input = ok.input.copy(std = listOf(1.0, -0.0, 1.0)))))
        assertEquals("invalid model spec: input.scale is not allowed with dtype uint8", bad(ok.copy(input = ok.input.copy(dtype = InputDType.UINT8, scale = 1.0))))
        assertEquals("invalid model spec: input.mean is not allowed with dtype uint8", bad(ok.copy(input = ok.input.copy(dtype = InputDType.UINT8, mean = listOf(0.0, 0.0, 0.0)))))
        assertEquals("invalid model spec: input.std is not allowed with dtype uint8", bad(ok.copy(input = ok.input.copy(dtype = InputDType.UINT8, std = listOf(1.0, 1.0, 1.0)))))
        assertEquals("invalid model spec: labelOffset must be an integer from -1000000 to 1000000", bad(ok.copy(labelOffset = 1_000_001)))
        assertEquals("invalid model spec: labelOffset must be an integer from -1000000 to 1000000", bad(ok.copy(labelOffset = Int.MIN_VALUE)))
    }
}
