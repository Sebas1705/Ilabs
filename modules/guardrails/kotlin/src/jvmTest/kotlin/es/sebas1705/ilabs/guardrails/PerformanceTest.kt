package es.sebas1705.ilabs.guardrails

import kotlin.test.Test
import kotlin.test.assertTrue

/** The scan is linear in the text: adversarial separator-heavy inputs finish quickly (generous bounds). */
class PerformanceTest {
    private fun timed(name: String, limitMs: Long, text: String) {
        val start = System.nanoTime()
        detectPii(text)
        val ms = (System.nanoTime() - start) / 1_000_000
        println("timing $name: $ms ms")
        assertTrue(ms < limitMs, "$name took $ms ms (limit $limitMs ms)")
    }

    @Test fun digitPairs() = timed("1 x8000", 1000, "1 ".repeat(8000))

    @Test fun letterDigitPairs() = timed("A1 x8000", 1000, "A1 ".repeat(8000))

    @Test fun secretPrefixes() = timed("sk- x8000", 1000, "sk-".repeat(8000))

    @Test fun cardGroups() = timed("4111 x100000", 1000, "4111 ".repeat(100_000))

    @Test fun dashedDigits() = timed("1- x8000", 1000, "1-".repeat(8000))

    @Test fun plusPhones() = timed("+1 x8000", 1000, "+1 ".repeat(8000))

    @Test
    fun oneMegabyteOfProseWithPii() {
        val sentence = "Escríbeme a ana@example.com o llama al 612 345 678; mi IBAN es ES28 0000 0000 0012 3456 7890 y la tarjeta 4111 1111 1111 1111. "
        val filler = "El rápido zorro marrón salta sobre el perro perezoso mientras la biblioteca abre a las nueve de la mañana. "
        val sb = StringBuilder()
        while (sb.length < 1_000_000) sb.append(filler).append(filler).append(sentence)
        timed("1 MB prose", 2000, sb.toString())
    }
}
