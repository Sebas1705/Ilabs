import type { Detection } from "@ilabs/vision";
import { formatPercent } from "../visionRun";

const DASHES = ["solid", "dashed", "dotted"] as const;

/** The colour, dash style and glyph that tell one class from another (the label text always says it too). */
export function classStyle(classIndex: number): { color: string; dash: (typeof DASHES)[number] } {
  return { color: `hsl(${Math.round((classIndex * 137.5) % 360)} 72% 40%)`, dash: DASHES[classIndex % DASHES.length]! };
}

/**
 * Boxes over an image of `width x height` pixels, placed in percentages so they follow the image at any size. Every
 * box carries a chip with its class and score as text; the same facts are in the list below the image, so the
 * overlay is hidden from assistive technology.
 */
export function BoxOverlay({ detections, width, height }: { detections: Detection[]; width: number; height: number }) {
  return (
    <div className="vis-boxes" aria-hidden="true" data-testid="vision-boxes">
      {detections.map((d, i) => {
        const { color, dash } = classStyle(d.classIndex);
        return (
          <div
            key={i}
            className={`vis-box${d.box.y1 / height < 0.08 ? " vis-box-top" : ""}`}
            data-testid="vision-box"
            style={{
              left: `${(d.box.x1 / width) * 100}%`,
              top: `${(d.box.y1 / height) * 100}%`,
              width: `${((d.box.x2 - d.box.x1) / width) * 100}%`,
              height: `${((d.box.y2 - d.box.y1) / height) * 100}%`,
              borderColor: color,
              borderStyle: dash,
            }}
          >
            <span className="vis-chip" style={{ borderColor: color }}>
              <span aria-hidden="true">▢</span> {d.label} {formatPercent(d.score, 0)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
