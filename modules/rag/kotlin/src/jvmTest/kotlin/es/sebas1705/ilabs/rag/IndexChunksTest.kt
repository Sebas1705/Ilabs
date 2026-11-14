package es.sebas1705.ilabs.rag

import kotlinx.coroutines.test.runTest
import java.lang.reflect.InvocationTargetException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull

class IndexChunksTest {
    private suspend fun index() = buildIndex(listOf(Document("a", "uno\n\ndos"), Document("b", "tres")), Chunking.Paragraph(4))

    @Test
    fun chunksCannotBeCastToAMutableList() = runTest {
        val idx = index()
        assertFailsWith<ClassCastException> { idx.chunks as MutableList<Chunk> }
        assertNull(idx.chunks as? MutableList<Chunk>)
    }

    /** Java callers see `java.util.List`: every mutator throws and the index keeps its chunks. */
    @Test
    fun javaMutatorsThrowAndTheIndexIsUnchanged() = runTest {
        val idx = index()
        val chunks = idx.chunks
        fun call(name: String, types: Array<Class<*>>, vararg args: Any?) {
            val e = assertFailsWith<InvocationTargetException>(name) { chunks.javaClass.getMethod(name, *types).invoke(chunks, *args) }
            assertIs<UnsupportedOperationException>(e.cause, name)
        }
        call("add", arrayOf(Any::class.java), chunks[0])
        call("remove", arrayOf(Int::class.javaPrimitiveType!!), 0)
        call("set", arrayOf(Int::class.javaPrimitiveType!!, Any::class.java), 0, chunks[1])
        call("clear", arrayOf())
        assertEquals(listOf("a#0", "a#1", "b#0"), idx.chunks.map { it.id })
        assertEquals(listOf("b#0"), search(idx, "tres", Mode.BM25).map { it.chunkId })
    }
}
