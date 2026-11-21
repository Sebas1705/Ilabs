import type { Image } from "@ilabs/vision";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { BackendSwitch, type RealState } from "../components/BackendSwitch";
import { BoxOverlay, classStyle } from "../components/BoxOverlay";
import { ClassBars } from "../components/ClassBars";
import { ImageCanvas } from "../components/ImageCanvas";
import { GeometryList, TensorPreview } from "../components/TensorPreview";
import { LoadErrors } from "../components/LoadErrors";
import { useFill } from "../fill";
import { LangContext, useT } from "../i18n";
import { useRun } from "../useRun";
import { recordingKey, visionAssets, type SampleDef, type Task } from "../visionAssets";
import { modelAvailable, modelUrl } from "../visionBackends/ort";
import { decodeFile, decodeSample } from "../visionImage";
import {
  decodeClassification,
  decodeDetections,
  fieldNumber,
  formatBox,
  formatPercent,
  runSection,
  type Backend,
  type DecodeError,
  type RawRun,
  type SectionResult,
} from "../visionRun";

const DEFAULT_SAMPLE = "cat";
const USER = "user";
/** The list and the overlay show at most this many detections; the rest is counted in a note. */
const LIST_CAP = 100;
const ALT_CAP = 20;

interface PickedFile {
  file: File;
  /** Names the pick, so a result that belongs to an older pick is never shown. */
  token: number;
}

/** Whether the model file of each task can be fetched; `null` while it is being looked for. */
function useAvailability(): Record<Task, boolean | null> {
  const [state, setState] = useState<Record<Task, boolean | null>>({ classification: null, detection: null });
  useEffect(() => {
    let cancelled = false;
    for (const task of ["classification", "detection"] as const) {
      const card = visionAssets.cards[task];
      const found = card === undefined ? Promise.resolve(false) : modelAvailable(modelUrl(card));
      void found.then((v) => !cancelled && setState((s) => ({ ...s, [task]: v })));
    }
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

interface SectionInputs {
  imagePromise: Promise<Image> | null;
  sample: SampleDef | undefined;
  isUser: boolean;
  effective: Backend;
}

/**
 * One section's model run. `key` names everything the task reads (task, image, backend), so a result that belongs to
 * another key is never shown and a slow older run never replaces a newer one (see `useRun`).
 */
function useSection(task: Task, key: string, inputs: SectionInputs) {
  // The run in flight for a key is shared: React StrictMode (dev) runs the mount effect twice, and the second pass must
  // join the first model call instead of making another one. The slot is cleared when the run settles.
  type Out = { key: string; result: SectionResult };
  const inflight = useRef<{ key: string; promise: Promise<Out> } | null>(null);
  return useRun<Out>(key, () => {
    if (inflight.current?.key === key) return inflight.current.promise;
    const { imagePromise, sample, isUser, effective } = inputs;
    const promise = (async (): Promise<Out> => {
      if (imagePromise === null) return { key, result: { kind: "no-image" } };
      const result = await runSection({
        task,
        card: visionAssets.cards[task],
        recording: sample ? visionAssets.recordings.get(recordingKey(sample.id, task)) : undefined,
        image: imagePromise,
        effective,
        isUser,
      });
      return { key, result };
    })();
    const slot = { key, promise };
    inflight.current = slot;
    const clear = () => {
      if (inflight.current === slot) inflight.current = null;
    };
    promise.then(clear, clear);
    return promise;
  });
}

/** Translated sentence for a library error kind; the library's own reason is shown apart as detail. */
function useErrorText(): (e: DecodeError) => string {
  const t = useT();
  const fill = useFill();
  return (e) => {
    if (e.kind === "invalid_options") return t("visionErrOptions");
    if (e.kind === "invalid_output") return t("visionErrOutput");
    if (e.kind === "invalid_spec") return t("visionErrSpec");
    return fill("visionErrOther", { kind: e.kind });
  };
}

function Timings({ raw, postMs }: { raw: RawRun; postMs: number }) {
  const t = useT();
  const fill = useFill();
  const ms = (n: number) => fill("visionMs", { n: n.toFixed(1) });
  return (
    <section aria-label={t("visionTimings")}>
      <h3>{t("visionTimings")}</h3>
      <dl className="kv vis-timings">
        <div>
          <dt>{t("visionTimePre")}</dt>
          <dd className="num">{ms(raw.preprocessMs)}</dd>
        </div>
        <div>
          <dt>{t("visionTimeInfer")}</dt>
          <dd className="num">{raw.backend === "recorded" ? t("visionTimeRecorded") : ms(raw.inferenceMs)}</dd>
        </div>
        <div>
          <dt>{t("visionTimePost")}</dt>
          <dd className="num">{ms(postMs)}</dd>
        </div>
      </dl>
    </section>
  );
}

function ErrorBlock({ error, id }: { error: DecodeError; id?: string }) {
  const t = useT();
  const text = useErrorText();
  return (
    <div className="vis-error" id={id}>
      <p className="vis-error-text">
        <span aria-hidden="true">!</span> {text(error)}
      </p>
      <p className="hint">
        <strong>{t("visionErrReason")}</strong> <code className="message">{error.detail}</code>
      </p>
    </div>
  );
}

export function VisionPage() {
  const t = useT();
  const fill = useFill();
  const lang = useContext(LangContext);
  const { samples, cards, errors } = visionAssets;
  const avail = useAvailability();

  const [sampleId, setSampleId] = useState(samples.some((s) => s.id === DEFAULT_SAMPLE) ? DEFAULT_SAMPLE : (samples[0]?.id ?? USER));
  const [backend, setBackend] = useState<Backend>("recorded");
  const [picked, setPicked] = useState<PickedFile | null>(null);
  const [topKText, setTopKText] = useState("5");
  const [scoreText, setScoreText] = useState("0.3");
  const [iouText, setIouText] = useState("0.5");
  const [nms, setNms] = useState(false);
  const [maxText, setMaxText] = useState("100");

  const isUser = sampleId === USER;
  const sample = samples.find((s) => s.id === sampleId);
  // A picked image has no recording: it always runs on the real model.
  const effective: Backend = isUser ? "ort" : backend;
  const imageKey = isUser ? `user:${picked?.token ?? 0}` : `sample:${sampleId}`;
  const imageTitle = isUser ? `${t("visionSampleUser")}${picked ? `: ${picked.file.name}` : ""}` : sample ? sample.title[lang] : "";

  // The key names the image; a decode that belongs to another key is never shown (useRun also drops it when stale).
  const imagePromise = useMemo(() => (isUser ? (picked ? decodeFile(picked.file) : null) : sample ? decodeSample(sample.url) : null), [imageKey]);
  const imageRun = useRun(imageKey, async () => (imagePromise === null ? null : { key: imageKey, image: await imagePromise }));
  const image = imageRun.value?.key === imageKey ? imageRun.value.image : null;

  const sectionKey = (task: Task) => `${task}|${imageKey}|${effective}`;
  const classRun = useSection("classification", sectionKey("classification"), { imagePromise, sample, isUser, effective });
  const detectRun = useSection("detection", sectionKey("detection"), { imagePromise, sample, isUser, effective });
  const classResult = classRun.value?.key === sectionKey("classification") ? classRun.value.result : null;
  const detectResult = detectRun.value?.key === sectionKey("detection") ? detectRun.value.result : null;

  // Changing a control decodes the same raw output again; the model is not called again.
  const classRaw = classResult?.kind === "ready" ? classResult.raw : null;
  const detectRaw = detectResult?.kind === "ready" ? detectResult.raw : null;
  const classDecoded = useMemo(() => (classRaw ? decodeClassification(classRaw, fieldNumber(topKText)) : null), [classRaw, topKText]);
  const detectDecoded = useMemo(
    () =>
      detectRaw
        ? decodeDetections(detectRaw, { scoreThreshold: fieldNumber(scoreText), iouThreshold: fieldNumber(iouText), maxDetections: fieldNumber(maxText), nms })
        : null,
    [detectRaw, scoreText, iouText, maxText, nms],
  );

  const runFailed = [imageRun.failed, classRun.failed, detectRun.failed].find((m): m is string => m !== null) ?? null;
  const waitingForFile = isUser && picked === null;
  const busy = !waitingForFile && runFailed === null && (classResult === null || detectResult === null);
  const fellBack = (classResult?.kind === "ready" && classResult.fellBack) || (detectResult?.kind === "ready" && detectResult.fellBack);

  const real: RealState = avail.classification === null || avail.detection === null ? "checking" : avail.classification || avail.detection ? "ready" : "missing";

  const detections = detectDecoded?.ok ? detectDecoded.value : null;
  const shown = detections ? detections.slice(0, LIST_CAP) : [];
  const extra = detections ? detections.length - shown.length : 0;
  const detectErrorId = detectDecoded && !detectDecoded.ok ? "vision-detect-error" : undefined;
  const scoreLabel = formatPercent(fieldNumber(scoreText), 0);

  // The coarse polite status line: one sentence per settled state, never per keystroke detail.
  const parts: string[] = [];
  if (runFailed !== null) parts.push(t("visionStatusFailed"));
  else if (waitingForFile) parts.push(t("visionNeedFile"));
  else if (classResult?.kind === "unavailable" || detectResult?.kind === "unavailable") parts.push(t("visionStatusUnavailable"));
  else if (busy) parts.push(t("visionRunning"));
  else {
    if (fellBack) parts.push(t("visionFellBack"));
    if (classDecoded?.ok && classDecoded.value[0]) parts.push(fill("visionStatusTop", { label: classDecoded.value[0].label, percent: formatPercent(classDecoded.value[0].score, 1) }));
    if (detections) {
      const key = detections.length === 0 ? "visionStatusNone" : detections.length === 1 ? "visionStatusOne" : "visionStatusMany";
      parts.push(fill(key, { n: detections.length, score: scoreLabel }));
    }
    if ((classDecoded && !classDecoded.ok) || (detectDecoded && !detectDecoded.ok)) parts.push(t("visionStatusCheck"));
  }
  const status = parts.join(" · ");

  const altText = (): string => {
    if (!detections) return imageTitle;
    const list = detections
      .slice(0, ALT_CAP)
      .map((d) => `${d.label} ${formatPercent(d.score, 0)}`)
      .join(", ");
    const more = detections.length > ALT_CAP ? `, ${fill("visionMore", { n: detections.length - ALT_CAP })}` : "";
    return detections.length === 0 ? `${imageTitle}. ${t("visionNoDetections")}` : `${imageTitle}. ${fill("visionOverlayAlt", { n: detections.length, list })}${more}`;
  };

  const noteFor = (r: SectionResult | null, task: Task) => {
    if (r === null) return null;
    if (r.kind === "no-image") return t("visionNeedFile");
    if (r.kind === "unavailable") return fill("visionUserUnavailable", { base: modelUrl(cards[task]!) });
    if (r.kind === "no-recording") return t("visionNoRecording");
    if (r.kind === "no-card") return t("visionNoCard");
    return null;
  };

  const classNote = noteFor(classResult, "classification");
  const detectNote = noteFor(detectResult, "detection");
  const sampleOptions = [...samples.map((s) => ({ id: s.id, label: s.title[lang] })), { id: USER, label: t("visionSampleUser") }];

  return (
    <>
      <main id="main" className="column" tabIndex={-1} aria-busy={busy}>
        <h1 tabIndex={-1}>{t("visionTitle")}</h1>
        <p className="muted">{t("visionSubtitle")}</p>
        <LoadErrors errors={errors} />

        <section aria-labelledby="h-vision-input" className="card">
          <h2 id="h-vision-input">{t("visionInput")}</h2>
          <label className="field">
            <span>{t("visionSample")}</span>
            <select value={sampleId} onChange={(e) => setSampleId(e.target.value)}>
              {sampleOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          {isUser && (
            <div className="field">
              <label htmlFor="vision-file">{t("visionFile")}</label>
              <input
                id="vision-file"
                type="file"
                accept="image/*"
                aria-describedby="vision-file-hint"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) setPicked((p) => ({ file, token: (p?.token ?? 0) + 1 }));
                }}
              />
              <p id="vision-file-hint" className="hint">
                {t("visionFileHint")}
              </p>
            </div>
          )}
          <BackendSwitch value={effective} onChange={setBackend} real={real} forced={isUser} />
          <p className="hint vis-honest">
            <span aria-hidden="true">ⓘ</span> {t("visionHonest")}
          </p>
          <p role="status" className={`status${runFailed !== null || (classDecoded && !classDecoded.ok) || (detectDecoded && !detectDecoded.ok) ? " status-warn" : ""}`}>
            {status}
          </p>
        </section>

        {runFailed !== null && (
          <p role="alert" className="card error">
            <span aria-hidden="true">!</span> {t("visionRunError")}: {runFailed}
          </p>
        )}

        <section aria-labelledby="h-vision-classify" className="card">
          <h2 id="h-vision-classify">{t("visionClassify")}</h2>
          <p className="muted">{t("visionClassifyHint")}</p>
          <label className="field">
            <span>{t("visionTopK")}</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={10}
              step={1}
              value={topKText}
              aria-invalid={classDecoded && !classDecoded.ok ? true : undefined}
              aria-describedby={classDecoded && !classDecoded.ok ? "vision-topk-error" : undefined}
              onChange={(e) => setTopKText(e.target.value)}
            />
          </label>
          {classDecoded && !classDecoded.ok && <ErrorBlock id="vision-topk-error" error={classDecoded.error} />}
          {classNote !== null && <p className="note-row">{classNote}</p>}
          {classRaw && (
            <>
              <h3>{t("visionPreview")}</h3>
              <TensorPreview tensor={classRaw.input} spec={classRaw.spec} />
              <GeometryList geometry={classRaw.geometry} spec={classRaw.spec} source={classRaw.source} />
              {classDecoded?.ok && (classDecoded.value.length === 0 ? <p className="muted">{t("visionNoEntries")}</p> : <ClassBars entries={classDecoded.value} />)}
              <Timings raw={classRaw} postMs={classDecoded?.ok ? classDecoded.ms : 0} />
            </>
          )}
        </section>

        <section aria-labelledby="h-vision-detect" className="card">
          <h2 id="h-vision-detect">{t("visionDetect")}</h2>
          <p className="muted">{t("visionDetectHint")}</p>
          <p className="hint">{t("visionControlsHint")}</p>
          <div className="field-pair">
            <label className="field">
              <span>{t("visionScore")}</span>
              <input type="number" inputMode="decimal" min={0} max={1} step={0.05} value={scoreText} aria-invalid={detectDecoded && !detectDecoded.ok ? true : undefined} aria-describedby={detectErrorId} onChange={(e) => setScoreText(e.target.value)} />
            </label>
            <label className="field">
              <span>{t("visionIou")}</span>
              <input type="number" inputMode="decimal" min={0} max={1} step={0.05} value={iouText} aria-invalid={detectDecoded && !detectDecoded.ok ? true : undefined} aria-describedby={detectErrorId} onChange={(e) => setIouText(e.target.value)} />
            </label>
            <label className="field">
              <span>{t("visionMaxDet")}</span>
              <input type="number" inputMode="numeric" min={1} max={100} step={1} value={maxText} aria-invalid={detectDecoded && !detectDecoded.ok ? true : undefined} aria-describedby={detectErrorId} onChange={(e) => setMaxText(e.target.value)} />
            </label>
            <div className="field">
              <label className="check">
                <input type="checkbox" checked={nms} onChange={(e) => setNms(e.target.checked)} aria-describedby={detectErrorId ? `vision-nms-hint ${detectErrorId}` : "vision-nms-hint"} />
                <span>{t("visionNms")}</span>
              </label>
              <p id="vision-nms-hint" className="hint">
                {t("visionNmsHint")}
              </p>
            </div>
          </div>
          {detectDecoded && !detectDecoded.ok && <ErrorBlock id="vision-detect-error" error={detectDecoded.error} />}
          {detectNote !== null && <p className="note-row">{detectNote}</p>}
          {detectRaw && (
            <>
              {image && (
                <ImageCanvas image={image} alt={altText()}>
                  {detections && <BoxOverlay detections={shown} width={image.width} height={image.height} />}
                </ImageCanvas>
              )}
              <GeometryList geometry={detectRaw.geometry} spec={detectRaw.spec} source={detectRaw.source} />
              {detections && (
                <>
                  <h3>{t("visionDetections")}</h3>
                  {detections.length === 0 ? (
                    <p className="muted">{t("visionNoDetections")}</p>
                  ) : (
                    <>
                      <ul className="vis-legend" aria-label={t("visionLegend")}>
                        {[...new Set(shown.map((d) => d.classIndex))].map((ci) => {
                          const first = shown.find((d) => d.classIndex === ci)!;
                          const { color, dash } = classStyle(ci);
                          return (
                            <li key={ci}>
                              <span className="vis-swatch" aria-hidden="true" style={{ borderColor: color, borderStyle: dash }} /> {first.label} ×{shown.filter((d) => d.classIndex === ci).length}
                            </li>
                          );
                        })}
                      </ul>
                      <ol className="vis-detections" aria-label={t("visionDetections")}>
                        {shown.map((d, i) => (
                          <li key={i} className="vis-detection">
                            <span className="state">
                              <span aria-hidden="true">▢</span> {d.label}
                            </span>
                            <span className="num">{formatPercent(d.score, 1)}</span>
                            <span className="muted">{t("visionBox")}</span>
                            <code>{formatBox(d)}</code>
                          </li>
                        ))}
                      </ol>
                      {extra > 0 && <p className="muted">{fill("visionMore", { n: extra })}</p>}
                    </>
                  )}
                </>
              )}
              <Timings raw={detectRaw} postMs={detectDecoded?.ok ? detectDecoded.ms : 0} />
            </>
          )}
        </section>
      </main>
      <footer className="column muted">{t("visionFooter")}</footer>
    </>
  );
}
