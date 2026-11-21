package es.sebas1705.ilabs.vision

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertSame
import kotlin.test.assertTrue

class PipelineTest {
    private val classifierSpec = spec(input = """{"width":1,"height":1,"layout":"nhwc","channels":"rgb","mode":"stretch","resample":"nearest","dtype":"float"}""")
    private val image = img(1, 1, 7, 8, 9)
    private val okOutputs = mapOf("output" to tensor(listOf(2), 1.0, 2.0))

    /** A model recording how many clock reads happened when it ran. */
    private class Probe(private val clock: CountingClock, private val body: suspend (Tensor) -> Map<String, Tensor>) : VisionModel {
        var calls = 0
        var readsAtRun = -1

        override suspend fun run(input: Tensor): Map<String, Tensor> {
            calls++
            readsAtRun = clock.reads
            return body(input)
        }
    }

    @Test
    fun aSuccessfulClassifyReadsTheClockFourTimesAndRunsTheModelOnce() = runTest {
        val clock = CountingClock(100.0, 102.5, 130.0, 131.25)
        val probe = Probe(clock) { okOutputs }
        val result = classify(probe, image, classifierSpec, topK = 1, clock = clock)
        assertEquals(1, probe.calls)
        assertEquals(2, probe.readsAtRun)
        assertEquals(4, clock.reads)
        assertEquals(2.5, result.timing.preprocessMs)
        assertEquals(27.5, result.timing.inferenceMs)
        assertEquals(1.25, result.timing.postprocessMs)
        assertEquals(listOf(1), result.entries.map { it.index })
    }

    @Test
    fun aSuccessfulDetectReadsTheClockFourTimesAndReturnsTheGeometry() = runTest {
        val clock = CountingClock(10.0, 8.0, 20.0, 21.0)
        val s = detectorSpec(input = """{"width":2,"height":2,"layout":"nhwc","channels":"rgb","mode":"stretch","resample":"nearest","dtype":"float"}""", output = """{"format":"ssd","boxOrder":"xyxy","coordinates":"pixels"}""")
        val outputs = mapOf("boxes" to tensor(listOf(1, 4), 0.0, 0.0, 1.0, 1.0), "classes" to tensor(listOf(1), 0.0), "scores" to tensor(listOf(1), 0.9))
        val result = detect(Probe(clock) { outputs }, img(2, 2, *IntArray(12)), s, clock = clock)
        assertEquals(4, clock.reads)
        assertEquals(-2.0, result.timing.preprocessMs)
        assertEquals(12.0, result.timing.inferenceMs)
        assertEquals(1.0, result.timing.postprocessMs)
        assertEquals(1.0, result.geometry.scaleX)
        assertEquals(1, result.detections.size)
    }

    @Test
    fun validationFailuresReadNoClockAndCallNoModel() = runTest {
        val clock = CountingClock(0.0, 1.0, 2.0, 3.0)
        val probe = Probe(clock) { okOutputs }
        assertKindSuspending(VisionErrorKind.INVALID_OPTIONS) { classify(probe, Image(0, 1, ByteArray(0)), classifierSpec, clock = clock) }
        assertKindSuspending(VisionErrorKind.INVALID_OPTIONS) { classify(probe, image, classifierSpec, topK = 0, clock = clock) }
        assertKindSuspending(VisionErrorKind.INVALID_OPTIONS) { classify(probe, image, classifierSpec, minScore = 1.5, clock = clock) }
        assertKindSuspending(VisionErrorKind.INVALID_OPTIONS) { classify(probe, image, detectorSpec(), clock = clock) }
        assertKindSuspending(VisionErrorKind.INVALID_OPTIONS) { detect(probe, image, classifierSpec, clock = clock) }
        assertKindSuspending(VisionErrorKind.INVALID_OPTIONS) { detect(probe, image, detectorSpec(), options = DetectionOptions(iouThreshold = 3.0, nms = false), clock = clock) }
        assertKindSuspending(VisionErrorKind.INVALID_OPTIONS) { detect(probe, image, detectorSpec(), options = DetectionOptions(maxDetections = 0), clock = clock) }
        assertKindSuspending(VisionErrorKind.INVALID_OPTIONS) { detect(probe, image, detectorSpec(), options = DetectionOptions(scoreThreshold = -1.0), clock = clock) }
        assertEquals(0, probe.calls)
        assertEquals(0, clock.reads)
    }

    @Test
    fun anInvalidSpecIsReportedBeforeAnyWork() = runTest {
        val clock = CountingClock(0.0, 1.0, 2.0, 3.0)
        val probe = Probe(clock) { okOutputs }
        val broken = classifierSpec.copy(input = classifierSpec.input.copy(width = 0))
        assertKindSuspending(VisionErrorKind.INVALID_SPEC) { classify(probe, image, broken, clock = clock) }
        assertEquals(0, probe.calls)
        assertEquals(0, clock.reads)
    }

    @Test
    fun anInvalidOutputLeavesThreeReadsAndNoResult() = runTest {
        for (bad in listOf(
            emptyMap(),
            mapOf("output" to tensor(listOf(2, 3), 1.0, 2.0, 3.0, 4.0, 5.0, 6.0)),
            mapOf("output" to Tensor(listOf(3), doubleArrayOf(1.0, 2.0))),
            mapOf("output" to tensor(listOf(2), 1.0, Double.NaN)),
            mapOf("output" to Tensor(listOf(0), doubleArrayOf())),
            mapOf("output" to Tensor(listOf(-1), doubleArrayOf())),
            mapOf("output" to tensor(listOf(1, 1, 2), 1.0, 2.0)),
            mapOf("other" to tensor(listOf(2), 1.0, 2.0)),
        )) {
            val clock = CountingClock(0.0, 1.0, 2.0, 3.0)
            val probe = Probe(clock) { bad }
            assertKindSuspending(VisionErrorKind.INVALID_OUTPUT) { classify(probe, image, classifierSpec, clock = clock) }
            assertEquals(1, probe.calls)
            assertEquals(3, clock.reads)
        }
        // [1, C] is squeezed and [C] accepted
        val clock = CountingClock(0.0, 1.0, 2.0, 3.0)
        assertEquals(2, classify(Probe(clock) { mapOf("output" to tensor(listOf(1, 2), 1.0, 2.0)) }, image, classifierSpec, clock = clock).entries.size)
    }

    @Test
    fun aModelErrorPropagatesUnchangedAfterTwoReads() = runTest {
        val boom = IllegalStateException("boom")
        val clock = CountingClock(0.0, 1.0, 2.0, 3.0)
        val probe = Probe(clock) { throw boom }
        val thrown = assertFailsWith<IllegalStateException> { classify(probe, image, classifierSpec, clock = clock) }
        assertSame(boom, thrown)
        assertEquals(2, clock.reads)
        assertEquals(1, probe.calls)
    }

    @Test
    fun cancellationAndErrorsFromTheModelOrTheClockPropagate() = runTest {
        val cancel = CancellationException("cancelled")
        assertSame(cancel, assertFailsWith<CancellationException> { classify({ throw cancel }, image, classifierSpec, clock = CountingClock(0.0, 1.0, 2.0, 3.0)) })
        val error = AssertionError("fatal")
        assertSame(error, assertFailsWith<AssertionError> { classify({ throw error }, image, classifierSpec, clock = CountingClock(0.0, 1.0, 2.0, 3.0)) })
        val oom = OutOfMemoryError("oom")
        assertSame(oom, assertFailsWith<OutOfMemoryError> { detect({ throw oom }, image, detectorSpec(), clock = CountingClock(0.0, 1.0, 2.0, 3.0)) })
        val clockFailure = RuntimeException("clock")
        val failing = Clock { throw clockFailure }
        assertSame(clockFailure, assertFailsWith<RuntimeException> { classify({ okOutputs }, image, classifierSpec, clock = failing) })
        val cancelClock = CancellationException("clock cancelled")
        assertSame(cancelClock, assertFailsWith<CancellationException> { classify({ okOutputs }, image, classifierSpec, clock = Clock { throw cancelClock }) })
    }

    @Test
    fun aClockThatFailsLateStopsTheSequence() = runTest {
        var reads = 0
        val clock = Clock {
            reads++
            if (reads == 4) throw IllegalStateException("late")
            reads.toDouble()
        }
        assertFailsWith<IllegalStateException> { classify({ okOutputs }, image, classifierSpec, clock = clock) }
        assertEquals(4, reads)
    }

    @Test
    fun scriptedModelIgnoresItsInputRecordsCallsAndReturnsTheSameTensors() = runTest {
        val outputs = mapOf("output" to tensor(listOf(2), 1.0, 2.0))
        val model = scriptedModel(outputs)
        val a = tensor(listOf(1), 1.0)
        val b = tensor(listOf(2), 5.0, 6.0)
        val r1 = model.run(a)
        val r2 = model.run(b)
        assertEquals(outputs, r1)
        assertSame(r1["output"], r2["output"])
        assertEquals(2, model.calls.size)
        assertSame(a, model.calls[0])
        assertSame(b, model.calls[1])
        val expected = toTensor(image, classifierSpec).tensor
        val scripted = scriptedModel(okOutputs)
        classify(scripted, image, classifierSpec, clock = CountingClock(0.0, 1.0, 2.0, 3.0))
        assertEquals(expected.shape, scripted.calls.single().shape)
        assertContentEquals(expected.data, scripted.calls.single().data)
    }

    @Test
    fun theDefaultClockIsARealOneAndTimingsAreNotNegative() = runTest {
        val result = classify(scriptedModel(okOutputs), image, classifierSpec)
        assertTrue(result.timing.preprocessMs >= 0.0 && result.timing.inferenceMs >= 0.0 && result.timing.postprocessMs >= 0.0)
    }

    @Test
    fun theImageIsNotMutatedByAPipelineRun() = runTest {
        val before = image.data.copyOf()
        classify(scriptedModel(okOutputs), image, classifierSpec, clock = CountingClock(0.0, 1.0, 2.0, 3.0))
        assertContentEquals(before, image.data)
    }
}
