import type { Geometry, ModelSpec, Tensor } from "@ilabs/vision";
import { useEffect, useMemo, useRef } from "react";
import { useFill } from "../fill";
import { useT, type Key } from "../i18n";
import { drawRgb } from "../visionImage";
import { tensorToRgb } from "../visionRun";

const MODE_KEY: Record<ModelSpec["input"]["mode"], Key> = {
  stretch: "visionModeStretch",
  centerCrop: "visionModeCenterCrop",
  letterbox: "visionModeLetterbox",
};

const fixed = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(4));

/** The image as the model sees it, drawn from the library's input tensor with the normalization undone. Capped at the model input size. */
export function TensorPreview({ tensor, spec }: { tensor: Tensor; spec: ModelSpec }) {
  const t = useT();
  const fill = useFill();
  const ref = useRef<HTMLCanvasElement>(null);
  const rgb = useMemo(() => tensorToRgb(tensor, spec), [tensor, spec]);
  const { width, height } = spec.input;
  useEffect(() => {
    drawRgb(ref.current, width, height, rgb);
  }, [rgb, width, height]);
  return (
    <canvas
      ref={ref}
      className="vis-canvas vis-preview"
      width={width}
      height={height}
      style={{ maxWidth: `${width}px` }}
      role="img"
      aria-label={fill("visionPreviewAlt", { w: width, h: height, mode: t(MODE_KEY[spec.input.mode]) })}
    />
  );
}

/** How the source image was fitted into the model input, as text. */
export function GeometryList({ geometry, spec, source }: { geometry: Geometry; spec: ModelSpec; source: { width: number; height: number } }) {
  const t = useT();
  return (
    <dl className="kv vis-geometry" aria-label={t("visionGeometry")}>
      <div>
        <dt>{t("visionGeoMode")}</dt>
        <dd>{t(MODE_KEY[spec.input.mode])}</dd>
      </div>
      <div>
        <dt>{t("visionGeoSource")}</dt>
        <dd className="num">
          {source.width} × {source.height}
        </dd>
      </div>
      <div>
        <dt>{t("visionGeoInput")}</dt>
        <dd className="num">
          {spec.input.width} × {spec.input.height}
        </dd>
      </div>
      <div>
        <dt>{t("visionGeoScale")}</dt>
        <dd className="num">
          {fixed(geometry.scaleX)}, {fixed(geometry.scaleY)}
        </dd>
      </div>
      <div>
        <dt>{t("visionGeoOffset")}</dt>
        <dd className="num">
          {fixed(geometry.offsetX)}, {fixed(geometry.offsetY)}
        </dd>
      </div>
      <div>
        <dt>{t("visionGeoNew")}</dt>
        <dd className="num">
          {geometry.newWidth} × {geometry.newHeight}
        </dd>
      </div>
    </dl>
  );
}
