package es.sebas1705.ilabs.demo

import androidx.lifecycle.SavedStateHandle
import es.sebas1705.ilabs.rag.Mode
import es.sebas1705.ilabs.rag.Source
import es.sebas1705.ilabs.rag.contract.FixtureOutcome
import es.sebas1705.ilabs.rag.contract.checkOutcome
import es.sebas1705.ilabs.rag.contract.parseFixture
import es.sebas1705.ilabs.rag.contract.runFixture
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class RagViewModelTest {
    /** Reads the contract fixtures straight from the repo, so no Android assets are needed. */
    private val loader = FixtureLoader {
        val dir = generateSequence(File("").absoluteFile) { it.parentFile }
            .map { File(it, "contracts/rag") }
            .first { it.isDirectory }
        dir.listFiles { f -> f.extension == "json" }!!.map { it.readText() }
    }

    private val demoKinds = setOf("search", "context", "answer", "eval")
    private val demoPrefixes = listOf("bm25-", "dense-", "hybrid-", "context-", "answer-", "eval-")

    /** Names of the fixtures the demo offers, derived from the files: a demo kind AND a group prefix. */
    private val eligible: List<String> = loader.load().map(::parseFixture)
        .filter { it.kind in demoKinds && demoPrefixes.any(it.name::startsWith) }
        .map { it.name }
        .sorted()
        .also { assertTrue("expected at least 48 demo fixtures, got ${it.size}", it.size >= 48) }

    @Before
    fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun viewModel(handle: SavedStateHandle = SavedStateHandle()) = RagViewModel(loader, handle)

    private fun select(name: String): RagViewModel = viewModel().also { it.select(name) }

    // ---- listing and groups ----

    @Test
    fun listsOnlyTheDemoFixturesSorted() {
        val names = viewModel().uiState.value.names
        assertEquals(eligible, names)
        assertTrue(names.none { it.startsWith("invalid-") || it.startsWith("chunk-") || it.startsWith("tokens-") })
    }

    @Test
    fun groupsFollowTheTaxonomyAndOrderOfTheWebTwin() {
        assertEquals(RagGroup.SEARCH, RagGroup.of("bm25-basic-ranking"))
        assertEquals(RagGroup.SEARCH, RagGroup.of("dense-basic-ranking"))
        assertEquals(RagGroup.SEARCH, RagGroup.of("hybrid-fusion-order"))
        assertEquals(RagGroup.CONTEXT, RagGroup.of("context-basic"))
        assertEquals(RagGroup.ANSWERS, RagGroup.of("answer-basic"))
        assertEquals(RagGroup.EVALUATION, RagGroup.of("eval-three-modes"))
        assertNull(RagGroup.of("invalid-topk-zero"))
        assertEquals(
            listOf(RagGroup.SEARCH, RagGroup.CONTEXT, RagGroup.ANSWERS, RagGroup.EVALUATION),
            viewModel().uiState.value.groups.map { it.first },
        )
        assertEquals(eligible.size, viewModel().uiState.value.groups.sumOf { it.second.size })
    }

    // ---- defaults ----

    @Test
    fun pickingAFixtureSetsTheDefaultsFromTheFixture() {
        val vm = select("hybrid-ranks-reported")
        val state = vm.uiState.value
        assertEquals("the first copy", state.question)
        assertEquals(Mode.HYBRID, state.mode)
        assertEquals(6, state.topK)
        assertFalse(state.readOnly)

        vm.select("bm25-basic-ranking")
        assertEquals(Mode.BM25, vm.uiState.value.mode)
        assertEquals(5, vm.uiState.value.topK)
        assertEquals("carné de lector", vm.uiState.value.question)

        vm.select("eval-three-modes")
        val eval = vm.uiState.value
        assertEquals("¿Cuánto cuesta cambiar la cadena?", eval.question)
        assertEquals(Mode.HYBRID, eval.mode)
        assertEquals(3, eval.topK)
        assertEquals(0, eval.labelledIndex)
    }

    // ---- results ----

    @Test
    fun hybridFixtureExposesTheFusedOrderAndThePerListRanks() {
        val run = select("hybrid-ranks-reported").uiState.value.run!!
        assertEquals(Mode.HYBRID, run.mode)
        assertTrue(run.chunks.isNotEmpty())
        val rows = run.rows
        assertEquals(6, rows.size)
        assertEquals(listOf("en-library#2", "en-library#0", "en-garden#2"), rows.take(3).map { it.hit.chunkId })
        assertEquals(listOf(1, 2, 3), rows.take(3).map { it.hit.rank })
        assertEquals(1 to 1, rows[0].hit.bm25Rank to rows[0].hit.denseRank)
        assertEquals(2 to 3, rows[1].hit.bm25Rank to rows[1].hit.denseRank)
        assertEquals(0.03278688524590164, rows[0].hit.score, 1e-9)
    }

    @Test
    fun switchingModeChangesTheColumnsAndTheRanking() {
        val vm = select("hybrid-ranks-reported")
        vm.setMode(Mode.BM25)
        val bm25 = vm.uiState.value.run!!
        assertEquals(Mode.BM25, bm25.mode)
        assertTrue(bm25.rows.all { it.hit.bm25Rank == null && it.hit.denseRank == null })
        assertEquals(bm25.rows.map { it.hit.score }.sortedDescending(), bm25.rows.map { it.hit.score })
        vm.setMode(Mode.DENSE)
        assertEquals(Mode.DENSE, vm.uiState.value.run!!.mode)
        assertTrue(vm.uiState.value.run!!.rows.isNotEmpty())
        vm.setMode(Mode.HYBRID)
        assertEquals(6, vm.uiState.value.run!!.rows.size)
    }

    @Test
    fun editingTheQuestionAndTopKRerunsTheLibrary() {
        val vm = select("bm25-basic-ranking")
        vm.setQuestion("taller")
        assertEquals("taller", vm.uiState.value.question)
        val run = vm.uiState.value.run!!
        assertEquals(listOf("es-taller#0"), run.rows.take(1).map { it.hit.chunkId })
        vm.setTopK(1)
        assertEquals(1, vm.uiState.value.run!!.rows.size)
        vm.setTopK(99)
        assertEquals(99, vm.uiState.value.topK)
        assertNull("no upper limit: the library accepts topK 99", vm.uiState.value.run!!.failure)
        vm.setTopK(0)
        assertEquals("invalid_options", vm.uiState.value.run!!.failure!!.kind)
        assertTrue("the corpus stays visible", vm.uiState.value.run!!.chunks.isNotEmpty())
    }

    @Test
    fun theFixturesCandidatesGoToTheLibraryAsWritten() {
        val vm = select("hybrid-candidates-cut")
        assertEquals(2, vm.uiState.value.topK)
        assertNull(vm.uiState.value.run!!.failure)
        vm.setTopK(3)
        val run = vm.uiState.value.run!!
        assertEquals("invalid_options", run.failure!!.kind)
        assertTrue("the corpus stays visible", run.chunks.isNotEmpty())
        vm.setMode(Mode.BM25) // candidates are ignored outside hybrid
        assertNull(vm.uiState.value.run!!.failure)
    }

    @Test
    fun contextFixtureExposesTheSourcesTheBudgetAndTheDroppedCount() {
        val run = select("context-stops-at-first-misfit").uiState.value.run!!
        val context = run.context!!
        assertEquals(listOf(Source(1, "top#0", "top")), context.sources)
        assertEquals(2, context.droppedCount)
        assertEquals(52, context.maxTokens)
        assertTrue(context.usedTokens in 1..52)
        assertTrue(context.content.endsWith("\n\n[1] Faro."))
        assertNull(run.failure)
        assertNull(run.citations)
    }

    @Test
    fun answerFixtureExposesTheCitationsOfTheScriptedReply() {
        val run = select("answer-unknown-citation").uiState.value.run!!
        val citations = run.citations!!
        assertEquals("Ask at the front desk [1]; see also [3] and [2].", citations.reply)
        assertEquals(listOf(1, 2), citations.citations.cited)
        assertEquals(listOf(3), citations.citations.unknown)
        assertEquals(2, run.context!!.sources.size)
    }

    @Test
    fun changingTheQuestionOfAnAnswerFixtureRechecksTheCitationsAgainstTheNewSources() {
        val vm = select("answer-unknown-citation")
        vm.setTopK(1)
        val citations = vm.uiState.value.run!!.citations!!
        assertEquals(listOf(1), citations.citations.cited)
        assertEquals(listOf(3, 2), citations.citations.unknown)
    }

    @Test
    fun evalFixtureShowsTheLabelledQuestionsAndTheMetricsOfTheThreeModes() {
        val vm = select("eval-three-modes")
        val state = vm.uiState.value
        assertEquals(5, state.labelled.size)
        val metrics = state.run!!.metrics!!
        assertEquals(listOf(Mode.BM25, Mode.DENSE, Mode.HYBRID), metrics.map { it.mode })
        for (m in metrics) {
            assertEquals(1.0, m.metrics.recallAtK, 0.0)
            assertEquals(1.0 / 3.0, m.metrics.precisionAtK, 0.0)
            assertEquals(1.0, m.metrics.reciprocalRank, 0.0)
        }
        assertNull(state.run.context)

        vm.selectLabelled(2)
        val picked = vm.uiState.value
        assertEquals("bicicleta", picked.question)
        assertEquals(2, picked.labelledIndex)
        assertNotNull(picked.run!!.metrics)
        // Typing anything else leaves the labelled questions: no metrics, no selection.
        vm.setQuestion("bicicleta roja")
        assertNull(vm.uiState.value.labelledIndex)
        assertNull(vm.uiState.value.run!!.metrics)
        // Typing a labelled question again selects it.
        vm.setQuestion("lost card")
        assertEquals(1, vm.uiState.value.labelledIndex)
        assertNotNull(vm.uiState.value.run!!.metrics)
    }

    @Test
    fun aQuestionWithoutTokensIsTheEmptyState() {
        val vm = select("bm25-basic-ranking")
        assertFalse(vm.uiState.value.run!!.emptyQuery)
        vm.setQuestion("¿? ¡! …")
        val run = vm.uiState.value.run!!
        assertTrue(run.emptyQuery)
        assertTrue(run.rows.isEmpty())
        assertNull(run.failure)
        vm.setQuestion("")
        assertTrue(vm.uiState.value.run!!.emptyQuery)
        // A question with tokens that matches nothing is NOT the empty state.
        vm.setQuestion("zzzz")
        assertFalse(vm.uiState.value.run!!.emptyQuery)
        assertTrue(vm.uiState.value.run!!.rows.isEmpty())
    }

    // ---- read-only fixtures ----

    @Test
    fun scriptedEmbedderAndErrorFixturesAreReadOnlyAndIgnoreTheControls() {
        val vm = select("dense-custom-embedder-dot-product")
        val before = vm.uiState.value
        assertTrue(before.readOnly)
        assertTrue(before.run!!.rows.isNotEmpty())
        vm.setQuestion("otra")
        vm.setMode(Mode.BM25)
        vm.setTopK(2)
        assertEquals(before, vm.uiState.value)

        vm.select("context-first-source-too-big")
        val state = vm.uiState.value
        assertTrue(state.readOnly)
        val failure = state.run!!.failure!!
        assertEquals("budget_too_small", failure.kind)
        assertEquals(68, failure.required)
        assertNull(state.run.context)
        assertTrue("the corpus is still shown", state.run.chunks.isNotEmpty())
        // The search worked, only the composition failed: the hits are shown.
        val setup = ragSetupOf(state.fixture!!)
        val reference = runBlocking {
            val index = es.sebas1705.ilabs.rag.buildIndex(setup.documents, setup.chunking, null)
            es.sebas1705.ilabs.rag.search(index, setup.query, setup.mode!!, setup.topK ?: 5, setup.candidates)
        }
        assertTrue(reference.isNotEmpty())
        assertEquals(reference, state.run.rows.map { it.hit })
        assertFalse(state.run.emptyQuery)

        vm.select("answer-no-hits-budget-too-small")
        assertEquals(40, vm.uiState.value.run!!.failure!!.required)
        assertTrue(vm.uiState.value.run!!.emptyQuery)
        assertTrue(vm.uiState.value.run!!.rows.isEmpty())

        vm.select("hybrid-no-embedder-error")
        assertEquals("no_embedder", vm.uiState.value.run!!.failure!!.kind)
        assertTrue(vm.uiState.value.readOnly)

        vm.select("answer-provider-error")
        assertEquals("rate_limit", vm.uiState.value.run!!.failure!!.kind)

        vm.select("bm25-basic-ranking")
        assertFalse(vm.uiState.value.readOnly)
    }

    // ---- loading, errors, saved state ----

    @Test
    fun selectionAndEditsSurviveRecreationThroughSavedStateHandle() {
        val handle = SavedStateHandle()
        val first = viewModel(handle)
        first.select("hybrid-ranks-reported")
        first.setQuestion("library card")
        first.setMode(Mode.DENSE)
        first.setTopK(3)
        val state = viewModel(handle).uiState.value
        assertEquals("hybrid-ranks-reported", state.selected)
        assertEquals("library card", state.question)
        assertEquals(Mode.DENSE, state.mode)
        assertEquals(3, state.topK)
        assertEquals(3, state.run!!.rows.size)

        val evalHandle = SavedStateHandle()
        val evalVm = viewModel(evalHandle)
        evalVm.select("eval-three-modes")
        evalVm.selectLabelled(3)
        val restored = viewModel(evalHandle).uiState.value
        assertEquals(3, restored.labelledIndex)
        assertEquals("library card", restored.question)
        assertNotNull(restored.run!!.metrics)
    }

    @Test
    fun anEmptyQuestionIsRestoredAsEmptyNotAsTheDefault() {
        val handle = SavedStateHandle()
        val first = viewModel(handle)
        first.select("bm25-basic-ranking")
        first.setQuestion("")
        val state = viewModel(handle).uiState.value
        assertEquals("", state.question)
        assertTrue(state.run!!.emptyQuery)
    }

    @Test
    fun unknownSavedSelectionFallsBackToTheDefaultFixtureAndItsDefaults() {
        val vm = viewModel(SavedStateHandle(mapOf("selected" to "does-not-exist", "question" to "x", "mode" to "dense", "topK" to 9)))
        val state = vm.uiState.value
        assertEquals("hybrid-fusion-order", state.selected)
        assertEquals("carné de lector", state.question)
        assertEquals(Mode.HYBRID, state.mode)
        assertEquals(4, state.topK)
    }

    @Test
    fun aSlowRunOfTheFirstFixtureIsIgnoredAfterSelectingAnother() {
        val gate = CompletableDeferred<RagRun>()
        val vm = RagViewModel(
            loader,
            SavedStateHandle(mapOf("selected" to "bm25-basic-ranking")),
            runner = { request ->
                if (request.fixture.name == "bm25-basic-ranking") gate.await() else runRag(request)
            },
        )
        assertNull(vm.uiState.value.run)
        vm.select("bm25-topk-cut")
        val chosen = vm.uiState.value.run
        assertNotNull(chosen)
        val slow = runBlocking {
            runRag(RagRequest(parseFixture(loader.load().first { "\"bm25-basic-ranking\"" in it }), "carné de lector", Mode.BM25, 5, false))
        }
        gate.complete(slow)
        val state = vm.uiState.value
        assertEquals("bm25-topk-cut", state.selected)
        assertEquals(chosen, state.run)
        assertNull(state.runError)
    }

    @Test
    fun aLiveBudgetTooSmallKeepsTheChunksAndTheHits() {
        val doc = loader.load().first { "\"context-basic\"" in it }
        val small = parseFixture(doc.replace("\"maxTokens\": 200", "\"maxTokens\": 20"))
        val run = runBlocking { runRag(RagRequest(small, "¿Cuánto dura el préstamo?", Mode.BM25, 2, false)) }
        val failure = run.failure!!
        assertEquals("budget_too_small", failure.kind)
        assertTrue(failure.required!! > 20)
        assertNull(run.context)
        assertTrue(run.chunks.isNotEmpty())
        assertEquals(2, run.rows.size)
    }

    @Test
    fun theKeyCheckAloneIgnoresARunThatDoesNotHonourCancellation() {
        // The runner keeps going after its job is cancelled, so only the key check can keep the old result out.
        val gate = CompletableDeferred<RagRun>()
        val vm = RagViewModel(
            loader,
            SavedStateHandle(mapOf("selected" to "bm25-basic-ranking")),
            runner = { request ->
                if (request.question == "slow") kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) { gate.await() } else runRag(request)
            },
        )
        vm.setQuestion("slow")
        vm.setQuestion("taller")
        val chosen = vm.uiState.value.run!!
        gate.complete(chosen.copy(emptyQuery = true))
        assertEquals(chosen, vm.uiState.value.run)
        assertNull(vm.uiState.value.runError)
    }

    @Test
    fun theOlderJobIsCancelledWhenTheControlsChange() {
        var cancelled = false
        val vm = RagViewModel(
            loader,
            SavedStateHandle(mapOf("selected" to "bm25-basic-ranking")),
            runner = { request ->
                if (request.question == "slow") {
                    try {
                        CompletableDeferred<RagRun>().await()
                    } catch (e: kotlinx.coroutines.CancellationException) {
                        cancelled = true
                        throw e
                    }
                } else {
                    runRag(request)
                }
            },
        )
        vm.setQuestion("slow")
        assertFalse(cancelled)
        vm.setMode(Mode.DENSE)
        assertTrue("changing a control cancels the previous job", cancelled)
    }

    @Test
    fun aSlowRunOfAnOlderQuestionIsIgnoredAfterTyping() {
        val gates = mutableListOf<CompletableDeferred<RagRun>>()
        val vm = RagViewModel(
            loader,
            SavedStateHandle(mapOf("selected" to "bm25-basic-ranking")),
            runner = { request -> if (request.question == "slow") CompletableDeferred<RagRun>().also(gates::add).await() else runRag(request) },
        )
        vm.setQuestion("slow")
        vm.setQuestion("taller")
        val chosen = vm.uiState.value.run
        assertEquals("es-taller#0", chosen!!.rows.first().hit.chunkId)
        gates.forEach { it.complete(chosen.copy(emptyQuery = true)) }
        assertEquals(chosen, vm.uiState.value.run)
    }

    @Test
    fun malformedFixtureAmongValidOnesKeepsTheValidOnesAndReportsPartialError() {
        val docs = loader.load() + "{ not json"
        val state = RagViewModel({ docs }, SavedStateHandle()).uiState.value
        assertEquals(eligible, state.names)
        assertTrue(state.loadError!!.contains("#${docs.size}"))
        assertNotNull(state.run)
    }

    @Test
    fun allBadOrLoaderFailureGivesAnEmptyListAndAnError() {
        val bad = RagViewModel({ listOf("x", "{}") }, SavedStateHandle()).uiState.value
        assertEquals(emptyList<String>(), bad.names)
        assertNull(bad.selected)
        assertNotNull(bad.loadError)
        val failed = RagViewModel({ error("assets missing") }, SavedStateHandle()).uiState.value
        assertTrue(failed.loadError!!.contains("assets missing"))
    }

    @Test
    fun runnerFailureEndsInErrorStateWithoutCrashing() {
        val vm = RagViewModel(loader, SavedStateHandle(), runner = { throw RuntimeException("boom") })
        val state = vm.uiState.value
        assertNull(state.run)
        assertTrue(state.runError!!.contains("boom"))
        assertEquals(eligible, state.names)
    }

    @Test
    fun runnerCancellationPropagatesAndIsNotAnError() {
        val vm = RagViewModel(loader, SavedStateHandle(), runner = { throw kotlinx.coroutines.CancellationException("cancelled") })
        assertNull(vm.uiState.value.runError)
    }

    // ---- every demo fixture ----

    private fun expectHas(fixture: es.sebas1705.ilabs.rag.contract.Fixture, key: String) =
        (fixture.root["expect"] as JsonObject).containsKey(key)

    private fun scripted(fixture: es.sebas1705.ilabs.rag.contract.Fixture): Boolean {
        val embedder = (fixture.root["setup"] as JsonObject)["embedder"] as? JsonObject
        return (embedder?.get("type") as? JsonPrimitive)?.content == "script"
    }

    @Test
    fun everyDemoFixtureMatchesItsContractExpectationsAndTheDemoShowsTheSameResult() {
        val vm = viewModel()
        assertTrue(vm.uiState.value.names.size >= 48)
        var live = 0
        var readOnly = 0
        for (name in vm.uiState.value.names) {
            vm.select(name)
            val state = vm.uiState.value
            assertNull(name, state.runError)
            val fixture = state.fixture!!
            val outcome: FixtureOutcome = runBlocking { runFixture(fixture) }
            val problems = checkOutcome(fixture, outcome)
            assertTrue("$name: $problems", problems.isEmpty())
            val run = state.run!!
            assertEquals(name, scripted(fixture) || expectHas(fixture, "error"), state.readOnly)
            if (state.readOnly) readOnly++ else live++
            if (outcome.error != null) {
                assertTrue(name, state.readOnly)
                assertEquals(name, outcome.error!!.kind, run.failure!!.kind)
                assertEquals(name, outcome.error!!.required, run.failure.required)
                continue
            }
            assertNull(name, run.failure)
            // The live run over the default controls reproduces what the harness recorded.
            outcome.hits?.let { assertEquals(name, it, run.rows.map { row -> row.hit }) }
            outcome.context?.let {
                assertEquals(name, it.message.content, run.context!!.content)
                assertEquals(name, it.sources, run.context.sources)
                assertEquals(name, it.droppedCount, run.context.droppedCount)
            }
            outcome.answer?.let {
                assertEquals(name, it.citations, run.citations!!.citations)
                assertEquals(name, it.answer, run.citations.reply)
                assertEquals(name, it.sources, run.context!!.sources)
                assertEquals(name, outcome.requests.single().messages.first().content, run.context.content)
            }
            outcome.questions?.let { questions ->
                assertEquals(name, questions[0].modes.map { m -> m.metrics }, run.metrics!!.map { m -> m.metrics })
                assertEquals(name, questions[0].modes.map { m -> m.hits }, run.metrics.map { m -> m.hits })
            }
        }
        assertTrue("live fixtures: $live", live >= 30)
        assertTrue("read-only fixtures: $readOnly", readOnly >= 10)
    }

    @Test
    fun theHarnessExpectationsArePresentForEveryDemoFixture() {
        // Guards the `expect` access of the test above: a fixture file without an expect object would hide a failure.
        for (doc in loader.load().map(::parseFixture).filter { it.name in eligible }) {
            assertTrue(doc.name, doc.root["expect"] is JsonObject)
            assertTrue(doc.name, (doc.root["setup"] as JsonObject)["documents"] is JsonArray)
        }
    }
}
