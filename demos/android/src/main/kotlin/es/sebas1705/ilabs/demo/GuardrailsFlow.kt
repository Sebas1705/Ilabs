package es.sebas1705.ilabs.demo

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import es.sebas1705.ilabs.guardrails.CheckFinding
import es.sebas1705.ilabs.guardrails.GuardedResult
import es.sebas1705.ilabs.guardrails.GuardedStatus
import es.sebas1705.ilabs.providers.Message
import es.sebas1705.ilabs.providers.Role

@Composable
internal fun GuardedSection(state: GuardrailsUiState, actions: GuardrailsActions) {
    SectionBlock(stringResource(R.string.guard_section_guarded)) {
        SamplePicker(listOf(null to state.guardedNames), state.guardedSelected.orEmpty(), actions.onGuarded)
        val view = state.guarded
        when {
            state.guardedRunError != null -> GuardErrorNote(stringResource(R.string.guard_run_error, state.guardedRunError), LiveRegionMode.Assertive)
            view == null -> GuardRunning()
            else -> GuardStatus(guardedStatus(view))
        }
        Text(
            stringResource(R.string.guard_guarded_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (view != null) GuardedCards(view)
    }
}

@Composable
private fun guardRoleLabel(role: Role): String = when (role) {
    Role.SYSTEM -> stringResource(R.string.guard_role_system)
    Role.USER -> stringResource(R.string.guard_role_user)
    Role.ASSISTANT -> stringResource(R.string.guard_role_assistant)
}

/** The coarse status line: allowed with its call count, blocked with the reason, or the failure. */
@Composable
private fun guardedStatus(view: GuardedView): String {
    val result = view.run.result
    val error = view.run.error
    return when {
        error != null -> stringResource(R.string.guard_status_failed, guardErrorLabel(error.kind))
        result == null -> ""
        result.status == GuardedStatus.OK -> pluralStringResource(R.plurals.guard_status_ok_calls, result.calls, result.calls)
        result.status == GuardedStatus.BLOCKED_INPUT -> stringResource(R.string.guard_status_line_blocked_input)
        else -> stringResource(R.string.guard_status_line_blocked_output)
    }
}

@Composable
private fun GuardedCards(view: GuardedView) {
    val result = view.run.result
    // A provider failure has no result, but the harness recorded what the provider was asked.
    val sent = result?.sent ?: view.run.requests.firstOrNull()?.messages
    val calls = result?.calls ?: view.run.requests.size

    Card(stringResource(R.string.guard_guarded_request)) { MessageList(view.request) }

    Card(stringResource(R.string.guard_guarded_sent)) {
        if (sent == null) {
            Text(stringResource(R.string.guard_guarded_sent_none), color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            Text(
                stringResource(R.string.guard_guarded_sent_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            MessageList(sent)
        }
    }

    // The reply exists only when a call was made and answered; otherwise there is nothing to say about it.
    view.reply?.let { reply ->
        Card(stringResource(R.string.guard_guarded_reply)) { CodeBlock(reply.ifEmpty { stringResource(R.string.guard_empty_text) }) }
    }

    Card(stringResource(R.string.guard_guarded_input)) {
        if (result == null) {
            Text(stringResource(R.string.guard_guarded_input_none), color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            val checked = view.request.filter { it.role != Role.SYSTEM }
            result.input.forEachIndexed { index, findings ->
                val role = checked.getOrNull(index)?.role?.let { guardRoleLabel(it) }.orEmpty()
                Section(stringResource(R.string.guard_guarded_message, index + 1, role))
                if (findings.isEmpty()) {
                    Text(stringResource(R.string.guard_checks_none), color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                CheckFindingsList(findings)
            }
        }
    }

    Card(stringResource(R.string.guard_guarded_output)) {
        val output: List<CheckFinding>? = result?.output
        if (output == null) {
            Text(stringResource(R.string.guard_guarded_output_none), color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            if (output.isEmpty()) Text(stringResource(R.string.guard_checks_none), color = MaterialTheme.colorScheme.onSurfaceVariant)
            CheckFindingsList(output)
        }
    }

    Card(stringResource(R.string.guard_guarded_result)) { ResultBlock(view, result, calls) }
}

/** Role and content of each message, one spoken sentence per row; the content is selectable. */
@Composable
private fun MessageList(messages: List<Message>) {
    messages.forEach { message ->
        val role = guardRoleLabel(message.role)
        val spoken = stringResource(R.string.guard_message_row, role, message.content)
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(role, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
            Column(Modifier.clearAndSetSemantics { contentDescription = spoken }) {
                CodeBlock(message.content.ifEmpty { stringResource(R.string.guard_empty_text) })
            }
        }
    }
}

@Composable
private fun ResultBlock(view: GuardedView, result: GuardedResult?, calls: Int) {
    val error = view.run.error
    if (error != null || result == null) {
        val kind = error?.kind.orEmpty()
        GuardBadge(stringResource(R.string.guard_label_code, guardErrorLabel(kind), kind), GuardTone.ERROR)
        Text(stringResource(R.string.guard_guarded_failed), color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(callsText(calls), fontWeight = FontWeight.SemiBold)
        return
    }
    val ok = result.status == GuardedStatus.OK
    val label = when (result.status) {
        GuardedStatus.OK -> stringResource(R.string.guard_status_ok)
        GuardedStatus.BLOCKED_INPUT -> stringResource(R.string.guard_status_blocked_input)
        GuardedStatus.BLOCKED_OUTPUT -> stringResource(R.string.guard_status_blocked_output)
    }
    GuardBadge(stringResource(R.string.guard_label_code, label, result.status.wire), if (ok) GuardTone.OK else GuardTone.ERROR)
    Text(callsText(result.calls), fontWeight = FontWeight.SemiBold, modifier = Modifier.heightIn(min = 24.dp))
    if (ok) {
        Section(stringResource(R.string.guard_guarded_final))
        CodeBlock(result.text.orEmpty().ifEmpty { stringResource(R.string.guard_empty_text) })
    } else {
        Text(stringResource(R.string.guard_guarded_blocked), color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    MappingTable(stringResource(R.string.guard_guarded_mapping), result.mapping)
    MappingTable(stringResource(R.string.guard_guarded_output_mapping), result.outputMapping)
}
