import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { LangContext, type Lang } from "../i18n";
import { visionAssets } from "../visionAssets";
import { BackendSwitch } from "./BackendSwitch";
import { BoxOverlay } from "./BoxOverlay";
import { ClassBars } from "./ClassBars";
import { ImageCanvas } from "./ImageCanvas";
import { GeometryList, TensorPreview } from "./TensorPreview";

const wrap = (ui: React.ReactNode, lang: Lang = "en") => render(<LangContext.Provider value={lang}>{ui}</LangContext.Provider>);
const spec = visionAssets.cards.classification!.spec;

describe("ClassBars", () => {
  it("writes every label and percentage as text and hides the bars", () => {
    const { container } = wrap(
      <ClassBars
        entries={[
          { index: 1, label: "tabby", score: 0.6463 },
          { index: 2, label: "tiger cat", score: 0.0004 },
        ]}
      />,
    );
    const rows = within(screen.getByRole("list", { name: "Top entries" })).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual(["tabby64.6%", "tiger cat0.0%"]);
    const bars = container.querySelectorAll(".classbar");
    expect(bars).toHaveLength(2);
    for (const b of bars) expect(b).toHaveAttribute("aria-hidden", "true");
  });
});

describe("BoxOverlay", () => {
  const det = (label: string, classIndex: number, x1: number, y1: number, x2: number, y2: number, score: number) => ({ label, classIndex, score, box: { x1, y1, x2, y2 } });

  it("places each box in percentages of the image and writes class and score on its chip", () => {
    wrap(<BoxOverlay width={200} height={100} detections={[det("cat", 16, 20, 50, 120, 90, 0.874), det("dog", 17, 0, 0, 200, 100, 0.3)]} />);
    const boxes = screen.getAllByTestId("vision-box");
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toHaveStyle({ left: "10%", top: "50%", width: "50%", height: "40%" });
    expect(within(boxes[0]!).getByText(/cat 87%/)).toBeInTheDocument();
    expect(within(boxes[1]!).getByText(/dog 30%/)).toBeInTheDocument();
    expect(screen.getByTestId("vision-boxes")).toHaveAttribute("aria-hidden", "true");
    // a box on the top edge keeps its chip inside the image
    expect(boxes[1]).toHaveClass("vis-box-top");
    expect(boxes[0]).not.toHaveClass("vis-box-top");
  });

  it("tells classes apart by dash style too, not by colour alone", () => {
    wrap(<BoxOverlay width={10} height={10} detections={[det("a", 0, 1, 1, 2, 2, 1), det("b", 1, 1, 1, 2, 2, 1), det("c", 2, 1, 1, 2, 2, 1)]} />);
    const styles = screen.getAllByTestId("vision-box").map((b) => (b as HTMLElement).style.borderStyle);
    expect(styles).toEqual(["solid", "dashed", "dotted"]);
  });
});

describe("ImageCanvas", () => {
  it("is an image with a text alternative and an aspect ratio, and shows its overlay", () => {
    wrap(
      <ImageCanvas image={{ width: 4, height: 2, data: new Uint8Array(24) }} alt="Close-up of a cat. 1 detection: cat 96%">
        <span>overlay</span>
      </ImageCanvas>,
    );
    const canvas = screen.getByRole("img", { name: "Close-up of a cat. 1 detection: cat 96%" });
    expect(canvas).toHaveAttribute("width", "4");
    expect(canvas).toHaveAttribute("height", "2");
    expect(screen.getByText("overlay")).toBeInTheDocument();
  });
});

describe("TensorPreview and GeometryList", () => {
  it("names the model input size and mode in its alternative, in both languages", () => {
    const tensor = { shape: [1, 3, 224, 224], data: new Array<number>(3 * 224 * 224).fill(0) };
    const { unmount } = wrap(<TensorPreview tensor={tensor} spec={spec} />);
    expect(screen.getByRole("img", { name: "The image as the model sees it: 224 by 224 pixels, centre crop" })).toBeInTheDocument();
    unmount();
    wrap(<TensorPreview tensor={tensor} spec={spec} />, "es");
    expect(screen.getByRole("img", { name: "La imagen tal como la ve el modelo: 224 por 224 píxeles, recorte central" })).toBeInTheDocument();
  });

  it("lists the geometry as text", () => {
    wrap(<GeometryList spec={spec} source={{ width: 640, height: 427 }} geometry={{ scaleX: 0.5, scaleY: 0.5245901639, offsetX: -48, offsetY: 0, newWidth: 320, newHeight: 224 }} />);
    const text = screen.getByLabelText("Preprocessing geometry").textContent;
    expect(text).toContain("centre crop");
    expect(text).toContain("640 × 427");
    expect(text).toContain("224 × 224");
    expect(text).toContain("0.5000, 0.5246");
    expect(text).toContain("-48, 0");
    expect(text).toContain("320 × 224");
  });
});

describe("BackendSwitch", () => {
  it("disables the real model until its files are found and names the download script", () => {
    const { rerender } = wrap(<BackendSwitch value="recorded" onChange={() => {}} real="missing" forced={false} />);
    expect(screen.getByRole("radio", { name: "Real model" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Recorded" })).toBeEnabled();
    expect(screen.getByRole("group", { name: "Backend" })).toHaveAccessibleDescription(/node scripts\/vision-models\.mjs --runtime onnx/);
    rerender(
      <LangContext.Provider value="en">
        <BackendSwitch value="recorded" onChange={() => {}} real="checking" forced={false} />
      </LangContext.Provider>,
    );
    expect(screen.getByRole("radio", { name: "Real model" })).toBeDisabled();
    expect(screen.getByRole("group", { name: "Backend" })).toHaveAccessibleDescription(/Looking for the model files/);
  });

  it("enables the real model when found and reports the choice", async () => {
    const onChange = vi.fn();
    wrap(<BackendSwitch value="recorded" onChange={onChange} real="ready" forced={false} />);
    await userEvent.setup().click(screen.getByRole("radio", { name: "Real model" }));
    expect(onChange).toHaveBeenCalledWith("ort");
  });

  it("locks the recorded option when a picked image forces the real model", () => {
    wrap(<BackendSwitch value="ort" onChange={() => {}} real="ready" forced />);
    expect(screen.getByRole("radio", { name: "Recorded" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Real model" })).toBeChecked();
    expect(screen.getByText(/Your image has no recording/)).toBeInTheDocument();
  });
});
