package es.sebas1705.ilabs.vision

import kotlin.math.exp

/** One ranked class: [index] is the model's class id, [label] comes from the spec's labels (or `#<index>`). */
data class ClassEntry(val index: Int, val label: String, val score: Double)

internal const val DEFAULT_TOP_K = 5
internal const val DEFAULT_MIN_SCORE = 0.0

internal fun validateClassifyOptions(topK: Int, minScore: Double) {
    if (topK < 1) invalidOptions("topK must be an integer >= 1")
    if (!(minScore >= 0.0 && minScore <= 1.0)) invalidOptions("minScore must be a number from 0 to 1")
}

/** The label of a class index: `labels[index - labelOffset]` when in range, else `#<index>`. */
internal fun labelFor(index: Int, spec: ModelSpec): String {
    val labels = spec.labels
    if (labels != null) {
        val k = index.toLong() - spec.labelOffset.toLong()
        if (k >= 0L && k < labels.size.toLong()) return labels[k.toInt()]
    }
    return "#$index"
}

/**
 * Reads a classifier's output vector: softmax for logits (numerically stable), the values as given for probabilities,
 * then the [topK] best, dropping scores below [minScore]. Options are validated before the output (`invalid_options`);
 * a bad output is `invalid_output`. [output] is never mutated.
 */
fun postprocessClassification(output: DoubleArray, spec: ModelSpec, topK: Int = DEFAULT_TOP_K, minScore: Double = DEFAULT_MIN_SCORE): List<ClassEntry> {
    validateModelSpec(spec)
    val classifier = requireClassifier(spec)
    validateClassifyOptions(topK, minScore)
    if (output.isEmpty()) invalidOutput("the classifier output must have at least one element")
    for (v in output) if (v.isNaN() || v.isInfinite()) invalidOutput("the classifier output must be finite")
    val count = output.size
    val scores = DoubleArray(count)
    if (classifier.type == ScoreType.PROBABILITIES) {
        for (i in 0 until count) {
            if (output[i] < 0.0) invalidOutput("probabilities must not be negative")
            scores[i] = output[i]
        }
    } else {
        var m = output[0]
        for (i in 1 until count) if (output[i] > m) m = output[i]
        val e = DoubleArray(count)
        for (i in 0 until count) e[i] = exp(output[i] - m)
        var s = 0.0
        for (i in 0 until count) s = s + e[i]
        for (i in 0 until count) scores[i] = e[i] / s
    }
    val order = (0 until count).sortedWith { a, b ->
        val sa = scores[a]
        val sb = scores[b]
        if (sa > sb) -1 else if (sa < sb) 1 else if (a < b) -1 else if (a > b) 1 else 0
    }
    val result = ArrayList<ClassEntry>()
    for (position in 0 until minOf(topK, count)) {
        val index = order[position]
        if (scores[index] < minScore) continue
        result.add(ClassEntry(index, labelFor(index, spec), scores[index]))
    }
    return result
}
