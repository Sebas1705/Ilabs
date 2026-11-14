package es.sebas1705.ilabs.rag

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class ChunkTest {
    private fun spans(text: String, chunking: Chunking): List<Pair<Int, Int>> =
        chunkDocument(Document("d", text), chunking).map { it.start to it.end }

    private fun texts(text: String, chunking: Chunking): List<String> =
        chunkDocument(Document("d", text), chunking).map { it.text }

    @Test
    fun fixedWindows() {
        assertEquals(listOf(0 to 4, 4 to 8, 8 to 10), spans("abcdefghij", Chunking.Fixed(4, 0)))
        assertEquals(listOf(0 to 4, 2 to 6, 4 to 8, 6 to 10), spans("abcdefghij", Chunking.Fixed(4, 2)))
        assertEquals(listOf(0 to 6, 2 to 8, 4 to 10), spans("abcdefghij", Chunking.Fixed(6, 4)))
        assertEquals(listOf(0 to 4, 4 to 8), spans("abcdefgh", Chunking.Fixed(4, 0)))
        assertEquals(listOf(0 to 2), spans("ab", Chunking.Fixed(5, 4)))
        assertEquals(listOf(0 to 3), spans("abc", Chunking.Fixed(Int.MAX_VALUE, 0)))
        assertEquals(emptyList(), spans("", Chunking.Fixed(4, 0)))
    }

    @Test
    fun offsetsAreCodePoints() {
        val chunks = chunkDocument(Document("d", "😀😀😀"), Chunking.Fixed(2, 0))
        assertEquals(listOf(0 to 2, 2 to 3), chunks.map { it.start to it.end })
        assertEquals(listOf("😀😀", "😀"), chunks.map { it.text })
        assertEquals(listOf("a", "\uD800", "b", "\uDC00", "𐀀"), texts("a\uD800b\uDC00𐀀", Chunking.Fixed(1, 0)))
    }

    @Test
    fun idsAndIndexes() {
        val chunks = chunkDocument(Document("notes#2024", "abcdef"), Chunking.Fixed(4, 0))
        assertEquals(
            listOf(Chunk("notes#2024#0", "notes#2024", 0, "abcd", 0, 4), Chunk("notes#2024#1", "notes#2024", 1, "ef", 4, 6)),
            chunks,
        )
    }

    @Test
    fun paragraphPackingAndSeparators() {
        val p = Chunking.Paragraph(100)
        assertEquals(listOf(0 to 8), spans("ab\r\n\r\ncd", p))
        assertEquals(listOf(0 to 2, 6 to 8), spans("ab\r\n\r\ncd", Chunking.Paragraph(3)))
        // a single break inside the text is not a separator; at the start or the end it is
        assertEquals(listOf(1 to 6), spans("\nab\ncd\r\n", p))
        // breaks separated by a space are separate runs of one
        assertEquals(listOf(0 to 7), spans("ab\n \ncd\n", p))
        assertEquals(listOf(0 to 4, 4 to 7), spans("ab\n \ncd\n", Chunking.Paragraph(4)))
        // a lone CR is ordinary; CRLF is matched greedily from the left
        assertEquals(listOf(0 to 4), spans("a\r\rb", p))
        assertEquals(listOf(0 to 3, 7 to 9), spans("ab\r\r\n\r\ncd", Chunking.Paragraph(3)))
        // \n\r\n is two line breaks: a separator
        assertEquals(listOf(0 to 2, 5 to 7), spans("ab\n\r\ncd", Chunking.Paragraph(2)))
    }

    @Test
    fun whitespaceOnlyParagraphsAreDroppedBeforePacking() {
        assertEquals(listOf(0 to 2, 9 to 11), spans("ab\n\n \t\r\n\ncd", Chunking.Paragraph(2)))
        // NBSP is not whitespace here
        assertEquals(listOf(0 to 1, 3 to 4, 6 to 7), spans("a\n\n \n\nb", Chunking.Paragraph(1)))
        // a dropped paragraph never extends a pack, but stays inside the slice of a pack around it
        assertEquals(listOf(0 to 10), spans("ab\n\n  \n\ncd", Chunking.Paragraph(10)))
        assertEquals(listOf(0 to 2, 8 to 10), spans("ab\n\n  \n\ncd", Chunking.Paragraph(9)))
        assertEquals(emptyList(), spans(" \n\n\t\n\n", p100))
        assertEquals(emptyList(), spans("", p100))
    }

    private val p100 = Chunking.Paragraph(100)

    @Test
    fun oversizedParagraphFlushesAndItsPiecesStandAlone() {
        assertEquals(
            listOf(0 to 2, 4 to 7, 7 to 10, 10 to 11, 13 to 15),
            spans("ab\n\nabcdefg\n\ncd", Chunking.Paragraph(3)),
        )
        // `ij` + separator + `Yo.` would fit in 8, but a piece is never packed
        assertEquals(listOf(0 to 8, 8 to 10, 12 to 15), spans("abcdefghij\n\nYo.", Chunking.Paragraph(8)))
        // exact maxSize packs
        assertEquals(listOf(0 to 7), spans("ab\n\nc\nd", Chunking.Paragraph(7)))
    }

    @Test
    fun chunkingOptionsAreValidated() {
        val doc = Document("d", "abc")
        for (bad in listOf(Chunking.Fixed(0, 0), Chunking.Fixed(4, 4), Chunking.Fixed(4, 5), Chunking.Fixed(4, -1), Chunking.Paragraph(0), Chunking.Paragraph(-3))) {
            val e = assertFailsWith<RagException>("$bad") { chunkDocument(doc, bad) }
            assertEquals(RagErrorKind.INVALID_OPTIONS, e.kind)
            assertEquals(null, e.required)
        }
        val e = assertFailsWith<RagException> { chunkDocument(Document("", "abc"), Chunking.Fixed(4, 0)) }
        assertEquals(RagErrorKind.INVALID_OPTIONS, e.kind)
    }
}
