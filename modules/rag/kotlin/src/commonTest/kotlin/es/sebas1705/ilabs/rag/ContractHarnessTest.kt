package es.sebas1705.ilabs.rag

import es.sebas1705.ilabs.providers.CompletionRequest
import es.sebas1705.ilabs.providers.Message
import es.sebas1705.ilabs.providers.Role
import es.sebas1705.ilabs.rag.contract.Fixture
import es.sebas1705.ilabs.rag.contract.FixtureError
import es.sebas1705.ilabs.rag.contract.checkOutcome
import es.sebas1705.ilabs.rag.contract.parseFixture
import es.sebas1705.ilabs.rag.contract.runFixture
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** Tests of the shared fixture harness itself: it must fail when it should, not only pass on the real fixtures. */
class ContractHarnessTest {
    private val docs = """[{"id": "a", "text": "uno dos"}, {"id": "b", "text": "dos tres"}]"""
    private val chunking = """{"type": "paragraph", "maxSize": 50}"""

    private fun fx(setup: String, expect: String, extra: String = "") =
        parseFixture("""{"name": "t", "setup": $setup, "expect": $expect$extra}""")

    private suspend fun failures(f: Fixture): List<String> = checkOutcome(f, runFixture(f))

    private suspend fun invalidMessage(f: Fixture): String {
        val e = assertFailsWith<IllegalStateException> { runFixture(f) }
        val message = e.message ?: ""
        assertTrue(message.startsWith("invalid fixture: "), message)
        return message
    }

    private fun searchSetup(extra: String = "", mode: String = "bm25") =
        """{"kind": "search", "documents": $docs, "chunking": $chunking, "query": "tres", "mode": "$mode"$extra}"""

    private val tresHit = """{"chunkId": "b#0", "docId": "b", "rank": 1, "score": 0.6931471805599453}"""

    @Test
    fun correctFixturesPassAndWrongOnesFail() = runTest {
        assertEquals(emptyList(), failures(fx("""{"kind": "tokens", "text": "¿Qué?"}""", """{"tokens": ["que"]}""")))
        assertEquals(1, failures(fx("""{"kind": "tokens", "text": "¿Qué?"}""", """{"tokens": ["qué"]}""")).size)
        assertEquals(emptyList(), failures(fx(searchSetup(), """{"hits": [$tresHit]}""")))
    }

    @Test
    fun scoresUseTheToleranceAndRanksAreExact() = runTest {
        val near = tresHit.replace("0.6931471805599453", "0.6931471805599458")
        assertEquals(emptyList(), failures(fx(searchSetup(), """{"hits": [$near]}""")))
        val far = tresHit.replace("0.6931471805599453", "0.6931481805599453")
        assertEquals(1, failures(fx(searchSetup(), """{"hits": [$far]}""")).size)
        val rank = tresHit.replace("\"rank\": 1", "\"rank\": 2")
        assertEquals(1, failures(fx(searchSetup(), """{"hits": [$rank]}""")).size)
        assertEquals(1, failures(fx(searchSetup(), """{"hits": []}""")).size)
        // a bm25Rank the actual hit does not have is a failure, and vice versa
        val withRank = tresHit.replace("}", ", \"bm25Rank\": 1}")
        assertEquals(1, failures(fx(searchSetup(), """{"hits": [$withRank]}""")).size)
    }

    @Test
    fun hybridRanksMustBePresentExactlyWhenExpected() = runTest {
        val setup = searchSetup(""", "embedder": {"type": "hash"}, "topK": 1""", mode = "hybrid")
        val f = fx(setup, """{"hits": [{"chunkId": "b#0", "docId": "b", "rank": 1, "score": 0.03278688524590164, "bm25Rank": 1, "denseRank": 1}]}""")
        val out = runFixture(f)
        assertEquals(emptyList(), checkOutcome(f, out))
        val dropped = out.copy(hits = out.hits!!.map { it.copy(denseRank = null) })
        assertEquals(1, checkOutcome(f, dropped).size)
    }

    @Test
    fun errorsAreReportedAsOutcomes() = runTest {
        val nonInteger = fx(searchSetup(""", "topK": 1.5"""), """{"error": {"kind": "invalid_options"}}""")
        assertEquals(FixtureError("invalid_options", null), runFixture(nonInteger).error)
        assertEquals(emptyList(), failures(nonInteger))
        val integralFloat = fx(searchSetup(""", "topK": 1.0"""), """{"hits": [$tresHit]}""")
        assertEquals(emptyList(), failures(integralFloat))
        val unknownMode = fx(searchSetup(mode = "sparse"), """{"error": {"kind": "invalid_options"}}""")
        assertEquals(emptyList(), failures(unknownMode))
        val wrongKind = fx(searchSetup(mode = "sparse"), """{"error": {"kind": "no_embedder"}}""")
        assertEquals(1, failures(wrongKind).size)
        val unexpectedSuccess = fx(searchSetup(), """{"error": {"kind": "no_embedder"}}""")
        assertEquals(1, failures(unexpectedSuccess).size)
        val badDim = fx("""{"kind": "embed", "text": "a", "dim": 0}""", """{"error": {"kind": "invalid_options"}}""")
        assertEquals(emptyList(), failures(badDim))
        val badType = fx("""{"kind": "chunk", "documents": $docs, "chunking": {"type": "sentence", "n": 2}}""", """{"error": {"kind": "invalid_options"}}""")
        assertEquals(emptyList(), failures(badType))
        val required = fx(
            """{"kind": "context", "documents": $docs, "chunking": $chunking, "query": "zzz", "mode": "bm25", "maxTokens": 39}""",
            """{"error": {"kind": "budget_too_small", "required": 41}}""",
        )
        assertEquals(1, failures(required).size)
    }

    @Test
    fun jsonNullOptionsAreInvalidOptions() = runTest {
        val invalidOptions = FixtureError("invalid_options", null)
        val cases = listOf(
            searchSetup(""", "topK": null"""),
            searchSetup(""", "candidates": null""", mode = "hybrid").replace("\"query\"", "\"embedder\": {\"type\": \"hash\"}, \"query\""),
            searchSetup(""", "embedder": {"type": "hash", "dim": null}"""),
            searchSetup().replace("\"mode\": \"bm25\"", "\"mode\": null"),
            searchSetup().replace("\"maxSize\": 50", "\"maxSize\": null"),
            """{"kind": "chunk", "documents": $docs, "chunking": {"type": "fixed", "size": 3, "overlap": null}}""",
            """{"kind": "embed", "text": "a", "dim": null}""",
            """{"kind": "metrics", "hits": [], "relevant": ["a"], "level": null}""",
            """{"kind": "context", "documents": $docs, "chunking": $chunking, "query": "tres", "mode": "bm25", "maxTokens": null}""",
        )
        for (setup in cases) assertEquals(invalidOptions, runFixture(fx(setup, """{"error": {"kind": "invalid_options"}}""")).error, setup)
        // candidates is ignored entirely outside hybrid, JSON null included
        assertEquals(emptyList(), failures(fx(searchSetup(""", "candidates": null"""), """{"hits": [$tresHit]}""")))
    }

    @Test
    fun evalTopKIsValidatedBeforeTheQuestionLoop() = runTest {
        fun eval(topK: String) = fx(
            """{"kind": "eval", "documents": $docs, "chunking": $chunking, "embedder": {"type": "hash"}, "topK": $topK, "questions": []}""",
            """{"error": {"kind": "invalid_options"}}""",
        )
        for (bad in listOf("0", "-1", "null", "2.5")) {
            assertEquals(FixtureError("invalid_options", null), runFixture(eval(bad)).error, "topK $bad")
        }
        val ok = runFixture(eval("3"))
        assertEquals(null, ok.error)
        assertEquals(emptyList(), ok.questions)
        val okFixture = fx(
            """{"kind": "eval", "documents": $docs, "chunking": $chunking, "embedder": {"type": "hash"}, "topK": 3, "questions": []}""",
            """{"questions": []}""",
        )
        assertEquals(emptyList(), failures(okFixture))
    }

    @Test
    fun wrongJsonTypesAreMalformedFixtures() = runTest {
        val hits = """{"hits": []}"""
        invalidMessage(fx(searchSetup().replace("\"id\": \"a\"", "\"id\": 1"), hits))
        invalidMessage(fx(searchSetup().replace("\"text\": \"uno dos\"", "\"text\": null"), hits))
        invalidMessage(fx(searchSetup(""", "embedder": {"type": "hash", "dim": "3"}"""), hits))
        invalidMessage(fx(searchSetup(""", "topK": "2""""), hits))
        invalidMessage(fx(searchSetup().replace("\"query\": \"tres\"", "\"query\": 3"), hits))
        invalidMessage(fx(searchSetup().replace("\"mode\": \"bm25\"", "\"mode\": 1"), hits))
        invalidMessage(fx("""{"kind": "chunk", "documents": {}, "chunking": $chunking}""", """{"chunks": []}"""))
        invalidMessage(fx("""{"kind": "citations", "sources": ["1"], "answer": "x"}""", """{"cited": [], "unknown": []}"""))
        invalidMessage(fx("""{"kind": "citations", "sources": [1], "answer": 2}""", """{"cited": [], "unknown": []}"""))
        invalidMessage(fx("""{"kind": "metrics", "hits": {}, "relevant": ["a"]}""", """{"recallAtK": 0, "precisionAtK": 0, "reciprocalRank": 0, "hit": false}"""))
        invalidMessage(fx("""{"kind": 3}""", """{"tokens": []}"""))
        // a chunking type that is not a string, null included, is malformed (an unknown string is invalid_options)
        val chunks = """{"chunks": []}"""
        invalidMessage(fx("""{"kind": "chunk", "documents": $docs, "chunking": {"type": null}}""", chunks))
        invalidMessage(fx("""{"kind": "chunk", "documents": $docs, "chunking": {"type": 1, "size": 3, "overlap": 0}}""", chunks))
        // citation sources are not options: non-numeric and non-integer entries are malformed
        val citations = """{"cited": [], "unknown": []}"""
        invalidMessage(fx("""{"kind": "citations", "sources": [1.5], "answer": "x"}""", citations))
        invalidMessage(fx("""{"kind": "citations", "sources": [null], "answer": "x"}""", citations))
        assertEquals(emptyList(), failures(fx("""{"kind": "citations", "sources": [1.0], "answer": "[1]"}""", """{"cited": [1], "unknown": []}""")))
        // relevant must be an array of strings, in metrics and in eval questions
        val metricsExpect = """{"recallAtK": 0, "precisionAtK": 0, "reciprocalRank": 0, "hit": false}"""
        invalidMessage(fx("""{"kind": "metrics", "hits": [], "relevant": "a"}""", metricsExpect))
        invalidMessage(fx("""{"kind": "metrics", "hits": [], "relevant": [1]}""", metricsExpect))
        invalidMessage(
            fx(
                """{"kind": "eval", "documents": $docs, "chunking": $chunking, "embedder": {"type": "hash"}, "topK": 1,
                   "questions": [{"query": "uno", "relevant": [null]}]}""",
                """{"questions": []}""",
            ),
        )
    }

    @Test
    fun setupKindsAreLookedUpExactly() = runTest {
        for (kind in listOf("constructor", "__proto__", "toString", "hasOwnProperty", "Tokens", "")) {
            assertEquals("invalid fixture: unknown setup kind: $kind", invalidMessage(fx("""{"kind": "$kind"}""", """{"tokens": []}""")))
        }
    }

    @Test
    fun scriptEntriesAreTyped() = runTest {
        fun answer(script: String) = fx(
            """{"kind": "answer", "documents": $docs, "chunking": $chunking, "query": "tres", "mode": "bm25", "maxTokens": 100,
                "provider": {"script": $script}}""",
            """{"error": {"kind": "unavailable"}, "calls": 1}""",
        )
        invalidMessage(answer("""[{"response": 1}]"""))
        invalidMessage(answer("""[{"response": null}]"""))
        invalidMessage(answer("""[{"error": {"kind": 1}}]"""))
        invalidMessage(answer("""[{"error": {"kind": null}}]"""))
        invalidMessage(answer("""[{"error": "rate_limit"}]"""))
        // an unknown provider error kind string is malformed too
        invalidMessage(answer("""[{"error": {"kind": "quota"}}]"""))
        assertTrue("unknown" in invalidMessage(answer("""[{"error": {"kind": "timeout", "detail": "x"}}]""")))
        assertTrue("unknown" in invalidMessage(answer("""[{"response": "a", "text": "b"}]""")))
        // a retryAfterMs is accepted (never compared)
        val delayed = fx(
            """{"kind": "answer", "documents": $docs, "chunking": $chunking, "query": "tres", "mode": "bm25", "maxTokens": 100,
                "provider": {"script": [{"error": {"kind": "timeout", "retryAfterMs": 5}}]}}""",
            """{"error": {"kind": "timeout"}, "calls": 1, "request": {"system": "$RAG_INSTRUCTION\n\n[1] dos tres", "user": "tres"}}""",
        )
        assertEquals(emptyList(), failures(delayed))
    }

    @Test
    fun answerRequestsAndCallsAreChecked() = runTest {
        val setup = """{"kind": "answer", "documents": $docs, "chunking": $chunking, "query": "tres", "mode": "bm25", "maxTokens": 100,
            "provider": {"script": [{"response": "Sí [1] [2]"}]}}"""
        val system = "$RAG_INSTRUCTION\\n\\n[1] dos tres"
        val good = """{"answer": "Sí [1] [2]", "sources": [{"n": 1, "chunkId": "b#0", "docId": "b"}], "citations": {"cited": [1], "unknown": [2]},
            "hitIds": ["b#0"], "calls": 1, "request": {"system": "$system", "user": "tres"}}"""
        val f = fx(setup, good)
        val out = runFixture(f)
        assertEquals(emptyList(), checkOutcome(f, out))
        val extraField = out.copy(requests = out.requests.map { it.copy(maxTokens = 5) })
        assertEquals(1, checkOutcome(f, extraField).size)
        val twice = out.copy(requests = out.requests + out.requests, calls = 2)
        assertTrue(checkOutcome(f, twice).isNotEmpty())
        val otherUser = out.copy(requests = listOf(CompletionRequest(listOf(Message(Role.SYSTEM, RAG_INSTRUCTION + "\n\n[1] dos tres"), Message(Role.USER, "x")))))
        assertEquals(1, checkOutcome(f, otherUser).size)

        val failing = """{"kind": "answer", "documents": $docs, "chunking": $chunking, "query": "tres", "mode": "bm25", "maxTokens": 100, "provider": {"script": []}}"""
        assertEquals(emptyList(), failures(fx(failing, """{"error": {"kind": "unavailable"}, "calls": 1, "request": {"system": "$system", "user": "tres"}}""")))
        // a request that was made must be declared
        assertEquals(1, failures(fx(failing, """{"error": {"kind": "unavailable"}, "calls": 1}""")).size)
        val noCall = """{"kind": "answer", "documents": $docs, "chunking": $chunking, "query": "tres", "mode": "bm25", "topK": 0, "maxTokens": 100, "provider": {"script": []}}"""
        assertEquals(emptyList(), failures(fx(noCall, """{"error": {"kind": "invalid_options"}, "calls": 0}""")))
    }

    @Test
    fun malformedFixturesFailExplicitly() = runTest {
        val tokens = """{"kind": "tokens", "text": "a"}"""
        val ok = """{"tokens": ["a"]}"""
        assertTrue("unknown" in invalidMessage(fx(tokens, ok, extra = """, "note": 1""")))
        assertTrue("unknown" in invalidMessage(fx("""{"kind": "tokens", "text": "a", "dim": 3}""", ok)))
        assertTrue("unknown" in invalidMessage(fx(tokens, """{"tokens": ["a"], "extra": []}""")))
        assertEquals("invalid fixture: unknown setup kind: nope", invalidMessage(fx("""{"kind": "nope"}""", ok)))
        assertTrue("unknown" in invalidMessage(fx(searchSetup().replace("\"text\": \"uno dos\"", "\"text\": \"uno dos\", \"lang\": \"es\""), """{"hits": []}""")))
        assertTrue("unknown" in invalidMessage(fx(searchSetup().replace("\"maxSize\": 50", "\"maxSize\": 50, \"size\": 3"), """{"hits": []}""")))
        assertTrue("unknown" in invalidMessage(fx(searchSetup(""", "embedder": {"type": "hash", "seed": 1}"""), """{"hits": []}""")))
        // missing required keys are malformed fixtures, never invalid_options
        invalidMessage(fx("""{"kind": "chunk", "documents": [{"id": "a"}], "chunking": $chunking}""", """{"chunks": []}"""))
        invalidMessage(fx("""{"kind": "chunk", "documents": $docs, "chunking": {"type": "fixed", "size": 3}}""", """{"chunks": []}"""))
        invalidMessage(fx("""{"kind": "search", "documents": $docs, "chunking": $chunking, "mode": "bm25"}""", """{"hits": []}"""))
        invalidMessage(fx(tokens, """{"hits": []}"""))
        invalidMessage(fx(searchSetup(""", "embedder": {"type": "openai"}"""), """{"hits": []}"""))
        invalidMessage(fx(searchSetup(""", "embedder": {"type": "script", "responses": [[["x"]]]}"""), """{"hits": []}"""))
        assertTrue(
            "called more often" in invalidMessage(
                fx(searchSetup(""", "embedder": {"type": "script", "responses": [[[1], [1]]]}""", mode = "dense"), """{"hits": []}"""),
            ),
        )
        val script = """{"kind": "answer", "documents": $docs, "chunking": $chunking, "query": "tres", "mode": "bm25", "maxTokens": 100,
            "provider": {"script": [{"response": "a"}, {"text": "b"}]}}"""
        // the `neither` message comes before the unknown-key check
        val neitherMessage = "invalid fixture: script entry 2 of provider mock has neither response nor error"
        assertEquals(neitherMessage, invalidMessage(fx(script, """{"error": {"kind": "unavailable"}, "calls": 1}""")))
        val empty = script.replace("{\"text\": \"b\"}", "{}")
        assertEquals(neitherMessage, invalidMessage(fx(empty, """{"error": {"kind": "unavailable"}, "calls": 1}""")))
        // answer fixtures must declare calls
        invalidMessage(fx(script.replace(", {\"text\": \"b\"}", ""), """{"error": {"kind": "unavailable"}}"""))
    }

    @Test
    fun fixtureFilesAreParsedStrictly() {
        for (bad in listOf("""{"name": "t",}""", """{"name": 't'}""", "[1]", "{} x", """{"name": "t"""")) {
            val e = assertFailsWith<IllegalStateException>(bad) { parseFixture(bad) }
            assertTrue((e.message ?: "").startsWith("invalid fixture: "), bad)
        }
        assertEquals("a\uD800b", (parseFixture("""{"name": "a\ud800b"}""").name))
    }
}
