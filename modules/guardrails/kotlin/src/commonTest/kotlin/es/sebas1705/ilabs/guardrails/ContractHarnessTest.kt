package es.sebas1705.ilabs.guardrails

import es.sebas1705.ilabs.guardrails.contract.Fixture
import es.sebas1705.ilabs.guardrails.contract.FixtureError
import es.sebas1705.ilabs.guardrails.contract.checkOutcome
import es.sebas1705.ilabs.guardrails.contract.parseFixture
import es.sebas1705.ilabs.guardrails.contract.runFixture
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** Tests of the shared fixture harness itself: it must fail when it should, not only pass on the real fixtures. */
class ContractHarnessTest {
    private fun fx(setup: String, expect: String) = parseFixture("""{"name": "t", "setup": $setup, "expect": $expect}""")

    private suspend fun failures(f: Fixture): List<String> = checkOutcome(f, runFixture(f))

    private suspend fun invalidMessage(f: Fixture): String {
        val e = assertFailsWith<IllegalStateException> { runFixture(f) }
        val message = e.message ?: ""
        assertTrue(message.startsWith("invalid fixture: "), message)
        return message.removePrefix("invalid fixture: ")
    }

    private val emailFinding = """{"kind": "email", "start": 0, "end": 15, "text": "ana@example.com"}"""

    @Test
    fun correctFixturesPassAndWrongOnesFail() = runTest {
        val setup = """{"kind": "pii", "text": "ana@example.com"}"""
        assertEquals(emptyList(), failures(fx(setup, """{"findings": [$emailFinding]}""")))
        assertEquals(1, failures(fx(setup, """{"findings": [${emailFinding.replace("15", "14")}]}""")).size)
        assertEquals(1, failures(fx(setup, """{"findings": []}""")).size)
        // an extra key in an expected element is a mismatch, not ignored
        assertEquals(1, failures(fx(setup, """{"findings": [${emailFinding.replace("}", ", \"x\": 1}")}]}""")).size)
    }

    @Test
    fun errorsAreReportedAsOutcomes() = runTest {
        val bad = fx("""{"kind": "pii", "text": "x", "kinds": ["nope"]}""", """{"error": {"kind": "invalid_options"}}""")
        assertEquals(FixtureError("invalid_options"), runFixture(bad).error)
        assertEquals(emptyList(), failures(bad))
        assertEquals(1, failures(fx("""{"kind": "pii", "text": "x", "kinds": ["nope"]}""", """{"error": {"kind": "invalid_policy"}}""")).size)
        assertEquals(1, failures(fx("""{"kind": "pii", "text": "x"}""", """{"error": {"kind": "invalid_options"}}""")).size)
        assertEquals(1, failures(fx("""{"kind": "pii", "text": "x", "kinds": []}""", """{"findings": []}""")).size)
        assertEquals(emptyList(), failures(fx("""{"kind": "pii", "text": "x", "kinds": []}""", """{"error": {"kind": "invalid_options"}}""")))
    }

    @Test
    fun metricsAreComparedAsExactDoubles() = runTest {
        val setup = """{"kind": "metrics", "expected": [{"kind": "email", "start": 0, "end": 1}], "found": [{"kind": "email", "start": 0, "end": 1}, {"kind": "phone", "start": 2, "end": 3}]}"""
        fun expect(p: String) = """{"precision": $p, "recall": 1, "f1": 0.6666666666666666, "byKind": [
            {"kind": "email", "precision": 1, "recall": 1, "f1": 1, "expected": 1, "found": 1, "correct": 1},
            {"kind": "phone", "precision": 0, "recall": 1, "f1": 0, "expected": 0, "found": 1, "correct": 0}]}"""
        assertEquals(emptyList(), failures(fx(setup, expect("0.5"))))
        assertEquals(1, failures(fx(setup, expect("0.5000000000000001"))).size)
    }

    @Test
    fun unknownMissingAndWrongTypeKeysAreMalformedFixtures() = runTest {
        assertEquals("unknown setup kind: bogus", invalidMessage(fx("""{"kind": "bogus"}""", """{}""")))
        assertEquals("unknown setup kind: constructor", invalidMessage(fx("""{"kind": "constructor"}""", """{}""")))
        assertEquals("unknown setup kind: __proto__", invalidMessage(fx("""{"kind": "__proto__"}""", """{}""")))
        assertEquals("unknown key: extra", invalidMessage(fx("""{"kind": "pii", "text": "x", "extra": 1}""", """{"findings": []}""")))
        assertEquals("missing key: text", invalidMessage(fx("""{"kind": "pii"}""", """{"findings": []}""")))
        assertEquals("wrong type: text", invalidMessage(fx("""{"kind": "pii", "text": 5}""", """{"findings": []}""")))
        assertEquals("wrong type: text", invalidMessage(fx("""{"kind": "pii", "text": null}""", """{"findings": []}""")))
        assertEquals("wrong type: kinds", invalidMessage(fx("""{"kind": "pii", "text": "x", "kinds": "email"}""", """{"findings": []}""")))
        assertEquals("wrong type: kinds", invalidMessage(fx("""{"kind": "pii", "text": "x", "kinds": null}""", """{"findings": []}""")))
        assertEquals("wrong type: mapping", invalidMessage(fx("""{"kind": "restore", "text": "x", "mapping": [["a"]]}""", """{"text": "x"}""")))
        assertEquals("wrong type: mapping", invalidMessage(fx("""{"kind": "restore", "text": "x", "mapping": [["a", 1]]}""", """{"text": "x"}""")))
        assertEquals("wrong type: mapping", invalidMessage(fx("""{"kind": "restore", "text": "x", "mapping": {}}""", """{"text": "x"}""")))
        assertEquals("unknown key: z", invalidMessage(fx("""{"kind": "pii", "text": "x"}""", """{"findings": [], "z": 1}""")))
        assertEquals("unknown key: z", invalidMessage(parseFixture("""{"name": "t", "setup": {"kind": "pii", "text": "x"}, "expect": {"findings": []}, "z": 1}""")))
        assertEquals("missing key: expect", invalidMessage(parseFixture("""{"name": "t", "setup": {"kind": "pii", "text": "x"}}""")))
    }

    @Test
    fun nestedShapesAreChecked() = runTest {
        val noMessages = """{"kind": "canary", "canary": "X", "messages": """
        assertEquals("wrong type: messages", invalidMessage(fx(noMessages + """"x"}""", """{"messages": []}""")))
        assertEquals("missing key: content", invalidMessage(fx(noMessages + """[{"role": "user"}]}""", """{"messages": []}""")))
        assertEquals("wrong type: role", invalidMessage(fx(noMessages + """[{"role": 1, "content": "a"}]}""", """{"messages": []}""")))
        assertEquals("wrong type: content", invalidMessage(fx(noMessages + """[{"role": "user", "content": 1}]}""", """{"messages": []}""")))
        assertEquals("unknown key: name", invalidMessage(fx(noMessages + """[{"role": "user", "content": "a", "name": "n"}]}""", """{"messages": []}""")))
        assertEquals("wrong type: canary", invalidMessage(fx("""{"kind": "canary", "canary": 1, "messages": []}""", """{"messages": []}""")))
        val spans = """{"kind": "metrics", "found": [], "expected": """
        assertEquals("wrong type: start", invalidMessage(fx(spans + """[{"kind": "email", "start": 1.5, "end": 2}]}""", """{}""")))
        assertEquals("missing key: end", invalidMessage(fx(spans + """[{"kind": "email", "start": 1}]}""", """{}""")))
        assertEquals("wrong type: expected", invalidMessage(fx(spans + """{}}""", """{}""")))
        assertEquals("unknown key: more", invalidMessage(fx(spans + """[{"kind": "email", "start": 1, "end": 2, "more": 0}]}""", """{}""")))
        assertEquals("wrong type: samples", invalidMessage(fx("""{"kind": "eval", "samples": 1}""", """{}""")))
        assertEquals("missing key: expected", invalidMessage(fx("""{"kind": "eval", "samples": [{"text": "a"}]}""", """{}""")))
        assertEquals("span outside sample text", invalidMessage(fx("""{"kind": "eval", "samples": [{"text": "ab", "expected": [{"kind": "email", "start": 0, "end": 3}]}]}""", """{"pii": {}, "injection": {}}""")))
        assertEquals("span outside sample text", invalidMessage(fx("""{"kind": "eval", "samples": [{"text": "ab", "expected": [{"kind": "email", "start": 2, "end": 1}]}]}""", """{"pii": {}, "injection": {}}""")))
        assertEquals("span outside sample text", invalidMessage(fx("""{"kind": "eval", "samples": [{"text": "ab", "expected": [{"kind": "email", "start": -1, "end": 1}]}]}""", """{"pii": {}, "injection": {}}""")))
    }

    private val provider = """"provider": {"script": [{"response": "ok"}]}"""
    private val request = """"request": {"messages": [{"role": "user", "content": "hi"}]}"""
    private val emptyPolicy = """"policy": {"input": [], "output": []}"""
    private val guardedExpect = """{"status": "ok", "text": "ok", "sent": [{"role": "user", "content": "hi"}], "input": [[]], "output": [],
        "calls": 1, "mapping": [], "outputMapping": [], "reply": "ok"}"""

    private fun guarded(extra: String = "", provider: String = this.provider) =
        """{"kind": "guarded", $request, $emptyPolicy, $provider$extra}"""

    @Test
    fun guardedFixturesRunTwiceAndAreCheckedStrictly() = runTest {
        assertEquals(emptyList(), failures(fx(guarded(), guardedExpect)))
        assertTrue(failures(fx(guarded(), guardedExpect.replace("\"calls\": 1", "\"calls\": 2"))).isNotEmpty())
        // reply is compared against the GuardedProvider response
        assertTrue(failures(fx(guarded(), guardedExpect.replace("\"reply\": \"ok\"", "\"reply\": \"no\""))).isNotEmpty())
        // text, sent and output must be absent exactly when absent from the expectation
        assertTrue(failures(fx(guarded(), guardedExpect.replace("\"text\": \"ok\", ", ""))).isNotEmpty())
        assertTrue(failures(fx(guarded(), guardedExpect.replace("\"output\": [],", ""))).isNotEmpty())
        assertTrue(failures(fx(guarded(), guardedExpect.replace("\"sent\": [{\"role\": \"user\", \"content\": \"hi\"}], ", ""))).isNotEmpty())
        assertTrue(failures(fx(guarded(), guardedExpect.replace("\"status\": \"ok\"", "\"status\": \"blocked_output\""))).isNotEmpty())
        assertTrue(failures(fx(guarded(), guardedExpect.replace("\"content\": \"hi\"}]", "\"content\": \"ha\"}]"))).isNotEmpty())
    }

    @Test
    fun guardedErrorExpectations() = runTest {
        val scripted = """"provider": {"script": [{"error": {"kind": "timeout"}}]}"""
        val ok = """{"error": {"kind": "timeout"}, "calls": 1, "sent": [{"role": "user", "content": "hi"}]}"""
        assertEquals(emptyList(), failures(fx(guarded(provider = scripted), ok)))
        assertTrue(failures(fx(guarded(provider = scripted), ok.replace("timeout", "rate_limit"))).isNotEmpty())
        assertTrue(failures(fx(guarded(provider = scripted), ok.replace("\"calls\": 1", "\"calls\": 0"))).isNotEmpty())
        assertTrue(failures(fx(guarded(provider = scripted), """{"error": {"kind": "timeout"}, "calls": 1}""")).isNotEmpty())
        assertEquals("missing key: calls", invalidMessage(fx(guarded(provider = scripted), """{"error": {"kind": "timeout"}}""")))
        // an exhausted script fails the one call with unavailable
        assertEquals(emptyList(), failures(fx(guarded(provider = """"provider": {"script": []}"""), ok.replace("timeout", "unavailable"))))
    }

    @Test
    fun providerScriptsAreChecked() = runTest {
        val e = """{"error": {"kind": "timeout"}, "calls": 1}"""
        assertEquals("script entry 2 of provider mock has neither response nor error", invalidMessage(fx(guarded(provider = """"provider": {"script": [{"response": "a"}, {"text": "b"}]}"""), e)))
        assertEquals("unknown provider error kind: boom", invalidMessage(fx(guarded(provider = """"provider": {"script": [{"error": {"kind": "boom"}}]}"""), e)))
        assertEquals("wrong type: response", invalidMessage(fx(guarded(provider = """"provider": {"script": [{"response": 1}]}"""), e)))
        assertEquals("wrong type: script", invalidMessage(fx(guarded(provider = """"provider": {"script": {}}"""), e)))
        assertEquals("unknown key: extra", invalidMessage(fx(guarded(provider = """"provider": {"script": [], "extra": 1}"""), e)))
        assertEquals("unknown key: more", invalidMessage(fx(guarded(provider = """"provider": {"script": [{"error": {"kind": "timeout", "more": 1}}]}"""), e)))
        assertEquals("wrong type: request", invalidMessage(fx("""{"kind": "guarded", "request": 1, $emptyPolicy, $provider}""", e)))
    }

    private val classifier = """, "classifier": {"script": [{"flagged": true, "label": "x"}]}"""

    @Test
    fun classifierScriptsAndInputs() = runTest {
        val checkSetup = """{"kind": "check", "text": "hello", "checks": [{"kind": "classifier", "action": "block"}]$classifier}"""
        val finding = """{"check": 0, "kind": "classifier", "action": "block", "fired": true, "details": {"flagged": true, "label": "x"}}"""
        val expect = """{"verdict": "block", "text": "hello", "mapping": [], "findings": [$finding], "classifierInputs": ["hello"]}"""
        assertEquals(emptyList(), failures(fx(checkSetup, expect)))
        assertTrue(failures(fx(checkSetup, expect.replace("[\"hello\"]", "[\"bye\"]"))).isNotEmpty())
        // a label that is expected but absent (or the reverse) is a mismatch
        assertTrue(failures(fx(checkSetup, expect.replace(", \"label\": \"x\"", ""))).isNotEmpty())
        assertEquals("missing key: classifierInputs", invalidMessage(fx(checkSetup, expect.replace(", \"classifierInputs\": [\"hello\"]", ""))))
        val noClassifier = """{"kind": "check", "text": "hello", "checks": []}"""
        assertEquals("unknown key: classifierInputs", invalidMessage(fx(noClassifier, """{"verdict": "allow", "text": "hello", "mapping": [], "findings": [], "classifierInputs": []}""")))
        val twice = """{"kind": "check", "text": "hello", "checks": [{"kind": "classifier", "action": "flag"}, {"kind": "classifier", "action": "flag"}]$classifier}"""
        assertEquals("classifier script exhausted", invalidMessage(fx(twice, """{"verdict": "allow", "text": "hello", "mapping": [], "findings": [], "classifierInputs": []}""")))
        assertEquals("wrong type: flagged", invalidMessage(fx(checkSetup.replace("\"flagged\": true", "\"flagged\": 1"), expect)))
        assertEquals("missing key: flagged", invalidMessage(fx(checkSetup.replace("\"flagged\": true, ", ""), expect)))
        assertEquals("wrong type: label", invalidMessage(fx(checkSetup.replace("\"label\": \"x\"", "\"label\": 1"), expect)))
        assertEquals("unknown key: extra", invalidMessage(fx(checkSetup.replace("\"flagged\": true", "\"flagged\": true, \"extra\": 1"), expect)))
    }

    @Test
    fun expectMustHaveTheKeysOfItsKindOrAnError() = runTest {
        assertEquals("expect has neither the keys of its kind nor error", invalidMessage(fx("""{"kind": "pii", "text": "x"}""", """{}""")))
        assertEquals("expect has neither the keys of its kind nor error", invalidMessage(fx("""{"kind": "restore", "text": "x", "mapping": []}""", """{"findings": []}""")))
        assertEquals("unknown key: calls", invalidMessage(fx("""{"kind": "pii", "text": "x"}""", """{"error": {"kind": "invalid_options"}, "calls": 1}""")))
    }

    @Test
    fun checksAndPolicyGoToParsePolicy() = runTest {
        // the harness does not look inside checks or policy: a bad one is the library's invalid_policy
        val badChecks = fx("""{"kind": "check", "text": "x", "checks": [{"kind": "pii", "action": "flag", "oops": 1}]}""", """{"error": {"kind": "invalid_policy"}}""")
        assertEquals(emptyList(), failures(badChecks))
        assertEquals(emptyList(), failures(fx("""{"kind": "check", "text": "x", "checks": 5}""", """{"error": {"kind": "invalid_policy"}}""")))
        assertEquals(emptyList(), failures(fx("""{"kind": "policy", "policy": []}""", """{"error": {"kind": "invalid_policy"}}""")))
        assertEquals(emptyList(), failures(fx("""{"kind": "policy", "policy": {"input": [], "output": []}}""", """{"valid": true}""")))
        assertTrue(failures(fx("""{"kind": "policy", "policy": {"input": [], "output": []}}""", """{"error": {"kind": "invalid_policy"}}""")).isNotEmpty())
        // canary checks are allowed in check fixtures
        assertEquals(emptyList(), failures(fx("""{"kind": "check", "text": "xCNRx", "checks": [{"kind": "canary", "action": "flag", "canary": "CNR"}]}""",
            """{"verdict": "allow", "text": "xCNRx", "mapping": [], "findings": [{"check": 0, "kind": "canary", "action": "flag", "fired": true, "details": {"found": true}}]}""")))
    }

    @Test
    fun anInvalidChecksListWithAClassifierRecordsNoInputs() = runTest {
        val setup = """{"kind": "check", "text": "x", "checks": [{"kind": "nope", "action": "flag"}]$classifier}"""
        val f = fx(setup, """{"error": {"kind": "invalid_policy"}, "classifierInputs": []}""")
        assertEquals(emptyList(), runFixture(f).classifierInputs)
        assertEquals(emptyList(), failures(f))
        assertTrue(failures(fx(setup, """{"error": {"kind": "invalid_policy"}, "classifierInputs": ["x"]}""")).isNotEmpty())
    }

    @Test
    fun evalShiftsEverySample() = runTest {
        val spans = """{"kind": "email", "start": 0, "end": 15}"""
        val setup = """{"kind": "eval", "samples": [{"text": "ana@example.com", "expected": [$spans]}, {"text": "ana@example.com", "expected": [$spans]}]}"""
        val metrics = """{"precision": 1, "recall": 1, "f1": 1, "byKind": [{"kind": "email", "precision": 1, "recall": 1, "f1": 1, "expected": 2, "found": 2, "correct": 2}]}"""
        val none = """{"precision": 1, "recall": 1, "f1": 1, "byKind": []}"""
        assertEquals(emptyList(), failures(fx(setup, """{"pii": $metrics, "injection": $none}""")))
        assertTrue(failures(fx(setup, """{"pii": ${metrics.replace("\"expected\": 2", "\"expected\": 1")}, "injection": $none}""")).isNotEmpty())
        // a kind that is neither a PII kind nor a category is the library's invalid_options
        assertEquals(emptyList(), failures(fx("""{"kind": "eval", "samples": [{"text": "a", "expected": [{"kind": "zzz", "start": 0, "end": 1}]}]}""", """{"error": {"kind": "invalid_options"}}""")))
    }

    @Test
    fun parseFixtureRejectsNonStrictJson() {
        assertFailsWith<IllegalStateException> { parseFixture("{") }
        assertFailsWith<IllegalStateException> { parseFixture("[]") }
        assertFailsWith<IllegalStateException> { parseFixture("""{"name": "t",}""") }
    }
}
