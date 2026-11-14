package es.sebas1705.ilabs.demo

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import es.sebas1705.ilabs.rag.Mode

/** Everything the screen can ask of the view model. */
class RagActions(
    val onSelect: (String) -> Unit,
    val onQuestion: (String) -> Unit,
    val onMode: (Mode) -> Unit,
    val onTopK: (Int) -> Unit,
    val onLabelled: (Int) -> Unit,
) {
    companion object {
        fun of(vm: RagViewModel) = RagActions(vm::select, vm::setQuestion, vm::setMode, vm::setTopK, vm::selectLabelled)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RagScreen(state: RagUiState, actions: RagActions, onBack: (() -> Unit)? = null) {
    val layoutDirection = LocalLayoutDirection.current
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
        // imePadding after consumeWindowInsets: the question field is never behind the keyboard.
        Box(
            Modifier.fillMaxSize().padding(top = padding.calculateTopPadding()).consumeWindowInsets(padding).imePadding(),
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
                item { Header(state, actions.onSelect) }
                if (state.selected != null) item(key = "controls-${state.selected}") { ControlsCard(state, actions) }
                val run = state.run
                if (run != null) {
                    val failure = run.failure
                    if (failure != null && failure.kind != "budget_too_small") {
                        item(key = "failure-${state.selected}") { FailureCard(failure) }
                    }
                    if (run.chunks.isNotEmpty() || failure == null || failure.kind == "budget_too_small") {
                        item(key = "chunks-${state.selected}") { ChunksCard(run) }
                    }
                    if (failure == null || failure.kind == "budget_too_small") {
                        item(key = "hits-${state.selected}") { HitsCard(run) }
                    }
                    if (state.hasContext && (run.context != null || failure?.kind == "budget_too_small")) {
                        item(key = "context-${state.selected}") { ContextCard(run, state.maxTokens) }
                    }
                    run.citations?.let { item(key = "citations-${state.selected}") { CitationsCard(it) } }
                    if (state.isEval) {
                        item(key = "metrics-${state.selected}") {
                            MetricsCard(run, state.question, state.labelledIndex?.let { state.labelled.getOrNull(it)?.level })
                        }
                    }
                }
                item {
                    Column(Modifier.padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(
                            stringResource(R.string.rag_note),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(
                            stringResource(R.string.rag_footer),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}


@Composable
private fun Header(state: RagUiState, onSelect: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            stringResource(R.string.rag_title),
            style = MaterialTheme.typography.headlineMedium,
            modifier = Modifier.semantics { heading() },
        )
        Text(
            stringResource(R.string.rag_subtitle),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        state.loadError?.let { ErrorNote(stringResource(R.string.rag_load_error, it), LiveRegionMode.Polite) }
        state.runError?.let { ErrorNote(stringResource(R.string.rag_run_error, it), LiveRegionMode.Assertive) }
        if (state.names.isNotEmpty()) FixturePicker(state.groups, state.selected.orEmpty(), onSelect)
        RunStatus(state)
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

/** One polite, coarse sentence about the run: the hit count and mode, the read-only notice or the error. */
@Composable
private fun RunStatus(state: RagUiState) {
    val run = state.run
    if (run == null) {
        if (state.fixture != null && state.runError == null) {
            Text(
                stringResource(R.string.rag_running),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
        return
    }
    val failure = run.failure
    val text = when {
        failure != null && failure.kind == "budget_too_small" ->
            pluralStringResource(R.plurals.rag_status_budget, failure.required ?: 0, failure.required ?: 0, state.maxTokens ?: 0)
        failure != null -> stringResource(R.string.rag_status_failed, ragErrorLabel(failure.kind))
        run.emptyQuery -> stringResource(R.string.rag_status_empty)
        else -> hitsStatus(run.rows.size, run.mode)
    }
    Text(
        text,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
    )
}

@Composable
private fun groupLabel(group: RagGroup): String = when (group) {
    RagGroup.SEARCH -> stringResource(R.string.rag_group_search)
    RagGroup.CONTEXT -> stringResource(R.string.rag_group_context)
    RagGroup.ANSWERS -> stringResource(R.string.rag_group_answers)
    RagGroup.EVALUATION -> stringResource(R.string.rag_group_evaluation)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FixturePicker(groups: List<Pair<RagGroup, List<String>>>, selected: String, onSelect: (String) -> Unit) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    val description = stringResource(R.string.rag_fixture_picker, selected)
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = selected,
            onValueChange = {},
            readOnly = true,
            singleLine = true,
            label = { Text(stringResource(R.string.rag_fixture)) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
            modifier = Modifier
                .menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable)
                .fillMaxWidth()
                .heightIn(min = 56.dp)
                .semantics { contentDescription = description },
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            groups.forEach { (group, names) ->
                Text(
                    groupLabel(group),
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp).semantics { heading() },
                )
                names.forEach { name ->
                    DropdownMenuItem(
                        text = { Text(name) },
                        onClick = {
                            onSelect(name)
                            expanded = false
                        },
                        modifier = Modifier.heightIn(min = 48.dp),
                    )
                }
            }
        }
    }
}

/** The question, the mode, topK and (for `eval` fixtures) the labelled questions. Read-only fixtures disable them all. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ControlsCard(state: RagUiState, actions: RagActions) {
    val enabled = !state.readOnly
    // The field keeps its own text while typing; it re-reads the state only when the program sets the question.
    var text by remember(state.selected) { mutableStateOf(state.question) }
    LaunchedEffect(state.questionRevision) { if (text != state.question) text = state.question }
    Card(stringResource(R.string.rag_controls)) {
        if (state.readOnly) {
            Text(
                stringResource(R.string.rag_readonly_hint),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        OutlinedTextField(
            value = text,
            onValueChange = {
                text = it
                actions.onQuestion(it)
            },
            enabled = enabled,
            label = { Text(stringResource(R.string.rag_question)) },
            minLines = 1,
            maxLines = 4,
            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
        )
        Section(stringResource(R.string.rag_mode))
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            Mode.entries.forEachIndexed { index, mode ->
                SegmentedButton(
                    selected = state.mode == mode,
                    onClick = { actions.onMode(mode) },
                    enabled = enabled,
                    shape = SegmentedButtonDefaults.itemShape(index, Mode.entries.size),
                    modifier = Modifier.heightIn(min = 48.dp),
                ) { Text(modeLabel(mode)) }
            }
        }
        TopKStepper(state.topK, enabled, actions.onTopK)
        if (state.isEval && state.labelled.isNotEmpty()) LabelledQuestions(state, enabled, actions.onLabelled)
    }
}

@Composable
private fun TopKStepper(topK: Int, enabled: Boolean, onTopK: (Int) -> Unit) {
    val less = stringResource(R.string.rag_top_k_less)
    val more = stringResource(R.string.rag_top_k_more)
    val spoken = pluralStringResource(R.plurals.rag_top_k_spoken, topK, topK)
    Section(stringResource(R.string.rag_top_k))
    Row(
        Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        IconButton(
            onClick = { onTopK((topK - 1).coerceAtLeast(RagViewModel.MIN_TOP_K)) },
            enabled = enabled && topK > RagViewModel.MIN_TOP_K,
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
            onClick = { onTopK(topK + 1) },
            enabled = enabled,
            modifier = Modifier.semantics { contentDescription = more },
        ) { Text("+", style = MaterialTheme.typography.titleLarge) }
    }
}

@Composable
private fun LabelledQuestions(state: RagUiState, enabled: Boolean, onPick: (Int) -> Unit) {
    Section(stringResource(R.string.rag_labelled))
    Text(
        stringResource(R.string.rag_labelled_hint),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    state.labelled.forEachIndexed { index, q ->
        val selected = state.labelledIndex == index
        val relevant = q.relevant.joinToString(", ")
        val level = levelLabel(q.level)
        val spoken = stringResource(R.string.rag_labelled_spoken, q.query, level, relevant)
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = { onPick(index) })
                .clearAndSetSemantics {
                    contentDescription = spoken
                    this.role = Role.RadioButton
                    this.selected = selected
                },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            RadioButton(selected = selected, onClick = null, enabled = enabled)
            Column(Modifier.padding(vertical = 4.dp)) {
                Text(q.query)
                Text(
                    stringResource(R.string.rag_labelled_relevant, level, relevant),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/** The corpus as the library chunked it: id, document, span in code points and text of every chunk. */
@Composable
internal fun ChunksCard(run: RagRun) {
    Card(stringResource(R.string.rag_chunks)) {
        Text(
            pluralStringResource(R.plurals.rag_chunks_count, run.chunks.size, run.chunks.size),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (run.chunks.isEmpty()) {
            Text(stringResource(R.string.rag_chunks_none), color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        run.chunks.forEach { chunk ->
            val span = stringResource(R.string.rag_chunk_span, chunk.docId, chunk.start, chunk.end)
            val hitRank = run.rows.firstOrNull { it.hit.chunkId == chunk.id }?.hit?.rank
            val spoken = if (hitRank == null) {
                stringResource(R.string.rag_chunk_spoken, chunk.id, span)
            } else {
                stringResource(R.string.rag_chunk_spoken_hit, chunk.id, span, hitRank)
            }
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Column(Modifier.clearAndSetSemantics { contentDescription = spoken }) {
                    Text(chunk.id, fontWeight = FontWeight.SemiBold)
                    Text(span, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (hitRank != null) {
                        Text(
                            "✓ ${stringResource(R.string.rag_chunk_hit, hitRank)}",
                            style = MaterialTheme.typography.labelLarge,
                            color = ILabsTheme.status.okFg,
                        )
                    }
                }
                CodeBlock(chunk.text)
            }
        }
    }
}
