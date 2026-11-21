package es.sebas1705.ilabs.demo

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.CreationExtras
import es.sebas1705.ilabs.guardrails.PiiKind
import es.sebas1705.ilabs.guardrails.contract.Fixture
import es.sebas1705.ilabs.guardrails.contract.FixtureOutcome
import es.sebas1705.ilabs.guardrails.contract.parseFixture
import es.sebas1705.ilabs.guardrails.contract.runFixture
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/**
 * What the screen renders, for the three sections. [textRevision] grows whenever the text is set by the program (picking
 * a sample, restoring), never while typing, so the text field only re-reads the state then. A section's result is null
 * while it runs and its `...RunError` is set when running it failed.
 */
data class GuardrailsUiState(
    val playgroundNames: List<String> = emptyList(),
    val guardedNames: List<String> = emptyList(),
    val measureNames: List<String> = emptyList(),
    val sample: String? = null,
    val sampleFixture: Fixture? = null,
    val text: String = "",
    val textRevision: Int = 0,
    /** True when the text is too long to highlight per character (see [HIGHLIGHT_LIMIT_CODE_POINTS]). */
    val largeText: Boolean = false,
    val controls: PolicyControls = PolicyControls(),
    /** True when the sample has checks the toggles cannot show (a classifier, a canary, a second check of a kind...). */
    val partialChecks: Boolean = false,
    val playground: PlaygroundRun? = null,
    val guardedSelected: String? = null,
    val guarded: GuardedView? = null,
    val measureSelected: String? = null,
    val measure: MeasureView? = null,
    /** Set when some or all fixture documents could not be loaded; the valid ones are still listed. */
    val loadError: String? = null,
    val runError: String? = null,
    val guardedRunError: String? = null,
    val measureRunError: String? = null,
) {
    /** Playground samples by group, in group order, empty groups left out. */
    val groups: List<Pair<GuardrailsGroup, List<String>>>
        get() = playgroundNames.mapNotNull { n -> GuardrailsGroup.of(n)?.let { it to n } }
            .groupBy({ it.first }, { it.second }).toList().sortedBy { it.first.ordinal }
}

class GuardrailsViewModel(
    loader: FixtureLoader,
    private val savedState: SavedStateHandle,
    private val runner: suspend (PlaygroundRequest) -> PlaygroundRun = ::runPlayground,
    private val fixtureRunner: suspend (Fixture) -> FixtureOutcome = ::runFixture,
    /** Where the library runs: off the main thread in the app (a long text can take a while), a test dispatcher in tests. */
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
) : ViewModel() {
    private val fixtures: Map<String, Fixture>
    private val _uiState = MutableStateFlow(GuardrailsUiState())
    val uiState: StateFlow<GuardrailsUiState> = _uiState.asStateFlow()
    private var playgroundJob: Job? = null
    private var guardedJob: Job? = null
    private var measureJob: Job? = null

    init {
        val problems = mutableListOf<String>()
        val parsed = try {
            loader.load().mapIndexedNotNull { index, doc ->
                try {
                    parseFixture(doc).also { check(it.name.isNotEmpty()) { "invalid fixture: missing name" } }
                } catch (e: Exception) {
                    problems += "${describe(index, doc)}: ${e.message ?: e::class.simpleName}"
                    null
                }
            }.sortedBy { it.name }
        } catch (e: Exception) {
            problems += e.message ?: e::class.simpleName.orEmpty()
            emptyList()
        }
        fixtures = parsed.associateBy { it.name }
        val playground = GuardrailsGroup.entries.flatMap { group ->
            parsed.filter { it.name.startsWith(group.prefix) && it.kind == PLAYGROUND_KINDS.getValue(group) && !expectsError(it) }.map { it.name }
        }
        val guarded = parsed.filter { it.name.startsWith("guarded-") && it.kind == "guarded" }.map { it.name }
        // An eval fixture that expects an error (an unknown metric kind) is not a labelled set to measure.
        val measure = parsed.filter { it.name.startsWith("eval-") && it.kind == "eval" && !expectsError(it) }.map { it.name }
        _uiState.value = GuardrailsUiState(
            playgroundNames = playground,
            guardedNames = guarded,
            measureNames = measure,
            loadError = problems.takeIf { it.isNotEmpty() }?.joinToString("; "),
        )
        if (playground.isNotEmpty()) {
            val saved = savedState.get<String>(KEY_SAMPLE)
            val default = playground.firstOrNull { it.startsWith(GuardrailsGroup.PII.prefix) } ?: playground.first()
            val name = saved?.takeIf(fixtures::containsKey)?.takeIf { it in playground } ?: default
            // Saved edits belong to the saved selection only; after a fallback the sample's defaults apply.
            openSample(name, restore = name == saved)
        }
        if (guarded.isNotEmpty()) {
            val saved = savedState.get<String>(KEY_GUARDED)
            openGuarded(saved?.takeIf { it in guarded } ?: DEFAULT_GUARDED.takeIf { it in guarded } ?: guarded.first())
        }
        if (measure.isNotEmpty()) {
            val saved = savedState.get<String>(KEY_MEASURE)
            openMeasure(saved?.takeIf { it in measure } ?: DEFAULT_MEASURE.takeIf { it in measure } ?: measure.first())
        }
    }

    // ---- playground ----

    /** Picks a playground sample: its text (and, for a check sample, its checks) become the starting values. */
    fun selectSample(name: String) {
        if (name in _uiState.value.playgroundNames) openSample(name, restore = false)
    }

    /** Sets the text as typed: the library validates nothing here, it only analyses. */
    fun setText(text: String) {
        val state = _uiState.value
        if (state.sample == null || text == state.text) return
        _uiState.update { it.copy(text = text, largeText = isLarge(text)) }
        persist()
        refreshPlayground()
    }

    fun setPiiAction(action: ControlAction) = edit { it.copy(piiAction = action) }

    fun togglePiiKind(kind: PiiKind) = edit { it.copy(piiKinds = if (kind in it.piiKinds) it.piiKinds - kind else it.piiKinds + kind) }

    fun setInjectionAction(action: ControlAction) = edit { it.copy(injectionAction = action) }

    /** Sets the threshold field as typed: the library validates it (a value outside 1 to 100 is its invalid_policy). */
    fun setInjectionThreshold(value: String) = edit { it.copy(injectionThreshold = value) }

    fun setDenyAction(action: ControlAction) = edit { it.copy(denyAction = action) }

    fun setDenyTerms(value: String) = edit { it.copy(denyTerms = value) }

    fun setMaxAction(action: ControlAction) = edit { it.copy(maxAction = action) }

    fun setMaxLength(value: String) = edit { it.copy(maxLength = value) }

    private fun edit(change: (PolicyControls) -> PolicyControls) {
        val state = _uiState.value
        if (state.sample == null) return
        val next = change(state.controls)
        if (next == state.controls) return
        _uiState.update { it.copy(controls = next) }
        persist()
        refreshPlayground()
    }

    private fun openSample(name: String, restore: Boolean) {
        val fixture = fixtures.getValue(name)
        val setup = try {
            sampleSetupOf(fixture)
        } catch (e: Exception) {
            playgroundJob?.cancel()
            savedState[KEY_SAMPLE] = name
            _uiState.update {
                it.copy(sample = name, sampleFixture = fixture, playground = null, runError = "$name: ${e.message ?: e::class.simpleName}")
            }
            return
        }
        val text = (if (restore) savedState.get<String>(KEY_TEXT) else null) ?: setup.text
        val controls = if (restore) restoredControls(setup.controls) else setup.controls
        _uiState.update {
            it.copy(
                sample = name, sampleFixture = fixture, text = text, largeText = isLarge(text), textRevision = it.textRevision + 1,
                controls = controls, partialChecks = setup.partial, playground = null, runError = null,
            )
        }
        persist()
        refreshPlayground()
    }

    private fun restoredControls(base: PolicyControls): PolicyControls = PolicyControls(
        piiAction = ControlAction.ofName(savedState.get<String>(KEY_PII_ACTION)) ?: base.piiAction,
        piiKinds = savedState.get<String>(KEY_PII_KINDS)?.let { kindsOfNames(it) } ?: base.piiKinds,
        injectionAction = ControlAction.ofName(savedState.get<String>(KEY_INJ_ACTION)) ?: base.injectionAction,
        injectionThreshold = savedState.get<String>(KEY_INJ_THRESHOLD) ?: base.injectionThreshold,
        denyAction = ControlAction.ofName(savedState.get<String>(KEY_DENY_ACTION)) ?: base.denyAction,
        denyTerms = savedState.get<String>(KEY_DENY_TERMS) ?: base.denyTerms,
        maxAction = ControlAction.ofName(savedState.get<String>(KEY_MAX_ACTION)) ?: base.maxAction,
        maxLength = savedState.get<String>(KEY_MAX_LENGTH) ?: base.maxLength,
    )

    private fun kindsOfNames(joined: String): Set<PiiKind> =
        if (joined.isEmpty()) emptySet() else joined.split(',').mapNotNull { n -> PiiKind.entries.firstOrNull { it.wire == n } }.toSet()

    private fun persist() {
        val s = _uiState.value
        savedState[KEY_SAMPLE] = s.sample
        savedState[KEY_TEXT] = persistedText(s.text)
        savedState[KEY_PII_ACTION] = s.controls.piiAction.name
        savedState[KEY_PII_KINDS] = PiiKind.entries.filter { it in s.controls.piiKinds }.joinToString(",") { it.wire }
        savedState[KEY_INJ_ACTION] = s.controls.injectionAction.name
        savedState[KEY_INJ_THRESHOLD] = s.controls.injectionThreshold
        savedState[KEY_DENY_ACTION] = s.controls.denyAction.name
        savedState[KEY_DENY_TERMS] = s.controls.denyTerms
        savedState[KEY_MAX_ACTION] = s.controls.maxAction.name
        savedState[KEY_MAX_LENGTH] = s.controls.maxLength
    }

    private fun isLarge(text: String) = text.length > HIGHLIGHT_LIMIT_CODE_POINTS && codePointLength(text) > HIGHLIGHT_LIMIT_CODE_POINTS

    /** Saved state must stay small: a longer text is saved cut to [MAX_SAVED_TEXT] characters, never inside a surrogate pair. */
    private fun persistedText(text: String): String {
        if (text.length <= MAX_SAVED_TEXT) return text
        val cut = if (text[MAX_SAVED_TEXT - 1].isHighSurrogate()) MAX_SAVED_TEXT - 1 else MAX_SAVED_TEXT
        return text.substring(0, cut)
    }

    private fun requestOf(s: GuardrailsUiState) = PlaygroundRequest(s.text, s.controls)

    /** Runs the current text and toggles. The previous job is cancelled; a result is applied only while its request is still current. */
    private fun refreshPlayground() {
        val state = _uiState.value
        if (state.sample == null) return
        val request = requestOf(state)
        playgroundJob?.cancel()
        playgroundJob = viewModelScope.launch(dispatcher) {
            try {
                val run = runner(request)
                _uiState.update { if (requestOf(it) != request) it else it.copy(playground = run, runError = null) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val message = "${state.sample}: ${e.message ?: e::class.simpleName}"
                _uiState.update { if (requestOf(it) != request) it else it.copy(playground = null, runError = message) }
            }
        }
    }

    // ---- guarded conversation ----

    fun selectGuarded(name: String) {
        if (name in _uiState.value.guardedNames) openGuarded(name)
    }

    private fun openGuarded(name: String) {
        savedState[KEY_GUARDED] = name
        _uiState.update { it.copy(guardedSelected = name, guarded = null, guardedRunError = null) }
        val fixture = fixtures.getValue(name)
        guardedJob?.cancel()
        guardedJob = viewModelScope.launch(dispatcher) {
            try {
                val view = guardedViewOf(fixture, fixtureRunner(fixture))
                _uiState.update { if (it.guardedSelected != name) it else it.copy(guarded = view, guardedRunError = null) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _uiState.update { if (it.guardedSelected != name) it else it.copy(guarded = null, guardedRunError = "$name: ${e.message ?: e::class.simpleName}") }
            }
        }
    }

    // ---- measure ----

    fun selectMeasure(name: String) {
        if (name in _uiState.value.measureNames) openMeasure(name)
    }

    private fun openMeasure(name: String) {
        savedState[KEY_MEASURE] = name
        _uiState.update { it.copy(measureSelected = name, measure = null, measureRunError = null) }
        val fixture = fixtures.getValue(name)
        measureJob?.cancel()
        measureJob = viewModelScope.launch(dispatcher) {
            try {
                val view = measureViewOf(fixture, fixtureRunner(fixture))
                _uiState.update { if (it.measureSelected != name) it else it.copy(measure = view, measureRunError = null) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _uiState.update { if (it.measureSelected != name) it else it.copy(measure = null, measureRunError = "$name: ${e.message ?: e::class.simpleName}") }
            }
        }
    }

    // ---- helpers ----

    private fun expectsError(fixture: Fixture): Boolean = (fixture.root["expect"] as? JsonObject)?.containsKey("error") == true

    /** Names a malformed document: its "name" field when one can be read, else its position (1-based). */
    private fun describe(index: Int, doc: String): String {
        val name = NAME_FIELD.find(doc)?.groupValues?.get(1)
        return if (name != null) "$name (#${index + 1})" else "#${index + 1}"
    }

    companion object {
        private val PLAYGROUND_KINDS = mapOf(
            GuardrailsGroup.PII to "pii",
            GuardrailsGroup.INJECTION to "injection",
            GuardrailsGroup.CHECKS to "check",
        )
        /** The most characters of the text kept in the saved state. */
        const val MAX_SAVED_TEXT = 50_000
        private const val DEFAULT_GUARDED = "guarded-ok-redact-and-restore"
        private const val DEFAULT_MEASURE = "eval-labelled-set"
        private const val KEY_SAMPLE = "sample"
        private const val KEY_TEXT = "text"
        private const val KEY_PII_ACTION = "piiAction"
        private const val KEY_PII_KINDS = "piiKinds"
        private const val KEY_INJ_ACTION = "injAction"
        private const val KEY_INJ_THRESHOLD = "injThreshold"
        private const val KEY_DENY_ACTION = "denyAction"
        private const val KEY_DENY_TERMS = "denyTerms"
        private const val KEY_MAX_ACTION = "maxAction"
        private const val KEY_MAX_LENGTH = "maxLength"
        private const val KEY_GUARDED = "guarded"
        private const val KEY_MEASURE = "measure"
        private val NAME_FIELD = Regex("\"name\"\\s*:\\s*\"([^\"]+)\"")

        fun factory(loader: FixtureLoader): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>, extras: CreationExtras): T =
                GuardrailsViewModel(loader, extras.createSavedStateHandle()) as T
        }
    }
}
