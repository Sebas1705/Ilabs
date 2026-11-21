# vision contract

Shared contract for the `vision` module (Kotlin and TypeScript): turn a raw RGB image into the tensor a classifier or detector expects (resize, crop or letterbox, channel order, normalization, layout), read the model's raw output back (softmax and top-k for classification; box decoding, score filtering and non-maximum suppression for detection), map boxes back to the original image and measure the result (top-k accuracy, IoU, average precision). Everything here is deterministic. Real model inference (floating-point results differ between LiteRT, ONNX Runtime and devices), image file decoding (JPEG, PNG, EXIF orientation), real clocks and the wording of the demo UI are not in the contract: a model is scripted in the fixtures. Both implementations must pass every `*.json` fixture in this folder.

Honest limits, each pinned by a rule below: the decoders read two output layouts only (`ssd` and `rows`); `rows` coordinates are always pixels of the model input; the geometry is one uniform mapping per image (no per-axis flips, no rotation); a model whose class ids do not start where its labels start needs `labelOffset`; images are at most 16,384 pixels per side.

## Rules

### Numbers and arithmetic

**Doubles.** Every real number in this module is an IEEE-754 binary64 value (`Double` in Kotlin, `number` in TypeScript). Resize, geometry, normalization, IoU, NMS and the metrics use only `+`, `-`, `*`, `/`, `floor` and comparisons, evaluated exactly in the order each rule writes, one operation at a time (no fused multiply-add, no extended precision, no `float32` anywhere, no re-association): both languages then produce bit-identical doubles. Only softmax (`exp`) and the logistic function (`exp`) may differ in the last bits between platforms. `min(a, b)` and `max(a, b)` of two numbers are the usual ones (the inputs are never NaN and equal inputs are identical, so the choice on a tie is not observable).

**Rounding.** `roundHalfUp(v) = floor(v + 0.5)`, always, never a library `round`, `roundToInt`, `rint` or `Math.round`. `floor` rounds toward negative infinity (`floor(-0.25) = -1`). Integers (sizes, offsets, indices) are exact integers; a `floor` result is converted to an integer only after clamping where a rule says so.

**Integer division.** `intdiv(a, b)` with `a >= 0` and `b > 0` is `floor(a / b)` on the integers (`intdiv(5, 2) = 2`).

**Negative zero.** Offsets are written `0 - cropX`, giving `+0`; other computations can produce `-0` (for example `0 / std` with a negative `std`); every comparison treats `0` and `-0` as equal and a fixture never distinguishes them (a unit-test rule: `-0` is accepted wherever `0` is).

**Doubles win over exact math.** The operation orders written in this contract are the contract, not an approximation of exact arithmetic: where a double result differs from the exact rational one (for example `11 * (15 / 22)` is `7.499999999999999`, not `7.5`; a bilinear sum that is exactly `232.5` in rational arithmetic can come out as `232.49999999999997`), the double result is the right one. Fixtures pin such cases (`geometry-letterbox-double-tie`, `geometry-centercrop-double-tie`, `resize-bilinear-double-tie-border`, `resize-bilinear-clamped-fx-tie`, `resize-bilinear-non-dyadic-weights`, `tensor-letterbox-bilinear`). An implementation must not use exact fractions, `float32`, a separable (x then y) interpolation, another association of the sum, or `srcW * dstH / srcH` in place of `srcW * scale`.

**Tolerance.** In fixtures every double is compared with an absolute tolerance of `1e-9`; bytes, integers (shapes, indices, class indices, sizes, counts), booleans, strings and orders are compared exactly. No fixture contains two different values that decide an order or a comparison closer than `1e-9` (exact ties are ties by construction: equal inputs, never a numeric coincidence).

### Images

An **image** is `{ width, height, data }`: `data` holds `width * height * 3` bytes (`0` to `255`) of 8-bit RGB, row-major, interleaved (`R G B` of the pixel `(0, 0)`, then of `(1, 0)`, ... then the next row), top row first. Pixel `(x, y)` starts at byte `(y * width + x) * 3`. There is no alpha channel (the caller drops it) and no decoding.

**Validation (`invalid_options`).** Every operation that takes an image checks, in this order, before any other work: (1) `width` and `height` are integers with `1 <= v <= 16384`; (2) `data` has exactly `width * height * 3` bytes (at most 805,306,368: fits a 32-bit integer); (3) every byte is an integer from 0 to 255 (a typed byte array already guarantees it). Any other size or length is `VisionError(invalid_options)`: images above 16,384 pixels per side are out of scope and rejected, never processed.

Inputs (images, tensors, specs, option objects, lists) are never mutated; results are new values.

### ModelSpec

A `ModelSpec` (the "model card") is plain JSON. `parseModelSpec(json)` takes a parsed JSON value (Kotlin also accepts a string, parsed strictly first: a string that is not valid JSON fails with the reason `spec must be valid JSON`, a unit-test case) and returns the typed spec or fails with `VisionError(invalid_spec)` whose message is exactly `invalid model spec: <reason>` with one of the reasons below (prefix and reasons are pinned). Typed specs built by hand are validated with the same rules at runtime.

```
{
  "input": {
    "width": int, "height": int,                         // required: model input size in pixels
    "layout": "nhwc" | "nchw",                           // required
    "channels": "rgb" | "bgr",                           // required: order of the channels the model expects
    "mode": "stretch" | "centerCrop" | "letterbox",      // required
    "resample": "nearest" | "bilinear",                  // required
    "dtype": "float" | "uint8",                          // required
    "padValue": int 0..255,        // optional, default 114 (letterbox padding byte)
    "scale": number,               // optional, default 1
    "mean": [number x 3],          // optional, default [0, 0, 0]
    "std":  [number x 3]           // optional, default [1, 1, 1]
  },
  "output": { "type": "logits" | "probabilities" }       // a classifier, OR
            { "format": "ssd", "boxOrder"?: "yxyx" | "xyxy", "coordinates"?: "normalized" | "pixels" }
            { "format": "rows", "boxFormat"?: "xywh" | "xyxy", "transposed"?: bool,
              "objectness"?: bool, "scoreActivation"?: "none" | "sigmoid" },
  "labels": [string],              // optional
  "labelOffset": int               // optional, default 0
}
```

Defaults: `boxOrder` `"yxyx"`; `coordinates` `"normalized"`; `boxFormat` `"xywh"`; `transposed` `false`; `objectness` `false`; `scoreActivation` `"none"`; `padValue` `114`; `scale` `1`; `mean` `[0, 0, 0]`; `std` `[1, 1, 1]`; `labelOffset` `0`; `labels` absent (labels become `"#<index>"`). An optional key may be absent but never `null`: JSON `null` for any key is rejected by that key's own value rule below (nothing treats `null` as absent). Integers are judged by value (`224` is an integer, `224.5` is not).

**Validation rules**, checked in this order; the first violated rule is the one reported (a fixture violates one rule; when a document has several offending keys the order among them is not pinned). `<path>` is the dotted path of the key (`input.width`, `output.boxOrder`, `labels`).

1. The spec is a JSON object: `invalid model spec: spec must be an object`.
2. The top level has no key other than `input`, `output`, `labels`, `labelOffset`: `invalid model spec: unknown key: <key>`.
3. `input` and `output` are present: `invalid model spec: missing key: input`, `invalid model spec: missing key: output`.
4. `input` is an object: `invalid model spec: input must be an object`.
5. `input` has no key other than the eleven above: `invalid model spec: unknown key: input.<key>`.
6. The required input keys are present, checked in the order `width`, `height`, `layout`, `channels`, `mode`, `resample`, `dtype`: `invalid model spec: missing key: input.<key>`.
7. `input.width` and `input.height` (checked in that order) are integers with `1 <= v <= 16384`: `invalid model spec: input.width must be an integer from 1 to 16384` (likewise `input.height`).
8. `input.layout` is one of the two strings: `invalid model spec: input.layout must be "nhwc" or "nchw"`.
9. `input.channels`: `invalid model spec: input.channels must be "rgb" or "bgr"`.
10. `input.mode`: `invalid model spec: input.mode must be "stretch", "centerCrop" or "letterbox"`.
11. `input.resample`: `invalid model spec: input.resample must be "nearest" or "bilinear"`.
12. `input.dtype`: `invalid model spec: input.dtype must be "float" or "uint8"`.
13. `input.padValue`, when present, is an integer with `0 <= v <= 255`: `invalid model spec: input.padValue must be an integer from 0 to 255`. It is accepted (and ignored) in every mode.
14. `input.scale`, when present, is a finite number (zero and negative values are valid): `invalid model spec: input.scale must be a finite number`.
15. `input.mean`, when present, is an array of exactly 3 finite numbers (negative values are valid): `invalid model spec: input.mean must be an array of 3 finite numbers`.
16. `input.std`, when present, is an array of exactly 3 finite numbers: `invalid model spec: input.std must be an array of 3 finite numbers`.
17. No `input.std` entry is `0` (negative entries are valid): `invalid model spec: input.std entries must not be 0`.
18. With `dtype` `"uint8"`, none of `scale`, `mean`, `std` is present (checked in that order): `invalid model spec: input.scale is not allowed with dtype uint8` (likewise `input.mean`, `input.std`).
19. `output` is an object: `invalid model spec: output must be an object`.
20. `output` has exactly one of the keys `type` and `format`: `invalid model spec: output must have exactly one of "type" and "format"` (both present, or neither).
21. A classifier output (`type` present): `output.type` is `"logits"` or `"probabilities"`: `invalid model spec: output.type must be "logits" or "probabilities"`.
22. A detector output (`format` present): `output.format` is `"ssd"` or `"rows"`: `invalid model spec: output.format must be "ssd" or "rows"`.
23. `output` has no key other than the ones of its kind: a classifier only `type`; an `ssd` detector only `format`, `boxOrder`, `coordinates`; a `rows` detector only `format`, `boxFormat`, `transposed`, `objectness`, `scoreActivation`: `invalid model spec: unknown key: output.<key>` (so `transposed` on an `ssd` output, or `boxOrder` on a `rows` output, is an unknown key).
24. `output.boxOrder`, when present: `invalid model spec: output.boxOrder must be "yxyx" or "xyxy"`.
25. `output.coordinates`, when present: `invalid model spec: output.coordinates must be "normalized" or "pixels"`.
26. `output.boxFormat`, when present: `invalid model spec: output.boxFormat must be "xywh" or "xyxy"`.
27. `output.transposed`, when present, is a JSON boolean: `invalid model spec: output.transposed must be a boolean`. Likewise `output.objectness`: `invalid model spec: output.objectness must be a boolean`.
28. `output.scoreActivation`, when present: `invalid model spec: output.scoreActivation must be "none" or "sigmoid"`.
29. `labels`, when present, is an array of strings (possibly empty): `invalid model spec: labels must be an array of strings`. An empty array is valid and is not the same as an absent `labels` (see detection rule D3).
30. `labelOffset`, when present, is an integer with `-1000000 <= v <= 1000000`: `invalid model spec: labelOffset must be an integer from -1000000 to 1000000`. It is accepted (and ignored) when `labels` is absent.

A classifier spec and a detector spec are distinguished by `output`; every operation below that needs one kind and gets the other fails with `VisionError(invalid_options)` (unit-test rule).

### Resize

`resize(image, dstW, dstH, method)` returns a new image of `dstW x dstH`.

1. Validate (`invalid_options`): the image (see Images), `dstW` and `dstH` integers with `1 <= v <= 16384`, `method` one of `"nearest"`, `"bilinear"` (any other value, `null` included, fails).
2. `srcW`, `srcH` are the source size; they and `dstW`, `dstH` are converted to doubles where an expression below uses them.
3. For each destination pixel `(x, y)` (`x` from 0 to `dstW - 1`, `y` from 0 to `dstH - 1`) compute the source position, each line one double operation, in this order:
   - `tx = x + 0.5`; `ux = tx * srcW`; `vx = ux / dstW`; `sx = vx - 0.5`;
   - `ty = y + 0.5`; `uy = ty * srcH`; `vy = uy / dstH`; `sy = vy - 0.5`.
   This is the half-pixel-centre convention: the centre of destination pixel `x` is at `x + 0.5` in destination space, mapped proportionally to source space, minus the `0.5` that turns "centre coordinate" into "pixel index".
4. **`nearest`.** `ix = floor(sx + 0.5)` and `iy = floor(sy + 0.5)` (round half up: a position exactly halfway between two source pixels takes the larger index), each clamped to `[0, srcW - 1]` and `[0, srcH - 1]`. The three bytes of the destination pixel are the three bytes of the source pixel `(ix, iy)`.
5. **`bilinear`.** For each axis separately:
   - `x0 = floor(sx)`; `fx = sx - x0` (computed from the UNCLAMPED `x0`, with `x0` as a double); `x1 = x0 + 1`;
   - clamp `x0` to `[0, srcW - 1]` and `x1` to `[0, srcW - 1]` independently (so at the borders both neighbours can be the same pixel, and `fx` keeps its value);
   - `wx0 = 1 - fx`; `wx1 = fx`.
   The same for `y` with `srcH` (`y0`, `fy`, `y1`, `wy0 = 1 - fy`, `wy1 = fy`). For each of the three channels, with `v00` the channel byte of source pixel `(x0, y0)`, `v10` of `(x1, y0)`, `v01` of `(x0, y1)`, `v11` of `(x1, y1)` (after clamping):
   - `a = v00 * wx0` then `a = a * wy0`; `b = v10 * wx1` then `b = b * wy0`; `c = v01 * wx0` then `c = c * wy1`; `d = v11 * wx1` then `d = d * wy1`;
   - `v = ((a + b) + c) + d`;
   - the destination byte is `roundHalfUp(v)` clamped to `[0, 255]`.
6. The destination pixel `(x, y)` is stored at byte `(y * dstW + x) * 3`.

A resize to the same size gives the same image (`sx = x` exactly, `fx = 0`). Resizing never mixes channels and works on bytes: the result is rounded to a byte in this step, before any normalization.

### Geometry and unmapping

`preprocessGeometry(srcW, srcH, spec)` takes a classifier or detector spec; `dstW = spec.input.width`, `dstH = spec.input.height`, `mode = spec.input.mode`. `srcW` and `srcH` are validated like image sizes (`invalid_options`). It returns the *geometry* `{ scaleX, scaleY, offsetX, offsetY, newWidth, newHeight }` (doubles for the first four, integers for the sizes): `scaleX` and `scaleY` are the ACTUAL ratios between the resized content and the source (not the nominal scale), and a model-input coordinate `u` maps back to the source as `(u - offset) / scale`.

**`stretch`.** `newWidth = dstW`, `newHeight = dstH`; `scaleX = dstW / srcW`, `scaleY = dstH / srcH`; `offsetX = 0`, `offsetY = 0`.

**`centerCrop`** (the whole image is scaled so that it covers the target, then the centred window is cut):

1. `rx = dstW / srcW`; `ry = dstH / srcH`; `scale = max(rx, ry)`.
2. `scaledW = max(dstW, roundHalfUp(srcW * scale))` and `scaledH = max(dstH, roundHalfUp(srcH * scale))` (integers; the `max` with the target size never changes a result, it guards rounding).
3. `cropX = intdiv(scaledW - dstW, 2)`, `cropY = intdiv(scaledH - dstH, 2)` (the larger half of an odd difference is cut on the right or bottom).
4. `scaleX = scaledW / srcW`, `scaleY = scaledH / srcH`; `offsetX = 0 - cropX`, `offsetY = 0 - cropY`; `newWidth = scaledW`, `newHeight = scaledH`.

**`letterbox`** (the whole image is scaled to fit inside the target, the rest is padding):

1. `rx = dstW / srcW`; `ry = dstH / srcH`; `scale = min(rx, ry)`.
2. `newW = max(1, roundHalfUp(srcW * scale))` and `newH = max(1, roundHalfUp(srcH * scale))` (integers, at least 1, never above the target).
3. `padX = intdiv(dstW - newW, 2)`, `padY = intdiv(dstH - newH, 2)` (the larger half of an odd difference goes right or bottom).
4. `scaleX = newW / srcW`, `scaleY = newH / srcH` (so `scaleX` and `scaleY` can differ slightly from `scale` and from each other); `offsetX = padX`, `offsetY = padY`; `newWidth = newW`, `newHeight = newH`.

**`unmapBox(box, geometry, srcW, srcH)`** maps a box `{ x1, y1, x2, y2 }` in model-input pixels back to the source image:

1. `ux1 = (x1 - offsetX) / scaleX`; `uy1 = (y1 - offsetY) / scaleY`; `ux2 = (x2 - offsetX) / scaleX`; `uy2 = (y2 - offsetY) / scaleY` (a subtraction, then a division).
2. Clamp each coordinate to the source image: `x` values to `[0, srcW]`, `y` values to `[0, srcH]`, as `min(max(v, 0), limit)`.
3. If the clamped width `x2 - x1 <= 0` or the clamped height `y2 - y1 <= 0`, the box has no area: the result is `null` (dropped). Otherwise the result is the clamped box.

A box that lies entirely in the padding, or entirely outside the source after mapping, is therefore dropped. `unmapBox` does not reorder swapped coordinates (the detection pipeline swaps them earlier): a box with `x1 > x2` maps to a negative extent and is dropped (`unmap-swapped-box-dropped`). `unmapBox` validates its input before step 1 (`invalid_options`): `srcW` and `srcH` like image sizes (integers `1 <= v <= 16384`; a fixture cannot test this apart from the geometry's own check, so it is a unit-test rule) and the four box coordinates finite (`invalid-unmap-non-finite`).

### Tensors: `toTensor(image, spec)`

Returns `{ tensor: { shape, data }, geometry }` (`data` doubles for `float`, byte values for `uint8`; the tensor `data` is always a list of numbers). Steps:

1. Validate the image (`invalid_options`). Compute `geometry = preprocessGeometry(srcW, srcH, spec)`.
2. Build the model-input canvas, `dstW x dstH x 3` bytes, per mode (the resize is the Resize rule with `method = spec.input.resample`):
   - `stretch`: the canvas is `resize(image, dstW, dstH, resample)`.
   - `centerCrop`: the canvas pixel `(x, y)` is the pixel `(x + cropX, y + cropY)` of the WHOLE image resized to `scaledW x scaledH`, with `cropX = 0 - offsetX` and `cropY = 0 - offsetY`. It is computed with the Resize formulas using `dstW := scaledW`, `dstH := scaledH` and the destination pixel `(x + cropX, y + cropY)` (an implementation must not allocate the whole resized image: `scaledW` can exceed 16,384; the result is the same as resizing the whole image and cutting the window, and different from cropping the source first, clarification 6).
   - `letterbox`: `r = resize(image, newW, newH, resample)`; the canvas is filled with `padValue` (default `114`) in all three channels; `r` is copied so that its pixel `(0, 0)` lands on the canvas pixel `(padX, padY)`.
3. Channel order: if `spec.input.channels` is `"bgr"`, swap the first and third byte of every canvas pixel (the padding included, which is unaffected since its three bytes are equal). Channel positions `0, 1, 2` below refer to this OUTPUT order.
4. Values. `dtype` `"float"`: for a byte `v` at output channel position `c`: `t1 = v * scale`; `t2 = t1 - mean[c]`; `value = t2 / std[c]` (`scale`, `mean`, `std` with their defaults; `mean` and `std` index the OUTPUT channel position, after the swap). `dtype` `"uint8"`: `value = v` (the swap and the layout apply; `scale`, `mean`, `std` are not allowed in the spec).
5. Layout. `nhwc`: `shape = [1, dstH, dstW, 3]`, `data[((y * dstW) + x) * 3 + c]`. `nchw`: `shape = [1, 3, dstH, dstW]`, `data[(c * dstH + y) * dstW + x]`.

`padValue` is a raw byte written before the channel swap and before normalization: the padding is normalized exactly like pixels.

### Classification output: `postprocessClassification(output, spec, { topK?, minScore? })`

`output` is a vector of numbers (the classifier's single output after the batch dimension is removed, see Pipeline). `spec.output` must be a classifier (`type`).

1. Validate options (`invalid_options`): `topK` an integer `>= 1` (default 5), `minScore` a number with `0 <= minScore <= 1` (default 0); `null` is a bad value, never "absent". A bad option fails before the output is looked at.
2. Validate the output (`invalid_output`): at least one element; every element finite (no NaN, no infinity); for `"probabilities"` every element `>= 0`.
3. Scores. `"probabilities"`: `score[i] = output[i]` (used as given, not renormalized, not softmaxed). `"logits"` (numerically stable softmax), in this order:
   - `m` = the largest element (a left-to-right scan keeping the larger);
   - `e[i] = exp(output[i] - m)` for every `i` (one subtraction, then `exp`);
   - `s = 0`; then for `i` from 0 up: `s = s + e[i]` (summation in index order, starting from `0`);
   - `score[i] = e[i] / s` (one division each).
4. Order the indices by descending score; exactly equal scores by ascending index (a stable sort of `0 .. C-1` by score descending does exactly this).
5. Keep the first `topK` of them (all of them when `topK >= C`), then drop the entries with `score < minScore` (a score equal to `minScore` is kept: the comparison is inclusive). The result may be empty.
6. Each entry is `{ index, label, score }`: `index` is the position in `output` (the model's class id). `label`: let `k = index - labelOffset`; if `labels` is present and `0 <= k < labels.length` the label is `labels[k]`, else it is `"#"` followed by the decimal digits of `index` (`#0`, `#17`).

### Detection output: `postprocessDetections(outputs, spec, geometry, source, options)`

`outputs` maps tensor names to tensors `{ shape, data }`; extra tensors are ignored. `spec.output` must be a detector. `source` is `{ width, height }`, the size of the ORIGINAL image (validated like image sizes). `geometry` is the geometry of that image for `spec` (a hand-built geometry is trusted). Result: a list of detections `{ box: { x1, y1, x2, y2 }, classIndex, label, score }`.

**Options** (validated first, `invalid_options`; `null` is a bad value, never "absent"): `scoreThreshold` a number with `0 <= v <= 1` (default `0.3`); `iouThreshold` a number with `0 <= v <= 1` (default `0.5`); `maxDetections` an integer `>= 1` (default `100`); `nms` a boolean (default `true` for `rows`, `false` for `ssd`). All four are validated even when `nms` is false.

**Tensor shapes.** A tensor's `data` must have exactly `product(shape)` elements, and every shape dimension must be an integer `>= 0` (`invalid_output` otherwise; the empty product is `1`, so shape `[]` holds one element). A leading batch dimension of size 1 is squeezed by shape alone:

- `ssd` needs the tensors `boxes`, `classes`, `scores`, and optionally `count`. `boxes`: shape `[1, n, 4]` or `[n, 4]` (rank 3 whose first dimension is 1 and last is 4, or rank 2 whose last is 4); `classes` and `scores`: shape `[1, n]` or `[n]`; `count`: exactly one element, shape `[]` or `[1]`. The `n` of the three must agree. A missing required tensor or any other shape is `invalid_output`. (`n = 0` is valid.)
- `rows` needs the tensor `rows`: shape `[1, a, b]` or `[a, b]` (rank 3 whose first dimension is 1, or rank 2); after squeezing it is `a x b`. Not transposed: `n = a` rows, `b = 4 + (objectness ? 1 : 0) + C` columns. Transposed: `b = n` rows, `a = 4 + (objectness ? 1 : 0) + C` columns, the value of column `j` for row `i` stored at index `j * b + i` (non-transposed: row `i`, column `j` at `i * b + j`). `C`, the number of classes, must be at least 1 (a tensor with too few columns is `invalid_output`).

**Candidates.** Every decoder yields candidates `{ x1, y1, x2, y2, classId, score, row }` in model-input pixels, `row` being the 0-based row index, in ascending row order. Class validity is checked on EVERY row a decoder examines, before any filtering, so options never change whether an output is valid:

- A class id must be finite and an integer by value with `0 <= id <= 2147483647`; and when `labels` is present, `0 <= id - labelOffset < labels.length`. Violations are `invalid_output`.

**D1. The `ssd` decoder.** The model already post-processed its output.
1. Validate the shapes above. Every element of `count`, when present, must be finite (`invalid_output`).
2. `n` is the row count; with `count`: `n' = min(max(floor(count), 0), n)` (the `count` float of TFLite truncates, it never rounds up); without `count`, `n' = n`. Only rows `0 .. n' - 1` are examined: rows beyond `n'` are ignored entirely (their values may be anything, even non-finite or invalid class ids).
3. For each examined row `i`: its four box values, its score and its class id must be finite (`invalid_output`), and the class rule above applies. `count`, when present, has shape `[]` or `[1]` only (`[2]` and `[1, 1]` are `invalid_output`).
4. Box. With `boxOrder` `"yxyx"` the four values `[a, b, c, d]` are `[ymin, xmin, ymax, xmax]`: `x1 = b`, `y1 = a`, `x2 = d`, `y2 = c`. With `"xyxy"`: `x1 = a`, `y1 = b`, `x2 = c`, `y2 = d`. With `coordinates` `"normalized"` the x values are then multiplied by `spec.input.width` and the y values by `spec.input.height` (the MODEL INPUT size, not the source size): `x1 = x1 * inW`, `y1 = y1 * inH`, `x2 = x2 * inW`, `y2 = y2 * inH`. With `"pixels"` they are already pixels of the model input.
5. `classId = classes[i]`, `score = scores[i]`.

**D2. The `rows` decoder.** Every element of `rows` must be finite (`invalid_output`). For each row `i` (all `n` rows), reading its values (transposed or not as above) as `v[0] .. v[b' - 1]`:
1. If `objectness`: `obj = v[4]` and the class scores are `v[5] .. v[4 + C]`; else the class scores are `v[4] .. v[3 + C]`.
2. If `scoreActivation` is `"sigmoid"`: replace `obj` (when present) and every class score `z` by `logistic(z)`, with `logistic(z) = 1 / (1 + exp(-z))` evaluated as `q = exp(0 - z)`, `p = 1 + q`, `logistic = 1 / p` (large negative `z` gives `0`, large positive `z` gives `1`; no NaN arises from finite input). With `"none"` the values are used as they are.
3. If `objectness`: every class score becomes `obj * score` (after the activation).
4. The detection of the row is its best class: the largest class score, the LOWEST class index on equal scores (scan classes in ascending order and replace the best only when strictly larger). `classId` is that index (0-based among the `C` class columns), `score` its score.
5. Box from `v[0] .. v[3]`. `boxFormat` `"xyxy"`: `x1 = v[0]`, `y1 = v[1]`, `x2 = v[2]`, `y2 = v[3]`. `"xywh"` (centre x, centre y, width, height): `hw = v[2] / 2`; `hh = v[3] / 2`; `x1 = v[0] - hw`; `y1 = v[1] - hh`; `x2 = v[0] + hw`; `y2 = v[1] + hh`. Coordinates are always pixels of the model input (`rows` has no `coordinates` key).

**D3. Labels.** The label index of a class id is `classId - labelOffset`, for `rows` exactly as for `ssd`. For a surviving detection, `classIndex = classId` (the model's id, never offset) and `label`: with `labels` present, `labels[classId - labelOffset]` (in range by the class rule, which is checked for the best class of EVERY row of a `rows` output and for every examined `ssd` row, before the score threshold; an empty `labels` array therefore rejects every output that has an examined row); without `labels`, `"#"` followed by the decimal digits of `classId`.

**Non-finite numbers.** Besides the element checks of each decoder, any candidate value that is non-finite after the arithmetic of the decoder (`obj * score`, `cx + hw`, `x * inW`, an overflow to infinity, `Infinity - Infinity`) is `invalid_output`: no decoder ever hands a NaN or an infinity to the detection order below.

**Detection order.** After a decoder produced the candidates:
1. Keep the candidates with `score >= scoreThreshold` (inclusive), preserving row order.
2. Swap coordinates independently: if `x2 < x1` exchange `x1` and `x2`; if `y2 < y1` exchange `y1` and `y2`.
3. If `nms` is enabled: `nms(list, iouThreshold)` on the list of step 2 (the NMS rule below; the list is in row order, and the survivors keep it).
4. Sort by descending score, exactly equal scores by ascending row index.
5. Keep the first `maxDetections`.
6. For each, `unmapBox(box, geometry, source.width, source.height)`; drop those that give `null`. (So the result can have fewer than `maxDetections` entries even when more candidates existed.)
7. Build the detections `{ box, classIndex, label, score }` in that order.

### NMS and IoU

**`iou(a, b)`** for boxes `{ x1, y1, x2, y2 }` taken as given (never reordered: two identical boxes with swapped corners `(10, 10, 0, 0)` have `iw = -10`, intersection `0`, union `100 + 100 - 0 = 200` and IoU `0`, `iou-swapped-boxes`). The public `iou` fails with `invalid_options` when a coordinate is not finite (`invalid-iou-non-finite`); `nms` validates its detections up front instead (the next rule), so its internal use of this arithmetic always sees finite coordinates:
1. `ix1 = max(a.x1, b.x1)`; `iy1 = max(a.y1, b.y1)`; `ix2 = min(a.x2, b.x2)`; `iy2 = min(a.y2, b.y2)`.
2. `iw = ix2 - ix1`; `ih = iy2 - iy1`. If `iw <= 0` or `ih <= 0`, `inter = 0` (boxes that only touch on an edge or a corner have intersection `0`); else `inter = iw * ih`.
3. `areaA = (a.x2 - a.x1) * (a.y2 - a.y1)`; `areaB = (b.x2 - b.x1) * (b.y2 - b.y1)`; `union = (areaA + areaB) - inter`.
4. If `union <= 0` the result is `0`; otherwise `inter / union`.

**`nms(detections, iouThreshold)`** works on detections `{ box, classIndex, label, score }` (`label` and every other field are carried through unchanged). `iouThreshold` is a number in `[0, 1]` (`invalid_options` otherwise). Class-aware: boxes of different classes never interact. Every detection must have a finite `score` and four finite box coordinates (`invalid_options` otherwise, before any suppression, whatever the class; clarification 37).
1. Group the input positions by `classIndex`.
2. For each class: `order` = its positions sorted by descending score, exactly equal scores by ascending input position. `suppressed[p] = false` for all. For each position `p` in `order`, in turn: if `suppressed[p]` skip it; otherwise keep `p`, and for each LATER position `q` in `order` with `suppressed[q] = false`: if `iou(box[p], box[q]) > iouThreshold` (STRICTLY greater) set `suppressed[q] = true`. (A suppressed box never suppresses another box.)
3. The result is the kept detections of all classes in ascending INPUT position (a subsequence of the input, no re-sorting).

### Metrics

**`topKAccuracy(predictions, truths, k)`.** `predictions` is one list of class indices per sample, ranked best first; `truths` the true class index per sample. `k` is an integer `>= 1` (`invalid_options`, `null` included) and `predictions` and `truths` must have the same length (`invalid_options`). `hits` = the number of samples whose truth equals one of the first `k` entries of its list (all of them when the list is shorter than `k`). The result is `hits / n` (one division); with no samples (`n = 0`) it is `0`.

**`averagePrecision(detections, truths, { iouThreshold })`** with `detections = [{ image, classIndex, score, box }]` and `truths = [{ image, classIndex, box }]` (flat lists; `image` an opaque string id; boxes `{ x1, y1, x2, y2 }`; `iouThreshold` required, a number in `[0, 1]`, `invalid_options` otherwise, `null` included). Result `{ byClass: [{ classIndex, ap }] }`: one entry for every class that has at least one truth, in ascending `classIndex`. A class with detections but no truths is skipped (not listed). For one class `c` (`nT` truths, `nT >= 1`):
1. `D` = the detections of class `c` ordered by descending score, exactly equal scores by ascending input position in `detections`.
2. `taken[t] = false` for each truth `t` of the class. For each detection `d` of `D` in turn: the candidate truths are the truths of the SAME image and class `c`; if there are none, `d` is a false positive. Otherwise `best` = the candidate with the highest `iou(d.box, t.box)`, the first one in input order on equal IoU (scan in input order, replace only when strictly greater). `d` is a true positive when `iou(d.box, best.box) >= iouThreshold` (inclusive) AND `taken[best]` is false, and then `taken[best] = true`; in every other case it is a false positive (it never falls back to a second-best truth).
3. Let `m = |D|`. After each detection `k` (1-based) with `tp` and `fp` the running counts: `precision[k] = tp / (tp + fp)`; `recall[k] = tp / nT` (one division each); `recall[0] = 0`.
4. Envelope: `env[m] = precision[m]`; for `k` from `m - 1` down to 1: `env[k] = max(precision[k], env[k + 1])` (the precision envelope, non-increasing from the right).
5. `ap = 0`; for `k` from 1 up to `m`: `ap = ap + ((recall[k] - recall[k - 1]) * env[k])` (all-point interpolation: the area under the envelope over recall, accumulated in this order). With `m = 0` the AP is `0`.

**Metric inputs and edge rules.** `averagePrecision` and `meanAveragePrecision` validate their inputs first (`invalid_options`): every detection has a finite `score`, finite box coordinates, a string `image` and an integer `classIndex >= 0`; every truth the same minus the score (`invalid-metrics-*`). With `iouThreshold` `0` the literal `>=` applies and there is no extra guard: a detection whose box is disjoint from the truth (IoU `0`) is a true positive (`ap-threshold-zero-disjoint-box`). When two truths have exactly equal IoU with a detection, the first in input order is its best truth (`ap-truth-tie-first-wins`).

**`meanAveragePrecision(detections, truths, { iouThreshold })`** returns `{ map, byClass }` with `byClass` as above; `map` = the sum of the `ap` values in ascending class order (a left-to-right sum starting from `0`) divided by the number of classes with truths; `0` when no class has truths. A class with truths and no detections counts with AP `0`.

### Pipeline

`VisionModel { run(input: Tensor): Promise<NamedTensors> }` (Kotlin: `fun interface VisionModel { suspend fun run(input: Tensor): Map<String, Tensor> }`); `Clock { nowMs(): number }` (Kotlin: `fun interface Clock { fun nowMs(): Double }`). `scriptedModel(outputs)` returns a model that ignores the values of its input, records every call (the input tensors, in order, as `calls`) and returns the scripted named tensors (the same map each time).

**`classify(model, image, spec, options)`** with `options = { topK?, minScore?, clock? }`:
1. Validate, before any clock or model call (`invalid_options`): the image, the classifier spec, `topK` and `minScore` as in the classification rule (`detect` validates the image, the detector spec and ALL its options in the same way: `scoreThreshold`, `iouThreshold`, `maxDetections`, `nms`). A failure here means zero clock reads and zero model calls.
2. `t0 = clock.nowMs()`.
3. `{ tensor, geometry } = toTensor(image, spec)`.
4. `t1 = clock.nowMs()`.
5. `outputs = model.run(tensor)`: exactly ONE call. An error thrown by the model propagates unchanged (no further clock read, no wrapping).
6. `t2 = clock.nowMs()`.
7. The tensor named `output` must be present, its data length must be `product(shape)`, and its shape must be `[C]` or `[1, C]` with `C >= 1` (a leading batch dimension of size 1 is squeezed): otherwise `invalid_output`. `entries = postprocessClassification(vector, spec, { topK, minScore })` (which validates the values: non-finite numbers are `invalid_output`).
8. `t3 = clock.nowMs()`.
9. Result `{ entries, timing: { preprocessMs: t1 - t0, inferenceMs: t2 - t1, postprocessMs: t3 - t2 } }`.

**`detect(model, image, spec, options)`** with `options = { scoreThreshold?, iouThreshold?, maxDetections?, nms?, clock? }`: the same nine steps with the detector spec; step 7 is `detections = postprocessDetections(outputs, spec, geometry, { width: image.width, height: image.height }, options)`; the result is `{ detections, timing, geometry }`.

The number of clock reads is therefore observable: the model's `run` is called after exactly 2 reads; a successful run reads 4 times; an error thrown by the model leaves 2 reads; an invalid output leaves 3 (the read after the model call happened, the output is checked afterwards); a validation error leaves 0. The clock is read exactly four times, in this order: before preprocessing, after preprocessing, after the model call, after postprocessing. When an error is raised after the model call, the remaining clock reads do not happen and no result is returned: malformed outputs are rejected before any result. The default clock (no `clock` option) is a real one and is not part of the contract. Timings are plain differences of the values read (no validation, no clamping: a clock `[10, 8, 20, 21]` gives `preprocessMs` `-2`, `pipeline-timing-negative-difference`).

### Errors

`VisionError(kind)` (a TypeScript class / a Kotlin exception) with `kind` one of:
- `invalid_spec`: `parseModelSpec` and hand-built specs (message `invalid model spec: <reason>`).
- `invalid_options`: an image that fails the Images rules; a resize target size or method; a geometry source size; `topK`, `minScore`, `scoreThreshold`, `iouThreshold`, `maxDetections`, `nms`, `k` out of range or of the wrong kind (including JSON `null`); predictions and truths of different lengths; a spec of the wrong kind for the operation.
- `invalid_output`: a model output with a missing tensor, a wrong shape or a data length that does not match its shape, an empty classification vector, a non-finite number (NaN or infinity), a negative probability, a class id that is not a non-negative integer or lies outside the labels range, a detector tensor set that is inconsistent.

Errors thrown by the model (or by a clock) are not `VisionError`s and propagate unchanged, `CancellationException` included. Options are validated before outputs, so an invalid option is `invalid_options` even when the output is also bad.

## Fixture format

`contracts/vision/<name>.json`:

```json
{
  "name": "resize-nearest-downscale",
  "setup": {
    "kind": "resize",
    "image": { "width": 4, "height": 4, "data": [0, 1, 2, "..."] },
    "width": 2,
    "height": 2,
    "method": "nearest"
  },
  "expect": {
    "image": { "width": 2, "height": 2, "data": [50, 51, 52, "..."] }
  }
}
```

(Abbreviated; the real file lists every byte.) Every file is exactly `JSON.stringify(fixture, null, 2) + "\n"`: 2-space indentation, LF, trailing newline.

Top-level keys: `name` (equal to the file name), `setup`, `expect`. `setup.kind` selects what runs:

| `kind` | `setup` keys (`?` optional) | Runs | `expect` |
|---|---|---|---|
| `resize` | `image`, `width`, `height`, `method` | `resize(image, width, height, method)` | `{ image }` |
| `geometry` | `srcWidth`, `srcHeight`, `spec`, `boxes?` | `preprocessGeometry(srcWidth, srcHeight, spec)`; with `boxes`, also `unmapBox(box, geometry, srcWidth, srcHeight)` for each box | `{ geometry: { scaleX, scaleY, offsetX, offsetY, newWidth, newHeight }, unmapped? }` (`unmapped` present exactly when `boxes` is: a list of boxes or `null`, one per input box) |
| `tensor` | `image`, `spec` | `toTensor(image, spec).tensor` | `{ shape, data }` |
| `classify` | `output` (a list of numbers), `spec`, `options?` (`topK`, `minScore`) | `postprocessClassification(output, spec, options)` | `{ entries: [{ index, label, score }] }` |
| `decode` | `outputs` (name to tensor), `spec`, `srcWidth`, `srcHeight`, `options?` (`scoreThreshold`, `iouThreshold`, `maxDetections`, `nms`) | `postprocessDetections(outputs, spec, preprocessGeometry(srcWidth, srcHeight, spec), { width: srcWidth, height: srcHeight }, options)` | `{ detections: [{ box, classIndex, label, score }] }` |
| `nms` | `detections`, `iouThreshold` | `nms(detections, iouThreshold)` | `{ detections }` |
| `metrics` | `op`, then per op: `iou`: `a`, `b`; `topk`: `predictions`, `truths`, `k`; `ap` and `map`: `detections`, `truths`, `iouThreshold` | `iou(a, b)`; `topKAccuracy`; `averagePrecision`; `meanAveragePrecision` | `iou` and `topk`: `{ value }`; `ap`: `{ byClass: [{ classIndex, ap }] }`; `map`: `{ map, byClass }` |
| `pipeline` | `image`, `spec`, `task` (`"classify"` or `"detect"`), `scripted`, `options?`, `clock` | `classify` or `detect` (see below) | success: `{ results, timing: { preprocessMs, inferenceMs, postprocessMs }, modelCalls, clockReads, input: { shape, data }, geometry? }`; or `{ error: { kind }, modelCalls, clockReads }`; or `{ modelError, modelCalls, clockReads }`; every pipeline expectation has `clockReads` |
| `spec` | `spec` (any JSON value) | `parseModelSpec(spec)` | `{ valid: true }` or `{ error: { kind: "invalid_spec", message } }` |

- Any kind except `spec` may instead expect `{ "error": { "kind": <kind>, "message"?: <string> } }` with `kind` one of `invalid_options`, `invalid_output`, `invalid_spec` (a `spec` embedded in another kind that fails to parse). There is no separate `invalid` kind: the `invalid-*` fixtures are ordinary fixtures of the kind whose operation they break, each breaking exactly one rule, except the fixtures whose table row says "two violations on purpose" or "intentional two violations" (`invalid-classify-options-before-output`, `invalid-decode-options-with-bad-output`, every `spec-order-*`), which pin which rule wins. `message` is compared only when present (the `spec` fixtures always give it).
- `image` is `{ width, height, data }`; `data` is an array of bytes, or `{ "fill": <byte>, "length": <n> }` standing for `n` copies of the byte (used for the 16,384-pixel fixtures). A `data` entry that is not an integer from 0 to 255 is a malformed fixture.
- A tensor is `{ shape: [ints], data: [numbers] }`. In `output` (classify), in tensor `data` (decode and pipeline outputs) an element may also be one of the strings `"NaN"`, `"Infinity"`, `"-Infinity"`, which the harness converts to the double (JSON has no way to write them). The same strings may stand for a box coordinate (`boxes` of `geometry`, `box` and `a`/`b` of `nms` and `metrics`) and for a `score`.
- `box` is `{ x1, y1, x2, y2 }`; a detection (decode and nms fixtures) is `{ box, classIndex, label, score }`; metrics detections are `{ image, classIndex, score, box }`, truths `{ image, classIndex, box }`.
- `options` of `classify` fixtures: `topK`, `minScore`. Of `decode` fixtures and of detect pipelines: `scoreThreshold`, `iouThreshold`, `maxDetections`, `nms`. A numeric option is a JSON number or `null`; `nms` a JSON boolean or `null`; `null` reaches the library as a bad value (`invalid_options`), never as "absent". Pipeline `options` carry no `clock` (the clock is the setup key `clock`).
- `spec` (in every kind but a malformed one) goes through `parseModelSpec`; it is a full spec (`input` has all seven required keys and `output` exists).
- `pipeline`: `scripted` is `{ "outputs": { name: tensor } }` or `{ "error": "<message>" }`. The harness builds `scriptedModel(outputs)` (or a model whose `run` throws a fresh error carrying the message, a non-`VisionError`), a recording wrapper, and a scripted clock that returns the four numbers of `clock` (an array of exactly 4 numbers) in order. It runs `classify` or `detect` with `options` plus that clock. The recording wrapper notes the number of clock reads at the moment `run` is called (it must be 2). A success must read the clock exactly four times and call the model exactly once.
  - `modelCalls` is the number of `run` calls (`1` after a successful run, `0` when validation failed first). `input` is the recorded input tensor of the single call, compared with tolerance. `clockReads` is the total number of clock reads when the call ended: `4` after a success, `2` when the model raised, `3` when the output was invalid, `0` when validation failed first. `geometry` is present exactly for `detect` (compared like the `geometry` kind) and absent for `classify`. `results` is the `entries` of `classify` or the `detections` of `detect`.
  - `{ error, modelCalls }` expects `classify`/`detect` to fail with that `VisionError` kind and the recorded call count to equal `modelCalls`; `clockReads` is compared as above (`0` when `modelCalls` is `0`: validation comes before the first read). `{ modelError, modelCalls }` expects the failure to be exactly the error thrown by the scripted model (the same object, not a `VisionError`, not wrapped) with that message and `modelCalls` calls.

## Comparison and harness

- `image` (resize): `width`, `height` exact; `data` exact byte for byte.
- `geometry`: `newWidth`, `newHeight` exact integers; `scaleX`, `scaleY`, `offsetX`, `offsetY` within `1e-9` absolute. `unmapped`: same length; each entry `null` exactly when expected `null`, else the four coordinates within `1e-9`.
- `tensor` / `input`: `shape` exact; `data` same length, every value within `1e-9` absolute.
- `entries`: same length; `index` exact; `label` exact; `score` within `1e-9`.
- `detections`: same length, in order; `classIndex`, `label` exact; `score` and the four box coordinates within `1e-9`.
- `metrics`: `value`, `ap`, `map` within `1e-9`; `byClass` same length, in order, `classIndex` exact.
- `timing`: the three values within `1e-9`. `modelCalls` exact.
- `error`: `kind` exact; `message` exact when expected. An unexpected error, or a missing error, fails the fixture.
- Every key an expectation lists is compared; keys absent from the expectation must be absent from the actual result (`unmapped`, `geometry`).
- Unknown keys are rejected on the raw JSON (before any typed parsing): the top level accepts only `name`, `setup`, `expect`; `setup` only `kind` and its kind's keys from the table; `image` only `width`, `height`, `data` (a `data` object only `fill`, `length`); a tensor only `shape`, `data`; a box only `x1`, `y1`, `x2`, `y2`; a detection (decode/nms) only `box`, `classIndex`, `label`, `score`; a metrics detection only `image`, `classIndex`, `score`, `box`; a truth only `image`, `classIndex`, `box`; a class-list entry of `byClass` only `classIndex`, `ap`; a classify entry only `index`, `label`, `score`; `scripted` only `outputs` or `error`; `options` only the keys of its kind; `geometry` only its six keys; `timing` only its three keys; `expect` only the keys of its kind (or `error`; a pipeline also `modelCalls`, `clockReads`, `modelError`). The content of `spec` is NOT checked by the harness: it goes to `parseModelSpec`, which rejects unknown keys itself.
- Values a typed API cannot represent are given to the library as an invalid value, so the `invalid-*` fixtures see the library's `VisionError(invalid_options)`, never a harness error (in a typed language the harness performs the same check as the library and raises the same error): a non-integer or `null` value for an integer option or size (`topK`, `maxDetections`, `k`, image and target sizes, `srcWidth`, `srcHeight`), a `null` for a number or boolean option, a `null` resize `method`, a method string that is not one of the two.
- Guard: the test asserts `fixtures.length >= 348`. Kotlin aggregates all failures and reports them together.

## Malformed fixtures

`runFixture` fails with `invalid fixture: <reason>` (an `Error` in TypeScript, an `IllegalStateException` in Kotlin) when the fixture itself is unusable. The reasons are identical in both harnesses:

- `unknown setup kind: <kind>` (also for names such as `constructor` or `__proto__`);
- `unknown key: <key>` (the offending key name only);
- `missing key: <key>` (a required key of the setup, an image, a tensor, a box, a detection, a metrics entry, an expectation is absent);
- `wrong type: <key>` (a JSON value of the wrong type: `name`, `kind`, `method`, `task`, `label`, `image` (metrics), `modelError` or `error` of `scripted` that is not a string; `fill`, `length`, `classIndex`, `index`, `modelCalls`, `clockReads` that are not integers; `width`/`height` of an image or target that are neither numbers nor `null`; a number field that is neither a number nor `null` (options) or, elsewhere, not a number; a boolean that is not a boolean; `shape`, `data`, `boxes`, `detections`, `truths`, `predictions`, `entries`, `byClass`, `output`, `clock` that are not arrays; `clock` with a length other than 4; a byte of `data` outside the integers 0 to 255; a tensor element that is neither a number nor one of the three non-finite strings);
- `unknown metrics op: <op>`;
- `clock called more than four times` (the library read the clock a fifth time; a failing fixture, reported as such);
- `expect has neither the keys of its kind nor error`.

A missing key is a malformed fixture, never `invalid_options`: the `invalid-*` fixtures always carry every required key with a bad value (an out-of-range number, `null`, a wrong length).

## Clarifications

These make the Rules exact where two implementations could otherwise differ. Several go beyond the design's wording; each says so.

1. **Half-pixel-centre mapping, written operation by operation.** `sx = (((x + 0.5) * srcW) / dstW) - 0.5`: `(x + 0.5) * srcW` is exact in doubles (a half-integer times an integer), and the division is correctly rounded, so every implementation gets the same double. Nearest uses `floor(sx + 0.5)`: a position that is exactly halfway between two source pixels goes to the larger index (`resize-nearest-downscale`, `resize-nearest-non-integer-ratio`). Bilinear uses `fx` computed from the unclamped `x0` and clamps `x0` and `x1` afterwards, independently. Pinned by `resize-bilinear-upscale`, `resize-bilinear-half-pixel-centers`, `resize-border-clamping`, `resize-bilinear-downscale`, `resize-1x1-source`, `resize-1x1-target`, `resize-identity`.
2. **Rounding is `floor(v + 0.5)` and the byte is rounded before normalization.** `4.5` becomes `5`, never `4` (round half to even) and never truncated. A resized pixel is a byte; normalization works on that byte. Pinned by `resize-rounding-half-up`, `tensor-resize-rounds-before-normalize`, `geometry-letterbox-rounds-half-up`, `geometry-centercrop-rounds-up`. Geometry rounds on the double `scale` (`geometry-letterbox-rounds-down`, `geometry-centercrop-rounds-down`, `geometry-centercrop-tie-up-from-odd`, `geometry-letterbox-double-tie`, `geometry-centercrop-double-tie`); `resample` is honored by letterbox and centerCrop (`tensor-letterbox-bilinear`, `tensor-letterbox-nearest-scaled`, `tensor-centercrop-bilinear`, `tensor-centercrop-nearest-scaled`).
3. **`scaleX` and `scaleY` are the actual content ratios (beyond the design's wording of "scale").** After rounding the resized size, the mapping back uses `newW / srcW` and `newH / srcH`, not the nominal `scale`: letterbox `3x1` to `8x6` has `scaleX = 8/3` but `scaleY = 3`. Pinned by `geometry-letterbox-odd-padding`, `geometry-letterbox-new-size-at-least-one`, `geometry-centercrop-rounds-up`, `unmap-letterbox`.
4. **Padding and crop halves.** An odd padding difference gives the extra pixel to the right or bottom (`padX = intdiv(dstW - newW, 2)`); an odd crop difference cuts the extra pixel on the right or bottom (`cropX = intdiv(scaledW - dstW, 2)`). Pinned by `geometry-letterbox-odd-padding`, `tensor-letterbox-pad`, `geometry-centercrop-odd-difference`.
5. **`offsetX = 0 - cropX`.** Written so that no `-0` appears; the mapping back stays `(u - offsetX) / scaleX`. Pinned by `geometry-centercrop-even`, `unmap-centercrop`.
6. **Centre crop resizes the whole image first, then cuts (beyond the design's wording).** The window is the pixel range `[cropX, cropX + dstW)` of the whole-image resize, computed with the destination coordinates shifted by `cropX`; cropping the source first and resizing it gives different pixels in general. Pinned by `tensor-centercrop`.
7. **`padValue` is a raw byte.** Default `114`, written in the canvas before the channel swap and normalized like a pixel (`tensor-padvalue-normalized`, `tensor-letterbox-pad`); with `dtype` `"uint8"` it stays a byte.
8. **Channel order and `mean`/`std` (beyond the design's wording of "the output channel").** The swap comes first; `mean[c]` and `std[c]` belong to the channel position `c` of the OUTPUT order (for `bgr`, `mean[0]` is the mean of blue). Normalizing in RGB order and swapping afterwards is the same error as indexing `mean` by the input channel, and gives different numbers whenever the three channels differ. Pinned by `tensor-bgr-swap-before-normalize`, `tensor-mean-std-output-channel-order`, `tensor-uint8-passthrough-keeps-swap`.
9. **Normalization is `(v * scale - mean) / std`.** Three operations in this order, not `(v - mean) * scale / std` and not `v * (scale / std)`. Defaults still run the same operations (`* 1`, `- 0`, `/ 1` are exact). Pinned by `tensor-scale-then-mean`.
10. **Softmax operation order.** `m`, then `exp(x - m)`, then the left-to-right sum starting from `0`, then one division each. Large logits do not overflow (`classify-softmax-stable-large-logits`: `exp(1000)` would be infinite). Equal logits give exactly equal scores (the same `exp` of the same double), so ties are real ties. Pinned by `classify-logits-softmax`, `classify-softmax-stable-large-logits`, `classify-topk-ties-by-index`, `classify-logits-all-equal`.
11. **Top-k and `minScore`.** Ranking is by descending score with exact ties by ascending index; `topK` larger than the class count returns every class; `minScore` is inclusive (a score equal to it stays), and the default `0` keeps even a score of exactly `0`. Pinned by `classify-topk-ties-by-index`, `classify-topk-larger-than-classes`, `classify-minscore-drops`, `classify-minscore-inclusive`, `classify-softmax-stable-large-logits`.
12. **Labels and the offset (beyond the design).** `index` and `classIndex` are the model's own ids; `labelOffset` is only subtracted for the label lookup. Classification with a label outside `labels` falls back to `#<index>` (a background class, or a short list), detection treats it as a bad output (`invalid_output`) because a class id outside the label list means the spec and the model disagree. Without `labels` both use `#<id>`; an empty `labels` array is a list, so detection rejects it. Pinned by `classify-labels-offset`, `classify-missing-label-fallback`, `classify-no-labels`, `decode-ssd-class-offset`, `invalid-decode-class-out-of-labels`, `pipeline-class-index-out-of-labels`.
13. **Validity does not depend on options.** Shapes, finiteness and class ids are checked on every examined row before thresholding, so a bad class id on a low-score row is still `invalid_output`; only `count` shortens what is examined. Pinned by `decode-class-check-before-threshold`, `decode-ssd-beyond-count-ignored`, `invalid-decode-non-finite-score`, `invalid-decode-class-not-integer`. Class ids are checked for every examined row of both decoders, against `labelOffset` and `labels` (`invalid-decode-rows-class-out-of-labels`, `decode-rows-label-offset`, `decode-empty-labels-array`, `decode-class-negative-index-with-offset`, `invalid-decode-class-negative`, `invalid-decode-class-too-large`); every non-finite value or result is `invalid_output` (`invalid-decode-rows-non-finite`, `invalid-decode-rows-non-finite-unused-column`, `invalid-decode-non-finite-box`, `-class`, `-count`, `-arithmetic`, `invalid-decode-rows-non-finite-arithmetic`, `classify-infinity-invalid`).
14. **`count` truncates, never rounds, and is clamped.** `floor(count)` clamped to `[0, n]`: `2.9` keeps two rows, `10` with two rows keeps both, a negative count keeps none. Pinned by `decode-ssd-count-truncates`, `decode-ssd-count-clamped`, `decode-ssd-count-negative`.
15. **Normalized coordinates scale by the model input, not the source.** `x * spec.input.width`, `y * spec.input.height`; the geometry then maps to the source. Pinned by `decode-ssd-yxyx-normalized` and `decode-ssd-normalized-different-sizes` (model input 100x50, source 400x300: scaling by the source size would give other numbers).
16. **Detection order is fixed.** Threshold (inclusive), coordinate swap, NMS, sort, cut, unmap, drop. NMS before the cut (a suppressed box cannot take a slot), the sort before the cut, the zero-area drop after the cut. Pinned by `decode-ssd-score-threshold-inclusive`, `decode-ssd-swapped-coordinates`, `decode-rows-nms-default-on`, `decode-maxdetections-after-sort`, `decode-ssd-sorted-before-cut`, `decode-zero-area-dropped`, `decode-unmap-letterbox`. NMS runs in model pixels before unmapping (`decode-nms-before-unmap`), the cut is before the zero-area drop (`decode-zero-area-drop-after-cut`) and the coordinate swap is before NMS (`decode-swap-before-nms`).
17. **NMS defaults (beyond the design: the default threshold).** `nms` defaults to on for `rows` and off for `ssd` (an `ssd` model usually post-processed already); the default `iouThreshold` is `0.5` (the design leaves it open). Pinned by `decode-rows-nms-default-on` (pairs with IoU `0.6` and about `0.538` lose their second box, a pair with IoU about `0.481` keeps both, so any default outside roughly `[0.481, 0.538)` fails), `decode-ssd-nms-default-off`, `decode-ssd-nms-option-true`, `decode-rows-nms-option-false`. `maxDetections` defaults to `100` (unit test). `nms()` itself returns the survivors in input order (clarification 18) and the default `iouThreshold` 0.5 is this contract's choice, not the model's. `maxDetections` 100 and the default `scoreThreshold` 0.3 are pinned by `decode-default-max-detections` and `decode-default-score-threshold`.
18. **NMS result order and cascade.** The survivors keep INPUT order (a subsequence); a suppressed box never suppresses (`nms-suppressed-box-does-not-suppress`); processing order is by descending score, ties by ascending input position (`nms-ties-by-index`, `nms-order-by-score-not-input`); classes never interact (`nms-class-aware`, `nms-keeps-lower-class-overlap`); the boundary is strict (`nms-strict-greater-boundary`; threshold `1` keeps even identical boxes, `nms-threshold-one-keeps-identical`; threshold `0` suppresses any overlap of positive area and keeps boxes that only touch, `nms-edge-touching-zero-iou`).
19. **IoU edge cases.** Intersection is `0` unless both overlap extents are positive; a union `<= 0` gives `0` (two identical zero-area boxes). Pinned by `iou-partial`, `iou-disjoint`, `iou-identical`, `iou-contained`, `iou-zero-area-union`, `iou-edge-touching`. Corners are never reordered: identical boxes with swapped corners give IoU `0` (`iou-swapped-boxes`); a non-finite coordinate is `invalid_options` (`invalid-iou-non-finite`).
20. **Average precision is VOC style.** A detection takes only its best-IoU truth of the same image and class; if that truth is taken or below the threshold it is a false positive, even when a lower-IoU truth would qualify; duplicates are false positives; precision is made non-increasing from the right; AP is the area over recall. Equal scores keep input order, so a tie between two detections can change the AP. The IoU test is inclusive. Pinned by `ap-perfect`, `ap-duplicate-detections-false-positive`, `ap-best-truth-no-fallback`, `ap-envelope`, `ap-score-ties-input-order`, `ap-multiple-images`, `ap-iou-threshold-inclusive`. With `iouThreshold` 0 there is no guard: a disjoint box (IoU `0 >= 0`) is a true positive (`ap-threshold-zero-disjoint-box`); equal IoU with two truths takes the first (`ap-truth-tie-first-wins`); the detections may come in any order (`ap-envelope`, `ap-duplicate-detections-false-positive` and `ap-multiple-images` list them unsorted). Metric inputs: non-finite score or box, negative or non-integer `classIndex` are `invalid_options` (`invalid-metrics-*`).
21. **Empty sets.** A class with truths and no detections: AP `0` (`ap-no-detections-zero`); a class with detections and no truths is skipped, so it neither appears in `byClass` nor changes `map` (`ap-class-without-truths-skipped`, `map-two-classes`); `map` with no truths at all is `0` (`map-no-truths-zero`); a class with truths and no detections counts as `0` in `map` (`map-class-without-detections-counts-zero`); `topKAccuracy` of no samples is `0` (`topk-empty-set-zero`), not `1`.
22. **`k` larger than the lists.** Only the entries that exist are searched (`topk-k-larger-than-lists`).
23. **Squeeze is by shape.** `[1, C]` and `[C]` are both a vector; `[1, n, 4]` and `[n, 4]` both boxes; a leading `1` is removed only when it is the batch dimension of a rank-3 box tensor, a rank-2 class or score tensor, or a rank-3 `rows` tensor. A rank-2 `[1, 4]` box tensor is one box, not a squeezed vector (it has no batch dimension to remove). Pinned by `classify-batch-dimension-squeezed`, `decode-ssd-yxyx-normalized` (batched), `decode-ssd-xyxy-pixels` (not batched), `decode-rows-transposed` (batched), `invalid-decode-boxes-shape`, `pipeline-invalid-output-shape`. A leading dimension other than 1 is not a batch (`invalid-decode-boxes-batch-2`, `invalid-decode-rows-batch-2`); negative dimensions are invalid (`invalid-decode-negative-dimension`); `count` is `[]` or `[1]` only (`invalid-decode-count-shape-vector`, `invalid-decode-count-shape-matrix`); a single row, a `rows` batch dimension and an empty `rows` are pinned by `decode-ssd-single-box`, `decode-rows-batch-dimension`, `decode-rows-empty`, and a `rows` tensor without class columns is `invalid_output` (`invalid-decode-rows-no-class-column`).
24. **The clock and the model are used once each, in a fixed order.** Four reads, one model call, validation before any of them; errors after the model call stop the sequence. Pinned by `pipeline-clock-timings`, `pipeline-single-model-call` (an empty result still costs one call and four reads), `pipeline-invalid-options-no-model-call`, `pipeline-model-error-propagates`. The number of reads at every exit is observable and pinned (`clockReads`: 4, 2, 3 or 0; the model runs after exactly 2); `detect` validates all its options before the first read like `classify` (`pipeline-detect-*`, `pipeline-classify-minscore-out-of-range`, `pipeline-invalid-image-no-clock`, `pipeline-spec-wrong-kind-for-*`); timings are not clamped (`pipeline-timing-negative-difference`).
25. **Fixture-only encodings.** `"NaN"`, `"Infinity"`, `"-Infinity"` strings in tensor data and the `{ fill, length }` image form are harness conveniences: JSON cannot write non-finite numbers and a 16,384-pixel image would not fit a fixture otherwise. Pinned by `invalid-decode-non-finite-score`, `pipeline-non-finite-output`, `invalid-image-too-large`, `resize-max-side-accepted`.
26. **`null` is a bad value, never "absent".** JSON `null` for an option or a spec key is invalid (`invalid_options`, or the key's own reason in a spec). Pinned by `invalid-null-option`, `invalid-nms-null`, `spec-invalid-padvalue-null`. Every optional spec key has its own null fixture (`spec-invalid-null-scale`, `-mean`, `-std`, `-labels`, `-labeloffset`, `-boxorder`, `-coordinates`, `-boxformat`, `-transposed`, `-objectness`, `-scoreactivation`) and so has every option (`invalid-minscore-null`, `invalid-score-threshold-null`, `invalid-iou-threshold-null`, `invalid-max-detections-null`, `invalid-resize-method-null`, `invalid-topk-k-null`, `invalid-ap-iou-threshold-null`, `invalid-nms-threshold-null`).
27. **`logistic` stays finite.** For a large negative `z`, `exp(0 - z)` overflows to infinity and `1 / (1 + inf)` is `0`; for a large positive `z`, `exp` underflows to `0` and the result is `1`. Pinned by `decode-rows-sigmoid`.
28. **Activation, then objectness, then best class.** With both `scoreActivation` sigmoid and `objectness`, the logistic function is applied to the objectness and to every class score first, then they are multiplied. Pinned by `decode-rows-objectness-sigmoid-order`.
29. **A spec is validated once, in one order, and the FIRST violated rule of the numbered list is the one reported.** Every violation has its own reason and fixture; the `spec-order-*` fixtures violate two rules each, on purpose, and pin the order (unknown key before missing key, missing key before value, width before layout, padValue before scale, std length before zero, scale type before uint8, layout before the output, exactly-one before the type, unknown output key before its value, labels before labelOffset, width before height, missing input before missing output, missing output before the type of input, required keys in the listed order, unknown input key before missing input key, output type before labels, dtype before padValue). The orders of rules that are not paired by a `spec-order-*` fixture (for example 9 before 10, 24 before 25, 27 `transposed` before `objectness`) are the numbered order but are not pinned: no fixture can tell them apart without one more two-violation fixture per pair. Pinned by the `spec-*` fixtures.
30. **Sizes.** Images, resize targets, `srcWidth`/`srcHeight` and spec input sizes are at most 16,384 per side (a 32-bit `Int` holds every product). A size of exactly 16,384 is accepted. Pinned by `resize-max-side-accepted`, `invalid-image-too-large`, `spec-invalid-width-too-large`.
31. **Doubles win over exact math (rewrites the earlier "not observable" claim).** The four bilinear terms are multiplied and added in the written order with weights `1 - f` and `f` computed once; a different association, a separable interpolation, `float32` weights or exact rational arithmetic changes bytes at exact `.5` ties (`resize-bilinear-non-dyadic-weights`: byte 137, exact math says 138; `resize-bilinear-double-tie-border`: 232, exact math says 233), and so does `fx`: it is computed from the UNCLAMPED `x0` and a clamped `x0` gives other bytes in rare cases (`resize-bilinear-clamped-fx-tie`: 234.49999999999997 and byte 234 as written, 234.50000000000003 and byte 235 with `fx` from the clamped `x0`). The geometry rounds `floor(srcW * scale + 0.5)` with the `scale` double computed first (`geometry-letterbox-double-tie`: newW 7 where `srcW * dstH / srcH` would give 8; `geometry-centercrop-double-tie`: scaledH 58 where exact math gives 59). Only the last bits of `exp` and of the logistic function, the order of the softmax summation (hidden by the `1e-9` tolerance) and `min`/`max` on equal inputs are unobservable; the `max(dstW, ...)` in `centerCrop` never changes a result.
32. **Boundary values and required keys.** `width`/`height` 16384, `labelOffset` +-1,000,000, `padValue` 0 and 255 (also on non-letterbox modes), a `scale` of 0 or a negative one, negative `mean` and negative non-zero `std` entries are valid (`spec-valid-boundaries`, `spec-valid-boundaries-negative`); `height`, `layout`, `channels`, `mode` and `resample` are required like the others (`spec-invalid-missing-*`); `padValue` 1.5 and -1, `height` 0 and 16385, `boxFormat` on `ssd` and `coordinates` on `rows` are invalid.
33. **Unit-test cases that no fixture can express.** `-0`, the JSON literals `224.0` and `1e999` (a parser that turns them into an integral double or an infinity), a Kotlin string spec that is not valid JSON (`spec must be valid JSON`), `unmapBox` source-size validation (the geometry kind validates the source first), a typed hand-built spec, input immutability. A negative tensor dimension is only consumed by the decoders and the pipeline, so it is pinned by `invalid-decode-negative-dimension`; there is no separate tensor-error fixture.
34. **Fractional `classIndex`.** In the `metrics` kind (detections and truths of `ap`/`map`) a `classIndex` that is a non-integer number is NOT a malformed fixture: it reaches the library and is `invalid_options` (fixture `invalid-metrics-class-fraction`); a `classIndex` that is not a number is `wrong type: classIndex`. In the detection inputs of the `nms` and `decode` kinds a non-integer `classIndex` is `wrong type: classIndex` (it cannot be represented as the library's integer). The list of `wrong type` keys in the Malformed fixtures section is read with this exception.
35. **Harness details agreed by both twins.** `classIndex` (in metrics, `nms` and `decode` detection inputs, and in model outputs) is an integer in `0..2147483647`; above that it is `invalid_options` (inputs) or `invalid_output` (outputs). `{ "fill", "length" }` image data: `length` is at most `2^30` (above it, `wrong type: length`). Integer options (`topK`, `maxDetections`, `k`) above `2^31 - 1` are valid integers (a Kotlin harness maps them to the largest `Int`). Equal non-finite values compare equal in the comparators. `postprocessDetections` validates its options before the source size. Hand-built typed specs with holes (sparse arrays) are rejected like any invalid spec. A model input of about `16384 x 16384` would need gigabytes of tensor memory: both libraries may fail with an out-of-memory error there; the contract only caps sizes.
36. **Non-finite check in the rows decoder covers the winning candidate.** After `obj * score`, only the BEST class of a row (its score and its box) is checked for finiteness; a non-best class score that overflows to `-Infinity` cannot win and is ignored (`+Infinity` always wins and is therefore reported). Pinned by `decode-rows-nonbest-overflow-ignored`.
37. **`nms` rejects non-finite scores and coordinates.** The public `nms` fails with `invalid_options` when any detection (of any class) has a score or a box coordinate that is NaN or an infinity, before any suppression; it never orders or compares such a value (an ordering that involves NaN is not a total order, so the result would depend on the sort algorithm, and the JVM sort can throw on it). It is the same rule `iou` already has (`invalid-iou-non-finite`) and the metrics have (`invalid-metrics-non-finite-score`); `postprocessDetections` never reaches it because the decoders reject non-finite values first (`invalid_output`). Pinned by `invalid-nms-non-finite-score`, `invalid-nms-infinite-score`, `invalid-nms-non-finite-box`, `invalid-nms-infinite-box`. The cost of `nms` is an implementation matter and does not change the result: the pairs an implementation may skip are exactly those whose overlap width is not positive, whose IoU is `0` and therefore never strictly above a threshold of at least `0`.

## Pinned by unit tests, not fixtures

- `parseModelSpec` rejects every invalid shape with the `invalid model spec:` prefix (one unit test per rule in addition to the fixtures; a Kotlin string input is parsed strictly first); hand-built typed specs are validated at runtime with the same rules.
- Calling `postprocessClassification` with a detector spec or `postprocessDetections` with a classifier spec is `invalid_options` (`invalid-classify-wrong-spec-kind`, `invalid-decode-wrong-spec-kind`, `pipeline-spec-wrong-kind-for-*` are the fixtures); `toTensor` validates its image (`invalid-tensor-image-length`); the default `maxDetections` 100 is `decode-default-max-detections`. What remains for unit tests: the same checks on hand-built typed objects.
- Inputs (images, tensors, specs, options, detections, metric lists) are not mutated; results are new objects.
- Huge sizes do not overflow: sizes above 16,384 per side are rejected with `invalid_options`; a centre crop whose scaled size exceeds 16,384 is computed without materializing the scaled image; resize of a 4096x4096 image completes in a few seconds (linear cost); `nms` of 100,000 candidate boxes of one class completes in a reasonable time (`nms` sweeps each class by x extent, so it is close to linear for boxes spread over the image and stays quadratic only when many overlapping boxes all survive, and the sorts are `O(n log n)`).
- A non-provider exception, a `CancellationException` (Kotlin) or an `Error` thrown by the model or the clock propagates unchanged from `classify` and `detect`.
- `scriptedModel` ignores the values of its input, records each call, and returns the same named tensors each time.
- A byte array is read as unsigned (`255`, not `-1`) in Kotlin.
- No `Math.round`, `roundToInt`, `rint`, `Float`, `Math.fround`, regular expression or locale-aware helper appears in the library sources (a source scan).
- The harness comparators reject wrong data (a self-test of the comparison functions).

## Worked examples

**Bilinear downscale (`resize-bilinear-downscale`).** A `4x4` image to `2x2`: `sx = ((x + 0.5) * 4) / 2 - 0.5 = 2x + 0.5`, so `x0 = 2x`, `fx = 0.5`, `x1 = 2x + 1` (likewise `y`), all four weights are `0.25`, and the output pixel is the average of a 2x2 block. The red block `10 20 / 12 18` gives `(10 + 20 + 12 + 18) / 4 = 15`.

**Letterbox (`geometry-letterbox-odd-padding`).** A `3x1` source into an `8x6` model input: `rx = 8/3`, `ry = 6`, `scale = 8/3`; `newW = roundHalfUp(3 * 2.666...) = 8`, `newH = roundHalfUp(2.666...) = 3`; `padX = intdiv(0, 2) = 0`, `padY = intdiv(3, 2) = 1`; `scaleX = 8/3`, `scaleY = 3/1 = 3`, `offsetX = 0`, `offsetY = 1`. A model box with `y1 = 2`, `y2 = 3` (inside the content rows `1` to `4`) maps back to `(2 - 1) / 3 = 0.333...` and `(3 - 1) / 3 = 0.666...`; a box with `y1 = 0`, `y2 = 1` lies in the top padding, maps to `-0.333...` and `0`, clamps to `0` and `0` and is dropped.

**Average precision (`ap-envelope`).** Three truths, detections in score order `FP, TP, FP, TP, TP`: precisions `0, 1/2, 1/3, 1/2, 3/5`, recalls `0, 1/3, 1/3, 2/3, 1`; envelope from the right `3/5` everywhere; `ap = (1/3 + 0 + 1/3 + 1/3) * 3/5 = 0.6`. Without the envelope it would be `0.5333...`.

## Fixtures

348 fixtures. Rows marked "intentional two violations" or "two violations on purpose" break two rules at once to pin which one wins; every other `invalid-*` and `spec-invalid-*` fixture breaks exactly one rule. `resize-max-side-accepted` is an acceptance-only fixture (its image is constant).

| Fixture | Kind | Rule it pins |
|---|---|---|
| `resize-nearest-upscale` | `resize` | nearest upscale 2x2 to 4x4: destination x maps to source index floor(sx + 0.5) with half-pixel centres ([0,0,1,1] per axis) |
| `resize-nearest-downscale` | `resize` | nearest downscale 4x4 to 2x2 lands exactly halfway between source pixels and takes the larger index (ties go up) |
| `resize-nearest-non-integer-ratio` | `resize` | nearest 3x2 to 5x3 with non-integer ratios: index maps [0,0,1,2,2] and [0,1,1], one axis ending on an exact tie |
| `resize-bilinear-upscale` | `resize` | bilinear upscale 2x2 to 4x4: half-pixel centres give weights 1, 3/4+1/4, 1/4+3/4, 1 per axis and clamp at both borders |
| `resize-bilinear-downscale` | `resize` | bilinear downscale 4x4 to 2x2 at fx = fy = 0.5 is the average of each 2x2 block |
| `resize-bilinear-half-pixel-centers` | `resize` | bilinear 2x1 to 8x1: positions x/4 - 0.375 (eighth weights), the two outer pixels on each side clamp to the border |
| `resize-1x1-source` | `resize` | a 1x1 source upscaled with bilinear gives the same pixel everywhere (every neighbour clamps to it) |
| `resize-1x1-target` | `resize` | downscaling to a 1x1 target samples the centre: the average of the four central pixels of 4x2 (sx = 1.5, sy = 0.5) |
| `resize-odd-sizes` | `resize` | bilinear 3x3 to 2x2 (odd source): positions 0.25 and 1.75 on each axis, quarter weights |
| `resize-border-clamping` | `resize` | bilinear 3x1 to 6x1: the first pixel (x0 = -1) and the last (x1 beyond the row) clamp to the border pixel, fx unchanged |
| `resize-rounding-half-up` | `resize` | bilinear results exactly on .5 round up (4.5 to 5, 0.5 to 1, 254.5 to 255), not to even and not truncated |
| `resize-identity` | `resize` | bilinear to the same size (3x2) returns the source bytes: sx = x exactly, fx = 0 |
| `resize-extreme-ratio` | `resize` | bilinear 8x2 to 1x1 (8:1 ratio): only the pixels at sx = 3.5 and sy = 0.5 contribute (85, 76, and 127.5 rounded up to 128) |
| `resize-max-side-accepted` | `resize` | an image of exactly 16384 pixels wide is accepted (the limit is inclusive) |
| `geometry-stretch` | `geometry` | stretch scales each axis independently (224/640 and 224/480) with no offset |
| `geometry-centercrop-even` | `geometry` | centerCrop 400x200 to 100x100: scale 0.5, scaled 200x100, crop 50 on x with offsetX = -50 |
| `geometry-centercrop-odd-difference` | `geometry` | centerCrop 8x4 to 5x5: scaled 10x5, an odd difference of 5 crops floor(5/2) = 2 on the left |
| `geometry-centercrop-rounds-up` | `geometry` | centerCrop 6x4 to 5x5: 6 * 1.25 = 7.5 rounds half up to 8, scaleX = 8/6 differs from scaleY = 1.25 |
| `geometry-centercrop-downscale` | `geometry` | centerCrop 5x4 to 3x3 (scale 0.75 below 1): 3.75 rounds up to 4, no crop on y |
| `geometry-letterbox-wide` | `geometry` | letterbox 640x360 to 320x320: scale 0.5, content 320x180, padY = 70 and no padX |
| `geometry-letterbox-tall` | `geometry` | letterbox 360x640 to 320x320: scale 0.5, content 180x320, padX = 70 and no padY |
| `geometry-letterbox-odd-padding` | `geometry` | letterbox 3x1 to 8x6: an odd padding of 3 gives padY = 1 (extra pixel at the bottom); scaleY = newH/srcH = 3, not the nominal scale 8/3 |
| `geometry-letterbox-new-size-at-least-one` | `geometry` | letterbox 1000x1 to 4x4: newH = max(1, roundHalfUp(0.004)) = 1, scaleY = 1 |
| `geometry-letterbox-rounds-half-up` | `geometry` | letterbox 2x1 to 5x9: newH = roundHalfUp(2.5) = 3 (not 2), padY = 3 |
| `unmap-stretch` | `geometry` | unmapBox through stretch divides by the per-axis scale (0.5 and 1) |
| `unmap-centercrop` | `geometry` | unmapBox through centerCrop adds the cropped columns back: (x + 2) / 1.25 |
| `unmap-letterbox` | `geometry` | unmapBox through letterbox subtracts the padding before dividing: (y - 70) / 0.5 |
| `unmap-clamps` | `geometry` | unmapBox clamps to the source image on every side |
| `unmap-box-in-padding-dropped` | `geometry` | a box entirely in the top or bottom padding, or with zero width, has no area after clamping and is dropped (null); a box beside them is kept |
| `tensor-nhwc-rgb` | `tensor` | nhwc rgb, defaults (scale 1, mean 0, std 1): the bytes in pixel order, shape [1,2,2,3] |
| `tensor-nchw-rgb` | `tensor` | nchw puts the planes one after the other (R plane, G plane, B plane), shape [1,3,2,2] |
| `tensor-bgr-swap-before-normalize` | `tensor` | bgr swaps first, then mean and std apply to the swapped channels: (30-1)/2, (20-2)/4, (10-3)/8 |
| `tensor-mean-std-output-channel-order` | `tensor` | ImageNet-style bgr nchw: mean[0] and std[0] belong to the first OUTPUT channel (blue), values with scale 1/255 |
| `tensor-scale-then-mean` | `tensor` | normalization is (v * scale - mean) / std, not (v - mean) * scale / std |
| `tensor-padvalue-normalized` | `tensor` | letterbox padding bytes (padValue 100) are normalized like pixels: (100 * 0.5 - mean) / std per channel |
| `tensor-uint8-passthrough-keeps-swap` | `tensor` | dtype uint8 keeps the bytes unchanged but still applies the bgr swap and the nchw layout |
| `tensor-letterbox-pad` | `tensor` | letterbox 1x2 into 4x2 with the default padValue 114: one pad column on the left, two on the right (the odd extra goes right) |
| `tensor-centercrop` | `tensor` | centerCrop 8x4 to 3x3 resizes the whole image to 6x3 then cuts columns 1..3 (columns [2,3,4], rows [0,2,3]); cropping the source first would give other columns |
| `tensor-resize-rounds-before-normalize` | `tensor` | bilinear gives bytes first (2.5 becomes 3, 7.5 becomes 8), then scale 0.1 applies: 0.3, not 0.25 |
| `classify-logits-softmax` | `classify` | stable softmax of [2, 1, 0.1], descending order, labels from the list |
| `classify-softmax-stable-large-logits` | `classify` | logits near 1000 do not overflow (max subtraction); a very negative logit gives exactly 0, still kept by the default minScore 0 |
| `classify-probabilities-as-given` | `classify` | probabilities are used as given (not renormalized, not softmaxed): [0.2, 0.5, 0.1] sums to 0.8 |
| `classify-topk-ties-by-index` | `classify` | equal scores (three equal logits) are ordered by ascending index and topK 2 cuts the third tie |
| `classify-logits-all-equal` | `classify` | four equal logits give exactly 0.25 each in index order |
| `classify-minscore-drops` | `classify` | entries below minScore are dropped (0.15 and 0.05 below 0.2) |
| `classify-minscore-inclusive` | `classify` | a score exactly equal to minScore stays (0.25 with minScore 0.25) |
| `classify-minscore-drops-all` | `classify` | when every score is below minScore the result is an empty list |
| `classify-topk-larger-than-classes` | `classify` | topK larger than the number of classes returns every class |
| `classify-labels-offset` | `classify` | label = labels[index - labelOffset]; index 0 with offset 1 has no label and falls back to #0; the entry index stays the model's |
| `classify-missing-label-fallback` | `classify` | an index beyond the labels list gets #<index> (#2, #3) |
| `classify-no-labels` | `classify` | without labels every label is #<index> |
| `classify-single-class` | `classify` | one logit gives probability exactly 1 |
| `decode-ssd-yxyx-normalized` | `decode` | ssd default order [ymin,xmin,ymax,xmax], normalized to the model input size (200x100), batched shapes [1,n,4]/[1,n]; a 0.1 score is below the default threshold 0.3 |
| `decode-ssd-xyxy-pixels` | `decode` | ssd boxOrder xyxy with pixel coordinates, no batch dimension, no labels (#id) |
| `decode-ssd-count-truncates` | `decode` | count 2.9 keeps the first two of four rows (floor, never rounded up) |
| `decode-ssd-count-clamped` | `decode` | a count above n (10 for 2 rows) keeps every row |
| `decode-ssd-count-negative` | `decode` | a negative count keeps no row |
| `decode-ssd-beyond-count-ignored` | `decode` | rows beyond count are not examined at all: a NaN box and class 99 outside the labels there are ignored |
| `decode-ssd-class-offset` | `decode` | labelOffset 1: class id 1 is labels[0] (person) and id 3 is labels[2] (car); classIndex stays the model id |
| `decode-ssd-score-threshold-inclusive` | `decode` | a score equal to scoreThreshold (0.5) is kept, 0.49 is dropped; output sorted by score |
| `decode-ssd-sorted-before-cut` | `decode` | maxDetections 2 on rows with scores [0.5,0.6,0.9,0.7] keeps the two best (0.9, 0.7), not the first two rows |
| `decode-ssd-swapped-coordinates` | `decode` | a box with x2 < x1 and y2 < y1 is swapped on both axes; another with only x swapped on x |
| `decode-ssd-nms-default-off` | `decode` | ssd does not run NMS by default: two heavily overlapping boxes of one class both stay |
| `decode-ssd-nms-option-true` | `decode` | nms: true turns NMS on for ssd (IoU 0.8 > default 0.5 suppresses the second box) |
| `decode-equal-scores-keep-row-order` | `decode` | equal scores keep ascending row order (rows with classes 3,1,2,0 all scoring 0.8) |
| `decode-ssd-empty` | `decode` | n = 0 (shape [1,0,4]) gives no detections |
| `decode-rows-xywh` | `decode` | rows with boxFormat xywh: x1 = cx - w/2 (w = 15 gives 42.5), best class per row, sorted by score |
| `decode-rows-xyxy` | `decode` | rows with boxFormat xyxy are taken as they are |
| `decode-rows-transposed` | `decode` | transposed rows [1,6,2] (columns first, with a batch dimension) decode like the xywh fixture |
| `decode-rows-objectness` | `decode` | objectness multiplies the class scores: 0.5 * 0.9 = 0.45 survives, 0.2 * 0.9 = 0.18 falls below 0.3 |
| `decode-rows-nonbest-overflow-ignored` | `decode` | a non-best class score that overflows to -Infinity after the objectness multiply cannot win and is ignored: only the winning candidate is checked for finiteness (here class 0 scores -5e307, fails the threshold, result empty) |
| `decode-rows-sigmoid` | `decode` | sigmoid activation: logistic(2) = 0.8807970779778823, logistic(0) = 0.5, +-1000 stay finite (1 and 0), logistic(-2) = 0.119 is dropped |
| `decode-rows-objectness-sigmoid-order` | `decode` | with sigmoid and objectness the logistic applies to objectness and class first, then they multiply: 0.5 * 0.8807970779778823 |
| `decode-rows-best-class-ties-lowest-index` | `decode` | equal best class scores pick the lowest class index (0.6,0.6,0.2 gives class 0; 0.1,0.7,0.7 gives class 1) |
| `decode-rows-nms-default-on` | `decode` | rows run class-aware NMS at the default IoU 0.5: pairs with IoU 0.6 and 0.538 lose their second box, a pair with IoU 0.481 keeps both |
| `decode-rows-nms-option-false` | `decode` | nms: false disables NMS for rows: both overlapping boxes stay |
| `decode-maxdetections-after-sort` | `decode` | NMS and the sort come before the cut: with maxDetections 2 the suppressed 0.85 box does not take a slot, so the 0.8 box of class 1 is kept |
| `decode-unmap-letterbox` | `decode` | boxes of a 100x100 letterboxed model (source 200x100, padY 25, scale 0.5) are unmapped; a box inside the padding is dropped, a partly padded one is clamped |
| `decode-zero-area-dropped` | `decode` | boxes with zero width, zero height, or entirely outside the source (clamped to zero width) are dropped after mapping |
| `decode-class-check-before-threshold` | `decode` | a class id outside the labels on a row below the threshold is still invalid_output (validity does not depend on options) |
| `nms-class-aware` | `nms` | boxes of different classes never suppress each other; the overlapping same-class box (IoU 0.68) is dropped |
| `nms-strict-greater-boundary` | `nms` | IoU exactly equal to the threshold (0.5) does not suppress; IoU 0.6 does |
| `nms-ties-by-index` | `nms` | equal scores: the box with the lower input index is kept, the later overlapping one is dropped |
| `nms-identical-boxes` | `nms` | three identical boxes of one class: only the best-scoring one survives |
| `nms-threshold-one-keeps-identical` | `nms` | with iouThreshold 1 even identical boxes stay (IoU 1 is not strictly greater than 1) |
| `nms-edge-touching-zero-iou` | `nms` | boxes touching on an edge or a corner have IoU 0, so even iouThreshold 0 keeps them |
| `nms-threshold-zero-suppresses-any-overlap` | `nms` | iouThreshold 0 suppresses any box with a positive-area overlap (IoU about 0.003) |
| `nms-keeps-lower-class-overlap` | `nms` | a lower-scoring box of another class overlapping a better box stays; its same-class twin does not |
| `nms-order-by-score-not-input` | `nms` | boxes are processed by descending score, not input order: the later 0.9 box suppresses the earlier 0.5 one |
| `nms-suppressed-box-does-not-suppress` | `nms` | a suppressed box never suppresses: B (suppressed by A) overlaps C, but C survives because A and C barely overlap |
| `nms-empty` | `nms` | no detections give no detections |
| `iou-partial` | `metrics` | two 10x10 boxes offset by 5 on both axes: 25 / 175 |
| `iou-disjoint` | `metrics` | disjoint boxes have IoU 0 |
| `iou-identical` | `metrics` | identical boxes have IoU 1 |
| `iou-contained` | `metrics` | a box inside another: 16 / 100 |
| `iou-edge-touching` | `metrics` | boxes sharing only an edge have intersection 0 and IoU 0 |
| `iou-zero-area-union` | `metrics` | two identical zero-area boxes have a union of 0 and IoU 0 (no division by zero) |
| `topk-basic` | `metrics` | top-2 accuracy of four samples: hits on samples 0, 1 and 3 give 3/4 |
| `topk-empty-set-zero` | `metrics` | no samples gives 0 (not 1) |
| `topk-k-larger-than-lists` | `metrics` | k = 5 with lists of length 1 and 2 only searches the entries that exist: 1 hit of 2 |
| `ap-perfect` | `metrics` | every truth matched by a higher-scored exact detection gives AP 1 |
| `ap-no-detections-zero` | `metrics` | a class with truths and no detections has AP 0 |
| `ap-duplicate-detections-false-positive` | `metrics` | a second detection of an already matched truth is a false positive (0.9 TP, 0.8 duplicate FP, 0.7 TP): AP 5/6 |
| `ap-best-truth-no-fallback` | `metrics` | a detection whose best-IoU truth is taken is a false positive even if a second truth has IoU 0.89 (VOC style): AP 0.5, not 1 |
| `ap-envelope` | `metrics` | precision is made non-increasing from the right: FP,TP,FP,TP,TP over 3 truths gives 0.6 (0.5333 without the envelope) |
| `ap-score-ties-input-order` | `metrics` | equal scores keep input order: TP then FP then TP gives 5/6 (FP then TP then TP would give 2/3) |
| `ap-multiple-images` | `metrics` | a detection only matches truths of its own image (image c has none: false positive); two classes are reported in ascending class order |
| `ap-class-without-truths-skipped` | `metrics` | a class with detections but no truths is not listed |
| `ap-iou-threshold-inclusive` | `metrics` | IoU exactly equal to iouThreshold (0.5) is a true positive |
| `ap-below-threshold-false-positive` | `metrics` | IoU 0.4 below the threshold is a false positive: AP 0 |
| `map-two-classes` | `metrics` | mAP averages the classes that have truths (AP 1 and AP 0.5): 0.75; the truthless class 7 is skipped |
| `map-no-truths-zero` | `metrics` | no truths at all: mAP 0 and no classes |
| `map-class-without-detections-counts-zero` | `metrics` | a class with truths and no detections counts as AP 0 in the mean: (1 + 0) / 2 |
| `pipeline-classify-basic` | `pipeline` | classify: preprocess, one model call, softmax and top-2, labels, timings from the clock [100, 102.5, 130, 131.25] |
| `pipeline-detect-basic` | `pipeline` | detect: nearest 4x2 to 2x2, ssd normalized boxes in model pixels, unmapped to the source (scaleX 0.5, scaleY 1), timings 1, 2, 0.5 |
| `pipeline-single-model-call` | `pipeline` | an empty result (all scores below the threshold) still costs exactly one model call and four clock reads |
| `pipeline-input-tensor-recorded` | `pipeline` | the recorded model input is the exact tensor of toTensor: letterbox 1x2 into 3x2, padValue 50, bgr, nchw, mean 10,20,30 and std 2 |
| `pipeline-clock-timings` | `pipeline` | the three timings are the successive differences of the four reads: [5, 7, 20, 20.5] gives 2, 13, 0.5 |
| `classify-batch-dimension-squeezed` | `pipeline` | a classifier output of shape [1, C] is squeezed to the vector [C] |
| `pipeline-extra-output-tensors-ignored` | `pipeline` | tensors other than the one the task reads are ignored (an extra NaN tensor does not matter) |
| `pipeline-model-error-propagates` | `pipeline` | an error thrown by the model reaches the caller unchanged (not wrapped, not a VisionError) after exactly one call |
| `pipeline-invalid-output-shape` | `pipeline` | a classifier output of shape [2, 3] (not [C] or [1, C]) is invalid_output after one call |
| `pipeline-non-finite-output` | `pipeline` | a NaN in the classifier output is invalid_output |
| `pipeline-missing-output-tensor` | `pipeline` | a classifier model that returns no tensor named output is invalid_output |
| `pipeline-class-index-out-of-labels` | `pipeline` | a detector class id (2) outside the labels list (2 entries) is invalid_output |
| `pipeline-invalid-options-no-model-call` | `pipeline` | an invalid option (topK 0) fails before any clock read or model call: modelCalls 0 |
| `invalid-topk-zero` | `metrics` | topKAccuracy with k = 0 is invalid_options |
| `invalid-topk-length-mismatch` | `metrics` | topKAccuracy with 2 prediction lists and 1 truth is invalid_options |
| `invalid-classify-topk-zero` | `classify` | classification topK 0 is invalid_options |
| `invalid-topk-fraction` | `classify` | classification topK 2.5 is not an integer: invalid_options |
| `invalid-null-option` | `classify` | JSON null for an option (topK) is a bad value, not an absent one: invalid_options |
| `invalid-minscore-out-of-range` | `classify` | minScore 1.5 is outside [0, 1]: invalid_options |
| `invalid-classify-options-before-output` | `classify` | precedence (two violations on purpose): options are validated before the output, so topK 0 with an empty output is invalid_options, not invalid_output |
| `invalid-classify-empty-output` | `classify` | an empty classification vector is invalid_output |
| `invalid-classify-non-finite` | `classify` | a NaN logit is invalid_output |
| `invalid-classify-negative-probability` | `classify` | a negative probability is invalid_output |
| `invalid-score-threshold-out-of-range` | `decode` | scoreThreshold 1.5 is outside [0, 1]: invalid_options |
| `invalid-iou-threshold-out-of-range` | `decode` | iouThreshold -0.1 is outside [0, 1]: invalid_options (validated even though ssd does not run NMS) |
| `invalid-max-detections-zero` | `decode` | maxDetections 0 is invalid_options |
| `invalid-nms-null` | `decode` | JSON null for nms is a bad value: invalid_options |
| `invalid-decode-missing-tensor` | `decode` | an ssd output without the scores tensor is invalid_output |
| `invalid-decode-boxes-shape` | `decode` | ssd boxes of shape [2, 3] (last dimension not 4) are invalid_output |
| `invalid-decode-length-mismatch` | `decode` | ssd boxes for 2 rows but 3 scores is invalid_output |
| `invalid-decode-data-length` | `decode` | a tensor whose data length (3) does not match its shape [1, 4] is invalid_output |
| `invalid-decode-non-finite-score` | `decode` | a NaN score on an examined row is invalid_output (even when the row would be below the threshold) |
| `invalid-decode-class-not-integer` | `decode` | a class id 1.5 is invalid_output |
| `invalid-decode-class-out-of-labels` | `decode` | class id 2 with labels of 2 entries (no offset) is invalid_output |
| `invalid-decode-rows-too-few-columns` | `decode` | a rows tensor with only 4 columns (no class column) is invalid_output |
| `invalid-image-data-length` | `resize` | an image whose data has 11 bytes instead of 2*2*3 is invalid_options |
| `invalid-image-size-zero` | `resize` | an image with width 0 is invalid_options |
| `invalid-image-too-large` | `resize` | an image 16385 pixels wide (valid data length) is rejected: above 16384 per side is invalid_options |
| `invalid-resize-method` | `resize` | a resize method other than nearest or bilinear is invalid_options |
| `invalid-resize-target-zero` | `resize` | a resize target of width 0 is invalid_options |
| `invalid-geometry-source-zero` | `geometry` | a geometry source width of 0 is invalid_options |
| `invalid-ap-iou-threshold-out-of-range` | `metrics` | averagePrecision with iouThreshold 1.5 is invalid_options |
| `invalid-nms-threshold-out-of-range` | `nms` | nms with iouThreshold 2 is invalid_options |
| `spec-valid-minimal` | `spec` | the smallest valid spec: seven required input keys and a classifier output |
| `spec-valid-detector` | `spec` | a letterboxed ssd detector with every optional key (padValue, scale, mean, std, boxOrder, coordinates, labels, labelOffset) |
| `spec-valid-rows` | `spec` | a uint8 centerCrop rows detector with transposed, objectness, boxFormat and scoreActivation, and empty labels |
| `spec-invalid-not-object` | `spec` | rule 1: the spec is an array, not an object |
| `spec-invalid-null` | `spec` | rule 1: JSON null is not an object |
| `spec-invalid-unknown-key` | `spec` | rule 2: an unknown top-level key |
| `spec-invalid-missing-input` | `spec` | rule 3: no input key |
| `spec-invalid-missing-output` | `spec` | rule 3: no output key |
| `spec-invalid-input-not-object` | `spec` | rule 4: input is a string |
| `spec-invalid-unknown-input-key` | `spec` | rule 5: an unknown input key |
| `spec-invalid-missing-input-width` | `spec` | rule 6: input.width missing |
| `spec-invalid-missing-input-dtype` | `spec` | rule 6: input.dtype missing (the last required key) |
| `spec-invalid-width-zero` | `spec` | rule 7: input.width 0 |
| `spec-invalid-height-fraction` | `spec` | rule 7: input.height 2.5 is not an integer |
| `spec-invalid-width-too-large` | `spec` | rule 7: input.width 16385 is above the limit |
| `spec-invalid-width-string` | `spec` | rule 7: input.width given as a string |
| `spec-invalid-layout` | `spec` | rule 8: input.layout other than nhwc or nchw |
| `spec-invalid-channels` | `spec` | rule 9: input.channels other than rgb or bgr |
| `spec-invalid-mode` | `spec` | rule 10: input.mode other than the three modes (case-sensitive) |
| `spec-invalid-resample` | `spec` | rule 11: input.resample other than nearest or bilinear |
| `spec-invalid-dtype` | `spec` | rule 12: input.dtype other than float or uint8 |
| `spec-invalid-padvalue-range` | `spec` | rule 13: padValue 256 is above 255 |
| `spec-invalid-padvalue-null` | `spec` | rule 13: padValue null is not absent |
| `spec-invalid-scale-type` | `spec` | rule 14: scale given as a string |
| `spec-invalid-mean-length` | `spec` | rule 15: mean with 2 entries |
| `spec-invalid-mean-entry` | `spec` | rule 15: a mean entry that is a string |
| `spec-invalid-std-not-array` | `spec` | rule 16: std is a number |
| `spec-invalid-std-zero` | `spec` | rule 17: a std entry equal to 0 |
| `spec-invalid-uint8-scale` | `spec` | rule 18: dtype uint8 with scale |
| `spec-invalid-uint8-mean` | `spec` | rule 18: dtype uint8 with mean |
| `spec-invalid-uint8-std` | `spec` | rule 18: dtype uint8 with std |
| `spec-invalid-output-not-object` | `spec` | rule 19: output is an array |
| `spec-invalid-output-both` | `spec` | rule 20: output has both type and format |
| `spec-invalid-output-neither` | `spec` | rule 20: output has neither type nor format |
| `spec-invalid-output-type` | `spec` | rule 21: output.type other than logits or probabilities |
| `spec-invalid-output-format` | `spec` | rule 22: output.format other than ssd or rows |
| `spec-invalid-output-unknown-key` | `spec` | rule 23: a classifier output with an extra key |
| `spec-invalid-ssd-transposed` | `spec` | rule 23: transposed belongs to rows, not ssd |
| `spec-invalid-rows-boxorder` | `spec` | rule 23: boxOrder belongs to ssd, not rows |
| `spec-invalid-boxorder-value` | `spec` | rule 24: boxOrder other than yxyx or xyxy |
| `spec-invalid-coordinates-value` | `spec` | rule 25: coordinates other than normalized or pixels |
| `spec-invalid-boxformat-value` | `spec` | rule 26: boxFormat other than xywh or xyxy |
| `spec-invalid-transposed-type` | `spec` | rule 27: transposed given as a string |
| `spec-invalid-objectness-type` | `spec` | rule 27: objectness given as a number |
| `spec-invalid-scoreactivation-value` | `spec` | rule 28: scoreActivation other than none or sigmoid |
| `spec-invalid-labels-not-array` | `spec` | rule 29: labels is a string |
| `spec-invalid-labels-entry-type` | `spec` | rule 29: a labels entry that is a number |
| `spec-invalid-labeloffset-fraction` | `spec` | rule 30: labelOffset 0.5 is not an integer |
| `spec-invalid-labeloffset-range` | `spec` | rule 30: labelOffset 1000001 is above the limit |
| `spec-invalid-labeloffset-string` | `spec` | rule 30: labelOffset given as a string |
| `resize-bilinear-non-dyadic-weights` | `resize` | non-dyadic weights: the written double operation order gives byte 137 where exact rational math gives 138 (doubles win over exact math) |
| `resize-bilinear-double-tie-border` | `resize` | bilinear 2x1 to 1x3: the exact value 232.5 evaluates to 232.49999999999997 in doubles and rounds to 232 (exact math says 233) |
| `geometry-letterbox-rounds-down` | `geometry` | letterbox 10x3 to 4x4: newH = roundHalfUp(1.2) = 1 (not 2), padY = 1, scaleY = 1/3 |
| `geometry-letterbox-double-tie` | `geometry` | letterbox 11x22 to 8x15: 11 * (15/22) is 7.499999999999999 in doubles (exact math says 7.5), so newW = 7, not 8 |
| `geometry-centercrop-rounds-down` | `geometry` | centerCrop 10x3 to 4x4: scaledW = roundHalfUp(13.33) = 13 (not 14), crop 4 |
| `geometry-centercrop-tie-up-from-odd` | `geometry` | centerCrop 3x4 to 4x6: scaledW = roundHalfUp(4.5) = 5 (a tie goes up), crop 0 on x |
| `geometry-centercrop-double-tie` | `geometry` | centerCrop 6x27 to 13x2: 27 * (13/6) is 58.49999999999999 in doubles (exact math says 58.5), so scaledH = 58, offsetY = -28 |
| `unmap-swapped-box-dropped` | `geometry` | unmapBox does not reorder: a box with x1 > x2 and y1 > y2 has a negative extent after mapping and is dropped (null), its reordered twin is kept |
| `invalid-unmap-non-finite` | `geometry` | a non-finite box coordinate given to unmapBox is invalid_options |
| `tensor-letterbox-bilinear` | `tensor` | letterbox 3x2 into 5x5 with bilinear resample: the content (5x3, padY 1) is bilinearly resized and padded with 114 |
| `tensor-letterbox-nearest-scaled` | `tensor` | letterbox 3x2 into 5x5 with nearest resample: the content (5x3) repeats source pixels, padding 114 |
| `tensor-centercrop-bilinear` | `tensor` | centerCrop 5x3 to 4x4 with bilinear resample: whole-image bilinear resize to 7x4 then the centred window |
| `tensor-centercrop-nearest-scaled` | `tensor` | centerCrop 5x3 to 4x4 with nearest resample: nearest resize to 7x4 then the centred window |
| `tensor-nchw-non-square` | `tensor` | nchw of a 3x2 (width 3, height 2) image: each plane is row-major with shape [1,3,2,3] (width and height are not mixed up) |
| `invalid-tensor-image-length` | `tensor` | toTensor validates the image: 11 bytes instead of 12 is invalid_options |
| `decode-nms-before-unmap` | `decode` | NMS runs in model pixels before unmapping: the 0.8 box (IoU 0.44 > 0.3) is suppressed, then the 0.9 box lies in the padding and is dropped, leaving nothing (NMS after unmapping would keep the second box) |
| `decode-zero-area-drop-after-cut` | `decode` | the cut to maxDetections comes before unmapping: with maxDetections 1 the best box (0.9, in the padding) takes the slot and is then dropped, so the result is empty |
| `decode-swap-before-nms` | `decode` | coordinates are swapped before NMS: the swapped 0.8 box (48,48,12,12) becomes (12,12,48,48), overlaps the 0.9 box with IoU 0.81 and is suppressed (unswapped its IoU would be 0) |
| `invalid-decode-rows-class-out-of-labels` | `decode` | a rows row below the default threshold whose best class (2) is outside labels of 2 entries is invalid_output, although the other row (best class 0, score 0.9) is fine: the class check covers every row before the threshold |
| `decode-rows-label-offset` | `decode` | labelOffset 1 applies to rows: best class 1 is labels[0] and best class 2 is labels[1]; classIndex stays the model id |
| `invalid-decode-rows-non-finite` | `decode` | an infinite value anywhere in a rows tensor is invalid_output |
| `invalid-decode-rows-non-finite-unused-column` | `decode` | a -infinity in a class column that does not win the row still makes the whole rows tensor invalid_output (the check covers every element, not only the arithmetic result) |
| `invalid-decode-non-finite-box` | `decode` | a NaN box value on an examined ssd row is invalid_output |
| `invalid-decode-non-finite-class` | `decode` | an infinite class id on an examined ssd row is invalid_output |
| `invalid-decode-non-finite-count` | `decode` | a NaN count is invalid_output |
| `invalid-decode-non-finite-arithmetic` | `decode` | a finite normalized box value that overflows when scaled by the model input size (1e308 * 200) is invalid_output |
| `invalid-decode-rows-non-finite-arithmetic` | `decode` | a finite rows value whose centre plus half width overflows (1.7e308 + 8.5e307) is invalid_output |
| `invalid-decode-class-negative` | `decode` | a negative class id is invalid_output (even without labels) |
| `invalid-decode-class-too-large` | `decode` | class id 2147483648 is above the 32-bit limit: invalid_output |
| `invalid-decode-classes-length-mismatch` | `decode` | ssd classes for 3 rows with 2 boxes and 2 scores is invalid_output |
| `invalid-decode-rows-batch-2` | `decode` | a rows tensor [2, 1, 5] has a leading dimension 2 (not a batch of 1): invalid_output |
| `invalid-decode-boxes-batch-2` | `decode` | ssd boxes [2, 1, 4] have a leading dimension 2: invalid_output |
| `invalid-decode-negative-dimension` | `decode` | a negative dimension (-1) is invalid_output even when the data length matches its absolute product |
| `invalid-decode-count-shape-vector` | `decode` | count of shape [2] (two elements) is invalid_output |
| `invalid-decode-count-shape-matrix` | `decode` | count of shape [1, 1] is not accepted (only [] and [1]): invalid_output |
| `invalid-decode-rows-no-class-column` | `decode` | objectness with only 5 columns leaves no class column (C = 0): invalid_output |
| `invalid-decode-options-with-bad-output` | `decode` | precedence (two violations on purpose): a bad option (scoreThreshold 2) wins over a missing tensor: invalid_options |
| `invalid-decode-maxdetections-fraction` | `decode` | maxDetections 1.5 is not an integer: invalid_options |
| `invalid-decode-source-size-zero` | `decode` | a source size of 0 given to decode is invalid_options |
| `invalid-decode-wrong-spec-kind` | `decode` | a classifier spec given to postprocessDetections is invalid_options |
| `invalid-classify-wrong-spec-kind` | `classify` | a detector spec given to postprocessClassification is invalid_options |
| `decode-ssd-single-box` | `decode` | one ssd row with boxes [1,4], classes [1], scores [1] and a scalar count of shape [] |
| `decode-default-score-threshold` | `decode` | with no options the default scoreThreshold 0.3 keeps 0.34 and drops 0.28 |
| `decode-ssd-normalized-different-sizes` | `decode` | normalized boxes scale by the MODEL INPUT size (100x50) and then map to the 400x300 source: x 0.25*100/0.25 = 100, y 0.125*50/(50/300) = 37.5 |
| `decode-rows-batch-dimension` | `decode` | a non-transposed rows tensor [1, 2, 6] (with a batch dimension) decodes like [2, 6] |
| `decode-rows-empty` | `decode` | a rows tensor with no rows (shape [0, 6]) gives no detections |
| `decode-empty-labels-array` | `decode` | an empty labels array is 'labels given': every class id is outside it, so even class 0 is invalid_output |
| `decode-class-negative-index-with-offset` | `decode` | labelOffset 1 with class id 0 gives label index -1 (outside the labels): invalid_output |
| `decode-default-max-detections` | `decode` | with no options a 150-row ssd output (no NMS by default, identical boxes, descending scores all above 0.3) returns exactly the first 100 detections: the default maxDetections is 100 |
| `classify-infinity-invalid` | `classify` | an infinite logit (not only NaN) is invalid_output |
| `ap-truth-tie-first-wins` | `metrics` | a detection with equal IoU to two truths takes the first truth in input order (threshold 0.3): the second detection, which only overlaps that first truth, is then a false positive: AP 0.5 |
| `ap-threshold-zero-disjoint-box` | `metrics` | iouThreshold 0 with the literal >= makes a detection whose box is disjoint from the truth (IoU 0) a true positive: AP 1 (there is no extra guard) |
| `iou-swapped-boxes` | `metrics` | iou takes corners as given: two identical boxes with swapped corners (10,10,0,0) have a negative intersection extent, intersection 0, union 200, IoU 0 (not 1) |
| `invalid-iou-non-finite` | `metrics` | a non-finite box coordinate given to iou is invalid_options |
| `topk-k-fraction-invalid` | `metrics` | topKAccuracy with k = 1.5 is not an integer: invalid_options |
| `invalid-metrics-non-finite-score` | `metrics` | a NaN detection score is invalid_options |
| `invalid-metrics-non-finite-box` | `metrics` | an infinite detection box coordinate is invalid_options |
| `invalid-metrics-truth-non-finite-box` | `metrics` | a NaN truth box coordinate is invalid_options |
| `invalid-metrics-class-negative` | `metrics` | a negative classIndex is invalid_options |
| `invalid-metrics-class-fraction` | `metrics` | a non-integer classIndex is invalid_options |
| `invalid-minscore-null` | `classify` | JSON null for minScore is a bad value: invalid_options |
| `invalid-score-threshold-null` | `decode` | JSON null for scoreThreshold is a bad value: invalid_options |
| `invalid-iou-threshold-null` | `decode` | JSON null for iouThreshold (decode) is a bad value: invalid_options |
| `invalid-max-detections-null` | `decode` | JSON null for maxDetections is a bad value: invalid_options |
| `invalid-resize-method-null` | `resize` | JSON null for the resize method is a bad value: invalid_options |
| `invalid-topk-k-null` | `metrics` | JSON null for k (topKAccuracy) is a bad value: invalid_options |
| `invalid-ap-iou-threshold-null` | `metrics` | JSON null for the averagePrecision iouThreshold is a bad value: invalid_options |
| `invalid-nms-threshold-null` | `nms` | JSON null for the nms iouThreshold is a bad value: invalid_options |
| `invalid-nms-non-finite-score` | `nms` | a NaN score on a detection of another class than the valid one is invalid_options |
| `invalid-nms-infinite-score` | `nms` | an infinite score (not only NaN) is invalid_options |
| `invalid-nms-non-finite-box` | `nms` | a NaN box coordinate on a detection of another class is invalid_options |
| `invalid-nms-infinite-box` | `nms` | an infinite box coordinate (not only NaN) is invalid_options |
| `pipeline-detect-max-detections-zero` | `pipeline` | detect validates maxDetections 0 before the first clock read: invalid_options, no clock read, no model call |
| `pipeline-detect-score-threshold-out-of-range` | `pipeline` | detect validates scoreThreshold 1.5 before any clock read |
| `pipeline-detect-iou-threshold-negative` | `pipeline` | detect validates iouThreshold -1 before any clock read |
| `pipeline-detect-nms-null` | `pipeline` | detect validates nms null before any clock read |
| `pipeline-classify-minscore-out-of-range` | `pipeline` | classify validates minScore 2 before any clock read |
| `pipeline-invalid-image-no-clock` | `pipeline` | an invalid image (width 0) fails before any clock read or model call |
| `pipeline-spec-wrong-kind-for-classify` | `pipeline` | classify given a detector spec is invalid_options before any clock read |
| `pipeline-spec-wrong-kind-for-detect` | `pipeline` | detect given a classifier spec is invalid_options before any clock read |
| `pipeline-output-data-length-mismatch` | `pipeline` | a classifier output tensor of shape [3] with 2 data values is invalid_output (data length must match the shape) |
| `pipeline-timing-negative-difference` | `pipeline` | timings are plain differences and are not clamped: clock [10, 8, 20, 21] gives preprocessMs -2 |
| `spec-invalid-null-scale` | `spec` | null for scale is a bad value (not absent) |
| `spec-invalid-null-mean` | `spec` | null for mean is a bad value |
| `spec-invalid-null-std` | `spec` | null for std is a bad value |
| `spec-invalid-null-labels` | `spec` | null for labels is a bad value |
| `spec-invalid-null-labeloffset` | `spec` | null for labelOffset is a bad value |
| `spec-invalid-null-boxorder` | `spec` | null for boxOrder is a bad value |
| `spec-invalid-null-coordinates` | `spec` | null for coordinates is a bad value |
| `spec-invalid-null-boxformat` | `spec` | null for boxFormat is a bad value |
| `spec-invalid-null-transposed` | `spec` | null for transposed is a bad value |
| `spec-invalid-null-objectness` | `spec` | null for objectness is a bad value |
| `spec-invalid-null-scoreactivation` | `spec` | null for scoreActivation is a bad value |
| `spec-invalid-missing-height` | `spec` | rule 6: input.height missing |
| `spec-invalid-missing-layout` | `spec` | rule 6: input.layout missing |
| `spec-invalid-missing-channels` | `spec` | rule 6: input.channels missing |
| `spec-invalid-missing-mode` | `spec` | rule 6: input.mode missing |
| `spec-invalid-missing-resample` | `spec` | rule 6: input.resample missing |
| `spec-invalid-height-zero` | `spec` | rule 7: input.height 0 |
| `spec-invalid-height-too-large` | `spec` | rule 7: input.height 16385 |
| `spec-invalid-padvalue-fraction` | `spec` | rule 13: padValue 1.5 is not an integer |
| `spec-invalid-padvalue-negative` | `spec` | rule 13: padValue -1 |
| `spec-invalid-ssd-boxformat` | `spec` | rule 23: boxFormat belongs to rows, not ssd |
| `spec-invalid-rows-coordinates` | `spec` | rule 23: coordinates belongs to ssd, not rows |
| `spec-valid-boundaries` | `spec` | boundary values are valid: 16384 x 16384, labelOffset 1000000, padValue 255 on a stretch spec, scale 0, negative mean and negative std entries |
| `spec-valid-boundaries-negative` | `spec` | boundary values are valid: width/height 1, padValue 0 on a centerCrop spec, scale negative, labelOffset -1000000 |
| `spec-order-unknown-key-before-missing` | `spec` | intentional two violations: an unknown top-level key and a missing output: the unknown key is reported (rule 2 before rule 3) |
| `spec-order-missing-before-value` | `spec` | intentional two violations: input.dtype missing and width 0: the missing key is reported (rule 6 before rule 7) |
| `spec-order-width-before-layout` | `spec` | intentional two violations: width 0 and a bad layout: the width is reported (rule 7 before rule 8) |
| `spec-order-padvalue-before-scale` | `spec` | intentional two violations: padValue 256 and scale a string: padValue is reported (rule 13 before rule 14) |
| `spec-order-std-length-before-zero` | `spec` | intentional two violations: std [0, 0] has the wrong length and zeros: the length is reported (rule 16 before rule 17) |
| `spec-order-scale-type-before-uint8` | `spec` | intentional two violations: dtype uint8 with a string scale: the scale type is reported (rule 14 before rule 18) |
| `spec-order-input-before-output` | `spec` | intentional two violations: a bad layout and an output that is not an object: the layout is reported (rule 8 before rule 19) |
| `spec-order-exactly-one-before-type` | `spec` | intentional two violations: both type and format with an invalid type: rule 20 is reported before rule 21 |
| `spec-order-unknown-output-key-before-value` | `spec` | intentional two violations: an ssd output with a bad boxOrder and a transposed key: the unknown key is reported (rule 23 before rule 24) |
| `spec-order-labels-before-labeloffset` | `spec` | intentional two violations: labels a string and labelOffset 0.5: labels is reported (rule 29 before rule 30) |
| `resize-bilinear-clamped-fx-tie` | `resize` | bilinear 2x1 to 1x3, pixel (0,0) channel 1: fx taken from the UNCLAMPED x0 gives 234.49999999999997 and byte 234; fx from the clamped x0 would give 234.50000000000003 and byte 235 (the written order is observable) |
| `invalid-decode-score-infinity` | `decode` | an ssd score of +infinity is invalid_output |
| `invalid-decode-score-negative-infinity` | `decode` | an ssd score of -infinity is invalid_output |
| `invalid-decode-classes-batch-2` | `decode` | ssd classes of shape [2, 1] (leading dimension 2) are invalid_output |
| `invalid-decode-scores-batch-2` | `decode` | ssd scores of shape [2, 1] (leading dimension 2) are invalid_output |
| `invalid-decode-rows-missing-tensor` | `decode` | a rows output without the tensor named rows is invalid_output |
| `pipeline-classify-topk-null` | `pipeline` | classify validates a null topK before any clock read |
| `pipeline-classify-minscore-null` | `pipeline` | classify validates a null minScore before any clock read |
| `pipeline-detect-iou-threshold-null` | `pipeline` | detect validates a null iouThreshold before any clock read |
| `pipeline-detect-score-threshold-null` | `pipeline` | detect validates a null scoreThreshold before any clock read |
| `pipeline-detect-max-detections-null` | `pipeline` | detect validates a null maxDetections before any clock read |
| `invalid-image-data-too-long` | `resize` | an image whose data has 13 bytes instead of 12 is invalid_options (the length must match exactly) |
| `invalid-image-height-too-large` | `resize` | an image 16385 pixels high (valid data length) is invalid_options |
| `invalid-resize-target-height-zero` | `resize` | a resize target height of 0 is invalid_options |
| `invalid-resize-target-too-large` | `resize` | a resize target height of 16385 is invalid_options |
| `spec-order-width-before-height` | `spec` | intentional two violations: width 0 and height 0: the width is reported first (rule 7) |
| `spec-order-missing-input-before-output` | `spec` | intentional two violations: neither input nor output present: missing input is reported first (rule 3) |
| `spec-order-missing-output-before-input-type` | `spec` | intentional two violations: input a string and output missing: missing output is reported first (rule 3 before rule 4) |
| `spec-order-required-keys` | `spec` | intentional two violations: input.height and input.dtype both missing: height is reported first (rule 6 order) |
| `spec-order-unknown-input-key-before-missing` | `spec` | intentional two violations: an unknown input key and a missing input.width: the unknown key is reported (rule 5 before rule 6) |
| `spec-order-output-type-before-labels` | `spec` | intentional two violations: output not an object and labels a string: the output is reported (rule 19 before rule 29) |
| `spec-order-dtype-before-padvalue` | `spec` | intentional two violations: dtype bad and padValue 1.5: the dtype is reported (rule 12 before rule 13) |
| `spec-invalid-labels-entry-null` | `spec` | rule 29: a labels entry that is null |
| `spec-invalid-mean-four-entries` | `spec` | rule 15: mean with 4 entries |
| `tensor-uint8-letterbox-padvalue` | `tensor` | dtype uint8 with an explicit padValue 7 on a letterbox spec: the padding stays the raw byte 7 (clarification 7) |
| `iou-swapped-one-axis` | `metrics` | two identical boxes (10,0,0,10) swapped on x only: iw = -10 gives intersection 0, each area is -100 (the formula as written), union -200 <= 0, so the IoU is 0 |
