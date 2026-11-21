import type { Image } from "@ilabs/vision";
import { useEffect, useRef, type ReactNode } from "react";
import { drawRgb } from "../visionImage";

/** An RGB image on a canvas with a text alternative; `children` are positioned over it in image percentages. */
export function ImageCanvas({ image, alt, children }: { image: Image; alt: string; children?: ReactNode }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    drawRgb(ref.current, image.width, image.height, image.data);
  }, [image]);
  return (
    <div className="vis-stage" style={{ aspectRatio: `${image.width} / ${image.height}`, maxWidth: `${image.width}px` }}>
      <canvas ref={ref} className="vis-canvas" width={image.width} height={image.height} role="img" aria-label={alt} />
      {children}
    </div>
  );
}
