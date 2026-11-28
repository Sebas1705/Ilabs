package es.sebas1705.ilabs.demo

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import es.sebas1705.ilabs.evals.Status
import kotlin.math.roundToInt

/** Everything the screen can ask of the view model. */
class AssistantActions(
    val onBackend: (AssistantBackend) -> Unit,
    val onEndpoint: (String) -> Unit,
    val onKey: (String) -> Unit,
    val onBudget: (Int) -> Unit,
    val onRedact: (Boolean) -> Unit,
    val onDraft: (String) -> Unit,
    val onSend: () -> Unit,
    val onNewConversation: () -> Unit,
    val onRunEvals: () -> Unit,
    val onCancelEvals: () -> Unit,
) {
    companion object {
        fun of(vm: AssistantViewModel) = AssistantActions(
            vm::setBackend, vm::setEndpoint, vm::setApiKey, vm::setBudget, vm::setRedact, vm::setDraft,
            vm::send, vm::newConversation, vm::runEvals, { vm.cancelEvals() },
        )
    }
}

/** Items above the first message of the list: the header, the settings and the chat heading. */
private const val FIRST_MESSAGE_INDEX = 3

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AssistantScreen(state: AssistantUiState, actions: AssistantActions, onBack: (() -> Unit)? = null) {
    val listState = rememberLazyListState()
    // The list follows the newest message, but only when one is added (not when the screen is restored).
    var shown by rememberSaveable { mutableIntStateOf(state.entries.size) }
    LaunchedEffect(state.entries.size) {
        if (state.entries.size > shown) listState.scrollToItem(FIRST_MESSAGE_INDEX + state.entries.size - 1)
        shown = state.entries.size
    }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.app_name), fontWeight = FontWeight.SemiBold) },
                navigationIcon = { if (onBack != null) BackToModules(onBack) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
        bottomBar = { Composer(state, actions) },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.TopCenter) {
            LazyColumn(
                state = listState,
                modifier = Modifier
                    .widthIn(max = ContentMaxWidth)
                    .fillMaxWidth()
                    .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal)),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item(key = "header") { Header() }
                item(key = "settings") { SettingsSection(state, actions) }
                item(key = "chat-head") { ChatHead(state, actions) }
                if (state.entries.isEmpty()) {
                    item(key = "empty") {
                        Text(
                            stringResource(R.string.assistant_empty),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                } else {
                    items(state.entries.size, key = { "message-$it" }) { MessageRow(state.entries[it]) }
                }
                item(key = "status") { StatusLine(state) }
                item(key = "trace") { TraceSection(state.trace) }
                item(key = "evals") { EvalsSection(state, actions) }
                item(key = "footer") {
                    Text(
                        stringResource(R.string.assistant_footer),
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
private fun Header() {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            stringResource(R.string.assistant_title),
            style = MaterialTheme.typography.headlineMedium,
            modifier = Modifier.semantics { heading() },
        )
        Text(
            stringResource(R.string.assistant_subtitle),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

// ---- settings ----------------------------------------------------------------------------------------------------

@Composable
private fun SettingsSection(state: AssistantUiState, actions: AssistantActions) {
    SectionBlock(stringResource(R.string.assistant_settings_heading)) {
        Column(Modifier.selectableGroup()) {
            BackendOption(AssistantBackend.MOCK, state, actions)
            BackendOption(AssistantBackend.WORKER, state, actions)
            BackendOption(AssistantBackend.MY_KEY, state, actions)
        }
        EndpointField(state, actions)
        if (state.backend == AssistantBackend.MY_KEY) KeyField(state, actions)
        BudgetControl(state, actions)
        RedactSwitch(state, actions)
    }
}

@Composable
private fun BackendOption(backend: AssistantBackend, state: AssistantUiState, actions: AssistantActions) {
    val enabled = backend == AssistantBackend.MOCK || state.gatewayReady
    val label = stringResource(
        when (backend) {
            AssistantBackend.MOCK -> R.string.assistant_backend_mock
            AssistantBackend.WORKER -> R.string.assistant_backend_worker
            AssistantBackend.MY_KEY -> R.string.assistant_backend_my_key
        },
    )
    val hint = if (!enabled) {
        stringResource(R.string.assistant_backend_disabled)
    } else {
        stringResource(
            when (backend) {
                AssistantBackend.MOCK -> R.string.assistant_backend_mock_hint
                AssistantBackend.WORKER -> R.string.assistant_backend_worker_hint
                AssistantBackend.MY_KEY -> R.string.assistant_backend_my_key_hint
            },
        )
    }
    val selected = state.backend == backend
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = { actions.onBackend(backend) })
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        RadioButton(selected = selected, onClick = null, enabled = enabled)
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodyLarge)
            Text(hint, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun EndpointField(state: AssistantUiState, actions: AssistantActions) {
    val check = state.endpointCheck
    val note = stringResource(
        when (check) {
            EndpointCheck.Empty -> R.string.assistant_endpoint_empty_note
            EndpointCheck.Invalid -> R.string.assistant_endpoint_invalid_note
            is EndpointCheck.Ok -> R.string.assistant_endpoint_ok_note
        },
    )
    OutlinedTextField(
        value = state.endpoint,
        onValueChange = actions.onEndpoint,
        singleLine = true,
        isError = check == EndpointCheck.Invalid,
        label = { Text(stringResource(R.string.assistant_endpoint_label)) },
        supportingText = { Text(note) },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done),
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
    )
}

/**
 * The key field: a password field with a show/hide toggle. Its value is held in memory by the view model and reaches no
 * saved state; the toggle itself is the only thing remembered here.
 */
@Composable
private fun KeyField(state: AssistantUiState, actions: AssistantActions) {
    var visible by rememberSaveable { mutableStateOf(false) }
    OutlinedTextField(
        value = state.apiKey.value,
        onValueChange = actions.onKey,
        singleLine = true,
        label = { Text(stringResource(R.string.assistant_key_label)) },
        visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false, imeAction = ImeAction.Done),
        trailingIcon = {
            val description = stringResource(if (visible) R.string.assistant_key_hide_description else R.string.assistant_key_show_description)
            TextButton(
                onClick = { visible = !visible },
                modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = description },
            ) {
                Text(stringResource(if (visible) R.string.assistant_key_hide else R.string.assistant_key_show))
            }
        },
        supportingText = {
            Text(stringResource(if (state.keyMissing) R.string.assistant_key_missing else R.string.assistant_key_note))
        },
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
    )
    if (state.keyMissing) {
        Text(stringResource(R.string.assistant_key_note), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun BudgetControl(state: AssistantUiState, actions: AssistantActions) {
    val value = stringResource(R.string.assistant_budget_value, state.budget)
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(stringResource(R.string.assistant_budget_label), style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
            Text(value, style = MaterialTheme.typography.titleSmall)
        }
        Slider(
            value = state.budget.toFloat(),
            onValueChange = { actions.onBudget(it.roundToInt()) },
            valueRange = AssistantEngine.MIN_BUDGET.toFloat()..AssistantEngine.MAX_BUDGET.toFloat(),
            steps = (AssistantEngine.MAX_BUDGET - AssistantEngine.MIN_BUDGET) / AssistantEngine.BUDGET_STEP - 1,
            modifier = Modifier.heightIn(min = 48.dp).semantics { stateDescription = value },
        )
        Text(
            stringResource(R.string.assistant_budget_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun RedactSwitch(state: AssistantUiState, actions: AssistantActions) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .toggleable(value = state.redact, role = Role.Switch, onValueChange = actions.onRedact),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(stringResource(R.string.assistant_redact_label), style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
            Switch(checked = state.redact, onCheckedChange = null)
        }
        Text(
            stringResource(R.string.assistant_redact_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

// ---- chat --------------------------------------------------------------------------------------------------------

@Composable
private fun ChatHead(state: AssistantUiState, actions: AssistantActions) {
    SectionBlock(stringResource(R.string.assistant_chat_heading)) {
        Text(
            stringResource(R.string.assistant_input_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        OutlinedButton(
            onClick = actions.onNewConversation,
            enabled = state.entries.isNotEmpty() || state.trace.isNotEmpty() || state.sending,
            modifier = Modifier.heightIn(min = 48.dp),
        ) {
            Text(stringResource(R.string.assistant_new))
        }
    }
}

@Composable
private fun MessageRow(entry: ChatEntry) {
    val colors = MaterialTheme.colorScheme
    val status = ILabsTheme.status
    val body = if (entry.role == ChatRole.BLOCKED) stringResource(R.string.assistant_blocked_text) else entry.text
    val spoken = stringResource(
        when (entry.role) {
            ChatRole.USER -> R.string.assistant_said_user
            ChatRole.ASSISTANT -> R.string.assistant_said_assistant
            ChatRole.BLOCKED -> R.string.assistant_said_blocked
        },
        body,
    )
    val label = stringResource(if (entry.role == ChatRole.USER) R.string.assistant_role_user else R.string.assistant_role_assistant)
    val container = when (entry.role) {
        ChatRole.USER -> colors.surfaceVariant
        ChatRole.ASSISTANT -> colors.surface
        ChatRole.BLOCKED -> status.warnBg
    }
    val content = if (entry.role == ChatRole.BLOCKED) status.warnFg else colors.onSurface
    Surface(
        color = container,
        contentColor = content,
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, colors.outlineVariant),
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = if (entry.role == ChatRole.USER) 24.dp else 0.dp, end = if (entry.role == ChatRole.USER) 0.dp else 24.dp)
            .clearAndSetSemantics {
                contentDescription = spoken
                // New replies are announced politely; the user's own lines are not.
                if (entry.role != ChatRole.USER) liveRegion = LiveRegionMode.Polite
            },
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                if (entry.role == ChatRole.BLOCKED) "! $label" else label,
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold,
            )
            Text(body, style = MaterialTheme.typography.bodyLarge)
        }
    }
}

/** What is going on right now: a polite "Thinking…" while a turn runs, or the assertive error of the last one. */
@Composable
private fun StatusLine(state: AssistantUiState) {
    val error = state.error
    when {
        state.sending -> GuardStatus(stringResource(R.string.assistant_thinking))
        error != null -> GuardErrorNote(errorText(error), LiveRegionMode.Assertive)
    }
}

@Composable
private fun errorText(error: AssistantError): String = when (error.kind) {
    "rate_limit" -> stringResource(R.string.assistant_error_rate_limit)
    "timeout" -> stringResource(R.string.assistant_error_timeout)
    "invalid_output" -> stringResource(R.string.assistant_error_invalid_output)
    TurnResult.KIND_BLOCKED -> stringResource(R.string.assistant_error_blocked)
    TurnResult.KIND_BUDGET -> stringResource(R.string.assistant_error_budget, error.required ?: AssistantEngine.MIN_BUDGET)
    else -> stringResource(R.string.assistant_error_unavailable)
}

/** The pinned input: the field, Send, and Enter to send (Shift+Enter keeps a new line). */
@Composable
private fun Composer(state: AssistantUiState, actions: AssistantActions) {
    Surface(color = MaterialTheme.colorScheme.surface, tonalElevation = 3.dp, modifier = Modifier.fillMaxWidth()) {
        Box(
            Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal + WindowInsetsSides.Bottom)),
            contentAlignment = Alignment.TopCenter,
        ) {
            Row(
                Modifier.widthIn(max = ContentMaxWidth).fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(
                    value = state.draft,
                    onValueChange = actions.onDraft,
                    label = { Text(stringResource(R.string.assistant_input_label)) },
                    maxLines = 4,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = { if (state.canSend) actions.onSend() }),
                    modifier = Modifier
                        .weight(1f)
                        .heightIn(min = 56.dp)
                        .onPreviewKeyEvent { event ->
                            val enter = event.key == Key.Enter || event.key == Key.NumPadEnter
                            if (enter && !event.isShiftPressed) {
                                if (event.type == KeyEventType.KeyDown && state.canSend) actions.onSend()
                                true
                            } else {
                                false
                            }
                        },
                )
                Button(
                    onClick = actions.onSend,
                    enabled = state.canSend,
                    modifier = Modifier.heightIn(min = 56.dp),
                ) {
                    Text(stringResource(R.string.assistant_send))
                }
            }
        }
    }
}

// ---- trace -------------------------------------------------------------------------------------------------------

@Composable
private fun TraceSection(trace: List<TraceEvent>) {
    SectionBlock(stringResource(R.string.assistant_trace_heading)) {
        Text(
            stringResource(R.string.assistant_trace_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (trace.isEmpty()) {
            Text(stringResource(R.string.assistant_trace_empty), style = MaterialTheme.typography.bodyMedium)
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                trace.forEach { TraceRow(it) }
            }
        }
    }
}

@Composable
private fun TraceRow(event: TraceEvent) {
    val text = traceText(event)
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 32.dp)
            .clearAndSetSemantics { contentDescription = text },
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            traceGlyph(event.kind),
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center,
            modifier = Modifier.width(24.dp),
        )
        Text(text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
    }
}

private fun traceGlyph(kind: TraceKind): String = when (kind) {
    TraceKind.WINDOW -> "▭"
    TraceKind.REDACTIONS -> "✱"
    TraceKind.ATTEMPT -> "→"
    TraceKind.FAILURE -> "✕"
    TraceKind.WAIT -> "…"
    TraceKind.FALLBACK -> "↪"
    TraceKind.ANSWERED -> "✓"
    TraceKind.BLOCKED -> "⛔"
}

@Composable
internal fun traceText(event: TraceEvent): String {
    val a = event.args
    fun int(i: Int) = a.getOrNull(i)?.toIntOrNull() ?: 0
    return when (event.kind) {
        TraceKind.WINDOW -> stringResource(R.string.assistant_trace_window, int(0), int(1), int(2), int(3))
        TraceKind.REDACTIONS -> {
            val pairs = a.chunked(2).filter { it.size == 2 }
            val total = pairs.sumOf { it[1].toIntOrNull() ?: 0 }
            val labels = pairs.map { metricKindLabel(it[0]) + "×" + it[1] }
            val list = labels.joinToString(", ")
            when {
                a.firstOrNull() == AssistantEngine.REDACTION_OFF -> stringResource(R.string.assistant_trace_redactions_off)
                total == 0 -> stringResource(R.string.assistant_trace_redactions_none)
                else -> pluralStringResource(R.plurals.assistant_trace_redactions, total, total, list)
            }
        }
        TraceKind.ATTEMPT -> stringResource(R.string.assistant_trace_attempt, int(1), a.getOrNull(0).orEmpty())
        TraceKind.FAILURE -> stringResource(R.string.assistant_trace_failure, a.getOrNull(0).orEmpty(), kindText(a.getOrNull(1).orEmpty()))
        TraceKind.WAIT -> stringResource(R.string.assistant_trace_wait, a.getOrNull(0)?.toLongOrNull()?.toInt() ?: 0, kindText(a.getOrNull(1).orEmpty()))
        TraceKind.FALLBACK -> stringResource(R.string.assistant_trace_fallback, kindText(a.getOrNull(0).orEmpty()))
        TraceKind.ANSWERED ->
            if (a.size >= 2) stringResource(R.string.assistant_trace_answered_fallback, kindText(a[1]))
            else stringResource(R.string.assistant_trace_answered, a.getOrNull(0).orEmpty())
        TraceKind.BLOCKED -> stringResource(R.string.assistant_trace_blocked)
    }
}

/** A short translated name for an error kind (a provider error, `blocked` or `budget`); an unknown one shows as written. */
@Composable
internal fun kindText(kind: String): String = when (kind) {
    "rate_limit" -> stringResource(R.string.assistant_kind_rate_limit)
    "timeout" -> stringResource(R.string.assistant_kind_timeout)
    "unavailable" -> stringResource(R.string.assistant_kind_unavailable)
    "invalid_output" -> stringResource(R.string.assistant_kind_invalid_output)
    TurnResult.KIND_BLOCKED -> stringResource(R.string.assistant_kind_blocked)
    TurnResult.KIND_BUDGET -> stringResource(R.string.assistant_kind_budget)
    else -> kind
}

// ---- evals -------------------------------------------------------------------------------------------------------

@Composable
private fun EvalsSection(state: AssistantUiState, actions: AssistantActions) {
    val evals = state.evals
    SectionBlock(stringResource(R.string.assistant_evals_heading)) {
        Text(stringResource(R.string.assistant_evals_intro), style = MaterialTheme.typography.bodyMedium)
        if (AssistantEvals.pauses(state.backend)) {
            Text(
                stringResource(R.string.assistant_evals_limit_note),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = actions.onRunEvals,
                enabled = state.backendReady && !evals.running && !state.sending,
                modifier = Modifier.heightIn(min = 48.dp),
            ) { Text(stringResource(R.string.assistant_evals_run)) }
            if (evals.running) {
                OutlinedButton(onClick = actions.onCancelEvals, modifier = Modifier.heightIn(min = 48.dp)) {
                    Text(stringResource(R.string.assistant_evals_cancel))
                }
            }
        }
        when {
            evals.running -> GuardStatus(
                if (evals.waitingMs > 0) stringResource(R.string.assistant_evals_waiting, evals.waitingMs.toInt())
                else stringResource(R.string.assistant_evals_progress, (evals.done + 1).coerceAtMost(evals.total), evals.total),
            )
            evals.cancelled -> GuardStatus(stringResource(R.string.assistant_evals_cancelled, evals.rows.size, evals.total))
            evals.failed -> GuardErrorNote(stringResource(R.string.assistant_evals_failed), LiveRegionMode.Polite)
            evals.rows.isNotEmpty() -> {
                val passed = evals.rows.count { it.status == Status.PASS }
                GuardStatus(stringResource(R.string.assistant_evals_summary, passed, evals.rows.size))
            }
        }
        if (evals.rows.isNotEmpty() && !evals.running) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                evals.rows.forEach { EvalRow(it) }
            }
        }
    }
}

@Composable
private fun evalCaseLabel(id: String): String = when (id) {
    AssistantEvals.GREETING -> stringResource(R.string.assistant_eval_greeting)
    AssistantEvals.CAPABILITIES -> stringResource(R.string.assistant_eval_capabilities)
    AssistantEvals.EMAIL -> stringResource(R.string.assistant_eval_email_not_echoed)
    AssistantEvals.PHONE -> stringResource(R.string.assistant_eval_phone_not_echoed)
    AssistantEvals.FOLLOWUP -> stringResource(R.string.assistant_eval_followup)
    else -> id
}

@Composable
private fun EvalRow(row: AssistantEvalRow) {
    val label = evalCaseLabel(row.caseId)
    val statusText = stringResource(
        when (row.status) {
            Status.PASS -> R.string.assistant_eval_pass
            Status.FAIL -> R.string.assistant_eval_fail
            Status.ERROR -> R.string.assistant_eval_error
        },
    )
    val tone = when (row.status) {
        Status.PASS -> GuardTone.OK
        Status.FAIL -> GuardTone.WARN
        Status.ERROR -> GuardTone.ERROR
    }
    val excerpt = if (row.error != null) kindText(row.error) else row.excerpt.ifEmpty { stringResource(R.string.assistant_eval_empty_reply) }
    val fell = row.fellBackFrom?.let { kindText(it) }
    val leak = stringResource(R.string.assistant_eval_leaked)
    val base = when {
        row.error != null -> stringResource(R.string.assistant_eval_row_error, label, statusText, excerpt)
        fell != null -> stringResource(R.string.assistant_eval_row_fallback, label, statusText, excerpt, fell)
        else -> stringResource(R.string.assistant_eval_row, label, statusText, excerpt)
    }
    val spoken = if (row.leaked) "$base $leak" else base
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth().clearAndSetSemantics { contentDescription = spoken },
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(label, style = MaterialTheme.typography.titleSmall)
            GuardBadge(statusText, tone)
            Text(excerpt, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (fell != null) {
                Text(
                    stringResource(R.string.assistant_trace_answered_fallback, fell),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (row.leaked) {
                Text(leak, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
        }
    }
}
