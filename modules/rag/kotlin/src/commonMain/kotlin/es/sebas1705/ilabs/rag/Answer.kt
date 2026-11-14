package es.sebas1705.ilabs.rag

import es.sebas1705.ilabs.providers.CompletionRequest
import es.sebas1705.ilabs.providers.Message
import es.sebas1705.ilabs.providers.Provider
import es.sebas1705.ilabs.providers.Role

/**
 * Validates every option first (those of [search] and [maxTokens]), then [search], [composeContext] and exactly ONE
 * `provider.complete` with `[system = composed content, user = query]` and nothing else. Every `RagException` happens
 * before the call. Nothing is caught: a `ProviderException` (and any other exception, cancellation included)
 * propagates unchanged after the one call; there are no retries.
 */
suspend fun answerWithSources(
    provider: Provider,
    index: RagIndex,
    query: String,
    mode: Mode,
    topK: Int = 5,
    candidates: Int? = null,
    maxTokens: Int,
): Answer {
    validateSearchOptions(mode, topK, candidates)
    if (maxTokens < 1) invalidOptions()
    val hits = search(index, query, mode, topK, candidates)
    val composed = composeContext(hits, index, maxTokens)
    val reply = provider.complete(
        CompletionRequest(messages = listOf(Message(Role.SYSTEM, composed.message.content), Message(Role.USER, query))),
    )
    return Answer(reply.text, composed.sources, extractCitations(reply.text, composed.sources), hits)
}
