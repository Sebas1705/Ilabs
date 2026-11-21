package es.sebas1705.ilabs.demo

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import es.sebas1705.ilabs.guardrails.KindMetrics
import es.sebas1705.ilabs.guardrails.Metrics

@Composable
internal fun MeasureSection(state: GuardrailsUiState, actions: GuardrailsActions) {
    SectionBlock(stringResource(R.string.guard_section_measure)) {
        SamplePicker(listOf(null to state.measureNames), state.measureSelected.orEmpty(), actions.onMeasure)
        val view = state.measure
        when {
            state.measureRunError != null -> GuardErrorNote(stringResource(R.string.guard_run_error, state.measureRunError), LiveRegionMode.Assertive)
            view == null -> GuardRunning()
            else -> GuardStatus(
                pluralStringResource(
                    R.plurals.guard_status_measure, view.samples.size, view.samples.size,
                    formatScore(view.pii.f1, 3), formatScore(view.injection.f1, 3),
                ),
            )
        }
        Text(
            stringResource(R.string.guard_measure_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            stringResource(R.string.guard_measure_note),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (view != null) {
            MetricsCard(stringResource(R.string.guard_measure_pii), view.pii)
            MetricsCard(stringResource(R.string.guard_measure_injection), view.injection)
            SamplesCard(view)
        }
    }
}

/** Precision, recall and F1 as text with three decimals, over all kinds and per kind; the bars are decorative. */
@Composable
private fun MetricsCard(title: String, metrics: Metrics) {
    Card(title) {
        val overall = stringResource(R.string.guard_measure_overall)
        val spokenOverall = stringResource(
            R.string.guard_metric_overall_spoken, title, formatScore(metrics.precision, 3), formatScore(metrics.recall, 3), formatScore(metrics.f1, 3),
        )
        Column(Modifier.fillMaxWidth().clearAndSetSemantics { contentDescription = spokenOverall }, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(overall, fontWeight = FontWeight.SemiBold)
            MetricValues(metrics.precision, metrics.recall, metrics.f1)
            GuardBar(metrics.f1)
        }
        metrics.byKind.forEach { KindRow(it) }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MetricValues(precision: Double, recall: Double, f1: Double) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(stringResource(R.string.guard_metric_cell, stringResource(R.string.guard_precision), formatScore(precision, 3)))
        Text(stringResource(R.string.guard_metric_cell, stringResource(R.string.guard_recall), formatScore(recall, 3)))
        Text(stringResource(R.string.guard_metric_cell, stringResource(R.string.guard_f1), formatScore(f1, 3)))
    }
}

@Composable
private fun KindRow(kind: KindMetrics) {
    val label = metricKindLabel(kind.kind)
    val spoken = stringResource(
        R.string.guard_metric_spoken, label, formatScore(kind.precision, 3), formatScore(kind.recall, 3), formatScore(kind.f1, 3),
        kind.expected, kind.found, kind.correct,
    )
    Column(
        Modifier.fillMaxWidth().padding(top = 8.dp).clearAndSetSemantics { contentDescription = spoken },
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(label, fontWeight = FontWeight.SemiBold)
        Text(
            stringResource(R.string.guard_metric_counts, kind.expected, kind.found, kind.correct),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        MetricValues(kind.precision, kind.recall, kind.f1)
        GuardBar(kind.f1)
    }
}

@Composable
private fun SamplesCard(view: MeasureView) {
    Card(stringResource(R.string.guard_measure_samples)) {
        Text(
            stringResource(R.string.guard_measure_samples_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        view.samples.forEachIndexed { index, sample ->
            Section(stringResource(R.string.guard_measure_sample, index + 1))
            CodeBlock(sample.text.ifEmpty { stringResource(R.string.guard_empty_text) })
            if (sample.spans.isEmpty()) Text(stringResource(R.string.guard_marks_none), color = MaterialTheme.colorScheme.onSurfaceVariant)
            val matched = remember(sample) { sliceCodePointRanges(sample.text, sample.spans.map { it.start to it.end }) }
            sample.spans.forEachIndexed { i, mark -> MarkRow(mark, matched[i]) }
        }
    }
}

/** One span of a sample: a glyph and a word for correct, missed or extra, its kind and where it sits. */
@Composable
private fun MarkRow(mark: SpanMark, matched: String) {
    val status = ILabsTheme.status
    val (glyph, word, color) = when (mark.status) {
        MarkStatus.CORRECT -> Triple("✓", stringResource(R.string.guard_mark_correct), status.okFg)
        MarkStatus.MISS -> Triple("✕", stringResource(R.string.guard_mark_miss), status.errFg)
        MarkStatus.EXTRA -> Triple("+", stringResource(R.string.guard_mark_extra), status.warnFg)
    }
    val kind = metricKindLabel(mark.kind)
    val span = spanText(mark.start, mark.end)
    val spoken = stringResource(R.string.guard_mark_row, word, kind, matched, span)
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).clearAndSetSemantics { contentDescription = spoken },
        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(glyph, fontWeight = FontWeight.Bold, color = color)
        Column {
            Text("$word: $kind", color = color, fontWeight = FontWeight.SemiBold)
            Text(matched.ifEmpty { stringResource(R.string.guard_empty_text) }, fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium)
            Text(span, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
