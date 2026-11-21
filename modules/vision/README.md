# vision

Get an image into a model and the model's answer back out, deterministically and measurably, with identical behavior in Kotlin and TypeScript. `vision` turns a raw RGB image into the tensor a classifier or detector expects (resize, centre crop or letterbox, channel order, normalization, layout), reads the model's raw output back (softmax and top-k for classifiers; box decoding, score filtering and non-maximum suppression for detectors), maps boxes back onto the original image, and measures the result (top-k accuracy, IoU, average precision). The model itself sits behind a one-method interface, so a real runtime (LiteRT, ONNX Runtime Web) and a scripted model are interchangeable. The behavior is pinned by the shared fixtures in [`contracts/vision`](../../contracts/vision/README.md); read that README for the exact rules, the clarifications and the fixture format.

It has no dependency on a model runtime and none on [`providers`](../providers/README.md) or any other iLabs module in its library code (Kotlin uses [`structured`](../structured/README.md) only for strict JSON parsing). It composes with the rest the same way the other modules do: a vision model can be the target of an [`evals`](../evals/README.md) suite (see [Composing](#composing-with-evals)).

## Honest limits first

**This is a readable, teaching-scale tour of the plumbing around a model, not an inference engine and not a guarantee about any model.** Read these before you trust anything it says.

- **The models make mistakes.** The small mobile models the demos use (MobileNetV2 and EfficientNet-Lite0 for classification, SSD-MobileNet v1 for detection) misclassify and miss objects: a crowd has no single ImageNet class, a very wide panorama shrinks its objects to a few pixels, a low-contrast photo gets a confident wrong label. The contract pins the preprocessing and the decoding, **not the accuracy of any model**. A high score means the model was confident, not that it was right.
- **No inference.** `vision` never runs a model. `VisionModel.run` is yours: floating-point results differ between LiteRT, ONNX Runtime and devices, so inference cannot be pinned by a fixture. In the fixtures a model is scripted.
- **No image decoding.** An image is `{ width, height, data }` with 8-bit RGB bytes. Decoding a JPEG or PNG, EXIF orientation, colour profiles and alpha (the caller composites it) are the platform's job.
- **One resize, no anti-aliasing.** `nearest` and four-neighbour `bilinear` with half-pixel centres. A big downscale (a 4000 px photo to 224 px) samples sparsely and aliases, unlike the area or anti-aliased filters of PIL, OpenCV `INTER_AREA` or TensorFlow's `antialias`. A model trained behind a different filter can score slightly differently here; downscale in two steps or in the platform before calling `vision` if that matters to you.
- **Doubles, not `float32`.** Everything is computed in 64-bit doubles so both languages agree to the bit, and the tensor you hand to a runtime holds doubles that you convert to `float32`. A framework that preprocesses in `float32` can differ from this in the last bit of a value; that is far below a model's own noise but it is not "bit-identical to the framework".
- **Two detector layouts only.** The decoders read the `ssd` layout (`boxes`, `classes`, `scores`, optional `count`: what TensorFlow's `TFLite_Detection_PostProcess` and the TF Object Detection API produce) and a `rows` layout (one row per candidate: box, optional objectness, class scores: YOLO-style heads). Another head needs its own small adapter that rewrites its outputs into one of the two.
- **One uniform geometry per image.** Unmapping assumes one scale per axis plus an offset: no flips, rotations or per-axis warps.
- **A model whose class ids do not start where its labels start needs `labelOffset`.** The two SSD-MobileNet builds in the demos number COCO classes differently (1-based in the ONNX one, 0-based in the TFLite one) and use different cards because of it.
- **Not covered:** training, segmentation, OCR, camera streams, GPU delegates, quantization tooling. Images are at most 16,384 pixels per side.

## The pipeline

```
 image (RGB bytes)
    |  preprocessGeometry      scale, offset and new size for THIS image and THIS spec
    v
 toTensor ------------------>  { tensor, geometry }
    |   resize | centre crop | letterbox  ->  channel order  ->  normalize  ->  layout
    v
 VisionModel.run(tensor)       YOUR runtime (LiteRT, ONNX Runtime Web, a script): not in the contract
    |   named output tensors
    v
 postprocessClassification     softmax, top-k, labels
 postprocessDetections         decode, threshold, swap, NMS, sort, cut, unmapBox
    |
    v
 results in the ORIGINAL image's pixels   -->   iou, nms, topKAccuracy, averagePrecision, meanAveragePrecision
```

`classify` and `detect` run the middle of this around a model with exactly one `run` call and time the three phases. Every step is also a function of its own, so you can run the preprocessing for a model the library never sees.

## Images

`{ width, height, data }`: `data` holds `width * height * 3` bytes, row-major, interleaved `R G B`, top row first. Pixel `(x, y)` starts at byte `(y * width + x) * 3`. Both sides are integers from 1 to 16,384 and the length must match, otherwise `invalid_options`. Inputs are never mutated.

## Resize

`resize(image, width, height, method)` with `"nearest"` or `"bilinear"`. Both use the **half-pixel-centre** convention: destination pixel `x` has its centre at `x + 0.5`, which maps proportionally to the source as `sx = (x + 0.5) * srcW / dstW - 0.5`.

- **`nearest`** takes the source pixel `floor(sx + 0.5)` (halfway rounds up), clamped to the image. Shrinking a `6x1` line to `4x1`, `sx = 1.5 x + 0.25` gives the source indices `0, 2, 3, 5`: the red, blue, yellow and magenta pixels of the line in the [TypeScript example](#typescript).
- **`bilinear`** mixes the four neighbours with weights from the fractional part of `sx` and `sy`; the border pixel is reused where a neighbour falls outside. The same `6x1` line to `4x1`: for `x = 1`, `sx = 1.75`, so the pixel is `0.25` of source pixel 1 (green) plus `0.75` of pixel 2 (blue): `(0, 64, 191)`, because `255 * 0.25 = 63.75` rounds to 64 and `255 * 0.75 = 191.25` to 191. A `4x4` image shrunk to `2x2` lands exactly between four pixels, so each output pixel is the plain average of a 2x2 block: the red values `10 20 / 12 18` become `(10 + 20 + 12 + 18) / 4 = 15`.

The result is rounded to a byte (`floor(v + 0.5)`, never a library `round`) **before** normalization. The exact operation order is part of the contract, because two languages only agree to the bit if they evaluate the same expression in the same order.

## The three preprocessing modes

`ModelSpec.input.mode` decides how the image meets the model's `width x height`. `preprocessGeometry(srcW, srcH, spec)` returns the *geometry* `{ scaleX, scaleY, offsetX, offsetY, newWidth, newHeight }`; a model-input coordinate `u` maps back to the source as `(u - offset) / scale`. `scaleX` and `scaleY` are the **actual** ratios of the integer-sized result, not the nominal scale, so they can differ slightly from each other.

| mode | what happens | geometry (source `6x1`, model `4x4`) |
|---|---|---|
| `stretch` | the image is resized straight to the model size; the aspect ratio is not kept | `scaleX` 2/3, `scaleY` 4, offset 0 |
| `centerCrop` | scale so the image **covers** the target, then cut the centred window | see below |
| `letterbox` | scale so the image **fits** inside the target, pad the rest with `padValue` (default 114) | see below |

**Letterbox, worked** (source `6x1` into a `4x4` input): `rx = 4/6`, `ry = 4`, `scale = min = 2/3`; `newW = roundHalfUp(6 * 2/3) = 4`, `newH = max(1, roundHalfUp(1 * 2/3)) = 1`; `padX = intdiv(4 - 4, 2) = 0`, `padY = intdiv(4 - 1, 2) = 1` (the larger half of an odd difference goes to the bottom); `scaleX = 4/6`, `scaleY = 1/1 = 1`, `offsetX = 0`, `offsetY = 1`. The canvas has the padding value in row 0 and rows 2 and 3 and the line in row 1.

**Unmapping, worked.** A model box `(0, 1, 4, 2)` covering the content row maps back to `((0 - 0) / (2/3), (1 - 1) / 1, (4 - 0) / (2/3), (2 - 1) / 1) = (0, 0, 6, 1)`: the whole line. A box `(0, 0, 4, 1)` lies in the padding: it maps to `y` from `-1` to `0`, which clamps to an empty box, and `unmapBox` returns `null` (the detection pipeline drops it). Results are clamped to the source image. Another case, a detector in letterbox mode on a `200x100` photo with a `100x100` input: `scale = 0.5`, `newWidth 100`, `newHeight 50`, `offsetY 25` (see the [detection snippet](#typescript)).

**Centre crop, worked** (source `8x4`, model `5x5`): `scale = max(5/8, 5/4) = 1.25`; the scaled image is `10x5`, so `cropX = intdiv(10 - 5, 2) = 2` and `cropY = 0`; `offsetX = -2`. A model box `(2, 1, 4, 3)` maps back to `((2 + 2) / 1.25, 1 / 1.25, (4 + 2) / 1.25, 3 / 1.25) = (3.2, 0.8, 4.8, 2.4)`. The window is cut from the **whole image resized**, not from a cropped source: `toTensor` computes only the pixels it needs, so a huge crop never allocates the scaled image.

## Normalization and layout

After the canvas is built (and the channels swapped when `channels` is `"bgr"`, padding included), each byte `v` at output channel position `c` becomes

```
value = ((v * scale) - mean[c]) / std[c]        scale default 1, mean default [0, 0, 0], std default [1, 1, 1]
```

with `mean` and `std` indexed by the **output** channel position, after the swap. Note the default `scale` is 1, not `1/255`: a model that expects `0..1` needs `"scale": 0.00392156862745098`. The padding is a raw byte written before normalization, so it is normalized like any pixel. Example: the pixel `(10, 20, 30)` with `channels: "bgr"`, `scale 0.5`, `mean [1, 2, 3]`, `std [2, 2, 2]` becomes `(30, 20, 10)`, then `(15, 10, 5)`, then `(14, 8, 2)`, then `(7, 4, 1)`.

`dtype: "uint8"` keeps the bytes (the swap and the layout still apply); `scale`, `mean` and `std` are rejected with it. The layout is `nhwc` (`[1, H, W, 3]`, element `((y * W) + x) * 3 + c`) or `nchw` (`[1, 3, H, W]`, element `(c * H + y) * W + x`).

## Classification output

`postprocessClassification(output, spec, { topK, minScore })` reads the classifier vector (after the batch dimension is removed):

- `"probabilities"`: used exactly as given (not renormalized); a negative value is invalid.
- `"logits"`: the numerically stable softmax: subtract the maximum, `exp`, sum in index order, divide. For `[2, 1, 0.1]`: the maximum is 2, `e = [1, 0.36787944117144233, 0.14956861922263506]`, `s = 1.5174480603940774`, scores `0.659, 0.2424, 0.0986` (`0.6590011388859679`, ...). Large logits (`[1000, 999, 998, -1000]`) cannot overflow.
- Order by descending score; **ties by ascending index**. Keep the first `topK` (default 5), then drop entries below `minScore` (default 0; a score equal to it stays).
- The label of class `index` is `labels[index - labelOffset]` when that is inside `labels`, otherwise `#<index>`. The ONNX SSD-MobileNet outputs COCO category ids (person is 1) while `labels` starts at 0 for id 1, so its card says `"labelOffset": 1`.

An empty vector, a non-finite value or a bad option is an error, never a result.

## Detection output

`postprocessDetections(outputs, spec, geometry, source, options)` takes **named** tensors (`{ shape, data }`; extra tensors are ignored), the geometry of that image and the original image size, and returns detections `{ box, classIndex, label, score }` **in the pixels of the original image**. A leading batch dimension of size 1 is squeezed.

- **`ssd`.** The model already post-processed its output. Tensors `boxes` (`[n, 4]`), `classes` and `scores` (`[n]`), optional `count`. With a `count`, only the first `floor(count)` rows are examined (rows beyond it may hold anything). `boxOrder` is `"yxyx"` (default, `[ymin, xmin, ymax, xmax]`) or `"xyxy"`; `coordinates` is `"normalized"` (default: fractions of the **model input** size) or `"pixels"`. Example: a `300x200` input and the normalized `yxyx` box `[0.1, 0.2, 0.5, 0.6]` is `(x1 60, y1 20, x2 180, y2 100)` in input pixels.
- **`rows`.** One tensor `rows`, one candidate per row (or per column with `transposed`): four box values, an optional objectness, then one score per class. `boxFormat` is `"xywh"` (centre and size, default) or `"xyxy"`. `scoreActivation` `"sigmoid"` applies the logistic function to every score (and to the objectness); with `objectness`, every class score is multiplied by it. A row's detection is its best class (the lowest index on a tie). Example: on a `200x100` input the row `[100, 50, 80, 40, 0.1, 0.8]` is a box centred at `(100, 50)` that is `80x40`: `(60, 30, 140, 70)`, best class 1 at `0.8`.

**The detection order**, after a decoder produced its candidates:

1. keep `score >= scoreThreshold` (default 0.3, inclusive);
2. swap coordinates per axis if a box came out reversed (`x2 < x1` or `y2 < y1`);
3. if `nms` is on (default **on for `rows`, off for `ssd`**, because SSD heads already suppress), class-aware NMS at `iouThreshold` (default 0.5);
4. sort by descending score (ties by row order) and keep the first `maxDetections` (default 100);
5. `unmapBox` each one into the original image and **drop the ones that end up with no area** (so fewer than `maxDetections` can come back).

Every class id is checked against the labels on every examined row **before** any filtering, so changing an option never changes whether an output is valid. A non-finite number anywhere in a decoder's arithmetic is an error: no NaN ever reaches the ordering.

## NMS and IoU

`iou(a, b)` is `intersection / union` for `{ x1, y1, x2, y2 }` boxes taken as given. Boxes that only touch on an edge have intersection 0; a zero union gives 0. Two `10x10` boxes where one is the top half of the other: intersection `10 * 5 = 50`, union `100 + 50 - 50 = 100`, IoU `0.5`.

`nms(detections, iouThreshold)` is greedy and **class-aware** (boxes of different classes never interact): per class, go through the boxes by descending score (ties by input position) and drop every later box whose IoU with a kept one is **strictly greater** than the threshold; a dropped box never suppresses another. The survivors come back in input order. Worked, at threshold 0.5: in class 0, `(0,0,10,10)` at 0.9 and `(0,0,10,5)` at 0.8 have IoU exactly 0.5, which is **not** greater than 0.5, so both stay; in class 1, `(0,0,10,10)` at 0.9 and `(0,0,10,6)` at 0.8 have IoU 0.6, so the second goes. The two identical boxes of different classes never see each other. A threshold of 1 keeps even identical boxes; a threshold of 0 suppresses any overlap.

## Metrics

- **`topKAccuracy(predictions, truths, k)`**: the share of samples whose true class is among the first `k` of their ranked predictions (0 for no samples).
- **`averagePrecision(detections, truths, { iouThreshold })`** per class that has truths, in ascending class order. Detections are taken by descending score; one is a true positive when its best same-image, same-class truth has `IoU >= iouThreshold` and is not already taken, otherwise a false positive (a duplicate is a false positive and there is no fallback to a second-best truth). Then precision and recall after each detection, the **precision envelope** (the best precision at any recall from there on), and the area under it over recall (all-point interpolation, not 11-point).
- **`meanAveragePrecision`**: the mean of the per-class APs over classes that have truths (a class with truths and no detections counts as 0).

Worked (the fixture `ap-envelope`): three truths, five detections in score order false, true, false, true, true. Precisions after each: `0, 1/2, 1/3, 1/2, 3/5`; recalls `0, 1/3, 1/3, 2/3, 1`. From the right, the envelope is `3/5` everywhere, so `AP = (1/3 + 0 + 1/3 + 1/3) * 3/5 = 0.6`. Without the envelope it would be `0.5333...`.

## ModelSpec

A model card is plain JSON; `parseModelSpec` validates it strictly (unknown keys are rejected) and every operation re-validates a hand-built spec.

```jsonc
{
  "input": {
    "width": 224, "height": 224,                          // required, 1..16384
    "layout": "nchw",                                     // "nhwc" | "nchw"
    "channels": "rgb",                                    // "rgb" | "bgr"
    "mode": "centerCrop",                                 // "stretch" | "centerCrop" | "letterbox"
    "resample": "bilinear",                               // "nearest" | "bilinear"
    "dtype": "float",                                     // "float" | "uint8"
    "padValue": 114, "scale": 1, "mean": [0, 0, 0], "std": [1, 1, 1]   // optional (the defaults shown)
  },
  "output": { "type": "logits" },                         // a classifier: "logits" | "probabilities"
  // or a detector: { "format": "ssd", "boxOrder": "yxyx", "coordinates": "normalized" }
  //            or: { "format": "rows", "boxFormat": "xywh", "transposed": false, "objectness": false, "scoreActivation": "none" }
  "labels": ["tench", "goldfish"],                        // optional
  "labelOffset": 0                                        // optional, default 0
}
```

The card of the ONNX MobileNetV2 used by the demos is `width 224`, `height 224`, `nchw`, `rgb`, `centerCrop`, `bilinear`, `float`, `scale 0.00392156862745098`, `mean [0.485, 0.456, 0.406]`, `std [0.229, 0.224, 0.225]` and a `logits` output (see [`demos/vision-assets/models.json`](../../demos/vision-assets/models.json)). A failing card throws `VisionError(invalid_spec)` with a message that starts with `invalid model spec: ` and names the first violated rule, for example `invalid model spec: input.width must be an integer from 1 to 16384`. The rules are checked in a pinned order, so two languages report the same one.

## Errors

`VisionError` (TypeScript, with a `kind` string) and `VisionException` (Kotlin, with a `kind` enum whose `wire` is the same string) carry one of three kinds:

- `invalid_spec`: a model card that breaks a rule (message `invalid model spec: <reason>`, the one message pinned verbatim).
- `invalid_options`: an image, size, option, threshold or spec of the wrong kind for the operation (a detector spec given to `classify`), including a JSON `null` where a value is expected (`null` is a bad value, never "absent").
- `invalid_output`: a model output that is wrong: a missing tensor, a shape that does not match the data, an empty or non-finite vector, a negative probability, a class id outside the labels.

Options are validated before outputs, and `classify`/`detect` validate everything **before** the first clock read or model call. Errors thrown by the model or the clock are **not** `VisionError`s and propagate unchanged (`CancellationException` included in Kotlin). The wording of `invalid_options` and `invalid_output` messages is not pinned and differs slightly between languages (`invalid_options: topK must be an integer of at least 1` in TypeScript, `invalid options: ...` in Kotlin).

## Classify and detect: the pipeline

`classify(model, image, spec, options)` and `detect(model, image, spec, options)` do the whole job: validate, `toTensor`, **one** `model.run`, then read the output. They read an injectable clock exactly four times (before preprocessing, after it, after the model call, after postprocessing) and return the three phases as `timing` (`preprocessMs`, `inferenceMs`, `postprocessMs`); the clock is real by default. `detect` also returns the `geometry`. `scriptedModel(outputs)` is a model that ignores its input values, records every call and returns the same tensors each time: the stand-in for tests, demos and the fixtures. The model's output for a classifier is the tensor named `output` (shape `[C]` or `[1, C]`); for a detector the tensors named in [Detection output](#detection-output).

## TypeScript

The package is `@ilabs/vision` (a pnpm workspace package, `modules/vision/ts`). A tiny image through `toTensor` and a classifier output through `postprocessClassification`:

```ts
import { parseModelSpec, postprocessClassification, toTensor, type Image } from "@ilabs/vision";

// A model card: 4x4 input, letterbox, nearest, pixels mapped from 0..255 to -1..1.
const spec = parseModelSpec({
  input: {
    width: 4, height: 4, layout: "nhwc", channels: "rgb", mode: "letterbox", resample: "nearest", dtype: "float",
    mean: [127.5, 127.5, 127.5], std: [127.5, 127.5, 127.5],
  },
  output: { type: "logits" },
  labels: ["red", "green", "blue"],
});

// A 6x1 image: red, green, blue, yellow, cyan, magenta.
const image: Image = {
  width: 6,
  height: 1,
  data: Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0, 0, 255, 255, 255, 0, 255]),
};

const { tensor, geometry } = toTensor(image, spec);
console.log(JSON.stringify(geometry));
console.log(JSON.stringify(tensor.shape));
for (let y = 0; y < 4; y++) console.log(y, tensor.data.slice(y * 12, y * 12 + 6).map((v) => v.toFixed(2)).join(" "));

// What a classifier would say about it: raw logits in, labelled top-k out.
console.log(JSON.stringify(postprocessClassification([2, 1, 0.1], spec, { topK: 2 })));
```

```
{"scaleX":0.6666666666666666,"scaleY":1,"offsetX":0,"offsetY":1,"newWidth":4,"newHeight":1}
[1,4,4,3]
0 -0.11 -0.11 -0.11 -0.11 -0.11 -0.11
1 1.00 -1.00 -1.00 -1.00 -1.00 1.00
2 -0.11 -0.11 -0.11 -0.11 -0.11 -0.11
3 -0.11 -0.11 -0.11 -0.11 -0.11 -0.11
[{"index":0,"label":"red","score":0.6590011388859679},{"index":1,"label":"green","score":0.24243297070471392}]
```

Rows 0, 2 and 3 are the padding byte 114 normalized (`(114 - 127.5) / 127.5 = -0.11`); row 1 holds red `(1, -1, -1)` and then blue `(-1, -1, 1)`: the nearest-neighbour picks `0, 2, 3, 5` of the line.

A detector output through `postprocessDetections` with `unmapBox`:

```ts
import { parseModelSpec, postprocessDetections, preprocessGeometry, unmapBox } from "@ilabs/vision";

// An SSD-style detector with a 100x100 letterboxed input, boxes as [x1, y1, x2, y2] in input pixels.
const spec = parseModelSpec({
  input: { width: 100, height: 100, layout: "nhwc", channels: "rgb", mode: "letterbox", resample: "bilinear", dtype: "uint8" },
  output: { format: "ssd", boxOrder: "xyxy", coordinates: "pixels" },
  labels: ["cat", "dog"],
});

// The photo was 200x100: it was scaled by 0.5 and centred vertically (25 rows of padding above and below).
const source = { width: 200, height: 100 };
const geometry = preprocessGeometry(source.width, source.height, spec);
console.log(JSON.stringify(geometry));

// The model's raw output: three candidate boxes in input pixels.
const outputs = {
  boxes: { shape: [3, 4], data: [20, 35, 60, 75, 10, 0, 50, 20, 10, 10, 50, 45] },
  classes: { shape: [3], data: [0, 1, 1] },
  scores: { shape: [3], data: [0.9, 0.8, 0.7] },
};

for (const d of postprocessDetections(outputs, spec, geometry, source)) {
  console.log(d.label, d.score, JSON.stringify(d.box));
}
// The second candidate (score 0.8) lies entirely in the top padding: it has no area in the photo and is dropped.

// The same mapping by hand, for the first box:
console.log(JSON.stringify(unmapBox({ x1: 20, y1: 35, x2: 60, y2: 75 }, geometry, source.width, source.height)));
```

```
{"scaleX":0.5,"scaleY":0.5,"offsetX":0,"offsetY":25,"newWidth":100,"newHeight":50}
cat 0.9 {"x1":40,"y1":20,"x2":120,"y2":100}
dog 0.7 {"x1":20,"y1":0,"x2":100,"y2":40}
{"x1":40,"y1":20,"x2":120,"y2":100}
```

`classify` and `detect` with a scripted model and a fixed clock (the classifier's `bgr` and `scale` show up in the tensor the model received: `200 * 0.5 = 100`; `detect` runs NMS here because the option says so, and the second box overlaps the first with an IoU far above 0.5):

```ts
import { classify, detect, parseModelSpec, scriptedModel, type Clock } from "@ilabs/vision";

// A fixed clock makes the timings reproducible: 0, 2, 12 and 13 ms.
function fixedClock(times: number[]): Clock {
  let i = 0;
  return { nowMs: () => times[i++]! };
}

const image = { width: 2, height: 2, data: new Uint8Array(12).fill(200) };

// Classification: the scripted model stands in for a real one and records what it receives.
const classifier = parseModelSpec({
  input: { width: 2, height: 2, layout: "nchw", channels: "bgr", mode: "stretch", resample: "bilinear", dtype: "float", scale: 0.5 },
  output: { type: "probabilities" },
  labels: ["a", "b", "c"],
});
const model = scriptedModel({ output: { shape: [1, 3], data: [0.2, 0.7, 0.1] } });
const result = await classify(model, image, classifier, { topK: 2, clock: fixedClock([0, 2, 12, 13]) });
console.log(JSON.stringify(result.entries));
console.log(JSON.stringify(result.timing));
console.log(model.calls.length, JSON.stringify(model.calls[0]!.shape), model.calls[0]!.data[0]);

// Detection: boxes in input pixels, a `count` tensor, options for the postprocessing only.
const detector = parseModelSpec({
  input: { width: 100, height: 100, layout: "nhwc", channels: "rgb", mode: "stretch", resample: "nearest", dtype: "uint8" },
  output: { format: "ssd", boxOrder: "xyxy", coordinates: "pixels" },
});
const out = await detect(
  scriptedModel({
    boxes: { shape: [1, 2, 4], data: [10, 10, 60, 60, 12, 12, 62, 62] },
    classes: { shape: [1, 2], data: [3, 3] },
    scores: { shape: [1, 2], data: [0.9, 0.8] },
    count: { shape: [1], data: [2] },
  }),
  { width: 100, height: 100, data: new Uint8Array(100 * 100 * 3) },
  detector,
  { nms: true, iouThreshold: 0.5 },
);
console.log(JSON.stringify(out.detections));
console.log(JSON.stringify(out.geometry));
```

```
[{"index":1,"label":"b","score":0.7},{"index":0,"label":"a","score":0.2}]
{"preprocessMs":2,"inferenceMs":10,"postprocessMs":1}
1 [1,3,2,2] 100
[{"box":{"x1":10,"y1":10,"x2":60,"y2":60},"classIndex":3,"label":"#3","score":0.9}]
{"scaleX":1,"scaleY":1,"offsetX":0,"offsetY":0,"newWidth":100,"newHeight":100}
```

The metrics (the `ap-envelope` example of [Metrics](#metrics) and the NMS example of [NMS and IoU](#nms-and-iou)):

```ts
import { averagePrecision, iou, meanAveragePrecision, nms, topKAccuracy, type Detection } from "@ilabs/vision";

// IoU: the second box is the top half of the first: intersection 10 x 5 = 50, union 100 + 50 - 50 = 100.
console.log(iou({ x1: 0, y1: 0, x2: 10, y2: 10 }, { x1: 0, y1: 0, x2: 10, y2: 5 }));
console.log(iou({ x1: 0, y1: 0, x2: 10, y2: 10 }, { x1: 10, y1: 0, x2: 20, y2: 10 })); // touching edges

// NMS is class-aware and the comparison is strict: IoU 0.5 against a threshold of 0.5 does not suppress,
// IoU 0.6 does.
const det = (x2: number, y2: number, classIndex: number, score: number): Detection => ({
  box: { x1: 0, y1: 0, x2, y2 },
  classIndex,
  label: `class${classIndex}`,
  score,
});
const kept = nms([det(10, 10, 0, 0.9), det(10, 5, 0, 0.8), det(10, 10, 1, 0.9), det(10, 6, 1, 0.8)], 0.5);
console.log(kept.map((d) => `${d.label}@${d.score}`).join(" "));

// Top-k accuracy: the truth is within the first k predictions of the sample.
console.log(topKAccuracy([[0, 1, 2], [1, 0, 2], [2, 1, 0], [3, 2, 1]], [0, 0, 0, 3], 2));

// Average precision: three truths, five detections ranked by score: FP, TP, FP, TP, TP.
const box = { x1: 0, y1: 0, x2: 10, y2: 10 };
const truths = ["a", "b", "c"].map((image) => ({ image, classIndex: 0, box }));
const detections = [
  { image: "z", classIndex: 0, score: 0.9, box }, // no truth in image z: false positive
  { image: "a", classIndex: 0, score: 0.8, box },
  { image: "z", classIndex: 0, score: 0.7, box }, // false positive
  { image: "b", classIndex: 0, score: 0.6, box },
  { image: "c", classIndex: 0, score: 0.5, box },
];
console.log(JSON.stringify(averagePrecision(detections, truths, { iouThreshold: 0.5 })));
console.log(JSON.stringify(meanAveragePrecision(detections, truths, { iouThreshold: 0.5 })));
```

```
0.5
0
class0@0.9 class0@0.8 class1@0.9
0.75
{"byClass":[{"classIndex":0,"ap":0.6}]}
{"map":0.6,"byClass":[{"classIndex":0,"ap":0.6}]}
```

## Kotlin

The Gradle project is `:modules:vision-kotlin` (Android and JVM), package `es.sebas1705.ilabs.vision`. The same examples. `parseModelSpec` takes a `JsonElement` or a string (parsed strictly first); a hand-built `ModelSpec` of typed enums works too and is validated when used. Options are named parameters in `classify`/`postprocessClassification` and a `DetectionOptions` in `detect`/`postprocessDetections` (its `nms` is a `Boolean?`: `null` means the per-layout default). Tensors hold `DoubleArray`s and images `ByteArray`s (read as unsigned).

```kotlin
import es.sebas1705.ilabs.vision.*
import kotlin.math.round

fun preprocess() {
    // A model card: 4x4 input, letterbox, nearest, pixels mapped from 0..255 to -1..1.
    val spec = parseModelSpec(
        """
        {
          "input": {
            "width": 4, "height": 4, "layout": "nhwc", "channels": "rgb", "mode": "letterbox", "resample": "nearest", "dtype": "float",
            "mean": [127.5, 127.5, 127.5], "std": [127.5, 127.5, 127.5]
          },
          "output": { "type": "logits" },
          "labels": ["red", "green", "blue"]
        }
        """,
    )

    // A 6x1 image: red, green, blue, yellow, cyan, magenta.
    val bytes = intArrayOf(255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0, 0, 255, 255, 255, 0, 255)
    val image = Image(6, 1, ByteArray(bytes.size) { bytes[it].toByte() })

    val prepared = toTensor(image, spec)
    println(prepared.geometry)
    println(prepared.tensor.shape)
    for (y in 0 until 4) {
        println("$y " + (0 until 6).joinToString(" ") { (round(prepared.tensor.data[y * 12 + it] * 100) / 100).toString() })
    }

    // What a classifier would say about it: raw logits in, labelled top-k out.
    println(postprocessClassification(doubleArrayOf(2.0, 1.0, 0.1), spec, topK = 2))
}
```

```
Geometry(scaleX=0.6666666666666666, scaleY=1.0, offsetX=0.0, offsetY=1.0, newWidth=4, newHeight=1)
[1, 4, 4, 3]
0 -0.11 -0.11 -0.11 -0.11 -0.11 -0.11
1 1.0 -1.0 -1.0 -1.0 -1.0 1.0
2 -0.11 -0.11 -0.11 -0.11 -0.11 -0.11
3 -0.11 -0.11 -0.11 -0.11 -0.11 -0.11
[ClassEntry(index=0, label=red, score=0.6590011388859679), ClassEntry(index=1, label=green, score=0.24243297070471392)]
```

```kotlin
import es.sebas1705.ilabs.vision.*

fun detections() {
    // An SSD-style detector with a 100x100 letterboxed input, boxes as [x1, y1, x2, y2] in input pixels.
    val spec = parseModelSpec(
        """
        {
          "input": { "width": 100, "height": 100, "layout": "nhwc", "channels": "rgb", "mode": "letterbox", "resample": "bilinear", "dtype": "uint8" },
          "output": { "format": "ssd", "boxOrder": "xyxy", "coordinates": "pixels" },
          "labels": ["cat", "dog"]
        }
        """,
    )

    // The photo was 200x100: it was scaled by 0.5 and centred vertically (25 rows of padding above and below).
    val source = ImageSize(200, 100)
    val geometry = preprocessGeometry(source.width, source.height, spec)
    println(geometry)

    // The model's raw output: three candidate boxes in input pixels.
    val outputs = mapOf(
        "boxes" to Tensor(listOf(3, 4), doubleArrayOf(20.0, 35.0, 60.0, 75.0, 10.0, 0.0, 50.0, 20.0, 10.0, 10.0, 50.0, 45.0)),
        "classes" to Tensor(listOf(3), doubleArrayOf(0.0, 1.0, 1.0)),
        "scores" to Tensor(listOf(3), doubleArrayOf(0.9, 0.8, 0.7)),
    )

    for (d in postprocessDetections(outputs, spec, geometry, source)) {
        println("${d.label} ${d.score} ${d.box}")
    }
    // The second candidate (score 0.8) lies entirely in the top padding: it has no area in the photo and is dropped.

    // The same mapping by hand, for the first box:
    println(unmapBox(Box(20.0, 35.0, 60.0, 75.0), geometry, source.width, source.height))
}
```

```
Geometry(scaleX=0.5, scaleY=0.5, offsetX=0.0, offsetY=25.0, newWidth=100, newHeight=50)
cat 0.9 Box(x1=40.0, y1=20.0, x2=120.0, y2=100.0)
dog 0.7 Box(x1=20.0, y1=0.0, x2=100.0, y2=40.0)
Box(x1=40.0, y1=20.0, x2=120.0, y2=100.0)
```

```kotlin
import es.sebas1705.ilabs.vision.*

suspend fun pipeline() {
    // A fixed clock makes the timings reproducible: 0, 2, 12 and 13 ms.
    val reads = ArrayDeque(listOf(0.0, 2.0, 12.0, 13.0))
    val clock = Clock { reads.removeFirst() }

    val image = Image(2, 2, ByteArray(12) { 200.toByte() })

    // Classification: the scripted model stands in for a real one and records what it receives.
    val classifier = parseModelSpec(
        """
        {
          "input": { "width": 2, "height": 2, "layout": "nchw", "channels": "bgr", "mode": "stretch", "resample": "bilinear", "dtype": "float", "scale": 0.5 },
          "output": { "type": "probabilities" },
          "labels": ["a", "b", "c"]
        }
        """,
    )
    val model = scriptedModel(mapOf("output" to Tensor(listOf(1, 3), doubleArrayOf(0.2, 0.7, 0.1))))
    val result = classify(model, image, classifier, topK = 2, clock = clock)
    println(result.entries)
    println(result.timing)
    println("${model.calls.size} ${model.calls[0].shape} ${model.calls[0].data[0]}")

    // Detection: boxes in input pixels, a `count` tensor, options for the postprocessing only.
    val detector = parseModelSpec(
        """
        {
          "input": { "width": 100, "height": 100, "layout": "nhwc", "channels": "rgb", "mode": "stretch", "resample": "nearest", "dtype": "uint8" },
          "output": { "format": "ssd", "boxOrder": "xyxy", "coordinates": "pixels" }
        }
        """,
    )
    val out = detect(
        scriptedModel(
            mapOf(
                "boxes" to Tensor(listOf(1, 2, 4), doubleArrayOf(10.0, 10.0, 60.0, 60.0, 12.0, 12.0, 62.0, 62.0)),
                "classes" to Tensor(listOf(1, 2), doubleArrayOf(3.0, 3.0)),
                "scores" to Tensor(listOf(1, 2), doubleArrayOf(0.9, 0.8)),
                "count" to Tensor(listOf(1), doubleArrayOf(2.0)),
            ),
        ),
        Image(100, 100, ByteArray(100 * 100 * 3)),
        detector,
        DetectionOptions(nms = true, iouThreshold = 0.5),
    )
    println(out.detections)
    println(out.geometry)
}
```

```
[ClassEntry(index=1, label=b, score=0.7), ClassEntry(index=0, label=a, score=0.2)]
Timing(preprocessMs=2.0, inferenceMs=10.0, postprocessMs=1.0)
1 [1, 3, 2, 2] 100.0
[Detection(box=Box(x1=10.0, y1=10.0, x2=60.0, y2=60.0), classIndex=3, label=#3, score=0.9)]
Geometry(scaleX=1.0, scaleY=1.0, offsetX=0.0, offsetY=0.0, newWidth=100, newHeight=100)
```

```kotlin
import es.sebas1705.ilabs.vision.*

fun metrics() {
    // IoU: the second box is the top half of the first: intersection 10 x 5 = 50, union 100 + 50 - 50 = 100.
    println(iou(Box(0.0, 0.0, 10.0, 10.0), Box(0.0, 0.0, 10.0, 5.0)))
    println(iou(Box(0.0, 0.0, 10.0, 10.0), Box(10.0, 0.0, 20.0, 10.0))) // touching edges

    // NMS is class-aware and the comparison is strict: IoU 0.5 against a threshold of 0.5 does not suppress,
    // IoU 0.6 does.
    fun det(x2: Double, y2: Double, classIndex: Int, score: Double) = Detection(Box(0.0, 0.0, x2, y2), classIndex, "class$classIndex", score)
    val kept = nms(listOf(det(10.0, 10.0, 0, 0.9), det(10.0, 5.0, 0, 0.8), det(10.0, 10.0, 1, 0.9), det(10.0, 6.0, 1, 0.8)), 0.5)
    println(kept.joinToString(" ") { "${it.label}@${it.score}" })

    // Top-k accuracy: the truth is within the first k predictions of the sample.
    println(topKAccuracy(listOf(listOf(0, 1, 2), listOf(1, 0, 2), listOf(2, 1, 0), listOf(3, 2, 1)), listOf(0, 0, 0, 3), 2))

    // Average precision: three truths, five detections ranked by score: FP, TP, FP, TP, TP.
    val box = Box(0.0, 0.0, 10.0, 10.0)
    val truths = listOf("a", "b", "c").map { Truth(it, 0, box) }
    val detections = listOf(
        ScoredDetection("z", 0, 0.9, box), // no truth in image z: false positive
        ScoredDetection("a", 0, 0.8, box),
        ScoredDetection("z", 0, 0.7, box), // false positive
        ScoredDetection("b", 0, 0.6, box),
        ScoredDetection("c", 0, 0.5, box),
    )
    println(averagePrecision(detections, truths, 0.5))
    println(meanAveragePrecision(detections, truths, 0.5))
}
```

```
0.5
0.0
class0@0.9 class0@0.8 class1@0.9
0.75
ApResult(byClass=[ClassAp(classIndex=0, ap=0.6)])
MapResult(map=0.6, byClass=[ClassAp(classIndex=0, ap=0.6)])
```

Differences between the two surfaces are small: options are an object in TypeScript and parameters in Kotlin; TypeScript enums are string unions and Kotlin's are enums (`ResizeMode.LETTERBOX`); `parseModelSpec` takes a parsed value in TypeScript and a `JsonElement` or string in Kotlin; `VisionError` versus `VisionException`; `Tensor.data` is `number[]` versus `DoubleArray`; the error wording of `invalid_options` and `invalid_output` differs (the `invalid model spec:` prefix does not). The behavior is the same, and the same fixtures check it.

## Plugging in a model

`VisionModel` is the one seam: it receives the input tensor and returns the **named** output tensors.

```ts
interface VisionModel { run(input: Tensor): Promise<Record<string, Tensor>> }   // Tensor = { shape: number[]; data: number[] }
```

```kotlin
fun interface VisionModel { suspend fun run(input: Tensor): Map<String, Tensor> }   // Tensor(shape: List<Int>, data: DoubleArray)
```

An adapter has three jobs: convert the library tensor to the runtime's (doubles to `float32`, or `uint8` when the card says `dtype: "uint8"`), run the model, and convert the outputs back **under the names the decoders expect**: `output` for a classifier, `boxes`/`classes`/`scores`/`count` for an `ssd` detector, `rows` for a `rows` detector. Runtime output names differ from model to model (the ONNX SSD calls them `detection_boxes`, ..., the TFLite one `TFLite_Detection_PostProcess`, `...:1`, ...), so the mapping lives next to the model, not in the library: the demos keep it in the model cards (`io` in [`models.json`](../../demos/vision-assets/models.json)).

**ONNX Runtime Web** (browser). This adapter type-checks against the real `onnxruntime-web` typings and its output-name mapping was run against a stubbed runtime; it was not run with a real model file:

```ts
import * as ort from "onnxruntime-web";
import type { Tensor, VisionModel } from "@ilabs/vision";

/**
 * Runs an ONNX model with ONNX Runtime Web. `inputName` and the runtime output names come from the model file (the
 * demo's model cards list them). `outputNames` maps each name the decoders expect (`output`, or
 * `boxes`/`classes`/`scores`/`count`, or `rows`) to the model's own output name, for example
 * `{ boxes: "detection_boxes", classes: "detection_classes", scores: "detection_scores", count: "num_detections" }`;
 * a model output that is not listed is returned under its own name.
 */
export async function onnxModel(
  modelUrl: string,
  inputName: string,
  dtype: "float32" | "uint8",
  outputNames: Record<string, string> = {},
): Promise<VisionModel> {
  const decoderName = new Map(Object.entries(outputNames).map(([decoder, runtime]) => [runtime, decoder]));
  const session = await ort.InferenceSession.create(modelUrl, { executionProviders: ["wasm"] });
  return {
    async run(input: Tensor): Promise<Record<string, Tensor>> {
      const data = dtype === "uint8" ? Uint8Array.from(input.data) : Float32Array.from(input.data);
      const result = await session.run({ [inputName]: new ort.Tensor(dtype, data, input.shape) });
      const outputs: Record<string, Tensor> = {};
      for (const [name, value] of Object.entries(result)) {
        outputs[decoderName.get(name) ?? name] = { shape: [...value.dims], data: Array.from(value.data as ArrayLike<number>) };
      }
      return outputs;
    },
  };
}
```

**LiteRT** (Android). The runtime call is platform code and is not repeated here; the shape of the adapter is: copy `input.data` into the interpreter's input buffer as `float32` (or bytes), run it **off the main thread**, read each output buffer into a `DoubleArray` with its shape, and return them under the decoder names. This wrapper is the part that is runtime-independent (compiled and run against the library; put the LiteRT calls inside `infer`):

```kotlin
import es.sebas1705.ilabs.vision.Tensor
import es.sebas1705.ilabs.vision.VisionModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Runs a blocking inference function on a background dispatcher so the main thread is never blocked. */
class BlockingModel(private val infer: (Tensor) -> Map<String, Tensor>) : VisionModel {
    override suspend fun run(input: Tensor): Map<String, Tensor> = withContext(Dispatchers.Default) { infer(input) }
}

suspend fun adapter() {
    val model = BlockingModel { input -> mapOf("output" to Tensor(listOf(1, 2), doubleArrayOf(input.data.sum(), 0.0))) }
    println(model.run(Tensor(listOf(2), doubleArrayOf(1.0, 2.0)))["output"]!!.data.toList())
}
```

```
[3.0, 0.0]
```

An adapter's errors propagate unchanged out of `classify`/`detect` (cancellation included), and every successful call makes exactly one `run`.

## Composing with `evals`

A vision model becomes a `Provider` by returning its top label as the reply, and then an [`evals`](../evals/README.md) suite can grade it like any other target: an `equals` grader per labelled sample is a top-1 accuracy check, and the suite's `passRate` is the accuracy. The user message of each case names the sample (this teaching-scale version keeps the images in a map; a real harness would load them), so the case reads as "classify this sample, expect this label". `vision` does not depend on `evals` or `providers`; the app that runs the suite depends on all three. Two models over two labelled samples (`byBrightness` looks at the first input value, `alwaysDark` is a script that never changes its mind):

```ts
import type { CompletionRequest, CompletionResponse, Provider } from "@ilabs/providers";
import { runSuite, type Suite } from "@ilabs/evals";
import { classify, parseModelSpec, scriptedModel, type Image, type Tensor, type VisionModel } from "@ilabs/vision";

// A classifier spec and a tiny labelled "dataset": the user message of a case names a sample.
const spec = parseModelSpec({
  input: { width: 2, height: 2, layout: "nhwc", channels: "rgb", mode: "stretch", resample: "nearest", dtype: "float", scale: 1 / 255 },
  output: { type: "logits" },
  labels: ["dark", "bright"],
});
const samples: Record<string, Image> = {
  "dark-1": { width: 2, height: 2, data: new Uint8Array(12).fill(10) },
  "bright-1": { width: 2, height: 2, data: new Uint8Array(12).fill(240) },
};

// A Provider whose "reply" is the top-1 label of a vision model on the sample named in the prompt.
function visionProvider(id: string, model: VisionModel): Provider {
  return {
    id,
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      const sample = samples[req.messages[req.messages.length - 1]!.content]!;
      const { entries } = await classify(model, sample, spec, { topK: 1 });
      return { text: entries[0]!.label, provider: id };
    },
  };
}

// Any object with a `run(tensor)` method is a model. This one looks at the first input value.
const byBrightness: VisionModel = {
  async run(input: Tensor) {
    return { output: { shape: [2], data: input.data[0]! < 0.5 ? [3, 0] : [0, 3] } };
  },
};
const alwaysDark = scriptedModel({ output: { shape: [2], data: [3, 0] } });

const suite: Suite = {
  cases: [
    { id: "dark", messages: [{ role: "user", content: "dark-1" }], graders: [{ kind: "equals", value: "dark" }] },
    { id: "bright", messages: [{ role: "user", content: "bright-1" }], graders: [{ kind: "equals", value: "bright" }] },
  ],
};
const run = await runSuite(suite, { targets: [visionProvider("by-brightness", byBrightness), visionProvider("always-dark", alwaysDark)] });
for (const s of run.summary) console.log(s.targetId, `${s.passed}/${s.total}`, s.passRate);
```

```
by-brightness 2/2 1
always-dark 1/2 0.5
```

```kotlin
import es.sebas1705.ilabs.evals.Equals
import es.sebas1705.ilabs.evals.EvalCase
import es.sebas1705.ilabs.evals.Suite
import es.sebas1705.ilabs.evals.runSuite
import es.sebas1705.ilabs.providers.CompletionRequest
import es.sebas1705.ilabs.providers.CompletionResponse
import es.sebas1705.ilabs.providers.Message
import es.sebas1705.ilabs.providers.Provider
import es.sebas1705.ilabs.providers.Role
import es.sebas1705.ilabs.vision.*

suspend fun evalsSuite() {
    val spec = parseModelSpec(
        """
        {
          "input": { "width": 2, "height": 2, "layout": "nhwc", "channels": "rgb", "mode": "stretch", "resample": "nearest", "dtype": "float", "scale": 0.00392156862745098 },
          "output": { "type": "logits" },
          "labels": ["dark", "bright"]
        }
        """,
    )
    val samples = mapOf(
        "dark-1" to Image(2, 2, ByteArray(12) { 10 }),
        "bright-1" to Image(2, 2, ByteArray(12) { 240.toByte() }),
    )

    // A Provider whose "reply" is the top-1 label of a vision model on the sample named in the prompt.
    fun visionProvider(name: String, model: VisionModel) = object : Provider {
        override val id = name
        override suspend fun complete(req: CompletionRequest): CompletionResponse {
            val image = samples.getValue(req.messages.last().content)
            val label = classify(model, image, spec, topK = 1).entries.first().label
            return CompletionResponse(label, name)
        }
    }

    // Any `VisionModel` works. This one looks at the first input value; the other always says "dark".
    val byBrightness = VisionModel { input -> mapOf("output" to Tensor(listOf(2), if (input.data[0] < 0.5) doubleArrayOf(3.0, 0.0) else doubleArrayOf(0.0, 3.0))) }
    val alwaysDark = scriptedModel(mapOf("output" to Tensor(listOf(2), doubleArrayOf(3.0, 0.0))))

    val suite = Suite(
        listOf(
            EvalCase("dark", listOf(Message(Role.USER, "dark-1")), listOf(Equals("dark"))),
            EvalCase("bright", listOf(Message(Role.USER, "bright-1")), listOf(Equals("bright"))),
        ),
    )
    val run = runSuite(suite, listOf(visionProvider("by-brightness", byBrightness), visionProvider("always-dark", alwaysDark)))
    for (s in run.summary) println("${s.targetId} ${s.passed}/${s.total} ${s.passRate}")
}
```

```
by-brightness 2/2 1.0
always-dark 1/2 0.5
```

For a real accuracy number the loop is the same with a labelled dataset: `topKAccuracy` over the ranked class indices of a test set gives top-1 and top-5, and `meanAveragePrecision` over detections and ground-truth boxes gives a detector's mAP, both deterministic given the model's outputs.

## Models and the download script

The library never ships or needs a model. The demos run in a **Recorded** mode by default: the raw outputs of the real ONNX models for seven sample photos, recorded once and committed (2 to 10 KB each), decoded live by this library. A **Real model** mode runs the actual models and needs the files, which are **never committed** (a classifier and a detector, each as ONNX for the web and TFLite for Android, about 4 to 28 MB each, as `--check` prints them in MiB). One script downloads them into the git-ignored `demos/vision-assets/models/` and verifies every file against a pinned SHA-256:

```sh
node scripts/vision-models.mjs                  # download every missing model, resumable, checksum verified
node scripts/vision-models.mjs --runtime onnx   # only the web models (or --runtime tflite, or --id <id>)
node scripts/vision-models.mjs --check          # list what is present and whether it matches the pinned checksum
```

The pinned list (URL, SHA-256, size and license of each model), the labels, the samples and the recorded outputs are described in [`demos/vision-assets/README.md`](../../demos/vision-assets/README.md). Every model is Apache-2.0 compatible; no AGPL model is used. Two honest notes from there: the ONNX and TFLite builds of a task are the same family, not the same weights, and the recorded outputs come from the ONNX models only; and the two TFLite models were read from their files and metadata but **not run** on the machine that pinned them, so confirm the TFLite class numbering on a device.

## Demos

The web demo has a **Vision** page and the Android demo a seventh **Vision** screen, each with two tasks on the same sample photos or your own image: **Classify** (the preprocessed input as the model sees it with its geometry, the top-k labels with probabilities, the three timings) and **Detect** (the boxes over the original image with the class and score as text, score and IoU threshold controls that re-run only the postprocessing on the same raw outputs, the geometry, the timings). A backend switch chooses **Recorded** or **Real model**; the real one is enabled only when the model file is present, and otherwise the page says so and names the download script. Your own image has no recording, so it always needs the real model. Every number shown comes from this library; the demos only draw and decode the picked image. A note on both says what the models get wrong.

## Limits

- **Models make mistakes and the contract does not measure them.** See [Honest limits first](#honest-limits-first).
- **Doubles only; `exp` can drift in the last bits.** Resize, geometry, normalization, IoU, NMS and the metrics use only `+ - * /`, `floor` and comparisons in a pinned order and agree to the bit between Kotlin and TypeScript. Softmax and the logistic function use `exp`, which may differ by a unit in the last place between platforms; fixtures compare doubles with an absolute tolerance of `1e-9` and integers, shapes, strings and orders exactly. No fixture hides an order or comparison closer than `1e-9`.
- **Kotlin `Int` range.** Sizes and counts are `Int`: an image is at most 16,384 pixels per side and `width * height * 3` bytes (at most 805,306,368, which fits an `Int`), a class id at most 2,147,483,647, `labelOffset` within +/- 1,000,000, `maxDetections` and `topK` an `Int` (a value beyond that range cannot be written in Kotlin at all). The contract's own bounds (image sides, data length, class ids, `labelOffset`) apply to both languages.
- **Cost.** `toTensor` is linear in the model input size (a centre crop never materializes the scaled image); `resize` is linear in its output size (a 4096x4096 image resizes in a few seconds, checked in both test suites); `nms` sweeps each class by x extent (only boxes whose x ranges can overlap are compared), so it is close to linear for boxes spread over the image and 100,000 disjoint or clustered boxes of one class take milliseconds (covered by tests); the worst case, many heavily overlapping boxes that all survive, is still quadratic. Decoding a `rows` output with tens of thousands of candidates is fine; it is not tuned for video rates.
- **Inputs are never mutated**; every result is a new value. A byte array is read as unsigned (`255`, not `-1`) in Kotlin.
- **No regular expressions, library rounding (`Math.round`, `roundToInt`) or `float32` in the library sources**: a source scan in each language's tests fails the build if one appears, because the dialects and rounding modes differ between the two languages.

## Contract

[`contracts/vision/README.md`](../../contracts/vision/README.md) defines the behavior (resize, geometry, tensors, both decoders, NMS, metrics, the pipeline, `ModelSpec` and its validation order, errors) and the fixture format; 348 fixtures pin it, and both implementations must pass every one. `runFixture` (exported by the TypeScript package and, in Kotlin, from `es.sebas1705.ilabs.vision.contract`) runs one fixture with a scripted model and a scripted clock. The design is in [the vision design spec](../../docs/superpowers/specs/2026-11-21-vision-design.md). Sibling modules: [`providers`](../providers/README.md), [`structured`](../structured/README.md), [`context`](../context/README.md), [`evals`](../evals/README.md), [`rag`](../rag/README.md) and [`guardrails`](../guardrails/README.md).
