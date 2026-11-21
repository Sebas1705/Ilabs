package es.sebas1705.ilabs.demo

import android.graphics.Bitmap
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import es.sebas1705.ilabs.vision.Detection
import es.sebas1705.ilabs.vision.ImageSize
import kotlin.math.max
import kotlin.math.roundToInt

/** Box colours per class, each dark enough for white text (at least 4.5:1); the text of the chip names the class too. */
private val ClassPalette = listOf(
    Color(0xFFC62828), Color(0xFF1565C0), Color(0xFF2E7D32), Color(0xFF6A1B9A),
    Color(0xFFAD5200), Color(0xFF006978), Color(0xFFAD1457), Color(0xFF5D4037),
)

internal fun classColor(classIndex: Int): Color = ClassPalette[Math.floorMod(classIndex, ClassPalette.size)]

internal fun PreviewImage.toImageBitmap(): ImageBitmap = Bitmap.createBitmap(argb, width, height, Bitmap.Config.ARGB_8888).asImageBitmap()

private val PreviewMaxSize = 280.dp
private val DetectionMaxHeight = 420.dp

/** The model input exactly as the model sees it, scaled up without smoothing. [description] is its text alternative. */
@Composable
internal fun PreviewCanvas(preview: PreviewImage, description: String, modifier: Modifier = Modifier) {
    val bitmap = remember(preview) { preview.toImageBitmap() }
    BoxWithConstraints(modifier.fillMaxWidth(), contentAlignment = Alignment.CenterStart) {
        val width: Dp = if (maxWidth < PreviewMaxSize) maxWidth else PreviewMaxSize
        val height = width * preview.height / preview.width
        Canvas(Modifier.width(width).height(height).semantics { contentDescription = description }) {
            drawImage(bitmap, dstSize = IntSize(size.width.roundToInt(), size.height.roundToInt()), filterQuality = FilterQuality.None)
        }
    }
}

/**
 * The original image with a rectangle and a text chip per detection (class and score, so colour is never the only cue).
 * Boxes are in pixels of [source]; [chips] holds the chip text of each detection. [description] lists them for screen readers.
 */
@Composable
internal fun DetectionCanvas(image: ImageBitmap?, source: ImageSize, detections: List<Detection>, chips: List<String>, description: String) {
    val measurer = rememberTextMeasurer()
    val chipStyle = MaterialTheme.typography.labelSmall.copy(color = Color.White, fontWeight = FontWeight.Bold)
    val placeholder = MaterialTheme.colorScheme.surfaceVariant
    BoxWithConstraints(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterStart) {
        val ratio = source.width.toFloat() / source.height.toFloat()
        val width: Dp = if (maxWidth / ratio > DetectionMaxHeight) DetectionMaxHeight * ratio else maxWidth
        val height = width / ratio
        Canvas(Modifier.width(width).height(height).semantics { contentDescription = description }) {
            drawRect(if (image == null) placeholder else Color.White)
            if (image != null) drawImage(image, dstSize = IntSize(size.width.roundToInt(), size.height.roundToInt()))
            val sx = size.width / source.width
            val sy = size.height / source.height
            val stroke = 2.dp.toPx()
            val pad = 4.dp.toPx()
            detections.forEachIndexed { i, d ->
                val color = classColor(d.classIndex)
                val topLeft = Offset(d.box.x1.toFloat() * sx, d.box.y1.toFloat() * sy)
                val boxSize = Size((d.box.x2 - d.box.x1).toFloat() * sx, (d.box.y2 - d.box.y1).toFloat() * sy)
                drawRect(color, topLeft, boxSize, style = Stroke(stroke))
                val layout = measurer.measure(chips.getOrElse(i) { d.label }, chipStyle, maxLines = 1)
                val chipW = layout.size.width + 2 * pad
                val chipH = layout.size.height + pad
                val x = topLeft.x.coerceIn(0f, max(0f, size.width - chipW))
                val y = if (topLeft.y - chipH >= 0f) topLeft.y - chipH else topLeft.y
                drawRect(color, Offset(x, y), Size(chipW, chipH))
                drawRect(Color.White, Offset(x, y), Size(chipW, chipH), style = Stroke(1.dp.toPx()))
                drawText(layout, topLeft = Offset(x + pad, y + pad / 2))
            }
        }
    }
}
