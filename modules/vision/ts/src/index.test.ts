import { describe, expect, it } from "vitest";
import * as api from "./index.js";

describe("public API", () => {
  it("exports only the documented runtime values", () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        "VisionError",
        "averagePrecision",
        "classify",
        "detect",
        "iou",
        "meanAveragePrecision",
        "nms",
        "parseModelSpec",
        "postprocessClassification",
        "postprocessDetections",
        "preprocessGeometry",
        "resize",
        "runFixture",
        "scriptedModel",
        "toTensor",
        "topKAccuracy",
        "unmapBox",
      ].sort(),
    );
  });

  it("VisionError carries a kind and is an Error", () => {
    const e = new api.VisionError("invalid_output", "x");
    expect(e.kind).toBe("invalid_output");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("VisionError");
    expect(new api.VisionError("invalid_spec").message).toBe("invalid_spec");
  });
});
