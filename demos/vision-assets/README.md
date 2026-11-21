# vision demo assets

Shared assets of the `vision` demos (`demos/web` and `demos/android`): sample images, labels, the pinned model list and the raw model outputs recorded once with the real models. **Model files are never committed**: they are downloaded on demand into `models/` (git-ignored) and verified against a SHA-256.

```
demos/vision-assets/
  models.json     pinned model cards: URL, SHA-256, size, license, ModelSpec, tensor names
  labels/         imagenet-1k.txt (1000 lines), coco-90.txt (90 lines, one per COCO category id)
  samples/        7 PNG images, each at most 300 KB, all CC0
  samples.json    id, title (es/en), size, license, source page and author of every sample
  recorded/       <sample>.<task>.json: raw ONNX outputs of the real models (task: classification | detection)
  models/         downloaded model files (git-ignored, never committed)
```

## Models

Four pinned models: a classifier and a detector, each as ONNX (web demo) and TFLite (Android demo). Every license was checked on the page named in `models.json` (`license.page`) and is Apache-2.0 compatible; no AGPL model (such as Ultralytics YOLO) is used.

| id | task | runtime | file | size | license | SHA-256 |
|---|---|---|---|---|---|---|
| `mobilenet-v2-onnx` | classification, ImageNet-1k | onnx | `mobilenetv2-12.onnx` | 13,964,571 B | Apache-2.0 | `c0c3f76d93fa3fd6580652a45618618a220fced18babf65774ed169de0432ad5` |
| `ssd-mobilenet-v1-onnx` | detection, COCO | onnx | `ssd_mobilenet_v1_12.onnx` | 29,461,455 B | MIT (page); upstream Apache-2.0 | `b8fba5e404077d4048d27fcd1667e85e27e192eb9bf51e696c46a3acd7d21058` |
| `efficientnet-lite0-tflite` | classification, ImageNet-1k | tflite | `efficientnet_lite0.tflite` | 18,582,189 B | Apache-2.0 | `6c7ab0a6e5dcbf38a8c33b960996a55a3b4300b36a018c4545801de3a3c8bde0` |
| `ssd-mobilenet-v1-tflite` | detection, COCO | tflite | `lite-model_ssd_mobilenet_v1_1_metadata_2.tflite` | 4,185,175 B | Apache-2.0 | `cbdecd08b44c5dea3821f77c5468e2936ecfbf43cde0795a2729fdb43401e58b` |

Where the files come from (exact URLs are in `models.json`):

- The two ONNX files are the `onnx/models` repository pinned to the commit `c5cae0f1942c8d7727372c7b1f6b485aa39e4421` (stored with Git LFS; the SHA-256 equals the LFS object id of that commit). The repository is Apache-2.0; the classifier page says "Apache 2.0", the SSD page says "MIT License" (the original TensorFlow Object Detection API model is Apache-2.0).
- `efficientnet_lite0.tflite` is Google's versioned MediaPipe model bucket (`float32/1`); the model card (`litert-community`) declares apache-2.0 and the file's embedded metadata states "Apache License. Version 2.0".
- `lite-model_ssd_mobilenet_v1_1_metadata_2.tflite` is the model of the TensorFlow Lite object detection example; its embedded metadata states "Apache License. Version 2.0".

Honest notes:

- The ONNX and TFLite builds of a task are the same family, not the same weights (MobileNetV2 vs EfficientNet-Lite0 for classification; SSD-MobileNet v1 float vs quantized for detection). The recorded outputs come from the **ONNX** models only. The demos replay them with the ONNX cards; the TFLite cards are for live inference on a device.
- Both detectors use the `ssd` output format (`boxes`, `classes`, `scores`, `count`; `yxyx`, normalized). They differ in the class numbering: the ONNX build outputs COCO category ids (person = 1), so its card has `labelOffset: 1`; the TFLite build outputs 0-based indices (person = 0), `labelOffset: 0`. Both use `labels/coco-90.txt`, one line per COCO id 1..90, with `???` on the ten ids COCO does not use (12, 26, 29, 30, 45, 66, 68, 69, 71, 83): 80 real classes in 90 slots. A model with the 80-class numbering would need its own labels file.
- The ONNX models were run for real (onnxruntime-node). The two TFLite models were **not** run here (no TFLite runtime on the capture machine): their input and output tensors, normalization and label files were read from the files and their metadata. Confirm the TFLite class convention on a device.
- `mobilenet-v2-onnx` asks for "resize to 256, centre crop 224"; the `centerCrop` mode resizes the short side straight to 224 (a slightly tighter crop). The recorded outputs use `centerCrop`.

## Labels

- `labels/imagenet-1k.txt`: the 1000 ImageNet-1k class names in the standard class order (tench = 0 ... toilet tissue = 999). It is byte for byte the `ImageNetLabels.txt` of TensorFlow (`https://storage.googleapis.com/download.tensorflow.org/data/ImageNetLabels.txt`, Apache-2.0) without its first `background` line, and identical to the `labels_without_background.txt` embedded in the EfficientNet-Lite0 model. The names come from WordNet synsets (WordNet license, permissive).
- `labels/coco-90.txt`: the 90-slot COCO label map embedded as `labelmap.txt` in the Apache-2.0 TFLite SSD-MobileNet file; the ten `???` slots are exactly the COCO category ids that do not exist. COCO annotations are CC BY 4.0; the class names are plain facts.

## Samples

Seven photos from Wikimedia Commons, all marked **CC0 1.0** on their file page (the license was read from the Commons file page metadata). Each was downscaled (and the giraffe cropped) with a palette PNG, so every file is at most 300 KB. See `samples.json` for sizes, SHA-256 and the exact source page of each.

| id | what it covers | source (Commons file page) | author |
|---|---|---|---|
| `cat` | a clear single object | [Tabby cat-3337027.jpg](https://commons.wikimedia.org/wiki/File:Tabby_cat-3337027.jpg) | pasja1000 |
| `dog` | a second clear single object | [Golden-retriever-dog.jpg](https://commons.wikimedia.org/wiki/File:Golden-retriever-dog.jpg) | Karen Arnold |
| `crowd` | a crowded scene | [Street Crowd.jpg](https://commons.wikimedia.org/wiki/File:Street_Crowd.jpg) | Yann Kemper |
| `giraffe-tall` | tall 1:2 portrait (centre crop of a 2:3 photo) | [Giraffe posing in the grass.jpg](https://commons.wikimedia.org/wiki/File:Giraffe_posing_in_the_grass.jpg) | Joselodos |
| `city-panorama` | very wide panorama (about 5:1), small objects | [Panorama of Bergen from Fløyen, 2006.jpg](https://commons.wikimedia.org/wiki/File:Panorama_of_Bergen_from_Fl%C3%B8yen,_2006.jpg) | DimiTalen |
| `fog-rocks` | low contrast, no COCO object | [Fog&Rocks.jpg](https://commons.wikimedia.org/wiki/File:Fog%26Rocks.jpg) | Kelli Doorne |
| `mountains-wide` | wide panorama (about 3.5:1), no COCO object | [Panorama Vercors-Chartreuse.jpg](https://commons.wikimedia.org/wiki/File:Panorama_Vercors-Chartreuse.jpg) | Wisi eu |

Regenerate a sample: download the Commons file at a thumbnail width of 1280 px (`Special:FilePath/<name>?width=1280`), resize to the width in `samples.json` (the giraffe: first crop the centre to a 1:2 box), save as a 256-colour palette PNG (for example with `sharp`: `png({ palette: true, quality: 90, colours: 256, effort: 10 })`), then update `samples.json` and run the capture script again.

## Recorded outputs

`recorded/<sample>.<task>.json` holds the **raw** tensors of the real ONNX model for that sample: named tensors with `shape` and `data` (float32 values written with the shortest decimal that reads back as the same float32), plus `sample`, `task`, `model` (card id), `modelSha256`, `runtime` (the exact `onnxruntime-node` version), `source` (the sample size) and `inputShape`. Each file is about 10 KB (classification) or 2 KB (detection).

To use them, read the card of `model` in `models.json`, map the tensor names with `io.outputs` (for the `ssd` format the decoder names `boxes`, `classes`, `scores`, `count` map to `detection_boxes`, `detection_classes`, `detection_scores`, `num_detections`), then call `postprocessClassification` or `postprocessDetections` with the card's `spec` plus its labels file and, for detection, the geometry of the sample (`preprocessGeometry(width, height, spec)`).

What the committed files decode to (default options, top-3 and detections at score 0.3 or more):

| sample | classification (MobileNetV2) | detection (SSD-MobileNet v1) |
|---|---|---|
| `cat` | tabby 64.6%, tiger cat 33.1%, Egyptian cat 1.6% | cat 96% |
| `dog` | golden retriever 99.8%, Labrador retriever 0.1%, Saluki 0.0% | dog 92% |
| `crowd` | abaya 17.0%, sunglasses 9.2%, bulletproof vest 6.9% (a crowd has no single class) | 14 person boxes (93% to 31%), 2 umbrella |
| `giraffe-tall` | bittern 24.6%, gazelle 12.0%, kite 9.5% (a small subject) | giraffe 100% |
| `city-panorama` | seashore 24.8%, alp 10.1%, lakeside 8.6% | none |
| `fog-rocks` | stone wall 73.1%, breakwater 4.8%, cliff 4.2% | none |
| `mountains-wide` | volcano 26.6%, alp 23.7%, radio telescope 7.1% | none |

## Download the models

Requires Node 24 or newer (run with Node 26.13). From the repository root:

```sh
node scripts/vision-models.mjs                  # download every missing model, resumable, SHA-256 verified
node scripts/vision-models.mjs --runtime onnx   # only the web models (or --runtime tflite, or --id <id>)
node scripts/vision-models.mjs --check          # list what is present and whether it matches the pinned checksum
node scripts/vision-models.mjs --force          # replace a present file whose checksum does not match
node scripts/vision-models.mjs --hash <id>      # for maintainers: download without verifying and print size and SHA-256
```

A file that already matches its SHA-256 is never touched; a present file that does not match is reported and kept unless `--force` is given. Downloads go to `<file>.part` (a later run resumes them with a Range request) and are renamed only after the checksum matches.

To pin a new model or version: add its card to `models.json`, run `--hash <id>` with placeholder zeros in `sha256` and `size`, paste the printed values, then run the script again.

## Serving the models to the web demo

- Dev and preview: the Vite config serves the git-ignored `demos/vision-assets/models/` at `/vision-models/`, so after `node scripts/vision-models.mjs --runtime onnx` the web demo finds the files with no setting. Nothing is copied into a production build.
- Deployed page: set `VITE_VISION_MODELS_BASE` at build time to the base URL that serves the model files (for example `https://example.com/models/`). It takes precedence over the `/vision-models/` route. A remote base must send CORS headers allowing the page origin; a remote base has not been tried here.
- Without model files the demo stays on the recorded backend.

## Recapture the outputs

The capture script runs the real ONNX models through `@ilabs/vision` preprocessing (`toTensor`) and writes `recorded/`. It is a dev-time tool: `onnxruntime-node` is **not** a dependency of the repository (the lockfile is untouched); install it outside the repo:

```sh
mkdir /tmp/ort && cd /tmp/ort && npm init -y && npm i onnxruntime-node@1.31.1   # any scratch folder
cd <repo root>
node scripts/vision-models.mjs --runtime onnx
node --import ./scripts/lib/register-ts.mjs scripts/capture-vision-outputs.mjs --ort /tmp/ort
node --import ./scripts/lib/register-ts.mjs scripts/capture-vision-outputs.mjs --print-only   # decode the committed files, no model needed
```

The `--import` hook only lets Node's built-in type stripping load `modules/vision/ts/src` (its imports end in `.js`). Re-running the capture with the same models and runtime version gives byte-identical files.

## Tests

```sh
node --import ./scripts/lib/register-ts.mjs --test "scripts/**/*.test.mjs"     # or: pnpm run test:scripts
```

`scripts/vision-models.test.mjs` covers the checksum verifier and the downloader with a local temporary file and a fake `fetch` (match, missing file, wrong size, wrong checksum, flipped byte, resume, server without Range support, refusal to overwrite a matching file). `scripts/vision-assets.test.mjs` runs `parseModelSpec` over every model card (with its labels), checks the labels, samples (size limit, checksum, license, source) and recorded files, decodes the recorded outputs with `@ilabs/vision` and checks the PNG decoder.
