import { useFill } from "../fill";
import { useT } from "../i18n";
import type { Backend } from "../visionRun";
import { modelsBase } from "../visionBackends/ort";

/** `checking` until the model files have been looked for; `ready` when a model file is reachable; `missing` otherwise. */
export type RealState = "checking" | "ready" | "missing";

/** Recorded (always available) or the real model (enabled only when its file is reachable). A picked image forces the real model. */
export function BackendSwitch({ value, onChange, real, forced }: { value: Backend; onChange: (b: Backend) => void; real: RealState; forced: boolean }) {
  const t = useT();
  const fill = useFill();
  const note = real === "ready" ? t("visionRealReady") : real === "checking" ? t("visionRealChecking") : fill("visionRealMissing", { base: modelsBase() });
  return (
    <fieldset className="modes" aria-describedby="vision-backend-note">
      <legend>{t("visionBackend")}</legend>
      <label className="radio">
        <input type="radio" name="vision-backend" value="recorded" checked={value === "recorded"} disabled={forced} onChange={() => onChange("recorded")} />
        <span>{t("visionBackendRecorded")}</span>
      </label>
      <label className="radio">
        <input type="radio" name="vision-backend" value="ort" checked={value === "ort"} disabled={real !== "ready"} onChange={() => onChange("ort")} />
        <span>{t("visionBackendReal")}</span>
      </label>
      <p id="vision-backend-note" className="hint vis-note-row">
        <span aria-hidden="true">{real === "ready" ? "✓" : "ⓘ"}</span> {forced ? t("visionUserForced") : note}
      </p>
    </fieldset>
  );
}
