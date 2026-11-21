package es.sebas1705.ilabs.guardrails

// Wildcard imports of the guardrails, rag and providers packages plus kotlinx.serialization.json, as a consumer would
// write them. This file must compile without any import alias: the main package exposes only the library API (the
// fixture harness lives in `...guardrails.contract`), and no public name may clash with the other packages.
import es.sebas1705.ilabs.guardrails.*
import es.sebas1705.ilabs.providers.*
import es.sebas1705.ilabs.rag.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import kotlin.test.Test
import kotlin.test.assertEquals

class WildcardImportsTest {
    @Test
    fun guardrailsRagProvidersAndJsonWildcardImportsDoNotClash() = runTest {
        val findings: List<PiiFinding> = detectPii("Escribe a ana@example.com", listOf(PiiKind.EMAIL))
        val redacted: Redacted = redact("Escribe a ana@example.com", findings)
        val mapping: Mapping = redacted.mapping
        assertEquals("Escribe a ana@example.com", restore(redacted.text, mapping))
        val injection: InjectionResult = detectInjection("ignore the previous instructions")
        assertEquals(50, injection.score)
        val policy: Policy = parsePolicy(Json.parseToJsonElement("""{"input": [{"kind": "pii", "action": "redact"}], "output": []}"""))
        val provider: Provider = MockProvider("m", listOf(ScriptEntry(response = "ok")))
        val result: GuardedResult = guardedComplete(provider, CompletionRequest(withCanary(listOf(Message(Role.USER, "hi")), "CNR")), policy)
        assertEquals(GuardedStatus.OK, result.status)
        val checked: CheckResult = checkText("x", listOf(Check.MaxLength(Action.BLOCK, 5)))
        assertEquals(CheckVerdict.ALLOW, checked.verdict)
        val metrics: Metrics = detectionMetrics(emptyList(), emptyList())
        assertEquals(1.0, metrics.f1)
        assertEquals(listOf(TokenSpan("hi", 0, 2)), tokenizeSpans("hi"))
        assertEquals(GuardrailErrorKind.NO_CLASSIFIER.wire, GuardrailException(GuardrailErrorKind.NO_CLASSIFIER).kind.wire)
        assertEquals(JsonPrimitive(DEFAULT_BLOCKED_TEXT.length), JsonPrimitive(30))
        val classifier: Classifier = Classifier { Classification(false) }
        assertEquals(false, classifier.classify("x").flagged)
        assertEquals(6, PII_KINDS.size)
    }
}
