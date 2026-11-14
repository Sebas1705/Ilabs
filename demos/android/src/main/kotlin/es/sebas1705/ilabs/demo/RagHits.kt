package es.sebas1705.ilabs.demo

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import es.sebas1705.ilabs.rag.Mode
import java.util.Locale

/** A score with 4 decimals and a dot (Locale.ROOT), the same text as the web twin's toFixed(4). */
internal fun formatScore(value: Double, decimals: Int = 4): String = String.format(Locale.ROOT, "%.${decimals}f", value)

@Composable
internal fun modeLabel(mode: Mode): String = when (mode) {
    Mode.BM25 -> stringResource(R.string.rag_mode_bm25)
    Mode.DENSE -> stringResource(R.string.rag_mode_dense)
    Mode.HYBRID -> stringResource(R.string.rag_mode_hybrid)
}

/** The hit table: header row, then one row per hit with the ranks and scores side by side. */
@Composable
internal fun HitsCard(run: RagRun) {
    Card(stringResource(R.string.rag_hits)) {
        when {
            run.emptyQuery -> Text(stringResource(R.string.rag_hits_empty_query), color = MaterialTheme.colorScheme.onSurfaceVariant)
            run.rows.isEmpty() -> Text(stringResource(R.string.rag_hits_none), color = MaterialTheme.colorScheme.onSurfaceVariant)
            else -> HitTable(run)
        }
    }
}

@Composable
private fun HitTable(run: RagRun) {
    val hybrid = run.mode == Mode.HYBRID
    val maxFused = run.rows.maxOf { it.hit.score }
    val columns = if (hybrid) {
        listOf(stringResource(R.string.rag_col_fused), stringResource(R.string.rag_col_bm25), stringResource(R.string.rag_col_dense))
    } else {
        listOf(stringResource(R.string.rag_col_rank_score, modeLabel(run.mode)))
    }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(
            Modifier.fillMaxWidth().semantics(mergeDescendants = true) { heading() },
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            columns.forEach { title ->
                Text(
                    title,
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
            }
        }
        run.rows.forEach { row ->
            val hit = row.hit
            val spoken = if (hybrid) {
                stringResource(
                    R.string.rag_hit_spoken_hybrid, hit.rank, hit.chunkId, hit.docId, formatScore(hit.score),
                    listEntry(hit.bm25Rank), listEntry(hit.denseRank),
                )
            } else {
                stringResource(R.string.rag_hit_spoken_single, hit.rank, hit.chunkId, hit.docId, modeLabel(run.mode), formatScore(hit.score))
            }
            Column(
                Modifier.fillMaxWidth().heightIn(min = 48.dp).clearAndSetSemantics { contentDescription = spoken },
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(hit.chunkId, fontWeight = FontWeight.SemiBold)
                Text(
                    stringResource(R.string.rag_hit_document, hit.docId),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (hybrid) {
                        Cell(stringResource(R.string.rag_cell_rank, hit.rank), formatScore(hit.score), hit.score, maxFused, Modifier.weight(1f))
                        Cell(
                            hit.bm25Rank?.let { stringResource(R.string.rag_cell_rank, it) } ?: stringResource(R.string.rag_list_absent),
                            null, null, 0.0, Modifier.weight(1f),
                        )
                        Cell(
                            hit.denseRank?.let { stringResource(R.string.rag_cell_rank, it) } ?: stringResource(R.string.rag_list_absent),
                            null, null, 0.0, Modifier.weight(1f),
                        )
                    } else {
                        Cell(stringResource(R.string.rag_cell_rank, hit.rank), formatScore(hit.score), hit.score, maxFused, Modifier.weight(1f))
                    }
                }
            }
        }
    }
}

@Composable
private fun listEntry(rank: Int?): String =
    if (rank == null) stringResource(R.string.rag_list_absent) else stringResource(R.string.rag_cell_rank, rank)

/** One rank and score as text; the bar under it is decorative (the text carries the value for every reader). */
@Composable
private fun Cell(rank: String, score: String?, value: Double?, max: Double, modifier: Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(rank, style = MaterialTheme.typography.bodyMedium)
        if (score != null) Text(score, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (value != null) ScoreBar(value, max)
    }
}

@Composable
private fun ScoreBar(value: Double?, max: Double) {
    val fraction = if (value == null || max <= 0.0) 0f else (value / max).toFloat().coerceIn(0f, 1f)
    Box(
        Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)).background(MaterialTheme.colorScheme.surfaceVariant),
    ) {
        if (fraction > 0f) {
            Box(Modifier.fillMaxWidth(fraction).height(6.dp).background(MaterialTheme.colorScheme.primary))
        }
    }
}

/** The pluralized hit count used by the live status line. */
@Composable
internal fun hitsStatus(count: Int, mode: Mode): String =
    pluralStringResource(R.plurals.rag_status_hits, count, count, modeLabel(mode))
