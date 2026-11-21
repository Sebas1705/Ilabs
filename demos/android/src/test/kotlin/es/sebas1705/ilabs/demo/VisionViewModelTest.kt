package es.sebas1705.ilabs.demo

import androidx.lifecycle.SavedStateHandle
import es.sebas1705.ilabs.vision.ClassEntry
import es.sebas1705.ilabs.vision.Detection
import es.sebas1705.ilabs.vision.ImageSize
import es.sebas1705.ilabs.vision.ResizeMode
import es.sebas1705.ilabs.vision.ScriptedModel
import es.sebas1705.ilabs.vision.Tensor
import es.sebas1705.ilabs.vision.classify
import es.sebas1705.ilabs.vision.detect
import es.sebas1705.ilabs.vision.preprocessGeometry
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class VisionViewModelTest {
    private val platform = ImageIoPlatform()
    private val plain = FileVisionAssets()
    private val catalog = loadVisionCatalog(plain)
    private val samples = catalog.samples

    @Before
    fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun engine(assets: VisionAssets = plain, models: VisionModels = FakeModels()) =
        VisionEngine(assets, platform, models, Dispatchers.Unconfined)

    /** A view model whose runner counts every request it receives. */
    private class Counted(val vm: VisionViewModel, val requests: MutableList<InferRequest>)

    private fun counted(
        assets: VisionAssets = plain,
        models: VisionModels = FakeModels(),
        handle: SavedStateHandle = SavedStateHandle(),
    ): Counted {
        val engine = engine(assets, models)
        val requests = mutableListOf<InferRequest>()
        val vm = VisionViewModel(assets, handle, { request ->
            requests += request
            engine.infer(request)
        })
        return Counted(vm, requests)
    }

    private fun withRealModels() = FileVisionAssets(models = TFLITE_FILES)

    private fun sample(id: String) = samples.first { it.id == id }

    // ---- the oracle: the library's own classify and detect over the recorded raw outputs, read independently ----

    private fun recordedTensors(id: String, task: VisionTask): Map<String, Tensor> = parseRecorded(File(VISION_ASSETS_DIR, "recorded/$id.${task.wire}.json").readText()).tensors

    private fun oracleEntries(id: String, topK: Int = 5): List<ClassEntry> = runBlocking {
        val card = catalog.recordedCard(VisionTask.CLASSIFICATION)!!
        val model = ScriptedModel(mapOf("output" to recordedTensors(id, VisionTask.CLASSIFICATION).getValue("output")))
        classify(model, platform.decode(sample(id).ref), card.spec, topK).entries
    }

    private fun oracleDetections(id: String): List<Detection> = runBlocking {
        val card = catalog.recordedCard(VisionTask.DETECTION)!!
        val raw = recordedTensors(id, VisionTask.DETECTION)
        val model = ScriptedModel(
            mapOf(
                "boxes" to raw.getValue("detection_boxes"),
                "classes" to raw.getValue("detection_classes"),
                "scores" to raw.getValue("detection_scores"),
                "count" to raw.getValue("num_detections"),
            ),
        )
        detect(model, platform.decode(sample(id).ref), card.spec).detections
    }

    // ---- listing and defaults ----

    @Test
    fun listsTheSevenSamplesAndStartsOnTheCat() {
        val state = counted().vm.uiState.value
        assertEquals(listOf("cat", "dog", "crowd", "giraffe-tall", "city-panorama", "fog-rocks", "mountains-wide"), state.samples.map { it.id })
        assertEquals("cat", state.selected)
        assertEquals(VisionBackend.RECORDED, state.backend)
        assertEquals(VisionControls(5, 0.3, 0.5, false, 100), state.controls)
        assertNull(state.loadError)
    }

    @Test
    fun theSampleTitlesComeInBothLanguages() {
        val cat = samples.first()
        assertEquals("Close-up of a tabby cat", cat.title("en"))
        assertEquals("Gato atigrado en primer plano", cat.title("es"))
    }

    // ---- live == recorded ----

    @Test
    fun everySampleGivesWhatTheLibraryComputesFromTheRecording() {
        val vm = counted().vm
        for (sample in samples) {
            vm.select(sample.id)
            val state = vm.uiState.value
            val classification = state.classification.result
            val detection = state.detection.result
            assertNotNull(sample.id, classification)
            assertNotNull(sample.id, detection)
            assertEquals(sample.id, oracleEntries(sample.id), classification!!.entries)
            assertEquals(sample.id, oracleDetections(sample.id), detection!!.detections)
            assertEquals(ImageSize(sample.width, sample.height), detection.source)
            assertEquals(VisionBackend.RECORDED, classification.backend)
        }
    }

    @Test
    fun theRecordedResultsMatchTheDocumentedOnes() {
        val vm = counted().vm
        val cat = vm.uiState.value
        assertEquals("tabby", cat.classification.result!!.entries.first().label)
        assertEquals(64.6, cat.classification.result.entries.first().score * 100, 0.05)
        assertEquals(listOf("cat"), cat.detection.result!!.detections.map { it.label })
        vm.select("crowd")
        val crowd = vm.uiState.value.detection.result!!.detections
        assertEquals(14, crowd.count { it.label == "person" })
        assertEquals(2, crowd.count { it.label == "umbrella" })
        vm.select("city-panorama")
        assertTrue(vm.uiState.value.detection.result!!.detections.isEmpty())
        vm.select("fog-rocks")
        assertEquals("stone wall", vm.uiState.value.classification.result!!.entries.first().label)
    }

    @Test
    fun aRecordingShowsInferenceAsRecordedAndTheOtherPhasesAsTimes() {
        val timings = counted().vm.uiState.value.classification.result!!.timings
        assertNull(timings.inferenceMs)
        assertTrue(timings.preprocessMs >= 0.0)
        assertTrue(timings.postprocessMs >= 0.0)
    }

    // ---- controls re-run only the postprocessing ----

    @Test
    fun controlChangesCallTheModelOnlyOncePerTask() {
        val c = counted()
        val vm = c.vm
        assertEquals(listOf(VisionTask.CLASSIFICATION, VisionTask.DETECTION), c.requests.map { it.task })
        val before = vm.uiState.value.detection.result!!.detections
        vm.setScoreThreshold(0.95)
        vm.setScoreThreshold(0.05)
        vm.setIouThreshold(0.1)
        vm.setNms(true)
        vm.setMaxDetections(1)
        vm.setTopK(3)
        vm.setTopK(10)
        assertEquals("one model call per task for the whole session", 2, c.requests.size)
        assertEquals(10, vm.uiState.value.classification.result!!.entries.size)
        assertEquals(1, vm.uiState.value.detection.result!!.detections.size)
        assertTrue(before.isNotEmpty())
    }

    @Test
    fun thresholdsFilterTheSameRawOutputs() {
        val vm = counted().vm
        vm.select("crowd")
        val loose = vm.uiState.value.detection.result!!.detections
        vm.setScoreThreshold(0.9)
        val strict = vm.uiState.value.detection.result!!.detections
        assertTrue(strict.size < loose.size)
        assertTrue(strict.all { it.score >= 0.9 })
        vm.setScoreThreshold(0.3)
        assertEquals(loose, vm.uiState.value.detection.result!!.detections)
        vm.setMaxDetections(3)
        assertEquals(3, vm.uiState.value.detection.result!!.detections.size)
    }

    @Test
    fun nmsOnNeverAddsBoxes() {
        val vm = counted().vm
        vm.select("crowd")
        vm.setScoreThreshold(0.05)
        val without = vm.uiState.value.detection.result!!.detections
        vm.setIouThreshold(0.2)
        vm.setNms(true)
        val with = vm.uiState.value.detection.result!!.detections
        assertTrue(with.size <= without.size)
        assertTrue(without.containsAll(with))
    }

    @Test
    fun selectingAnotherSampleRunsBothTasksAgain() {
        val c = counted()
        c.vm.select("dog")
        assertEquals(4, c.requests.size)
        assertEquals(listOf("cat", "cat", "dog", "dog"), c.requests.map { it.sampleId })
        assertEquals("dog", c.vm.uiState.value.selected)
    }

    // ---- geometry and preview ----

    @Test
    fun theGeometryAndThePreviewComeFromTheLibrary() {
        val vm = counted().vm
        val cat = sample("cat")
        val classification = vm.uiState.value.classification.result!!
        val classCard = catalog.recordedCard(VisionTask.CLASSIFICATION)!!
        assertEquals(preprocessGeometry(cat.width, cat.height, classCard.spec), classification.geometry)
        assertEquals(ResizeMode.CENTER_CROP, classification.mode)
        assertEquals(224, classification.preview.width)
        assertEquals(224, classification.preview.height)
        assertEquals(224 * 224, classification.preview.argb.size)
        assertTrue(classification.preview.argb.all { (it ushr 24) == 0xFF })
        val detection = vm.uiState.value.detection.result!!
        assertEquals(ResizeMode.STRETCH, detection.mode)
        assertEquals(300, detection.inputWidth)
        assertEquals(preprocessGeometry(cat.width, cat.height, catalog.recordedCard(VisionTask.DETECTION)!!.spec), detection.geometry)
        vm.select("giraffe-tall")
        val tall = vm.uiState.value.detection.result!!
        val giraffe = sample("giraffe-tall")
        assertEquals(300.0 / giraffe.width, tall.geometry.scaleX, 1e-12)
        assertEquals(300.0 / giraffe.height, tall.geometry.scaleY, 1e-12)
    }

    // ---- the real model ----

    @Test
    fun theRealModelIsUnavailableWithoutTheModelFiles() {
        val vm = counted().vm
        val state = vm.uiState.value
        assertFalse(state.realSelectable)
        assertEquals(mapOf(VisionTask.CLASSIFICATION to false, VisionTask.DETECTION to false), state.realAvailable)
        vm.setBackend(VisionBackend.REAL)
        assertEquals(VisionBackend.RECORDED, vm.uiState.value.backend)
        assertNotNull(vm.uiState.value.classification.result)
    }

    @Test
    fun theRealModelWorksThroughTheAdapterWhenTheModelFilesExist() {
        val models = FakeModels()
        val c = counted(withRealModels(), models)
        val vm = c.vm
        assertTrue(vm.uiState.value.realSelectable)
        vm.setBackend(VisionBackend.REAL)
        val state = vm.uiState.value
        assertEquals(VisionBackend.REAL, state.backend)
        val classification = state.classification.result!!
        assertEquals(VisionBackend.REAL, classification.backend)
        assertEquals("efficientnet-lite0-tflite", classification.cardId)
        assertEquals("tabby", classification.entries.first().label)
        assertNotNull("a real run reports the inference time", classification.timings.inferenceMs)
        val detection = state.detection.result!!
        assertEquals("ssd-mobilenet-v1-tflite", detection.cardId)
        assertEquals(listOf("cat"), detection.detections.map { it.label })
        val box = detection.detections.single().box
        val cat = sample("cat")
        assertEquals(0.2 * 300 / (300.0 / cat.width), box.x1, 1e-6)
        assertEquals(0.9 * 300 / (300.0 / cat.height), box.y2, 1e-6)
        assertEquals(listOf("efficientnet-lite0-tflite", "ssd-mobilenet-v1-tflite"), models.opened)
        assertEquals(2, models.calls)
        vm.setScoreThreshold(0.95)
        assertTrue(vm.uiState.value.detection.result!!.detections.isEmpty())
        assertEquals("a control change does not call the model again", 2, models.calls)
    }

    @Test
    fun theBackendSwitchesBetweenTheRecordingAndTheRealModelAndBack() {
        val models = FakeModels()
        val c = counted(withRealModels(), models)
        val vm = c.vm
        assertEquals(VisionBackend.RECORDED, vm.uiState.value.backend)
        assertEquals("the recording is the default and asks no model", 0, models.calls)
        c.requests.clear()
        vm.setBackend(VisionBackend.RECORDED)
        assertTrue("the backend already chosen is not a change", c.requests.isEmpty())
        vm.setBackend(VisionBackend.REAL)
        assertEquals(VisionBackend.REAL, vm.uiState.value.backend)
        assertEquals(listOf(VisionBackend.REAL, VisionBackend.REAL), c.requests.map { it.backend })
        assertEquals(2, models.calls)
        vm.setBackend(VisionBackend.RECORDED)
        val state = vm.uiState.value
        assertEquals(VisionBackend.RECORDED, state.backend)
        assertEquals(VisionBackend.RECORDED, state.classification.result!!.backend)
        assertEquals(VisionBackend.RECORDED, state.detection.result!!.backend)
        assertNull(state.classification.result.timings.inferenceMs)
        assertEquals("going back to the recording never calls a model", 2, models.calls)
        assertEquals("one request per task per switch", 4, c.requests.size)
    }

    @Test
    fun theBackendIsKeptThroughRecreation() {
        val handle = SavedStateHandle()
        val first = counted(withRealModels(), handle = handle).vm
        first.setBackend(VisionBackend.REAL)
        val restored = counted(withRealModels(), handle = handle).vm
        assertEquals(VisionBackend.REAL, restored.uiState.value.backend)
    }

    @Test
    fun aMissingTaskModelFallsBackToTheRecordingWithANote() {
        val assets = FileVisionAssets(models = setOf("efficientnet_lite0.tflite"))
        val vm = counted(assets).vm
        vm.setBackend(VisionBackend.REAL)
        val state = vm.uiState.value
        assertEquals(VisionBackend.REAL, state.classification.result!!.backend)
        assertNull(state.classification.note)
        assertEquals(VisionBackend.RECORDED, state.detection.result!!.backend)
        assertEquals(VisionNote.REAL_UNAVAILABLE_FALLBACK, state.detection.note)
    }

    @Test
    fun yourImageForcesTheRealModelAndHasNoResultsWithoutIt() {
        val c = counted()
        c.vm.useImage("asset:samples/dog.png")
        val state = c.vm.uiState.value
        assertTrue(state.yourImage)
        assertEquals(VisionBackend.REAL, state.effectiveBackend)
        assertNull(state.classification.result)
        assertNull(state.detection.result)
        assertEquals(VisionNote.REAL_UNAVAILABLE_NO_RECORDING, state.classification.note)
        assertEquals(VisionNote.REAL_UNAVAILABLE_NO_RECORDING, state.detection.note)
        assertEquals("nothing is asked of a model that is not there", 2, c.requests.size)
    }

    @Test
    fun yourImageRunsTheRealModelWhenItIsThere() {
        val vm = counted(withRealModels()).vm
        vm.useImage("asset:samples/dog.png")
        val state = vm.uiState.value
        assertEquals(VisionBackend.REAL, state.classification.result!!.backend)
        assertEquals(ImageSize(sample("dog").width, sample("dog").height), state.detection.result!!.source)
        vm.select("cat")
        assertFalse(vm.uiState.value.yourImage)
    }

    @Test
    fun anImageThatCannotBeOpenedIsARunError() {
        val vm = counted(withRealModels()).vm
        vm.useImage("file:/definitely/not/here.png")
        val failure = vm.uiState.value.classification.failure
        assertEquals("image", failure!!.kind)
    }

    // ---- load problems ----

    @Test
    fun aMalformedSampleAmongValidOnesKeepsTheValidOnes() {
        val valid = File(VISION_ASSETS_DIR, "samples.json").readText()
        val json = kotlinx.serialization.json.Json.parseToJsonElement(valid) as kotlinx.serialization.json.JsonObject
        val list = (json["samples"] as kotlinx.serialization.json.JsonArray).toList()
        val broken = kotlinx.serialization.json.buildJsonObject { put("id", kotlinx.serialization.json.JsonPrimitive("bad")) }
        val custom = kotlinx.serialization.json.buildJsonObject {
            put("samples", kotlinx.serialization.json.JsonArray(listOf(list[0], broken, list[1])))
        }.toString()
        val vm = counted(FileVisionAssets(overrides = mapOf("samples.json" to custom))).vm
        val state = vm.uiState.value
        assertEquals(listOf("cat", "dog"), state.samples.map { it.id })
        assertTrue(state.loadError!!.contains("bad"))
        assertNotNull("the valid samples still run", state.classification.result)
    }

    @Test
    fun aMalformedCardIsReportedAndTheOtherCardsStay() {
        val json = File(VISION_ASSETS_DIR, "models.json").readText().replace("\"mode\": \"centerCrop\"", "\"mode\": \"nonsense\"")
        val vm = counted(FileVisionAssets(overrides = mapOf("models.json" to json))).vm
        val state = vm.uiState.value
        assertTrue(state.loadError!!.contains("model #"))
        assertNotNull(state.detection.result)
        assertNull(state.classification.result)
        assertNotNull(state.classification.failure)
    }

    @Test
    fun aLoaderThatFailsGivesALoadErrorAndNoSelection() {
        val broken = object : VisionAssets {
            override fun text(path: String): String? = error("assets missing")

            override fun bytes(path: String): ByteArray? = error("assets missing")

            override fun exists(path: String): Boolean = error("assets missing")
        }
        val state = VisionViewModel(broken, SavedStateHandle(), { error("not called") }).uiState.value
        assertTrue(state.samples.isEmpty())
        assertNull(state.selected)
        assertTrue(state.loadError!!.contains("assets missing"))
    }

    // ---- failures ----

    @Test
    fun aThrowingModelSetsARunError() {
        val vm = VisionViewModel(plain, SavedStateHandle(), { throw RuntimeException("boom") })
        val state = vm.uiState.value
        assertEquals(VisionFailure("run", "boom"), state.classification.failure)
        assertEquals(VisionFailure("run", "boom"), state.detection.failure)
        assertNull(state.classification.result)
        assertFalse(state.classification.running)
    }

    @Test
    fun cancellationFromTheRunnerIsRethrownNotShownAsAnError() {
        val vm = VisionViewModel(plain, SavedStateHandle(), { throw CancellationException("cancelled") })
        val state = vm.uiState.value
        assertNull(state.classification.failure)
        assertNull(state.detection.failure)
    }

    @Test
    fun theLibraryRejectsInvalidControlsAndAValidOneRecovers() {
        val c = counted()
        val vm = c.vm
        vm.setMaxDetections(0)
        val failure = vm.uiState.value.detection.failure!!
        assertEquals("invalid_options", failure.kind)
        assertTrue(failure.detail!!.contains("maxDetections"))
        assertNull(vm.uiState.value.detection.result)
        vm.setScoreThreshold(1.5)
        assertEquals("invalid_options", vm.uiState.value.detection.failure!!.kind)
        vm.setMaxDetections(100)
        vm.setScoreThreshold(0.3)
        assertNotNull(vm.uiState.value.detection.result)
        assertNull(vm.uiState.value.detection.failure)
        vm.setTopK(0)
        assertEquals("invalid_options", vm.uiState.value.classification.failure!!.kind)
        vm.setTopK(5)
        assertEquals(5, vm.uiState.value.classification.result!!.entries.size)
        assertEquals("only postprocessing ran", 2, c.requests.size)
    }

    @Test
    fun aRecordingThatDoesNotMatchTheModelIsARunError() {
        val tampered = File(VISION_ASSETS_DIR, "recorded/cat.classification.json").readText().replace("mobilenet-v2-onnx", "other-model")
        val assets = object : VisionAssets by plain {
            override fun text(path: String): String? = if (path == "recorded/cat.classification.json") tampered else plain.text(path)
        }
        val vm = VisionViewModel(assets, SavedStateHandle(), engine(assets)::infer)
        assertTrue(vm.uiState.value.classification.failure!!.detail!!.contains("other-model"))
        assertNotNull(vm.uiState.value.detection.result)
    }

    // ---- stale results ----

    private val catInference: Map<VisionTask, Inference> by lazy {
        runBlocking {
            VisionTask.entries.associateWith { task ->
                engine().infer(InferRequest(task, sample("cat").ref, "cat", VisionBackend.RECORDED, catalog.recordedCard(task)!!))
            }
        }
    }

    @Test
    fun aSlowRunIsCancelledWhenAnotherSampleIsSelected() {
        val gate = CompletableDeferred<Inference>()
        val engine = engine()
        val vm = VisionViewModel(plain, SavedStateHandle(mapOf("selected" to "crowd")), { request ->
            if (request.sampleId == "crowd" && request.task == VisionTask.DETECTION) gate.await() else engine.infer(request)
        })
        assertTrue(vm.uiState.value.detection.running)
        vm.select("dog")
        gate.complete(catInference.getValue(VisionTask.DETECTION))
        assertEquals("dog", vm.uiState.value.selected)
        assertEquals(oracleDetections("dog"), vm.uiState.value.detection.result!!.detections)
    }

    @Test
    fun aSlowRunThatCannotBeCancelledIsStillIgnoredByItsKey() {
        val gate = CompletableDeferred<Inference>()
        val engine = engine()
        val vm = VisionViewModel(plain, SavedStateHandle(mapOf("selected" to "crowd")), { request ->
            if (request.sampleId == "crowd" && request.task == VisionTask.DETECTION) {
                withContext(NonCancellable) { gate.await() }
            } else {
                engine.infer(request)
            }
        })
        vm.select("dog")
        gate.complete(catInference.getValue(VisionTask.DETECTION))
        assertEquals(oracleDetections("dog"), vm.uiState.value.detection.result!!.detections)
        assertFalse(vm.uiState.value.detection.running)
    }

    @Test
    fun aControlChangeWhileTheModelRunsDoesNotCallItASecondTime() {
        val gate = CompletableDeferred<Inference>()
        var calls = 0
        val vm = VisionViewModel(plain, SavedStateHandle(), { request ->
            calls++
            if (request.task == VisionTask.DETECTION) gate.await() else engine().infer(request)
        })
        vm.setScoreThreshold(0.8)
        vm.setMaxDetections(7)
        assertEquals(2, calls)
        gate.complete(runBlocking { engine().infer(InferRequest(VisionTask.DETECTION, sample("cat").ref, "cat", VisionBackend.RECORDED, catalog.recordedCard(VisionTask.DETECTION)!!)) })
        assertEquals(2, calls)
        val result = vm.uiState.value.detection.result!!
        assertTrue(result.detections.all { it.score >= 0.8 })
    }

    // ---- saved state ----

    @Test
    fun stateSurvivesRecreationThroughTheSavedStateHandle() {
        val handle = SavedStateHandle()
        val first = counted(withRealModels(), handle = handle).vm
        first.select("crowd")
        first.setBackend(VisionBackend.REAL)
        first.setTopK(7)
        first.setScoreThreshold(0.55)
        first.setIouThreshold(0.25)
        first.setNms(true)
        first.setMaxDetections(12)
        val second = counted(withRealModels(), handle = handle).vm.uiState.value
        assertEquals("crowd", second.selected)
        assertEquals(VisionBackend.REAL, second.backend)
        assertEquals(VisionControls(7, 0.55, 0.25, true, 12), second.controls)
        assertNotNull(second.detection.result)
    }

    @Test
    fun theUsersImageSurvivesRecreation() {
        val handle = SavedStateHandle()
        counted(withRealModels(), handle = handle).vm.useImage("asset:samples/fog-rocks.png")
        val restored = counted(withRealModels(), handle = handle).vm.uiState.value
        assertTrue(restored.yourImage)
        assertEquals("asset:samples/fog-rocks.png", restored.imageRef)
        assertNotNull(restored.classification.result)
    }

    @Test
    fun savedStateOfAnUnknownSampleOrAMissingRealModelFallsBack() {
        val vm = counted(handle = SavedStateHandle(mapOf("selected" to "gone", "backend" to "real", "topK" to 3))).vm.uiState.value
        assertEquals("cat", vm.selected)
        assertEquals(VisionBackend.RECORDED, vm.backend)
        assertEquals(3, vm.controls.topK)
        val noImage = counted(handle = SavedStateHandle(mapOf("selected" to VISION_YOUR_IMAGE))).vm.uiState.value
        assertEquals("cat", noImage.selected)
    }
}
