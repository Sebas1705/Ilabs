package es.sebas1705.ilabs.demo

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import es.sebas1705.ilabs.rag.Level

/** Translated message for a library or provider error kind; an unknown kind falls back to its raw code. */
@Composable
internal fun ragErrorLabel(kind: String): String = when (kind) {
    "invalid_options" -> stringResource(R.string.rag_error_invalid_options)
    "no_embedder" -> stringResource(R.string.rag_error_no_embedder)
    "invalid_embedding" -> stringResource(R.string.rag_error_invalid_embedding)
    "rate_limit" -> stringResource(R.string.rag_error_rate_limit)
    "timeout" -> stringResource(R.string.rag_error_timeout)
    "invalid_output" -> stringResource(R.string.rag_error_invalid_output)
    "unavailable" -> stringResource(R.string.rag_error_unavailable)
    else -> kind
}

/** A failure other than `budget_too_small`: translated message with a glyph and the library's own reason as detail. */
@Composable
internal fun FailureCard(failure: RagFailure) {
    Card(stringResource(R.string.rag_error_title)) {
        val message = ragErrorLabel(failure.kind)
        val status = ILabsTheme.status
        Surface(
            color = status.errBg,
            contentColor = status.errFg,
            shape = RoundedCornerShape(8.dp),
            modifier = Modifier.fillMaxWidth().semantics(mergeDescendants = true) { contentDescription = message },
        ) {
            Row(Modifier.padding(12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("✕", fontWeight = FontWeight.Bold)
                Text(message, fontWeight = FontWeight.SemiBold)
            }
        }
        failure.detail?.let {
            Section(stringResource(R.string.rag_error_reason))
            CodeBlock(it)
        }
    }
}

/** The composed context, its budget bar with text values and the dropped count, or the `budget_too_small` state. */
@Composable
internal fun ContextCard(run: RagRun, maxTokens: Int?) {
    val context = run.context
    val failure = run.failure?.takeIf { it.kind == "budget_too_small" }
    Card(stringResource(R.string.rag_context)) {
        if (failure != null) {
            BudgetTooSmall(failure.required ?: 0, maxTokens)
        } else if (context != null) {
            Text(
                stringResource(R.string.rag_context_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            CodeBlock(context.content)
            Section(stringResource(R.string.rag_budget))
            BudgetBar(context.usedTokens, context.maxTokens)
            val kept = pluralStringResource(R.plurals.rag_sources_kept, context.sources.size, context.sources.size)
            val dropped = context.droppedCount?.let { pluralStringResource(R.plurals.rag_dropped, it, it) }
            KeyValue(stringResource(R.string.rag_sources), kept)
            context.sources.forEach { s ->
                val entry = stringResource(R.string.rag_source_entry, s.n, s.chunkId, s.docId)
                Text(
                    entry,
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.heightIn(min = 32.dp).semantics { contentDescription = entry },
                )
            }
            if (dropped != null) KeyValue(stringResource(R.string.rag_dropped_label), dropped)
        }
    }
}

/** A bar whose text carries the numbers; the bar itself is decorative. */
@Composable
private fun BudgetBar(used: Int, max: Int) {
    val text = pluralStringResource(R.plurals.rag_budget_used, max, used, max)
    val fraction = if (max <= 0) 0f else (used.toFloat() / max).coerceIn(0f, 1f)
    Text(text, style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics(mergeDescendants = true) { contentDescription = text })
    Box(
        Modifier.fillMaxWidth().height(10.dp).clip(RoundedCornerShape(5.dp)).background(MaterialTheme.colorScheme.surfaceVariant)
            .clearAndSetSemantics {},
    ) {
        if (fraction > 0f) Box(Modifier.fillMaxWidth(fraction).height(10.dp).background(MaterialTheme.colorScheme.primary))
    }
}

/** The "budget too small" state: a glyph, the number the library asked for and the budget that was given. */
@Composable
private fun BudgetTooSmall(required: Int, maxTokens: Int?) {
    val status = ILabsTheme.status
    val text = pluralStringResource(R.plurals.rag_budget_needs, required, required, maxTokens ?: 0)
    Surface(
        color = status.errBg,
        contentColor = status.errFg,
        shape = RoundedCornerShape(8.dp),
        modifier = Modifier.fillMaxWidth().semantics(mergeDescendants = true) {
            liveRegion = LiveRegionMode.Polite
            contentDescription = text
        },
    ) {
        Row(Modifier.padding(12.dp).heightIn(min = 24.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("✕", fontWeight = FontWeight.Bold)
            Text(text, fontWeight = FontWeight.SemiBold)
        }
    }
}

/** Cited and unknown markers as badges (glyph and text), after the scripted reply. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun CitationsCard(view: CitationView) {
    Card(stringResource(R.string.rag_citations)) {
        Text(
            stringResource(R.string.rag_citations_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Section(stringResource(R.string.rag_reply))
        CodeBlock(view.reply)
        val citations = view.citations
        if (citations.cited.isEmpty() && citations.unknown.isEmpty()) {
            Text(stringResource(R.string.rag_citations_none), color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                citations.cited.forEach { MarkerBadge(it, cited = true) }
                citations.unknown.forEach { MarkerBadge(it, cited = false) }
            }
        }
    }
}

@Composable
private fun MarkerBadge(n: Int, cited: Boolean) {
    val status = ILabsTheme.status
    val text = stringResource(if (cited) R.string.rag_badge_cited else R.string.rag_badge_unknown, n)
    Surface(
        color = if (cited) status.okBg else status.warnBg,
        contentColor = if (cited) status.okFg else status.warnFg,
        shape = RoundedCornerShape(50),
        modifier = Modifier.heightIn(min = 32.dp).clearAndSetSemantics { contentDescription = text },
    ) {
        Row(
            Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(if (cited) "✓" else "!", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelLarge)
            Text(text, style = MaterialTheme.typography.labelLarge)
        }
    }
}

/** Recall, precision and reciprocal rank of the labelled question for each of the three modes, as text. */
@Composable
internal fun MetricsCard(run: RagRun, question: String, level: Level?) {
    Card(stringResource(R.string.rag_metrics)) {
        val metrics = run.metrics
        if (metrics == null) {
            Text(stringResource(R.string.rag_metrics_none), color = MaterialTheme.colorScheme.onSurfaceVariant)
            return@Card
        }
        Text(stringResource(R.string.rag_metrics_question, question), style = MaterialTheme.typography.bodyMedium)
        level?.let {
            Text(
                stringResource(R.string.rag_metrics_level, levelLabel(it)),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("", Modifier.weight(1.2f))
            for (title in listOf(R.string.rag_metric_recall, R.string.rag_metric_precision, R.string.rag_metric_rr, R.string.rag_metric_hit)) {
                Text(stringResource(title), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
            }
        }
        metrics.forEach { m ->
            val label = modeLabel(m.mode)
            val recall = formatScore(m.metrics.recallAtK, 3)
            val precision = formatScore(m.metrics.precisionAtK, 3)
            val rr = formatScore(m.metrics.reciprocalRank, 3)
            val hitText = stringResource(if (m.metrics.hit) R.string.rag_hit_yes else R.string.rag_hit_no)
            val spoken = stringResource(R.string.rag_metrics_row_spoken, label, recall, precision, rr, hitText)
            Row(
                Modifier.fillMaxWidth().heightIn(min = 48.dp).clearAndSetSemantics { contentDescription = spoken },
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(label, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1.2f))
                Text(recall, modifier = Modifier.weight(1f))
                Text(precision, modifier = Modifier.weight(1f))
                Text(rr, modifier = Modifier.weight(1f))
                Text("${if (m.metrics.hit) "✓" else "✕"} $hitText", fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            }
        }
    }
}

@Composable
internal fun levelLabel(level: Level): String = when (level) {
    Level.CHUNK -> stringResource(R.string.rag_level_chunk)
    Level.DOC -> stringResource(R.string.rag_level_doc)
}
