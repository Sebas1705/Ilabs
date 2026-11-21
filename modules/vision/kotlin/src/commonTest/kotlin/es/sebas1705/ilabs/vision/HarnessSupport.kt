package es.sebas1705.ilabs.vision

import es.sebas1705.ilabs.vision.contract.Fixture
import es.sebas1705.ilabs.vision.contract.FixtureOutcome
import es.sebas1705.ilabs.vision.contract.checkOutcome
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** A path into a JSON document: object keys (strings) and array indices (ints). */
internal typealias JsonPath = List<Any>

/** Rebuilds [this] with the node at [path] replaced by `f(node)` (`null` removes it; the root cannot be removed). */
internal fun JsonElement.edit(path: JsonPath, f: (JsonElement) -> JsonElement?): JsonElement {
    if (path.isEmpty()) return f(this) ?: JsonNull
    val head = path[0]
    val rest = path.drop(1)
    return when (this) {
        is JsonObject -> {
            val key = head as String
            val child = this[key] ?: error("no key $key")
            val updated = if (rest.isEmpty()) f(child) else child.edit(rest, f)
            val copy = LinkedHashMap(this)
            if (updated == null) copy.remove(key) else copy[key] = updated
            JsonObject(copy)
        }
        is JsonArray -> {
            val index = head as Int
            val child = this[index]
            val updated = if (rest.isEmpty()) f(child) else child.edit(rest, f)
            val copy = ArrayList(this)
            if (updated == null) copy.removeAt(index) else copy[index] = updated
            JsonArray(copy)
        }
        else -> error("cannot descend into $this")
    }
}

internal fun JsonElement.at(path: JsonPath): JsonElement = path.fold(this) { node, key ->
    when (node) {
        is JsonObject -> node[key as String] ?: error("no key $key")
        is JsonArray -> node[key as Int]
        else -> error("cannot descend into $node")
    }
}

/** `a.b.0.c` as a path: all-digit segments are array indices. */
internal fun pathOf(dotted: String): JsonPath = if (dotted.isEmpty()) emptyList() else dotted.split(".").map { part -> part.toIntOrNull() ?: part }

internal fun parseJson(text: String): JsonElement = Json.parseToJsonElement(text)

/** A mutable handle on a JSON document for the malformed-fixture tests. */
internal class Doc(var root: JsonElement) {
    /** Sets the value at the dotted [path] (the key is created when the parent is an object that lacks it). */
    fun put(path: String, json: String) {
        val p = pathOf(path)
        val value = parseJson(json)
        val key = p.last()
        root = root.edit(p.dropLast(1)) { parent ->
            if (parent is JsonObject) JsonObject(LinkedHashMap(parent).also { it[key as String] = value }) else parent
        }
    }

    fun remove(path: String) {
        root = root.edit(pathOf(path)) { null }
    }
}

internal fun fixtureOf(json: String) = Fixture(parseJson(json))

/** True when [checkOutcome] accepts the run (a fixture that became malformed does not pass). */
internal fun passes(fx: Fixture, outcome: FixtureOutcome): Boolean = try {
    checkOutcome(fx, outcome).isEmpty()
} catch (e: IllegalStateException) {
    false
}

/** The path of every non-container value of a JSON document. */
internal fun leafPaths(node: JsonElement, path: JsonPath = emptyList(), out: MutableList<JsonPath> = mutableListOf()): List<JsonPath> {
    when (node) {
        is JsonArray -> node.forEachIndexed { i, v -> leafPaths(v, path + i, out) }
        is JsonObject -> for ((k, v) in node) leafPaths(v, path + k, out)
        else -> out.add(path)
    }
    return out
}

/** The path of every non-empty array of a JSON document. */
internal fun arrayPaths(node: JsonElement, path: JsonPath = emptyList(), out: MutableList<JsonPath> = mutableListOf()): List<JsonPath> {
    when (node) {
        is JsonArray -> {
            if (node.isNotEmpty()) out.add(path)
            node.forEachIndexed { i, v -> arrayPaths(v, path + i, out) }
        }
        is JsonObject -> for ((k, v) in node) arrayPaths(v, path + k, out)
        else -> Unit
    }
    return out
}

/** At most [max] evenly spread items. */
internal fun <T> sample(items: List<T>, max: Int): List<T> =
    if (items.size <= max) items else List(max) { i -> items[(i.toLong() * (items.size - 1) / (max - 1)).toInt()] }

/** Every object of a fixture that has a closed key set: not the content of a `spec` and not a name-to-tensor map. */
internal fun closedObjects(node: JsonElement, path: JsonPath = emptyList(), out: MutableList<JsonPath> = mutableListOf()): List<JsonPath> {
    when (node) {
        is JsonArray -> node.forEachIndexed { i, v -> closedObjects(v, path + i, out) }
        is JsonObject -> {
            if (path.lastOrNull() != "outputs") out.add(path)
            for ((k, v) in node) {
                if (k == "spec" && path == listOf<Any>("setup")) continue
                closedObjects(v, path + k, out)
            }
        }
        else -> Unit
    }
    return out
}

internal fun JsonPrimitive.isNumberLiteral() = !isString && this !is JsonNull
