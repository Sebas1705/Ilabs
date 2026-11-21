package es.sebas1705.ilabs.guardrails

import es.sebas1705.ilabs.rag.TokenSpan
import es.sebas1705.ilabs.rag.tokenizeSpans

/** The category of an injection signal (also the metric kind of the signal). */
enum class InjectionCategory(val wire: String) {
    OVERRIDE("override"),
    ROLE_HIJACK("role_hijack"),
    PROMPT_LEAK("prompt_leak"),
    DELIMITER("delimiter"),
}

/** One matching entry of the phrase table: its id, category and the code-point span of its first match. */
data class InjectionSignal(val id: String, val category: InjectionCategory, val start: Int, val end: Int)

/** The result of [detectInjection]: the integer [score] from 0 to 100 and the [signals] in table order. */
data class InjectionResult(val score: Int, val signals: List<InjectionSignal>)

/** An entry of the pinned phrase table. */
sealed interface InjectionEntry {
    val id: String
    val category: InjectionCategory
    val weight: Int

    /** A token entry: 2 to 4 anchors (sets of folded tokens) and the largest number of tokens between two anchors. */
    data class Tokens(
        override val id: String,
        override val category: InjectionCategory,
        override val weight: Int,
        val maxGap: Int,
        val anchors: List<List<String>>,
    ) : InjectionEntry {
        internal val anchorSets: List<Set<String>> = anchors.map { it.toSet() }
    }

    /** A delimiter entry: a literal ASCII string matched on the raw text, case-sensitive. */
    data class Delimiter(
        override val id: String,
        override val category: InjectionCategory,
        override val weight: Int,
        val literal: String,
        val lineStart: Boolean,
    ) : InjectionEntry
}

private fun tokens(id: String, category: InjectionCategory, weight: Int, maxGap: Int, vararg anchors: String): InjectionEntry =
    InjectionEntry.Tokens(id, category, weight, maxGap, anchors.map { a -> alternatives(a) })

/** The comma-separated alternatives of an anchor of the table (a hand-written split: no `split(`). */
private fun alternatives(anchor: String): List<String> {
    val out = ArrayList<String>()
    var from = 0
    for (i in 0..anchor.length) {
        if (i == anchor.length || anchor[i] == ',') {
            out += anchor.substring(from, i)
            from = i + 1
        }
    }
    return out
}

private fun delimiter(id: String, weight: Int, literal: String, lineStart: Boolean = false): InjectionEntry =
    InjectionEntry.Delimiter(id, InjectionCategory.DELIMITER, weight, literal, lineStart)

/** The pinned phrase table of `contracts/guardrails/README.md`, in table order (34 entries). */
val INJECTION_TABLE: List<InjectionEntry> = run {
    val o = InjectionCategory.OVERRIDE
    val r = InjectionCategory.ROLE_HIJACK
    val l = InjectionCategory.PROMPT_LEAK
    listOf(
        tokens("en-ignore-previous", o, 50, 3, "ignore,disregard,forget,skip", "previous,prior,earlier,preceding", "instructions,instruction,rules,directions,prompts"),
        tokens("en-ignore-the-above", o, 40, 2, "ignore,disregard,forget,skip", "above"),
        tokens("en-override-rules", o, 40, 2, "override,bypass,circumvent", "rules,restrictions,guidelines,safeguards,filters"),
        tokens("en-do-anything-now", o, 35, 0, "do", "anything", "now"),
        tokens("en-from-now-on", o, 15, 0, "from", "now", "on"),
        tokens("es-ignora-anteriores", o, 50, 3, "ignora,ignore,ignorar,olvida,olvide,olvidar,omite,omitir", "instrucciones,indicaciones,reglas,ordenes", "anteriores,previas,precedentes"),
        tokens("es-olvida-lo-anterior", o, 40, 2, "ignora,ignore,olvida,olvide,omite", "anterior"),
        tokens("es-salta-restricciones", o, 40, 2, "salta,saltate,evita,elude,desactiva,quita", "restricciones,reglas,filtros,normas,limitaciones"),
        tokens("es-cualquier-cosa-ahora", o, 35, 0, "cualquier", "cosa", "ahora"),
        tokens("es-a-partir-de-ahora", o, 15, 0, "a", "partir", "de", "ahora"),
        tokens("en-you-are-now", r, 25, 0, "you", "are", "now"),
        tokens("en-act-as", r, 20, 0, "act", "as"),
        tokens("en-pretend-to-be", r, 30, 0, "pretend", "to,you", "be,are"),
        tokens("en-developer-mode", r, 40, 0, "developer,god,jailbreak,unrestricted", "mode"),
        tokens("en-no-restrictions", r, 25, 1, "without,no", "restrictions,limits,filters,censorship"),
        tokens("es-ahora-eres", r, 25, 0, "ahora", "eres"),
        tokens("es-actua-como", r, 20, 0, "actua,actue,actuar", "como"),
        tokens("es-finge-ser", r, 30, 0, "finge,finja,fingir", "ser,que"),
        tokens("es-modo-desarrollador", r, 40, 0, "modo", "desarrollador,dios,jailbreak,ilimitado"),
        tokens("es-sin-restricciones", r, 25, 1, "sin", "restricciones,limites,filtros,censura"),
        tokens("en-reveal-system-prompt", l, 45, 3, "reveal,show,print,repeat,display,output", "system", "prompt,instructions"),
        tokens("en-what-are-your-instructions", l, 30, 0, "what", "are,were", "your", "instructions,rules"),
        tokens("en-repeat-words-above", l, 40, 2, "repeat,print,output,copy", "words,text,everything", "above"),
        tokens("en-hidden-prompt", l, 30, 1, "hidden,secret,initial,original", "prompt,instructions"),
        tokens("es-revela-prompt-sistema", l, 45, 3, "revela,muestra,muestrame,imprime,repite,dime,ensename", "prompt,instrucciones", "sistema"),
        tokens("es-cuales-son-tus-instrucciones", l, 30, 0, "cuales", "son,eran", "tus", "instrucciones,reglas,indicaciones"),
        tokens("es-repite-texto-anterior", l, 40, 2, "repite,imprime,copia,escribe", "texto,palabras,todo", "anterior,arriba"),
        tokens("es-prompt-oculto", l, 30, 1, "prompt,instrucciones", "oculto,oculta,ocultas,secreto,secretas,originales,iniciales"),
        delimiter("delim-system-colon", 30, "system:", lineStart = true),
        delimiter("delim-sistema-colon", 30, "sistema:", lineStart = true),
        delimiter("delim-hash-system", 25, "### system"),
        delimiter("delim-im-start", 35, "<|im_start|>"),
        delimiter("delim-inst", 30, "[INST]"),
        delimiter("delim-endoftext", 35, "<|endoftext|>"),
    )
}

private fun matchTokens(entry: InjectionEntry.Tokens, tokens: List<TokenSpan>): IntArray? {
    for (i0 in tokens.indices) {
        if (tokens[i0].token !in entry.anchorSets[0]) continue
        var prev = i0
        var complete = true
        for (j in 1 until entry.anchorSets.size) {
            var found = -1
            var t = prev + 1
            val limit = minOf(prev + 1 + entry.maxGap, tokens.size - 1)
            while (t <= limit) {
                if (tokens[t].token in entry.anchorSets[j]) {
                    found = t
                    break
                }
                t++
            }
            if (found < 0) {
                complete = false
                break
            }
            prev = found
        }
        if (complete) return intArrayOf(tokens[i0].start, tokens[prev].end)
    }
    return null
}

private fun matchDelimiter(entry: InjectionEntry.Delimiter, cp: CodePoints): IntArray? {
    val c = cp.cps
    val lit = entry.literal
    var i = 0
    while (i + lit.length <= c.size) {
        var same = true
        for (k in lit.indices) if (c[i + k] != lit[k].code) {
            same = false
            break
        }
        if (same) {
            val atLineStart = i == 0 || c[i - 1] == 0x0A || c[i - 1] == 0x0D
            if (!entry.lineStart || atLineStart) return intArrayOf(i, i + lit.length)
        }
        i++
    }
    return null
}

/**
 * Scores lexical prompt-injection signals with the pinned phrase table: each matching entry counts once (its first
 * match), `score = min(100, sum of weights)`, signals in table order. A signal, not a defense.
 */
fun detectInjection(text: String): InjectionResult {
    val tokens = tokenizeSpans(text)
    val cp = CodePoints(text)
    var score = 0
    val signals = ArrayList<InjectionSignal>()
    for (entry in INJECTION_TABLE) {
        val span = when (entry) {
            is InjectionEntry.Tokens -> matchTokens(entry, tokens)
            is InjectionEntry.Delimiter -> matchDelimiter(entry, cp)
        } ?: continue
        score += entry.weight
        signals += InjectionSignal(entry.id, entry.category, span[0], span[1])
    }
    return InjectionResult(minOf(100, score), signals.toList())
}
