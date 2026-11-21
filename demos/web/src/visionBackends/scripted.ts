import { scriptedModel, type VisionModel } from "@ilabs/vision";
import { decoderOutputs, type ModelCard, type Recording } from "../visionAssets";

/** The recorded backend: a model that ignores its input and answers with the recorded raw tensors of the ONNX model. */
export function scriptedFor(card: ModelCard, recording: Recording): VisionModel {
  return scriptedModel(decoderOutputs(card, recording.outputs));
}
