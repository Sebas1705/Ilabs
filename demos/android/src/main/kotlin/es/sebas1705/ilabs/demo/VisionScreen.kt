package es.sebas1705.ilabs.demo

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import es.sebas1705.ilabs.vision.ClassEntry
import es.sebas1705.ilabs.vision.Detection
import es.sebas1705.ilabs.vision.ResizeMode
import kotlinx.coroutines.launch
import java.util.Locale
import kotlin.math.roundToInt

/** What the screen needs to show and import pictures; the Android implementation sits in the activity. */
class VisionImages(
    /** Decodes the picture of a reference for showing (off the main thread); null when it cannot be opened. */
    val bitmap: suspend (String) -> ImageBitmap?,
    /** Copies a picked content URI into the app and returns the picture's reference; throws when it cannot be read. */
    val import: suspend (String) -> String,
)

/** Everything the screen can ask of the view model. */
class VisionActions(
    val onSelect: (String) -> Unit,
    val onImage: (String) -> Unit,
    val onBackend: (VisionBackend) -> Unit,
    val onTopK: (Int) -> Unit,
    val onScore: (Double) -> Unit,
    val onIou: (Double) -> Unit,
    val onNms: (Boolean) -> Unit,
    val onMax: (Int) -> Unit,
    val images: VisionImages,
) {
    companion object {
        fun of(vm: VisionViewModel, images: VisionImages) = VisionActions(
            vm::select, vm::useImage, vm::setBackend, vm::setTopK, vm::setScoreThreshold, vm::setIouThreshold, vm::setNms, vm::setMaxDetections, images,
        )
    }
}

private fun number(value: Double, decimals: Int): String = String.format(Locale.getDefault(), "%.${decimals}f", value)

internal fun percent(score: Double, decimals: Int): String = String.format(Locale.getDefault(), "%.${decimals}f%%", score * 100.0)

private fun gridStep(value: Float): Double = (value * 20f).roundToInt() / 20.0

/** A whole number as it is, anything else with four decimals (the web page does the same for scales and offsets). */
internal fun fixed(value: Double): String =
    if (value == Math.rint(value)) value.toLong().toString() else String.format(Locale.getDefault(), "%.4f", value)

/** The most detections the canvas text alternative lists; the rest is summed up as "+N more". */
internal const val ALT_CAP = 20

/** The chip texts of the first [ALT_CAP] detections for the canvas alternative, and how many were left out. */
internal fun altChips(detections: List<Detection>): Pair<List<String>, Int> =
    detections.take(ALT_CAP).map { "${it.label} ${percent(it.score, 0)}" } to (detections.size - ALT_CAP).coerceAtLeast(0)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VisionScreen(state: VisionUiState, actions: VisionActions, onBack: (() -> Unit)? = null) {
    val layoutDirection = LocalLayoutDirection.current
    val image by produceState<ImageBitmap?>(null, state.imageRef) {
        value = null
        val ref = state.imageRef
        value = if (ref == null) null else runCatching { actions.images.bitmap(ref) }.getOrNull()
    }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.app_name), fontWeight = FontWeight.SemiBold) },
                navigationIcon = { if (onBack != null) BackToModules(onBack) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
    ) { padding ->
        Box(
            Modifier.fillMaxSize().padding(top = padding.calculateTopPadding()).consumeWindowInsets(padding),
            contentAlignment = Alignment.TopCenter,
        ) {
            LazyColumn(
                modifier = Modifier.widthIn(max = ContentMaxWidth).fillMaxWidth(),
                contentPadding = PaddingValues(
                    start = 16.dp + padding.calculateLeftPadding(layoutDirection),
                    end = 16.dp + padding.calculateRightPadding(layoutDirection),
                    top = 12.dp,
                    bottom = 12.dp + padding.calculateBottomPadding(),
                ),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item { Header(state) }
                if (state.selected != null) {
                    item { SourceCard(state, actions) }
                    item { ClassifyCard(state, actions) }
                    item { DetectCard(state, actions, image) }
                }
                item {
                    Text(
                        stringResource(R.string.vision_footer),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(vertical = 8.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun Header(state: VisionUiState) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            stringResource(R.string.vision_title),
            style = MaterialTheme.typography.headlineMedium,
            modifier = Modifier.semantics { heading() },
        )
        Text(
            stringResource(R.string.vision_subtitle),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        state.loadError?.let { ErrorNote(stringResource(R.string.vision_load_error, it), LiveRegionMode.Polite) }
    }
}

/** An error line with a glyph (never colour alone) that screen readers announce when it appears. */
@Composable
private fun ErrorNote(text: String, mode: LiveRegionMode) {
    Row(
        Modifier.semantics(mergeDescendants = true) {
            liveRegion = mode
            contentDescription = text
        },
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("✕", fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.error)
        Text(text, color = MaterialTheme.colorScheme.error)
    }
}

@Composable
private fun failureText(failure: VisionFailure): String {
    val detail = failure.detail.orEmpty()
    return when (failure.kind) {
        "invalid_options" -> stringResource(R.string.vision_error_invalid_options, detail)
        "invalid_spec" -> stringResource(R.string.vision_error_invalid_spec, detail)
        "invalid_output" -> stringResource(R.string.vision_error_invalid_output, detail)
        "image" -> stringResource(R.string.vision_error_image, detail)
        else -> stringResource(R.string.vision_error_run, detail)
    }
}

/**
 * One polite, coarse sentence. While [settled] is false (a slider is being dragged) the text on screen follows the
 * value but the announced text stays the last settled one, so a drag is announced once, when it ends.
 */
@Composable
private fun StatusLine(text: String, settled: Boolean = true) {
    var announced by remember { mutableStateOf(text) }
    LaunchedEffect(text, settled) { if (settled) announced = text }
    Text(
        text,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.semantics {
            liveRegion = LiveRegionMode.Polite
            contentDescription = announced
        },
    )
}

/** How the picture was fitted into the model input, one fact per line (the same rows as the web page). */
@Composable
private fun GeometryRows(result: VisionResult) {
    val g = result.geometry
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        listOf(
            stringResource(R.string.vision_geo_mode, modeLabel(result.mode)),
            stringResource(R.string.vision_geo_source, result.source.width, result.source.height),
            stringResource(R.string.vision_geo_input, result.inputWidth, result.inputHeight),
            stringResource(R.string.vision_geo_scale, fixed(g.scaleX), fixed(g.scaleY)),
            stringResource(R.string.vision_geo_offset, fixed(g.offsetX), fixed(g.offsetY)),
            stringResource(R.string.vision_geo_new, g.newWidth, g.newHeight),
        ).forEach { Text(it, style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable
private fun NoteLine(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

// ---- the shared controls ---------------------------------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SourceCard(state: VisionUiState, actions: VisionActions) {
    val language = LocalConfiguration.current.locales[0].language
    val scope = rememberCoroutineScope()
    var expanded by rememberSaveable { mutableStateOf(false) }
    var pickError by rememberSaveable { mutableStateOf<String?>(null) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) {
            scope.launch {
                try {
                    actions.onImage(actions.images.import(uri.toString()))
                    pickError = null
                } catch (e: kotlin.coroutines.cancellation.CancellationException) {
                    throw e
                } catch (e: Exception) {
                    pickError = e.message ?: e::class.simpleName
                }
            }
        }
    }
    val yourImage = stringResource(R.string.vision_your_image)
    val selectedTitle = if (state.yourImage) yourImage else state.sample?.title(language).orEmpty()
    val description = stringResource(R.string.vision_sample_picker, selectedTitle)
    Card(stringResource(R.string.vision_controls)) {
        ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
            OutlinedTextField(
                value = selectedTitle,
                onValueChange = {},
                readOnly = true,
                singleLine = false,
                label = { Text(stringResource(R.string.vision_sample)) },
                trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
                modifier = Modifier
                    .menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable)
                    .fillMaxWidth()
                    .heightIn(min = 56.dp)
                    .semantics { contentDescription = description },
            )
            ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                state.samples.forEach { sample ->
                    DropdownMenuItem(
                        text = { Text(sample.title(language)) },
                        onClick = {
                            actions.onSelect(sample.id)
                            expanded = false
                        },
                        modifier = Modifier.heightIn(min = 48.dp),
                    )
                }
            }
        }
        OutlinedButton(
            onClick = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
            modifier = Modifier.heightIn(min = 48.dp),
        ) { Text(stringResource(R.string.vision_pick_image)) }
        pickError?.let { ErrorNote(stringResource(R.string.vision_error_image, it), LiveRegionMode.Assertive) }
        val size = state.classification.result?.source ?: state.detection.result?.source
        if (size != null) NoteLine(stringResource(R.string.vision_image_size, size.width, size.height))
        Section(stringResource(R.string.vision_backend))
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            SegmentedButton(
                selected = state.effectiveBackend == VisionBackend.RECORDED,
                onClick = { actions.onBackend(VisionBackend.RECORDED) },
                enabled = !state.yourImage,
                shape = SegmentedButtonDefaults.itemShape(0, 2),
                modifier = Modifier.heightIn(min = 48.dp),
            ) { Text(stringResource(R.string.vision_backend_recorded)) }
            SegmentedButton(
                selected = state.effectiveBackend == VisionBackend.REAL,
                onClick = { actions.onBackend(VisionBackend.REAL) },
                enabled = state.realSelectable,
                shape = SegmentedButtonDefaults.itemShape(1, 2),
                modifier = Modifier.heightIn(min = 48.dp),
            ) { Text(stringResource(R.string.vision_backend_real)) }
        }
        NoteLine(stringResource(R.string.vision_recorded_hint))
        NoteLine(stringResource(R.string.vision_real_hint))
        if (!state.realSelectable) NoteLine(stringResource(R.string.vision_real_unavailable))
        if (state.yourImage) NoteLine(stringResource(R.string.vision_your_image_hint))
    }
}

// ---- Classify ------------------------------------------------------------------------------------------------------------

@Composable
private fun modeLabel(mode: ResizeMode): String = when (mode) {
    ResizeMode.STRETCH -> stringResource(R.string.vision_mode_stretch)
    ResizeMode.CENTER_CROP -> stringResource(R.string.vision_mode_center_crop)
    ResizeMode.LETTERBOX -> stringResource(R.string.vision_mode_letterbox)
}

@Composable
private fun sourceLabel(result: VisionResult): String = stringResource(
    R.string.vision_model_line,
    result.cardId,
    stringResource(if (result.backend == VisionBackend.REAL) R.string.vision_source_real else R.string.vision_source_recorded),
)

@Composable
private fun timingsText(t: VisionTimings): String = stringResource(
    R.string.vision_timings,
    number(t.preprocessMs, 1),
    t.inferenceMs?.let { stringResource(R.string.vision_timing_ms, number(it, 1)) } ?: stringResource(R.string.vision_timing_recorded),
    number(t.postprocessMs, 1),
)

@Composable
private fun SectionNote(section: VisionSection) {
    when (section.note) {
        VisionNote.REAL_UNAVAILABLE_FALLBACK -> StatusLine(stringResource(R.string.vision_status_fallback))
        VisionNote.REAL_UNAVAILABLE_NO_RECORDING -> StatusLine(stringResource(R.string.vision_no_recording_note))
        null -> Unit
    }
}

@Composable
private fun ClassifyCard(state: VisionUiState, actions: VisionActions) {
    val section = state.classification
    Card(stringResource(R.string.vision_classify_title)) {
        Text(
            stringResource(R.string.vision_classify_subtitle),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        SectionNote(section)
        val failure = section.failure
        if (failure != null) ErrorNote(failureText(failure), LiveRegionMode.Assertive)
        val result = section.result
        if (result != null) {
            val top = result.entries.firstOrNull()
            StatusLine(
                if (top == null) stringResource(R.string.vision_status_none) else stringResource(R.string.vision_status_top, top.label, percent(top.score, 1)),
            )
        } else if (section.running) {
            StatusLine(stringResource(R.string.vision_running))
        }
        TopKStepper(state.controls.topK, actions.onTopK)
        if (result != null) {
            NoteLine(sourceLabel(result))
            Section(stringResource(R.string.vision_preview))
            PreviewCanvas(result.preview, stringResource(R.string.vision_preview_description, result.inputWidth, result.inputHeight))
            GeometryRows(result)
            Section(stringResource(R.string.vision_classes))
            result.entries.forEach { ClassRow(it) }
            Text(timingsText(result.timings), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        NoteLine(stringResource(R.string.vision_note))
    }
}

@Composable
private fun TopKStepper(topK: Int, onTopK: (Int) -> Unit) {
    val less = stringResource(R.string.vision_top_k_less)
    val more = stringResource(R.string.vision_top_k_more)
    val spoken = pluralStringResource(R.plurals.vision_top_k_spoken, topK, topK)
    Section(stringResource(R.string.vision_top_k))
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        IconButton(
            onClick = { onTopK((topK - 1).coerceAtLeast(VisionViewModel.MIN_TOP_K)) },
            enabled = topK > VisionViewModel.MIN_TOP_K,
            modifier = Modifier.semantics { contentDescription = less },
        ) { Text("−", style = MaterialTheme.typography.titleLarge) }
        Text(
            "$topK",
            style = MaterialTheme.typography.titleLarge,
            modifier = Modifier.widthIn(min = 40.dp).semantics {
                contentDescription = spoken
                liveRegion = LiveRegionMode.Polite
            },
        )
        IconButton(
            onClick = { onTopK((topK + 1).coerceAtMost(VisionViewModel.MAX_TOP_K)) },
            enabled = topK < VisionViewModel.MAX_TOP_K,
            modifier = Modifier.semantics { contentDescription = more },
        ) { Text("+", style = MaterialTheme.typography.titleLarge) }
    }
}

/** A class and its probability as text, with a decorative bar (hidden from screen readers: the percent is the value). */
@Composable
private fun ClassRow(entry: ClassEntry) {
    val text = percent(entry.score, 1)
    val spoken = stringResource(R.string.vision_class_spoken, entry.label, text)
    Column(Modifier.fillMaxWidth().heightIn(min = 48.dp).clearAndSetSemantics { contentDescription = spoken }, verticalArrangement = Arrangement.Center) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(entry.label, modifier = Modifier.weight(1f).padding(end = 8.dp))
            Text(text, fontWeight = FontWeight.SemiBold)
        }
        Box(Modifier.fillMaxWidth().height(6.dp).background(MaterialTheme.colorScheme.surfaceVariant)) {
            Box(Modifier.fillMaxWidth(entry.score.coerceIn(0.0, 1.0).toFloat()).height(6.dp).background(MaterialTheme.colorScheme.primary))
        }
    }
}

// ---- Detect ----------------------------------------------------------------------------------------------------------------

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DetectCard(state: VisionUiState, actions: VisionActions, image: ImageBitmap?) {
    val section = state.detection
    val controls = state.controls
    // True while a slider is being dragged: the status line then keeps its last announcement until the drag ends.
    var adjusting by remember { mutableStateOf(false) }
    Card(stringResource(R.string.vision_detect_title)) {
        Text(
            stringResource(R.string.vision_detect_subtitle),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        SectionNote(section)
        val failure = section.failure
        if (failure != null) ErrorNote(failureText(failure), LiveRegionMode.Assertive)
        val result = section.result
        if (result != null) {
            val count = result.detections.size
            val score = percent(controls.scoreThreshold, 0)
            StatusLine(
                if (count == 0) stringResource(R.string.vision_status_no_detections, score) else pluralStringResource(R.plurals.vision_status_detections, count, count, score),
                settled = !adjusting,
            )
        } else if (section.running) {
            StatusLine(stringResource(R.string.vision_running))
        }
        DetectControls(state, actions, onAdjusting = { adjusting = it })
        if (result != null) {
            NoteLine(sourceLabel(result))
            val listed = result.detections.take(VisionViewModel.MAX_LISTED_DETECTIONS)
            val chips = listed.map { "${it.label} ${percent(it.score, 0)}" }
            // The text alternative lists at most ALT_CAP detections and counts the rest, like the web page.
            val (altList, altMore) = altChips(result.detections)
            val description = if (result.detections.isEmpty()) {
                stringResource(R.string.vision_canvas_none)
            } else {
                val head = pluralStringResource(R.plurals.vision_canvas_description, result.detections.size, result.detections.size, altList.joinToString("; "))
                if (altMore > 0) "$head, ${pluralStringResource(R.plurals.vision_detections_more, altMore, altMore)}" else head
            }
            DetectionCanvas(image, result.source, listed, chips, description)
            GeometryRows(result)
            Section(stringResource(R.string.vision_detections))
            if (listed.isEmpty()) {
                NoteLine(stringResource(R.string.vision_no_detections))
            } else {
                Section(stringResource(R.string.vision_legend))
                FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    listed.distinctBy { it.classIndex }.forEach { d ->
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Box(Modifier.size(14.dp).background(classColor(d.classIndex)))
                            Text(
                                stringResource(R.string.vision_legend_item, d.label, listed.count { it.classIndex == d.classIndex }),
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                    }
                }
                listed.forEach { DetectionRow(it) }
                val more = result.detections.size - listed.size
                if (more > 0) NoteLine(pluralStringResource(R.plurals.vision_detections_more, more, more))
            }
            Text(timingsText(result.timings), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        NoteLine(stringResource(R.string.vision_note))
    }
}

@Composable
private fun DetectControls(state: VisionUiState, actions: VisionActions, onAdjusting: (Boolean) -> Unit) {
    val c = state.controls
    Section(stringResource(R.string.vision_detect_controls))
    LabeledSlider(
        label = stringResource(R.string.vision_score_threshold, number(c.scoreThreshold, 2)),
        value = c.scoreThreshold.toFloat(),
        range = 0f..1f,
        steps = 19,
        onChange = {
            onAdjusting(true)
            actions.onScore(gridStep(it))
        },
        onFinished = { onAdjusting(false) },
    )
    LabeledSlider(
        label = stringResource(R.string.vision_iou_threshold, number(c.iouThreshold, 2)),
        value = c.iouThreshold.toFloat(),
        range = 0f..1f,
        steps = 19,
        onChange = {
            onAdjusting(true)
            actions.onIou(gridStep(it))
        },
        onFinished = { onAdjusting(false) },
    )
    val nmsLabel = stringResource(R.string.vision_nms)
    // The whole row is the switch: the label is part of the touch target and of what a screen reader announces.
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .toggleable(value = c.nms, role = Role.Switch, onValueChange = actions.onNms),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(nmsLabel, modifier = Modifier.weight(1f))
        Switch(checked = c.nms, onCheckedChange = null)
    }
    NoteLine(stringResource(R.string.vision_nms_hint))
    LabeledSlider(
        label = stringResource(R.string.vision_max_detections, c.maxDetections),
        value = c.maxDetections.toFloat(),
        range = 1f..100f,
        steps = 0, // a continuous track (98 tick marks are noise); the value is rounded to a whole number
        onChange = {
            onAdjusting(true)
            actions.onMax(it.roundToInt())
        },
        onFinished = { onAdjusting(false) },
    )
}

@Composable
private fun LabeledSlider(
    label: String,
    value: Float,
    range: ClosedFloatingPointRange<Float>,
    steps: Int,
    onChange: (Float) -> Unit,
    onFinished: () -> Unit,
) {
    Column(Modifier.fillMaxWidth()) {
        Text(label, style = MaterialTheme.typography.bodyMedium)
        Slider(
            value = value.coerceIn(range.start, range.endInclusive),
            onValueChange = onChange,
            onValueChangeFinished = onFinished,
            valueRange = range,
            steps = steps,
            modifier = Modifier.heightIn(min = 48.dp).semantics {
                contentDescription = label
                stateDescription = label
            },
        )
    }
}

/** A detection: swatch, class, score and the box in pixels of the original image; one spoken sentence per row. */
@Composable
private fun DetectionRow(d: Detection) {
    val x1 = d.box.x1.roundToInt()
    val y1 = d.box.y1.roundToInt()
    val x2 = d.box.x2.roundToInt()
    val y2 = d.box.y2.roundToInt()
    val score = percent(d.score, 1)
    val spoken = stringResource(R.string.vision_detection_spoken, d.label, score, x1, y1, x2, y2)
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).clearAndSetSemantics { contentDescription = spoken },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(Modifier.size(14.dp).background(classColor(d.classIndex)))
        Column(Modifier.weight(1f)) {
            Text("${d.label} $score", fontWeight = FontWeight.SemiBold)
            Text(
                stringResource(R.string.vision_box, x1, y1, x2, y2),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
