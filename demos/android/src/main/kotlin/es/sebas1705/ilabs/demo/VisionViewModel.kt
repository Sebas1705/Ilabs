package es.sebas1705.ilabs.demo

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.CreationExtras
import es.sebas1705.ilabs.vision.ClassEntry
import es.sebas1705.ilabs.vision.Detection
import es.sebas1705.ilabs.vision.DetectionOptions
import es.sebas1705.ilabs.vision.Geometry
import es.sebas1705.ilabs.vision.ImageSize
import es.sebas1705.ilabs.vision.ResizeMode
import es.sebas1705.ilabs.vision.VisionException
import es.sebas1705.ilabs.vision.postprocessClassification
import es.sebas1705.ilabs.vision.postprocessDetections
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlin.time.DurationUnit
import kotlin.time.TimeSource

/** The value of [VisionUiState.selected] while the user's own image is the picture. */
const val VISION_YOUR_IMAGE = "~your-image"

/** The postprocessing controls. The library validates them; the screen only offers a sensible range. */
data class VisionControls(
    val topK: Int = VisionViewModel.DEFAULT_TOP_K,
    val scoreThreshold: Double = VisionViewModel.DEFAULT_SCORE_THRESHOLD,
    val iouThreshold: Double = VisionViewModel.DEFAULT_IOU_THRESHOLD,
    val nms: Boolean = false,
    val maxDetections: Int = VisionViewModel.DEFAULT_MAX_DETECTIONS,
)

/** The three phases of a run in milliseconds; [inferenceMs] is null for a recording (nothing ran). */
data class VisionTimings(val preprocessMs: Double, val inferenceMs: Double?, val postprocessMs: Double)

/** A failure: [kind] is the library's wire name (`invalid_options`, `invalid_spec`, `invalid_output`), `image` or `run`. */
data class VisionFailure(val kind: String, val detail: String?)

/** Why a section shows a note instead of, or next to, its results. */
enum class VisionNote {
    /** The real model was asked for but is not in this build: the recording is shown. */
    REAL_UNAVAILABLE_FALLBACK,

    /** The user's image has no recording and the real model is not in this build: nothing can be shown. */
    REAL_UNAVAILABLE_NO_RECORDING,
}

/**
 * Everything one task shows. [entries] and [detections] come from the library, [geometry] and [preview] describe what the
 * model saw; [source] is the size of the original image, so every detection box is in its pixels.
 */
data class VisionResult(
    val task: VisionTask,
    val backend: VisionBackend,
    val cardId: String,
    val mode: ResizeMode,
    val inputWidth: Int,
    val inputHeight: Int,
    val geometry: Geometry,
    val preview: PreviewImage,
    val source: ImageSize,
    val entries: List<ClassEntry>,
    val detections: List<Detection>,
    val timings: VisionTimings,
)

/** One of the two sections (Classify, Detect). */
data class VisionSection(
    val running: Boolean = false,
    val result: VisionResult? = null,
    val failure: VisionFailure? = null,
    val note: VisionNote? = null,
)

data class VisionUiState(
    val samples: List<VisionSample> = emptyList(),
    /** A sample id, or [VISION_YOUR_IMAGE]. */
    val selected: String? = null,
    /** The reference of the picture shown (`asset:...` or `file:...`). */
    val imageRef: String? = null,
    /** The backend the user chose; the user's own image always runs the real model. */
    val backend: VisionBackend = VisionBackend.RECORDED,
    /** Whether the TFLite model of each task is in this build. */
    val realAvailable: Map<VisionTask, Boolean> = emptyMap(),
    val controls: VisionControls = VisionControls(),
    val classification: VisionSection = VisionSection(),
    val detection: VisionSection = VisionSection(),
    /** Set when some or all of the assets could not be loaded; the valid ones are still offered. */
    val loadError: String? = null,
) {
    val yourImage: Boolean get() = selected == VISION_YOUR_IMAGE
    val effectiveBackend: VisionBackend get() = if (yourImage) VisionBackend.REAL else backend
    val realSelectable: Boolean get() = realAvailable.values.any { it }
    val sample: VisionSample? get() = samples.firstOrNull { it.id == selected }

    fun section(task: VisionTask): VisionSection = if (task == VisionTask.CLASSIFICATION) classification else detection

    fun withSection(task: VisionTask, section: VisionSection): VisionUiState =
        if (task == VisionTask.CLASSIFICATION) copy(classification = section) else copy(detection = section)
}

/**
 * The postprocessing of one inference: the library decodes the raw outputs with the card's spec and the current
 * [controls]. The model is not involved, so this is what a control change re-runs.
 */
internal fun postprocess(inference: Inference, controls: VisionControls): VisionResult {
    val spec = inference.card.spec
    val start = TimeSource.Monotonic.markNow()
    var entries = emptyList<ClassEntry>()
    var detections = emptyList<Detection>()
    if (inference.task == VisionTask.CLASSIFICATION) {
        val output = inference.outputs[VISION_CLASSIFIER_OUTPUT] ?: error("the model gave no classifier output")
        entries = postprocessClassification(output.data, spec, controls.topK)
    } else {
        val options = DetectionOptions(controls.scoreThreshold, controls.iouThreshold, controls.maxDetections, controls.nms)
        detections = postprocessDetections(inference.outputs, spec, inference.geometry, inference.source, options)
    }
    val postprocessMs = start.elapsedNow().toDouble(DurationUnit.MILLISECONDS)
    return VisionResult(
        inference.task, inference.backend, inference.card.id, spec.input.mode, spec.input.width, spec.input.height,
        inference.geometry, inference.preview, inference.source, entries, detections,
        VisionTimings(inference.preprocessMs, inference.inferenceMs, postprocessMs),
    )
}

private fun failureOf(e: Exception): VisionFailure = when (e) {
    is VisionException -> VisionFailure(e.kind.wire, e.message)
    is VisionImageException -> VisionFailure("image", e.message)
    else -> VisionFailure("run", e.message ?: e::class.simpleName)
}

class VisionViewModel(
    private val loader: VisionAssets,
    private val savedState: SavedStateHandle,
    /** Obtains the raw outputs of one task for one image: the only step that calls a model. */
    private val runner: suspend (InferRequest) -> Inference,
    private val onClear: () -> Unit = {},
) : ViewModel() {
    private class Raw(val key: String, val inference: Inference)

    private sealed interface Plan {
        class Run(val request: InferRequest, val note: VisionNote?) : Plan {
            val key: String get() = "${request.task}|${request.imageRef}|${request.backend}|${request.card.id}|${request.sampleId}"
        }

        class Unavailable(val note: VisionNote) : Plan

        class Broken(val failure: VisionFailure) : Plan
    }

    private val catalog: VisionCatalog = try {
        loadVisionCatalog(loader)
    } catch (e: Exception) {
        VisionCatalog(emptyList(), emptyList(), listOf(e.message ?: e::class.simpleName.orEmpty()))
    }
    private val realAvailable: Map<VisionTask, Boolean> = VisionTask.entries.associateWith { task ->
        try {
            catalog.realCard(task)?.let { loader.exists("models/${it.file}") } == true
        } catch (e: Exception) {
            false
        }
    }
    private val _uiState = MutableStateFlow(VisionUiState())
    val uiState: StateFlow<VisionUiState> = _uiState.asStateFlow()
    private val jobs = HashMap<VisionTask, Job>()
    private val inflight = HashMap<VisionTask, String>()
    private val raws = HashMap<VisionTask, Raw>()

    init {
        val samples = catalog.samples
        val userRef = savedState.get<String>(KEY_IMAGE)
        val saved = savedState.get<String>(KEY_SELECTED)
        val selected = when {
            saved == VISION_YOUR_IMAGE && userRef != null -> VISION_YOUR_IMAGE
            saved != null && samples.any { it.id == saved } -> saved
            samples.any { it.id == DEFAULT_SAMPLE } -> DEFAULT_SAMPLE
            else -> samples.firstOrNull()?.id
        }
        val realSelectable = realAvailable.values.any { it }
        val backend = if (savedState.get<String>(KEY_BACKEND) == "real" && realSelectable) VisionBackend.REAL else VisionBackend.RECORDED
        val controls = VisionControls(
            topK = savedState.get<Int>(KEY_TOP_K) ?: DEFAULT_TOP_K,
            scoreThreshold = savedState.get<Double>(KEY_SCORE) ?: DEFAULT_SCORE_THRESHOLD,
            iouThreshold = savedState.get<Double>(KEY_IOU) ?: DEFAULT_IOU_THRESHOLD,
            nms = savedState.get<Boolean>(KEY_NMS) ?: false,
            maxDetections = savedState.get<Int>(KEY_MAX) ?: DEFAULT_MAX_DETECTIONS,
        )
        _uiState.value = VisionUiState(
            samples = samples,
            selected = selected,
            imageRef = refOf(selected, userRef, samples),
            backend = backend,
            realAvailable = realAvailable,
            controls = controls,
            loadError = catalog.problems.takeIf { it.isNotEmpty() }?.joinToString("; "),
        )
        persist()
        if (selected != null) VisionTask.entries.forEach(::refresh)
    }

    private fun refOf(selected: String?, userRef: String?, samples: List<VisionSample>): String? =
        if (selected == VISION_YOUR_IMAGE) userRef else samples.firstOrNull { it.id == selected }?.ref

    /** Picks a sample image; both tasks run on it. */
    fun select(id: String) {
        val state = _uiState.value
        val sample = state.samples.firstOrNull { it.id == id } ?: return
        if (state.selected == id) return
        _uiState.update { it.copy(selected = id, imageRef = sample.ref) }
        persist()
        VisionTask.entries.forEach(::refresh)
    }

    /** Uses the user's own image, already imported by the platform as [ref]. */
    fun useImage(ref: String) {
        if (_uiState.value.samples.isEmpty()) return
        savedState[KEY_IMAGE] = ref
        _uiState.update { it.copy(selected = VISION_YOUR_IMAGE, imageRef = ref) }
        persist()
        VisionTask.entries.forEach(::refresh)
    }

    fun setBackend(backend: VisionBackend) {
        val state = _uiState.value
        if (backend == state.backend || (backend == VisionBackend.REAL && !state.realSelectable)) return
        _uiState.update { it.copy(backend = backend) }
        persist()
        VisionTask.entries.forEach(::refresh)
    }

    /** Sets topK as given: the library validates it (a value below 1 is its invalid_options). */
    fun setTopK(value: Int) = setControls(VisionTask.CLASSIFICATION) { it.copy(topK = value) }

    fun setScoreThreshold(value: Double) = setControls(VisionTask.DETECTION) { it.copy(scoreThreshold = value) }

    fun setIouThreshold(value: Double) = setControls(VisionTask.DETECTION) { it.copy(iouThreshold = value) }

    fun setNms(value: Boolean) = setControls(VisionTask.DETECTION) { it.copy(nms = value) }

    fun setMaxDetections(value: Int) = setControls(VisionTask.DETECTION) { it.copy(maxDetections = value) }

    private fun setControls(task: VisionTask, change: (VisionControls) -> VisionControls) {
        val state = _uiState.value
        val next = change(state.controls)
        if (next == state.controls || state.selected == null) return
        _uiState.update { it.copy(controls = next) }
        persist()
        repost(task)
    }

    private fun persist() {
        val s = _uiState.value
        savedState[KEY_SELECTED] = s.selected
        savedState[KEY_BACKEND] = if (s.backend == VisionBackend.REAL) "real" else "recorded"
        savedState[KEY_TOP_K] = s.controls.topK
        savedState[KEY_SCORE] = s.controls.scoreThreshold
        savedState[KEY_IOU] = s.controls.iouThreshold
        savedState[KEY_NMS] = s.controls.nms
        savedState[KEY_MAX] = s.controls.maxDetections
    }

    /** What the current selection asks of [task]: run it (from the recording or the real model), show a note, or fail. */
    private fun plan(task: VisionTask): Plan? {
        val state = _uiState.value
        val ref = state.imageRef ?: return null
        val sampleId = state.sample?.id
        var note: VisionNote? = null
        if (state.effectiveBackend == VisionBackend.REAL) {
            val real = catalog.realCard(task)
            if (real != null && realAvailable[task] == true) return Plan.Run(InferRequest(task, ref, sampleId, VisionBackend.REAL, real), null)
            if (state.yourImage) return Plan.Unavailable(VisionNote.REAL_UNAVAILABLE_NO_RECORDING)
            note = VisionNote.REAL_UNAVAILABLE_FALLBACK
        }
        val card = catalog.recordedCard(task) ?: return Plan.Broken(VisionFailure("run", "no model card for ${task.wire}"))
        return Plan.Run(InferRequest(task, ref, sampleId, VisionBackend.RECORDED, card), note)
    }

    private fun currentKey(task: VisionTask): String? = (plan(task) as? Plan.Run)?.key

    private fun setSection(task: VisionTask, section: VisionSection) = _uiState.update { it.withSection(task, section) }

    /** Starts the task over for the current selection: the previous job is cancelled and its raw outputs dropped. */
    private fun refresh(task: VisionTask) {
        jobs.remove(task)?.cancel()
        inflight.remove(task)
        raws.remove(task)
        when (val plan = plan(task)) {
            null -> setSection(task, VisionSection())
            is Plan.Unavailable -> setSection(task, VisionSection(note = plan.note))
            is Plan.Broken -> setSection(task, VisionSection(failure = plan.failure))
            is Plan.Run -> start(task, plan)
        }
    }

    /** Asks the runner once. A result is applied only while its key is still the current one. */
    private fun start(task: VisionTask, plan: Plan.Run) {
        val key = plan.key
        inflight[task] = key
        setSection(task, VisionSection(running = true, note = plan.note))
        jobs[task] = viewModelScope.launch {
            try {
                val inference = runner(plan.request)
                if (currentKey(task) != key) return@launch
                raws[task] = Raw(key, inference)
                inflight.remove(task)
                applyPost(task)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (currentKey(task) != key) return@launch
                inflight.remove(task)
                setSection(task, VisionSection(failure = failureOf(e), note = plan.note))
            }
        }
    }

    /** A control changed: postprocess the raw outputs we already have; ask the model again only when there are none. */
    private fun repost(task: VisionTask) {
        val plan = plan(task) as? Plan.Run ?: return
        when {
            raws[task]?.key == plan.key -> applyPost(task)
            inflight[task] == plan.key -> Unit // the running inference postprocesses with the latest controls when it ends
            else -> refresh(task)
        }
    }

    private fun applyPost(task: VisionTask) {
        val plan = plan(task) as? Plan.Run ?: return
        val raw = raws[task]?.takeIf { it.key == plan.key } ?: return
        val section = try {
            VisionSection(result = postprocess(raw.inference, _uiState.value.controls), note = plan.note)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            VisionSection(failure = failureOf(e), note = plan.note)
        }
        setSection(task, section)
    }

    override fun onCleared() {
        onClear()
    }

    companion object {
        const val DEFAULT_TOP_K = 5
        const val MIN_TOP_K = 1
        const val MAX_TOP_K = 10
        const val DEFAULT_SCORE_THRESHOLD = 0.3
        const val DEFAULT_IOU_THRESHOLD = 0.5
        const val DEFAULT_MAX_DETECTIONS = 100
        const val MAX_LISTED_DETECTIONS = 100
        private const val DEFAULT_SAMPLE = "cat"
        private const val KEY_SELECTED = "selected"
        private const val KEY_IMAGE = "image"
        private const val KEY_BACKEND = "backend"
        private const val KEY_TOP_K = "topK"
        private const val KEY_SCORE = "score"
        private const val KEY_IOU = "iou"
        private const val KEY_NMS = "nms"
        private const val KEY_MAX = "max"

        fun factory(assets: VisionAssets, platform: VisionPlatform): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>, extras: CreationExtras): T {
                val models = LiteRtModels(assets)
                val engine = VisionEngine(assets, platform, models)
                return VisionViewModel(assets, extras.createSavedStateHandle(), engine::infer, onClear = models::close) as T
            }
        }
    }
}
