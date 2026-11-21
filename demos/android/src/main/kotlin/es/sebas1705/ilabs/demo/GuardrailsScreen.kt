package es.sebas1705.ilabs.demo

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import es.sebas1705.ilabs.guardrails.Action
import es.sebas1705.ilabs.guardrails.CheckKind
import es.sebas1705.ilabs.guardrails.InjectionCategory
import es.sebas1705.ilabs.guardrails.PiiKind

/** Everything the screen can ask of the view model. */
class GuardrailsActions(
    val onSample: (String) -> Unit,
    val onText: (String) -> Unit,
    val onPiiAction: (ControlAction) -> Unit,
    val onPiiKind: (PiiKind) -> Unit,
    val onInjectionAction: (ControlAction) -> Unit,
    val onThreshold: (String) -> Unit,
    val onDenyAction: (ControlAction) -> Unit,
    val onDenyTerms: (String) -> Unit,
    val onMaxAction: (ControlAction) -> Unit,
    val onMaxLength: (String) -> Unit,
    val onGuarded: (String) -> Unit,
    val onMeasure: (String) -> Unit,
) {
    companion object {
        fun of(vm: GuardrailsViewModel) = GuardrailsActions(
            vm::selectSample, vm::setText, vm::setPiiAction, vm::togglePiiKind, vm::setInjectionAction,
            vm::setInjectionThreshold, vm::setDenyAction, vm::setDenyTerms, vm::setMaxAction, vm::setMaxLength,
            vm::selectGuarded, vm::selectMeasure,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GuardrailsScreen(state: GuardrailsUiState, actions: GuardrailsActions, onBack: (() -> Unit)? = null) {
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
        // imePadding after consumeWindowInsets: the text area is never behind the keyboard.
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
                verticalArrangement = Arrangement.spacedBy(24.dp),
            ) {
                item { Header(state) }
                if (state.sample != null) item(key = "playground") { PlaygroundSection(state, actions) }
                if (state.guardedSelected != null) item(key = "guarded") { GuardedSection(state, actions) }
                if (state.measureSelected != null) item(key = "measure") { MeasureSection(state, actions) }
                item {
                    Text(
                        stringResource(R.string.guard_footer),
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
private fun Header(state: GuardrailsUiState) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            stringResource(R.string.guard_title),
            style = MaterialTheme.typography.headlineMedium,
            modifier = Modifier.semantics { heading() },
        )
        Text(
            stringResource(R.string.guard_subtitle),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        state.loadError?.let { GuardErrorNote(stringResource(R.string.guard_load_error, it), LiveRegionMode.Polite) }
    }
}

/** A named region: its title is the pane title for screen readers and the heading of the section. */
@Composable
internal fun SectionBlock(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier.fillMaxWidth().semantics {
            paneTitle = title
            isTraversalGroup = true
        },
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(title, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
        content()
    }
}

/** An error line with a glyph (never colour alone) that screen readers announce when it appears. */
@Composable
internal fun GuardErrorNote(text: String, mode: LiveRegionMode) {
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

/** One polite, coarse sentence under a picker. */
@Composable
internal fun GuardStatus(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
    )
}

@Composable
internal fun GuardRunning() = GuardStatus(stringResource(R.string.guard_running))

/** A status chip: a glyph and a label, so meaning never rests on colour alone. */
@Composable
internal fun GuardBadge(label: String, tone: GuardTone, modifier: Modifier = Modifier) {
    val status = ILabsTheme.status
    val (bg, fg, glyph) = when (tone) {
        GuardTone.OK -> Triple(status.okBg, status.okFg, "✓")
        GuardTone.WARN -> Triple(status.warnBg, status.warnFg, "!")
        GuardTone.ERROR -> Triple(status.errBg, status.errFg, "✕")
    }
    Surface(color = bg, contentColor = fg, shape = RoundedCornerShape(50), modifier = modifier) {
        Row(
            Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(glyph, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelLarge)
            Text(label, style = MaterialTheme.typography.labelLarge)
        }
    }
}

enum class GuardTone { OK, WARN, ERROR }

/** A decorative bar: the text beside it carries the value, so the bar is hidden from screen readers. */
@Composable
internal fun GuardBar(fraction: Double) {
    val f = fraction.toFloat().coerceIn(0f, 1f)
    Box(
        Modifier.fillMaxWidth().height(8.dp).clip(RoundedCornerShape(4.dp)).background(MaterialTheme.colorScheme.surfaceVariant)
            .clearAndSetSemantics {},
    ) {
        if (f > 0f) Box(Modifier.fillMaxWidth(f).height(8.dp).background(MaterialTheme.colorScheme.primary))
    }
}

/**
 * A sample picker: a read-only field that opens a menu. A group label (when given) is a heading inside the menu;
 * the menu items are 48 dp high.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SamplePicker(groups: List<Pair<String?, List<String>>>, selected: String, onSelect: (String) -> Unit) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    val description = stringResource(R.string.guard_sample_picker, selected)
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = selected,
            onValueChange = {},
            readOnly = true,
            singleLine = true,
            label = { Text(stringResource(R.string.guard_sample)) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
            modifier = Modifier
                .menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable)
                .fillMaxWidth()
                .heightIn(min = 56.dp)
                .semantics { contentDescription = description },
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            groups.forEach { (label, names) ->
                if (label != null) {
                    Text(
                        label,
                        style = MaterialTheme.typography.titleSmall,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp).semantics { heading() },
                    )
                }
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

// ---- labels ---------------------------------------------------------------------------------------------------------

@Composable
internal fun kindLabel(kind: PiiKind): String = when (kind) {
    PiiKind.EMAIL -> stringResource(R.string.guard_kind_email)
    PiiKind.PHONE -> stringResource(R.string.guard_kind_phone)
    PiiKind.IBAN -> stringResource(R.string.guard_kind_iban)
    PiiKind.CARD -> stringResource(R.string.guard_kind_card)
    PiiKind.SPANISH_ID -> stringResource(R.string.guard_kind_spanish_id)
    PiiKind.SECRET -> stringResource(R.string.guard_kind_secret)
}

@Composable
internal fun categoryLabel(category: InjectionCategory): String = when (category) {
    InjectionCategory.OVERRIDE -> stringResource(R.string.guard_category_override)
    InjectionCategory.ROLE_HIJACK -> stringResource(R.string.guard_category_role_hijack)
    InjectionCategory.PROMPT_LEAK -> stringResource(R.string.guard_category_prompt_leak)
    InjectionCategory.DELIMITER -> stringResource(R.string.guard_category_delimiter)
}

/** A metric kind (a PII kind or an injection category) by its wire name; an unknown one shows as written. */
@Composable
internal fun metricKindLabel(wire: String): String =
    PiiKind.entries.firstOrNull { it.wire == wire }?.let { kindLabel(it) }
        ?: InjectionCategory.entries.firstOrNull { it.wire == wire }?.let { categoryLabel(it) }
        ?: wire

@Composable
internal fun checkKindLabel(kind: CheckKind): String = when (kind) {
    CheckKind.PII -> stringResource(R.string.guard_check_pii)
    CheckKind.INJECTION -> stringResource(R.string.guard_check_injection)
    CheckKind.DENY_TERMS -> stringResource(R.string.guard_check_denyterms)
    CheckKind.MAX_LENGTH -> stringResource(R.string.guard_check_maxlength)
    CheckKind.CANARY -> stringResource(R.string.guard_check_canary)
    CheckKind.CLASSIFIER -> stringResource(R.string.guard_check_classifier)
}

@Composable
internal fun actionLabel(action: Action): String = when (action) {
    Action.BLOCK -> stringResource(R.string.guard_action_block)
    Action.REDACT -> stringResource(R.string.guard_action_redact)
    Action.FLAG -> stringResource(R.string.guard_action_flag)
}

@Composable
internal fun controlActionLabel(action: ControlAction): String = when (action) {
    ControlAction.OFF -> stringResource(R.string.guard_action_off)
    ControlAction.FLAG -> stringResource(R.string.guard_action_flag)
    ControlAction.REDACT -> stringResource(R.string.guard_action_redact)
    ControlAction.BLOCK -> stringResource(R.string.guard_action_block)
}

/** Translated text for a library or provider error kind; an unknown kind falls back to the raw code. */
@Composable
internal fun guardErrorLabel(kind: String): String = when (kind) {
    "invalid_policy" -> stringResource(R.string.guard_error_invalid_policy)
    "invalid_options" -> stringResource(R.string.guard_error_invalid_options)
    "no_classifier" -> stringResource(R.string.guard_error_no_classifier)
    "rate_limit" -> stringResource(R.string.guard_error_rate_limit)
    "timeout" -> stringResource(R.string.guard_error_timeout)
    "invalid_output" -> stringResource(R.string.guard_error_invalid_output)
    "unavailable" -> stringResource(R.string.guard_error_unavailable)
    else -> kind
}

@Composable
internal fun spanText(start: Int, end: Int): String = stringResource(R.string.guard_code_points, start, end)

@Composable
internal fun verdictLabel(allow: Boolean): String =
    if (allow) stringResource(R.string.guard_verdict_allow) else stringResource(R.string.guard_verdict_block)

@Composable
internal fun callsText(calls: Int): String = pluralStringResource(R.plurals.guard_calls, calls, calls)
