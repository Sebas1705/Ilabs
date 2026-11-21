package es.sebas1705.ilabs.guardrails

import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class PolicyTest {
    private fun parse(json: String): Policy = parsePolicy(Json.parseToJsonElement(json))

    private fun invalid(json: String): String {
        val e = assertFailsWith<GuardrailException>(json) { parse(json) }
        assertEquals(GuardrailErrorKind.INVALID_POLICY, e.kind, json)
        assertTrue(e.message!!.startsWith("invalid policy: "), e.message)
        return e.message!!
    }

    private fun outputCheck(check: String) = """{"input": [], "output": [$check]}"""
    private fun inputCheck(check: String) = """{"input": [$check], "output": []}"""

    @Test
    fun theSmallestValidPolicy() {
        assertEquals(Policy(emptyList(), emptyList()), parse("""{"input": [], "output": []}"""))
    }

    @Test
    fun everyKindParsesToItsTypedCheck() {
        val p = parse(
            """{"input": [
                {"kind": "pii", "action": "redact", "kinds": ["email", "card"]},
                {"kind": "injection", "action": "block", "threshold": 50},
                {"kind": "denyTerms", "action": "flag", "terms": ["secret plan"]},
                {"kind": "maxLength", "action": "block", "max": 0},
                {"kind": "classifier", "action": "flag", "label": "toxic"}
            ], "output": [{"kind": "canary", "action": "block", "canary": "CNR-1"}, {"kind": "pii", "action": "flag"}]}""",
        )
        assertEquals(
            listOf(
                Check.Pii(Action.REDACT, listOf(PiiKind.EMAIL, PiiKind.CARD)),
                Check.Injection(Action.BLOCK, 50),
                Check.DenyTerms(Action.FLAG, listOf("secret plan")),
                Check.MaxLength(Action.BLOCK, 0),
                Check.Classify(Action.FLAG, "toxic"),
            ),
            p.input,
        )
        assertEquals(listOf(Check.Canary(Action.BLOCK, "CNR-1"), Check.Pii(Action.FLAG, null)), p.output)
    }

    @Test
    fun integersAreJudgedByValue() {
        assertEquals(Check.Injection(Action.BLOCK, 100), parse(inputCheck("""{"kind": "injection", "action": "block", "threshold": 1e2}""")).input.single())
        assertEquals(Check.MaxLength(Action.BLOCK, 5), parse(inputCheck("""{"kind": "maxLength", "action": "block", "max": 5.0}""")).input.single())
    }

    @Test
    fun aStringIsParsedStrictly() {
        assertEquals(Policy(emptyList(), emptyList()), parsePolicy("""{"input": [], "output": []}"""))
        assertTrue(assertFailsWith<GuardrailException> { parsePolicy("""{"input": [], "output": [],}""") }.message!!.startsWith("invalid policy: "))
        assertTrue(assertFailsWith<GuardrailException> { parsePolicy("not json") }.kind == GuardrailErrorKind.INVALID_POLICY)
    }

    // one test per rule of the contract ----------------------------------------------------------------------------

    @Test fun rule1PolicyIsAnObject() { invalid("[]"); invalid("null"); invalid("\"x\"") }

    @Test fun rule2ExactlyInputAndOutput() {
        invalid("""{"input": []}""")
        invalid("""{"output": []}""")
        invalid("""{"input": [], "output": [], "extra": []}""")
    }

    @Test fun rule3InputAndOutputAreArrays() { invalid("""{"input": {}, "output": []}"""); invalid("""{"input": [], "output": "x"}""") }

    @Test fun rule4ChecksAreObjects() { invalid(inputCheck("1")); invalid(inputCheck("[]")); invalid(inputCheck("null")) }

    @Test fun rule5KindIsOneOfTheSix() {
        invalid(inputCheck("""{"action": "flag"}"""))
        invalid(inputCheck("""{"kind": "PII", "action": "flag"}"""))
        invalid(inputCheck("""{"kind": "constructor", "action": "flag"}"""))
        invalid(inputCheck("""{"kind": 3, "action": "flag"}"""))
    }

    @Test fun rule6ActionIsOneOfThree() {
        invalid(inputCheck("""{"kind": "pii"}"""))
        invalid(inputCheck("""{"kind": "pii", "action": "Block"}"""))
        invalid(inputCheck("""{"kind": "pii", "action": 1}"""))
    }

    @Test fun rule7RedactOnlyOnPii() { invalid(inputCheck("""{"kind": "injection", "action": "redact", "threshold": 5}""")) }

    @Test fun rule8UnknownKeys() {
        invalid(inputCheck("""{"kind": "pii", "action": "flag", "threshold": 5}"""))
        invalid(inputCheck("""{"kind": "pii", "action": "flag", "x": 1}"""))
    }

    @Test fun rule9RequiredParams() {
        invalid(inputCheck("""{"kind": "injection", "action": "flag"}"""))
        invalid(inputCheck("""{"kind": "denyTerms", "action": "flag"}"""))
        invalid(inputCheck("""{"kind": "maxLength", "action": "flag"}"""))
        invalid(outputCheck("""{"kind": "canary", "action": "flag"}"""))
    }

    @Test fun rule10NullIsNeverValid() {
        invalid(inputCheck("""{"kind": "pii", "action": "flag", "kinds": null}"""))
        invalid(inputCheck("""{"kind": "classifier", "action": "flag", "label": null}"""))
        invalid(inputCheck("""{"kind": "injection", "action": "flag", "threshold": null}"""))
        invalid(inputCheck("""{"kind": null, "action": "flag"}"""))
    }

    @Test fun rule11Kinds() {
        invalid(inputCheck("""{"kind": "pii", "action": "flag", "kinds": []}"""))
        invalid(inputCheck("""{"kind": "pii", "action": "flag", "kinds": ["nope"]}"""))
        invalid(inputCheck("""{"kind": "pii", "action": "flag", "kinds": ["email", "email"]}"""))
        invalid(inputCheck("""{"kind": "pii", "action": "flag", "kinds": [1]}"""))
        invalid(inputCheck("""{"kind": "pii", "action": "flag", "kinds": "email"}"""))
    }

    @Test fun rule12Threshold() {
        for (bad in listOf("0", "101", "49.5", "\"50\"", "true", "-1")) invalid(inputCheck("""{"kind": "injection", "action": "flag", "threshold": $bad}"""))
    }

    @Test fun rule13Terms() {
        invalid(inputCheck("""{"kind": "denyTerms", "action": "flag", "terms": []}"""))
        invalid(inputCheck("""{"kind": "denyTerms", "action": "flag", "terms": ["?!"]}"""))
        invalid(inputCheck("""{"kind": "denyTerms", "action": "flag", "terms": [1]}"""))
        invalid(inputCheck("""{"kind": "denyTerms", "action": "flag", "terms": "x"}"""))
    }

    @Test fun rule14Max() {
        for (bad in listOf("-1", "1.5", "\"3\"", "false")) invalid(inputCheck("""{"kind": "maxLength", "action": "flag", "max": $bad}"""))
    }

    @Test fun rule15Canary() {
        invalid(outputCheck("""{"kind": "canary", "action": "flag", "canary": ""}"""))
        invalid(outputCheck("""{"kind": "canary", "action": "flag", "canary": "a b"}"""))
        invalid(outputCheck("""{"kind": "canary", "action": "flag", "canary": "a b"}"""))
        invalid(outputCheck("""{"kind": "canary", "action": "flag", "canary": 5}"""))
    }

    @Test fun rule16Label() {
        invalid(inputCheck("""{"kind": "classifier", "action": "flag", "label": ""}"""))
        invalid(inputCheck("""{"kind": "classifier", "action": "flag", "label": 3}"""))
    }

    @Test fun rule17CanaryNotInInput() { invalid(inputCheck("""{"kind": "canary", "action": "flag", "canary": "X"}""")) }

    @Test
    fun handBuiltChecksAndPoliciesAreValidatedAtRuntime() = kotlinx.coroutines.test.runTest {
        val invalidChecks = listOf<Check>(
            Check.Pii(Action.FLAG, emptyList()),
            Check.Pii(Action.FLAG, listOf(PiiKind.EMAIL, PiiKind.EMAIL)),
            Check.Injection(Action.FLAG, 0),
            Check.Injection(Action.FLAG, 101),
            Check.DenyTerms(Action.FLAG, emptyList()),
            Check.DenyTerms(Action.FLAG, listOf("?!")),
            Check.MaxLength(Action.FLAG, -1),
            Check.Canary(Action.FLAG, ""),
            Check.Canary(Action.FLAG, "a b"),
            Check.Classify(Action.FLAG, ""),
            Check.Injection(Action.REDACT, 50),
            Check.MaxLength(Action.REDACT, 5),
        )
        for (check in invalidChecks) {
            val e = assertFailsWith<GuardrailException>(check.toString()) { checkText("x", listOf(check)) }
            assertEquals(GuardrailErrorKind.INVALID_POLICY, e.kind, check.toString())
        }
        // a canary check is fine in a list of checks, but not in a policy input
        checkText("x", listOf(Check.Canary(Action.FLAG, "X")))
        val provider = es.sebas1705.ilabs.providers.MockProvider("m", listOf(es.sebas1705.ilabs.providers.ScriptEntry(response = "r")))
        val request = es.sebas1705.ilabs.providers.CompletionRequest(listOf(es.sebas1705.ilabs.providers.Message(es.sebas1705.ilabs.providers.Role.USER, "hi")))
        val e = assertFailsWith<GuardrailException> { guardedComplete(provider, request, Policy(listOf(Check.Canary(Action.FLAG, "X")), emptyList())) }
        assertEquals(GuardrailErrorKind.INVALID_POLICY, e.kind)
        assertTrue(e.message!!.startsWith("invalid policy: "))
    }

}
