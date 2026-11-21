package es.sebas1705.ilabs.demo

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
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
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import es.sebas1705.ilabs.guardrails.CheckDetails
import es.sebas1705.ilabs.guardrails.CheckFinding
import es.sebas1705.ilabs.guardrails.CheckVerdict
import es.sebas1705.ilabs.guardrails.Mapping
import es.sebas1705.ilabs.guardrails.PiiKind

@Composable
internal fun PlaygroundSection(state: GuardrailsUiState, actions: GuardrailsActions) {
    SectionBlock(stringResource(R.string.guard_section_playground)) {
        val groups = state.groups.map { (group, names) -> groupLabel(group) to names }
        SamplePicker(groups, state.sample.orEmpty(), actions.onSample)
        val run = state.playground
        when {
            state.runError != null -> GuardErrorNote(stringResource(R.string.guard_run_error, state.runError), LiveRegionMode.Assertive)
            run == null -> GuardRunning()
            else -> GuardStatus(playgroundStatus(run))
        }
        if (state.partialChecks) {
            Text(
                stringResource(R.string.guard_partial),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        TextCard(state, actions)
        if (run != null) {
            PolicyErrorCard(run)
            HighlightsCard(state.text, run, state.largeText)
            RedactedCard(run, state.largeText)
            InjectionCard(run)
        }
        PolicyCard(state, actions)
        Text(
            stringResource(R.string.guard_limits),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun groupLabel(group: GuardrailsGroup): String = when (group) {
    GuardrailsGroup.PII -> stringResource(R.string.guard_group_pii)
    GuardrailsGroup.INJECTION -> stringResource(R.string.guard_group_injection)
    GuardrailsGroup.CHECKS -> stringResource(R.string.guard_group_checks)
}

/** The kind and the library's reason when the scan options or the policy were refused; the options come first. */
private fun runErrorOf(run: PlaygroundRun): Pair<String, String>? =
    run.piiError?.let { "invalid_options" to it } ?: (run.policy as? PolicyRun.Invalid)?.let { it.kind to it.reason }

/** The coarse status line: findings and signals with the verdict, or what is wrong. */
@Composable
private fun playgroundStatus(run: PlaygroundRun): String {
    val count = run.findings.size + run.injection.signals.size
    return when {
        run.piiError != null -> guardErrorLabel("invalid_options")
        run.policy is PolicyRun.Invalid -> stringResource(R.string.guard_status_invalid_policy)
        run.policy is PolicyRun.Checked -> {
            val block = run.policy.result.verdict == CheckVerdict.BLOCK
            pluralStringResource(if (block) R.plurals.guard_status_block else R.plurals.guard_status_allow, count, count)
        }
        else -> ""
    }
}

/** A separate card for a refused policy or scan option: the translated meaning and the library's own reason. */
@Composable
private fun PolicyErrorCard(run: PlaygroundRun) {
    val (kind, reason) = runErrorOf(run) ?: return
    val text = guardErrorLabel(kind)
    val detail = stringResource(R.string.guard_library_reason, reason)
    Card(stringResource(R.string.guard_policy_error)) {
        Column(
            Modifier.semantics(mergeDescendants = true) {
                liveRegion = LiveRegionMode.Polite
                contentDescription = "$text $detail"
            },
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("!", fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.error)
                Text(text, color = MaterialTheme.colorScheme.error)
            }
            Text(detail, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

/** A text field that keeps its own text while typing and re-reads the state only when the program sets it ([revision]). */
@Composable
private fun SyncedField(
    value: String,
    revision: Int,
    onChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    singleLine: Boolean = true,
    minLines: Int = 1,
    maxLines: Int = if (singleLine) 1 else 4,
    numeric: Boolean = false,
) {
    var local by remember { mutableStateOf(value) }
    LaunchedEffect(revision) { if (local != value) local = value }
    OutlinedTextField(
        value = local,
        onValueChange = {
            local = it
            onChange(it)
        },
        label = { Text(label) },
        singleLine = singleLine,
        minLines = minLines,
        maxLines = maxLines,
        keyboardOptions = if (numeric) KeyboardOptions(keyboardType = KeyboardType.Number) else KeyboardOptions.Default,
        modifier = modifier.fillMaxWidth().heightIn(min = 56.dp),
    )
}

@Composable
private fun TextCard(state: GuardrailsUiState, actions: GuardrailsActions) {
    Card(stringResource(R.string.guard_text)) {
        SyncedField(
            value = state.text,
            revision = state.textRevision,
            onChange = actions.onText,
            label = stringResource(R.string.guard_text),
            singleLine = false,
            minLines = 3,
            maxLines = 8,
        )
        Text(
            stringResource(R.string.guard_text_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

// ---- highlights -----------------------------------------------------------------------------------------------------

private fun glyphOf(family: HighlightFamily) = if (family == HighlightFamily.PII) "⚑" else "⚠"

@Composable
private fun HighlightsCard(text: String, run: PlaygroundRun, large: Boolean) {
    Card(stringResource(R.string.guard_highlights)) {
        val spans = highlightSpansOf(run)
        val labels = spans.map { metricKindLabel(it.kind) }
        val plain = large || spans.size > FINDINGS_PLAIN_TEXT_LIMIT
        if (text.isEmpty()) {
            Text(stringResource(R.string.guard_text_empty), color = MaterialTheme.colorScheme.onSurfaceVariant)
            return@Card
        }
        Text(
            stringResource(
                when {
                    plain -> R.string.guard_large_text
                    spans.isEmpty() -> R.string.guard_highlights_none
                    else -> R.string.guard_highlights_hint
                },
                LARGE_TEXT_PREVIEW_CHARS,
                FINDINGS_LIST_LIMIT,
            ),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        val shown = spans.take(FINDINGS_LIST_LIMIT)
        val slices = remember(text, shown) { sliceCodePointRanges(text, shown.map { it.start to it.end }) }
        if (plain) CodeBlock(largeTextPreview(text)) else HighlightedText(text, spans, labels, slices)
        shown.forEachIndexed { i, span -> FindingRow(span, labels[i], slices[i]) }
        if (spans.size > shown.size) Text(stringResource(R.string.guard_more_findings, spans.size - shown.size), color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/**
 * The text with every finding and signal underlined and followed by its glyph and kind; one region with a spoken
 * alternative. PII and injection marks differ by glyph, weight and tone, never by colour alone.
 */
@Composable
private fun HighlightedText(text: String, spans: List<HighlightSpan>, labels: List<String>, slices: List<String>) {
    val pii = MaterialTheme.colorScheme.primary
    val injection = MaterialTheme.colorScheme.tertiary
    val annotated = remember(text, spans, labels, pii, injection) {
        buildAnnotatedString {
            highlightSegments(text, spans).forEach { segment ->
                if (segment.marks.isEmpty()) {
                    append(segment.text)
                } else {
                    val first = spans[segment.marks.first()]
                    val tone = if (first.family == HighlightFamily.PII) pii else injection
                    val italic = if (first.family == HighlightFamily.PII) FontStyle.Normal else FontStyle.Italic
                    withStyle(SpanStyle(background = tone.copy(alpha = 0.2f), fontWeight = FontWeight.SemiBold, fontStyle = italic, textDecoration = TextDecoration.Underline)) { append(segment.text) }
                    segment.marks.forEach { m ->
                        withStyle(SpanStyle(color = tone, fontWeight = FontWeight.Bold)) { append(highlightTag(glyphOf(spans[m].family), labels[m])) }
                    }
                }
            }
        }
    }
    val alt = if (spans.isEmpty()) {
        text
    } else {
        val list = slices.indices.joinToString("; ") { "${labels[it]} “${slices.getOrElse(it) { "" }}”" }
        pluralStringResource(R.plurals.guard_highlight_alt, spans.size, spans.size, list)
    }
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.surfaceVariant,
        contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
        shape = RoundedCornerShape(8.dp),
    ) {
        SelectionContainer {
            Text(
                annotated,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(10.dp).clearAndSetSemantics { contentDescription = alt },
            )
        }
    }
}

/** One finding or signal as one spoken sentence: its kind and matched text, then where it sits. */
@Composable
private fun FindingRow(span: HighlightSpan, label: String, matched: String) {
    val where = spanText(span.start, span.end)
    val spoken = stringResource(R.string.guard_finding_spoken, label, matched, where)
    val tone = if (span.family == HighlightFamily.PII) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.tertiary
    Column(Modifier.fillMaxWidth().heightIn(min = 48.dp).clearAndSetSemantics { contentDescription = spoken }, verticalArrangement = Arrangement.Center) {
        Text("${glyphOf(span.family)} $label", style = MaterialTheme.typography.labelLarge, color = tone)
        span.detail?.let { Text(it, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
        Text(matched, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium)
        Text(where, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

// ---- redaction and injection ----------------------------------------------------------------------------------------

@Composable
private fun RedactedCard(run: PlaygroundRun, large: Boolean) {
    Card(stringResource(R.string.guard_redacted)) {
        val redacted = run.redacted ?: return@Card
        Text(
            stringResource(R.string.guard_redacted_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        val shown = if (large) largeTextPreview(redacted.text) else redacted.text
        CodeBlock(shown.ifEmpty { stringResource(R.string.guard_empty_text) })
        MappingTable(stringResource(R.string.guard_mapping), redacted.mapping)
    }
}

/** Placeholder to original, one row per entry; each row is one spoken sentence. */
@Composable
internal fun MappingTable(title: String, mapping: Mapping) {
    Section(title)
    if (mapping.isEmpty()) {
        Text(stringResource(R.string.guard_mapping_none), color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    val capped = capEntries(mapping)
    capped.shown.forEach { (placeholder, original) ->
        val spoken = stringResource(R.string.guard_mapping_spoken, placeholder, original)
        Row(
            Modifier.fillMaxWidth().heightIn(min = 48.dp).clearAndSetSemantics { contentDescription = spoken },
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
        ) {
            Text(stringResource(R.string.guard_mapping_row, placeholder, original), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium)
        }
    }
    if (capped.more > 0) Text(stringResource(R.string.guard_more_findings, capped.more), color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun InjectionCard(run: PlaygroundRun) {
    val injection = run.injection
    val spokenScore = stringResource(R.string.guard_injection_spoken, injection.score)
    Card(stringResource(R.string.guard_injection)) {
        Column(Modifier.clearAndSetSemantics { contentDescription = spokenScore }, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(stringResource(R.string.guard_injection_score, injection.score), style = MaterialTheme.typography.headlineSmall)
            GuardBar(injection.score / 100.0)
        }
        if (injection.signals.isEmpty()) Text(stringResource(R.string.guard_signals_none), color = MaterialTheme.colorScheme.onSurfaceVariant)
        injection.signals.forEach { signal ->
            val category = categoryLabel(signal.category)
            val span = spanText(signal.start, signal.end)
            val spoken = stringResource(R.string.guard_signal_spoken, signal.id, category, span)
            Column(Modifier.fillMaxWidth().heightIn(min = 48.dp).clearAndSetSemantics { contentDescription = spoken }, verticalArrangement = Arrangement.Center) {
                Text(signal.id, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold)
                Text(
                    stringResource(R.string.guard_signal_row, category, span),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

// ---- policy ---------------------------------------------------------------------------------------------------------

private val ACTIONS_WITH_REDACT = listOf(ControlAction.OFF, ControlAction.FLAG, ControlAction.REDACT, ControlAction.BLOCK)
private val ACTIONS_WITHOUT_REDACT = listOf(ControlAction.OFF, ControlAction.FLAG, ControlAction.BLOCK)

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PolicyCard(state: GuardrailsUiState, actions: GuardrailsActions) {
    val c = state.controls
    Card(stringResource(R.string.guard_policy)) {
        Text(
            stringResource(R.string.guard_policy_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Section(stringResource(R.string.guard_check_pii))
        ActionChoice(stringResource(R.string.guard_check_pii), ACTIONS_WITH_REDACT, c.piiAction, actions.onPiiAction)
        Text(stringResource(R.string.guard_kinds), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PiiKind.entries.forEach { kind ->
                val selected = kind in c.piiKinds
                FilterChip(
                    selected = selected,
                    onClick = { actions.onPiiKind(kind) },
                    label = { Text(kindLabel(kind)) },
                    leadingIcon = if (selected) ({ Text("✓", fontWeight = FontWeight.Bold) }) else null,
                    modifier = Modifier.heightIn(min = 48.dp),
                )
            }
        }

        Section(stringResource(R.string.guard_check_injection))
        ActionChoice(stringResource(R.string.guard_check_injection), ACTIONS_WITHOUT_REDACT, c.injectionAction, actions.onInjectionAction)
        SyncedField(c.injectionThreshold, state.textRevision, actions.onThreshold, stringResource(R.string.guard_threshold), numeric = true)

        Section(stringResource(R.string.guard_check_denyterms))
        ActionChoice(stringResource(R.string.guard_check_denyterms), ACTIONS_WITHOUT_REDACT, c.denyAction, actions.onDenyAction)
        SyncedField(c.denyTerms, state.textRevision, actions.onDenyTerms, stringResource(R.string.guard_terms))

        Section(stringResource(R.string.guard_check_maxlength))
        ActionChoice(stringResource(R.string.guard_check_maxlength), ACTIONS_WITHOUT_REDACT, c.maxAction, actions.onMaxAction)
        SyncedField(c.maxLength, state.textRevision, actions.onMaxLength, stringResource(R.string.guard_max), numeric = true)

        state.playground?.policy?.let { VerdictBlock(it, state.text) }
    }
}

/** One action per check as a single choice that wraps at any font size; every option is at least 48 dp high. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ActionChoice(group: String, options: List<ControlAction>, selected: ControlAction, onSelect: (ControlAction) -> Unit) {
    val title = stringResource(R.string.guard_action)
    FlowRow(
        Modifier.fillMaxWidth().selectableGroup().semantics { contentDescription = "$group, $title" },
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        options.forEach { option ->
            val isSelected = option == selected
            FilterChip(
                selected = isSelected,
                onClick = { onSelect(option) },
                label = { Text(controlActionLabel(option)) },
                leadingIcon = if (isSelected) ({ Text("✓", fontWeight = FontWeight.Bold) }) else null,
                modifier = Modifier.heightIn(min = 48.dp).semantics { role = Role.RadioButton },
            )
        }
    }
}

/** The library's answer for the policy: the verdict and one row per check. A refused policy has its own error card. */
@Composable
private fun VerdictBlock(policy: PolicyRun, text: String) {
    when (policy) {
        is PolicyRun.Invalid -> Unit
        is PolicyRun.Checked -> {
            Section(stringResource(R.string.guard_verdict))
            val result = policy.result
            val allow = result.verdict == CheckVerdict.ALLOW
            GuardBadge(verdictLabel(allow), if (allow) GuardTone.OK else GuardTone.ERROR)
            if (result.text != text) {
                Section(stringResource(R.string.guard_verdict_after))
                CodeBlock(result.text.ifEmpty { stringResource(R.string.guard_empty_text) })
                if (result.mapping.isNotEmpty()) MappingTable(stringResource(R.string.guard_mapping), result.mapping)
            }
            Section(stringResource(R.string.guard_checks_results))
            if (result.findings.isEmpty()) {
                Text(stringResource(R.string.guard_checks_none), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            CheckFindingsList(result.findings)
        }
    }
}

// ---- check findings (shared with the guarded conversation) ------------------------------------------------------------

@Composable
private fun moreLines(more: Int): List<String> = if (more > 0) listOf(stringResource(R.string.guard_more_findings, more)) else emptyList()

/** The summary line and the detail lines of a check's details. */
@Composable
private fun detailLines(details: CheckDetails): List<String> = when (details) {
    is CheckDetails.PiiDetails -> listOf(pluralStringResource(R.plurals.guard_detail_pii, details.findings.size, details.findings.size)) +
        capEntries(details.findings).shown.map { f ->
            stringResource(R.string.guard_finding_spoken, kindLabel(f.kind), f.text, spanText(f.start, f.end))
        } + moreLines(capEntries(details.findings).more)
    is CheckDetails.InjectionDetails -> listOf(
        stringResource(R.string.guard_detail_injection, details.score) + ", " +
            pluralStringResource(R.plurals.guard_detail_signals, details.signals.size, details.signals.size),
    ) + capEntries(details.signals).shown.map { s ->
        stringResource(R.string.guard_signal_spoken, s.id, categoryLabel(s.category), spanText(s.start, s.end))
    } + moreLines(capEntries(details.signals).more)
    is CheckDetails.DenyTermsDetails -> listOf(pluralStringResource(R.plurals.guard_detail_matches, details.matches.size, details.matches.size)) +
        capEntries(details.matches).shown.map { m -> stringResource(R.string.guard_detail_match, m.term, spanText(m.start, m.end)) } +
        moreLines(capEntries(details.matches).more)
    is CheckDetails.MaxLengthDetails -> listOf(pluralStringResource(R.plurals.guard_detail_length, details.length, details.length))
    is CheckDetails.CanaryDetails -> listOf(
        stringResource(if (details.found) R.string.guard_detail_canary_found else R.string.guard_detail_canary_absent),
    )
    is CheckDetails.ClassifierDetails -> listOfNotNull(
        stringResource(if (details.flagged) R.string.guard_detail_classifier_flagged else R.string.guard_detail_classifier_clear),
        details.label?.let { stringResource(R.string.guard_detail_label, it) },
    )
}

/** One block per check: whether it fired (glyph and text), its kind and action, and what it found. One spoken sentence each. */
@Composable
internal fun CheckFindingsList(findings: List<CheckFinding>) {
    findings.forEach { finding ->
        val lines = detailLines(finding.details)
        val kind = checkKindLabel(finding.kind)
        val action = actionLabel(finding.action)
        val fired = stringResource(if (finding.fired) R.string.guard_check_fired else R.string.guard_check_quiet)
        val spoken = stringResource(R.string.guard_check_spoken, finding.check + 1, kind, action, fired, lines.joinToString(". "))
        Column(
            Modifier.fillMaxWidth().heightIn(min = 48.dp).clearAndSetSemantics { contentDescription = spoken },
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(stringResource(R.string.guard_check_header, finding.check + 1, kind, action), fontWeight = FontWeight.SemiBold)
            GuardBadge(fired, if (finding.fired) GuardTone.WARN else GuardTone.OK)
            lines.forEachIndexed { index, line ->
                Text(
                    line,
                    style = if (index == 0) MaterialTheme.typography.bodyMedium else MaterialTheme.typography.bodySmall,
                    color = if (index == 0) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = if (index == 0) Modifier else Modifier.padding(start = 12.dp),
                )
            }
        }
    }
}
