package es.sebas1705.ilabs.guardrails

import es.sebas1705.ilabs.rag.tokenizeSpans
import es.sebas1705.ilabs.structured.parseStrict
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/** What a firing check does: stop the call, redact the text (PII only) or only record. */
enum class Action(val wire: String) {
    BLOCK("block"),
    REDACT("redact"),
    FLAG("flag"),
}

/** The six check kinds, with their wire names. */
enum class CheckKind(val wire: String) {
    PII("pii"),
    INJECTION("injection"),
    DENY_TERMS("denyTerms"),
    MAX_LENGTH("maxLength"),
    CANARY("canary"),
    CLASSIFIER("classifier"),
}

/** A declarative check. Typed checks are validated with the policy rules when they are used. */
sealed interface Check {
    val kind: CheckKind
    val action: Action

    /** Personal data and secrets; [kinds] null means all kinds. */
    data class Pii(override val action: Action, val kinds: List<PiiKind>? = null) : Check {
        override val kind: CheckKind get() = CheckKind.PII
    }

    /** Fires when the injection score is at least [threshold] (1 to 100). */
    data class Injection(override val action: Action, val threshold: Int) : Check {
        override val kind: CheckKind get() = CheckKind.INJECTION
    }

    /** Fires when a term (a token sequence) occurs. */
    data class DenyTerms(override val action: Action, val terms: List<String>) : Check {
        override val kind: CheckKind get() = CheckKind.DENY_TERMS
    }

    /** Fires when the text has more than [max] code points. */
    data class MaxLength(override val action: Action, val max: Int) : Check {
        override val kind: CheckKind get() = CheckKind.MAX_LENGTH
    }

    /** Fires when the text contains [canary] (output only). */
    data class Canary(override val action: Action, val canary: String) : Check {
        override val kind: CheckKind get() = CheckKind.CANARY
    }

    /** Fires when the classifier flags the text (and, with a [label], the same label). */
    data class Classify(override val action: Action, val label: String? = null) : Check {
        override val kind: CheckKind get() = CheckKind.CLASSIFIER
    }
}

/** The checks run on the input messages and on the model reply. */
data class Policy(val input: List<Check>, val output: List<Check>)

private fun hasTokens(term: String): Boolean = tokenizeSpans(term).isNotEmpty()

private fun distinctKinds(kinds: List<PiiKind>) = kinds.toSet().size == kinds.size

/** Validates a typed check with the policy rules; [allowCanary] is false for the input list of a policy. */
internal fun validateCheck(check: Check, allowCanary: Boolean) {
    if (check.action == Action.REDACT && check !is Check.Pii) invalidPolicy("redact is only allowed on pii checks")
    when (check) {
        is Check.Pii -> {
            val kinds = check.kinds
            if (kinds != null && (kinds.isEmpty() || !distinctKinds(kinds))) invalidPolicy("kinds must be a non-empty list of distinct kinds")
        }
        is Check.Injection -> if (check.threshold !in 1..100) invalidPolicy("threshold must be an integer from 1 to 100")
        is Check.DenyTerms -> {
            if (check.terms.isEmpty()) invalidPolicy("terms must not be empty")
            if (check.terms.any { !hasTokens(it) }) invalidPolicy("every term needs at least one token")
        }
        is Check.MaxLength -> if (check.max < 0) invalidPolicy("max must be at least 0")
        is Check.Canary -> {
            if (!allowCanary) invalidPolicy("a canary check is not allowed in input")
            if (!isValidCanary(check.canary)) invalidPolicy("a canary must be non-empty and contain no whitespace")
        }
        is Check.Classify -> if (check.label != null && check.label.isEmpty()) invalidPolicy("label must not be empty")
    }
}

internal fun validateChecks(checks: List<Check>, allowCanary: Boolean) {
    for (c in checks) validateCheck(c, allowCanary)
}

internal fun validatePolicy(policy: Policy) {
    validateChecks(policy.input, allowCanary = false)
    validateChecks(policy.output, allowCanary = true)
}

internal fun hasClassifierCheck(checks: List<Check>): Boolean = checks.any { it is Check.Classify }

// ---- parsing ---------------------------------------------------------------------------------------------------------

private fun JsonElement.stringOrNull(): String? = (this as? JsonPrimitive)?.takeIf { it !is JsonNull && it.isString }?.content

/** An integer by VALUE within the Int range, or null (not a number, not integral, out of range). */
private fun JsonElement.integerOrNull(): Int? {
    val p = this as? JsonPrimitive ?: return null
    if (p is JsonNull || p.isString) return null
    val d = p.doubleOrNull ?: return null
    if (d.isNaN() || d.isInfinite() || d % 1.0 != 0.0) return null
    if (d < Int.MIN_VALUE.toDouble() || d > Int.MAX_VALUE.toDouble()) return null
    return d.toInt()
}

private val CHECK_KEYS: Map<String, Set<String>> = mapOf(
    "pii" to setOf("kind", "action", "kinds"),
    "injection" to setOf("kind", "action", "threshold"),
    "denyTerms" to setOf("kind", "action", "terms"),
    "maxLength" to setOf("kind", "action", "max"),
    "canary" to setOf("kind", "action", "canary"),
    "classifier" to setOf("kind", "action", "label"),
)

private fun parseCheck(el: JsonElement, allowCanary: Boolean): Check {
    val o = el as? JsonObject ?: invalidPolicy("a check must be an object")
    val kindName = (o["kind"] ?: invalidPolicy("a check needs a kind")).stringOrNull() ?: invalidPolicy("kind must be a string")
    val allowed = CHECK_KEYS[kindName] ?: invalidPolicy("unknown check kind")
    val actionName = (o["action"] ?: invalidPolicy("a check needs an action")).stringOrNull() ?: invalidPolicy("action must be a string")
    val action = Action.entries.firstOrNull { it.wire == actionName } ?: invalidPolicy("unknown action")
    if (action == Action.REDACT && kindName != "pii") invalidPolicy("redact is only allowed on pii checks")
    for (key in o.keys) if (key !in allowed) invalidPolicy("unknown key in a $kindName check")
    for ((_, value) in o) if (value is JsonNull) invalidPolicy("null is not a valid value")
    val check: Check = when (kindName) {
        "pii" -> Check.Pii(action, o["kinds"]?.let { parseKinds(it) })
        "injection" -> Check.Injection(action, (o["threshold"] ?: invalidPolicy("threshold is required")).integerOrNull() ?: invalidPolicy("threshold must be an integer"))
        "denyTerms" -> Check.DenyTerms(action, parseTerms(o["terms"] ?: invalidPolicy("terms is required")))
        "maxLength" -> Check.MaxLength(action, (o["max"] ?: invalidPolicy("max is required")).integerOrNull() ?: invalidPolicy("max must be an integer"))
        "canary" -> Check.Canary(action, (o["canary"] ?: invalidPolicy("canary is required")).stringOrNull() ?: invalidPolicy("canary must be a string"))
        else -> Check.Classify(action, o["label"]?.let { it.stringOrNull() ?: invalidPolicy("label must be a string") })
    }
    validateCheck(check, allowCanary)
    return check
}

private fun parseKinds(el: JsonElement): List<PiiKind> {
    val array = el as? JsonArray ?: invalidPolicy("kinds must be an array")
    return array.map { item ->
        val name = item.stringOrNull() ?: invalidPolicy("kinds must be strings")
        PiiKind.entries.firstOrNull { it.wire == name } ?: invalidPolicy("unknown PII kind name")
    }
}

private fun parseTerms(el: JsonElement): List<String> {
    val array = el as? JsonArray ?: invalidPolicy("terms must be an array")
    return array.map { it.stringOrNull() ?: invalidPolicy("terms must be strings") }
}

private fun parseList(el: JsonElement?, where: String, allowCanary: Boolean): List<Check> {
    val array = el as? JsonArray ?: invalidPolicy("$where must be an array")
    return array.map { parseCheck(it, allowCanary) }
}

/**
 * Builds a typed [Policy] from a parsed JSON value, checking every rule of the contract; any violation is a
 * [GuardrailException] of kind `invalid_policy` whose message starts with `invalid policy: `.
 */
fun parsePolicy(json: JsonElement): Policy {
    val o = json as? JsonObject ?: invalidPolicy("a policy must be an object")
    for (key in o.keys) if (key != "input" && key != "output") invalidPolicy("unknown key in the policy")
    if ("input" !in o) invalidPolicy("input is required")
    if ("output" !in o) invalidPolicy("output is required")
    return Policy(parseList(o["input"], "input", allowCanary = false), parseList(o["output"], "output", allowCanary = true))
}

/** Parses [json] strictly first (anything that is not strict JSON is `invalid_policy`), then as [parsePolicy]. */
fun parsePolicy(json: String): Policy = parsePolicy(parseStrict(json) ?: invalidPolicy("not valid strict JSON"))
