import * as guardrails from "@ilabs/guardrails";
import type { CheckResult } from "@ilabs/guardrails";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { App } from "../App";
import { LangContext, type Lang } from "../i18n";
import { evalFixtures, guardedFixtures, guardrailFixtures, playgroundFixtures } from "../guardrailsFixtures";
import { GuardrailsPage } from "./GuardrailsPage";

vi.mock("@ilabs/guardrails", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ilabs/guardrails")>();
  return { ...actual, checkText: vi.fn(actual.checkText), runFixture: vi.fn(actual.runFixture) };
});

function mount(lang: Lang = "en") {
  return render(
    <LangContext.Provider value={lang}>
      <GuardrailsPage />
    </LangContext.Provider>,
  );
}

const settled = () => waitFor(() => expect(screen.getByRole("main")).not.toHaveAttribute("aria-busy", "true"));
const section = (name: string) => screen.getByRole("region", { name });
const playground = () => section("Playground");
const guarded = () => section("Guarded conversation");
const measure = () => section("Measure");
const sample = (region: HTMLElement) => within(region).getByLabelText("Sample") as HTMLSelectElement;
const textarea = () => within(playground()).getByLabelText("Text") as HTMLTextAreaElement;
const verdict = () => within(playground()).getByRole("region", { name: "Verdict" });
const status = (region: HTMLElement) => within(region).getByRole("status");

async function pick(region: HTMLElement, name: string) {
  fireEvent.change(sample(region), { target: { value: name } });
  await settled();
}
const type = (value: string) => fireEvent.change(textarea(), { target: { value } });
const marks = () => Array.from(within(playground()).getByRole("region", { name: "Text with findings" }).querySelectorAll("mark"));
const action = (group: string) => within(within(playground()).getByRole("group", { name: group })).getByLabelText("Action") as HTMLSelectElement;
const by = (name: string) => guardrailFixtures.find((f) => f.name === name)!;
const tableRows = (table: HTMLElement) => within(table).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell").map((c) => c.textContent));

describe("GuardrailsPage", () => {
  it("is reachable from the nav through the registry", async () => {
    window.location.hash = "";
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("link", { name: "Guardrails" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Guardrails" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Guardrails" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "RAG" })).not.toHaveAttribute("aria-current");
    expect(window.location.hash).toBe("#/guardrails");
  });

  it("has three named sections, each with a heading, in the order Playground, Guarded conversation and Measure", async () => {
    mount();
    await settled();
    const names = ["Playground", "Guarded conversation", "Measure"];
    const regions = names.map((name) => section(name));
    for (const [i, name] of names.entries()) {
      expect(within(regions[i]!).getByRole("heading", { level: 2, name })).toBeInTheDocument();
      if (i > 0) expect(regions[i - 1]!.compareDocumentPosition(regions[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("offers the samples grouped PII, Injection and Checks, and the guarded and measure pickers", async () => {
    mount();
    await settled();
    const groups = within(sample(playground())).getAllByRole("group");
    expect(groups.map((g) => g.getAttribute("label"))).toEqual(["PII", "Injection", "Checks"]);
    const offered = playgroundFixtures(guardrailFixtures);
    expect(within(sample(playground())).getAllByRole("option")).toHaveLength(offered.length);
    // A sample that expects an error is not text to analyse, so it is not offered.
    const errorNames = guardrailFixtures.filter((f) => "error" in f.expect).map((f) => f.name);
    expect(errorNames.length).toBeGreaterThan(0);
    const optionNames = within(sample(playground())).getAllByRole("option").map((o) => (o as HTMLOptionElement).value);
    for (const name of errorNames) expect(optionNames).not.toContain(name);
    expect(within(sample(guarded())).getAllByRole("option")).toHaveLength(guardedFixtures(guardrailFixtures).length);
    expect(within(sample(guarded())).getAllByRole("option").length).toBeGreaterThanOrEqual(21);
    expect(within(sample(measure())).getAllByRole("option").map((o) => o.textContent)).toEqual(["eval-labelled-set", "eval-shift-length-plus-one", "eval-spans-kept-apart"]);
  });

  it("starts on the first PII sample, the scripted ok guarded sample and the labelled set", async () => {
    mount();
    await settled();
    expect(sample(playground())).toHaveValue("pii-card-dot-separator-not-card");
    expect(textarea()).toHaveValue(by("pii-card-dot-separator-not-card").setup.text as string);
    expect(sample(guarded())).toHaveValue("guarded-ok-redact-and-restore");
    expect(sample(measure())).toHaveValue("eval-labelled-set");
  });

  it("renders every playground sample without an alert and with a status line", async () => {
    mount();
    const names = within(sample(playground())).getAllByRole("option").map((o) => (o as HTMLOptionElement).value);
    expect(names.length).toBeGreaterThanOrEqual(150);
    for (const name of names) {
      await pick(playground(), name);
      expect(screen.queryByRole("alert"), name).toBeNull();
      expect(status(playground()).textContent, name).toMatch(/^\d+ findings?, verdict (allow|block)$/);
      // A textarea reports its value with line breaks normalised to LF; the library keeps running on the sample as written.
      expect(textarea().value, name).toBe((by(name).setup.text as string).replace(/\r\n?/g, "\n"));
    }
  }, 120_000);

  it("renders every guarded sample and every measure sample without an alert", async () => {
    mount();
    for (const f of guardedFixtures(guardrailFixtures)) {
      await pick(guarded(), f.name);
      expect(screen.queryByRole("alert"), f.name).toBeNull();
      expect(status(guarded()).textContent, f.name).not.toBe("");
    }
    for (const f of evalFixtures(guardrailFixtures)) {
      await pick(measure(), f.name);
      expect(screen.queryByRole("alert"), f.name).toBeNull();
      expect(status(measure()).textContent, f.name).not.toBe("");
    }
  }, 120_000);

  describe("playground", () => {
    it("highlights a PII finding and shows the redacted text with its mapping", async () => {
      mount();
      await pick(playground(), "pii-email-basic");
      expect(marks()).toHaveLength(1);
      expect(marks()[0]).toHaveTextContent("ana@example.com");
      expect(marks()[0]).toHaveTextContent("Email");
      const redacted = within(playground()).getByRole("region", { name: "Redacted text" });
      expect(redacted.querySelector("pre")!.textContent).toBe("Escríbeme a <EMAIL_1> mañana.");
      expect(tableRows(within(redacted).getByRole("table", { name: "Mapping" }))).toEqual([["<EMAIL_1>", "ana@example.com"]]);
      expect(status(playground())).toHaveTextContent("1 finding, verdict allow");
    });

    it("reacts live to typing an email", async () => {
      mount();
      await pick(playground(), "pii-empty-text");
      expect(marks()).toHaveLength(0);
      expect(status(playground())).toHaveTextContent("0 findings, verdict allow");
      type("write to bob@example.org today");
      await waitFor(() => expect(marks()).toHaveLength(1));
      expect(marks()[0]).toHaveTextContent("bob@example.org");
      expect(within(playground()).getByRole("region", { name: "Redacted text" }).querySelector("pre")!.textContent).toBe("write to <EMAIL_1> today");
      expect(status(playground())).toHaveTextContent("1 finding, verdict allow");
    });

    it("highlights after an emoji and keeps a lone surrogate in the text", async () => {
      mount();
      await pick(playground(), "injection-delimiter-offsets-after-emoji");
      expect(marks()).toHaveLength(1);
      expect(marks()[0]).toHaveTextContent("[INST]");
      await pick(playground(), "pii-lone-surrogates-offsets");
      const expected = (by("pii-lone-surrogates-offsets").expect as { findings: { text: string }[] }).findings;
      expect(marks().length).toBe(expected.length);
      for (const [i, f] of expected.entries()) expect(marks()[i]!.textContent).toContain(f.text);
    });

    it("shows the injection score as text with a decorative bar, and the signals that fired", async () => {
      mount();
      await pick(playground(), "injection-en-ignore-previous");
      const region = within(playground()).getByRole("region", { name: "Injection score" });
      expect(region).toHaveTextContent("Score: 50 of 100");
      expect(region.querySelector('.tokenbar[aria-hidden="true"]')).not.toBeNull();
      const rows = tableRows(within(region).getByRole("table", { name: "Signals that fired" }));
      expect(rows).toEqual([["en-ignore-previous", "Override", "7–39"]]);
      expect(marks()[0]).toHaveTextContent("Override");
    });

    it("says no signal fired for a clean text", async () => {
      mount();
      await pick(playground(), "injection-clean-text-zero");
      const region = within(playground()).getByRole("region", { name: "Injection score" });
      expect(region).toHaveTextContent("Score: 0 of 100");
      expect(region).toHaveTextContent("No signal fired.");
    });

    it("changes the verdict when the PII check is set to block", async () => {
      mount();
      await pick(playground(), "pii-email-basic");
      expect(verdict()).toHaveTextContent("Allow");
      fireEvent.change(action("PII check"), { target: { value: "block" } });
      await waitFor(() => expect(verdict()).toHaveTextContent("Block"));
      expect(status(playground())).toHaveTextContent("1 finding, verdict block");
      const list = within(verdict()).getByRole("list", { name: "Check results" });
      expect(list).toHaveTextContent("Fired");
    });

    it("lets the PII kinds be narrowed through the library", async () => {
      mount();
      await pick(playground(), "pii-email-basic");
      const group = within(playground()).getByRole("group", { name: "PII kinds to look for" });
      expect(within(group).getAllByRole("checkbox")).toHaveLength(6);
      await userEvent.setup().click(within(group).getByRole("checkbox", { name: "Email" }));
      await waitFor(() => expect(marks()).toHaveLength(0));
      expect(status(playground())).toHaveTextContent("0 findings, verdict allow");
    });

    it("starts the toggles from the checks of a check sample", async () => {
      mount();
      await pick(playground(), "check-block-beats-redact");
      expect(action("PII check")).toHaveValue("redact");
      expect(action("Denied terms")).toHaveValue("block");
      expect(within(playground()).getByLabelText("Terms (comma separated)")).toHaveValue("secreto");
      expect(action("Injection check")).toHaveValue("off");
      expect(verdict()).toHaveTextContent("Block");
      expect(verdict()).toHaveTextContent("El secreto es <EMAIL_1>");
      expect(screen.queryByText(/cannot express/)).toBeNull();
    });

    it("says when a sample has checks the toggles cannot express", async () => {
      mount();
      await pick(playground(), "check-classifier-flagged");
      expect(within(playground()).getByText(/checks these controls cannot express/)).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("shows a translated invalid-policy message with the library reason, without a verdict", async () => {
      mount();
      await pick(playground(), "injection-en-ignore-previous");
      fireEvent.change(action("Injection check"), { target: { value: "block" } });
      fireEvent.change(within(playground()).getByLabelText("Threshold (1–100)"), { target: { value: "0" } });
      const error = await within(playground()).findByRole("region", { name: "Policy error" });
      expect(error).toHaveTextContent("The policy is not valid, so no verdict was computed.");
      expect(error).toHaveTextContent("Reason:");
      expect(error.querySelector("code")!.textContent).toMatch(/^invalid policy: /);
      expect(status(playground())).toHaveTextContent("The policy is not valid.");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(within(playground()).queryByRole("region", { name: "Verdict" })).toBeNull();
      // The scans do not depend on the policy and stay visible.
      expect(within(playground()).getByRole("region", { name: "Injection score" })).toHaveTextContent("Score: 50 of 100");
      fireEvent.change(within(playground()).getByLabelText("Threshold (1–100)"), { target: { value: "40" } });
      await waitFor(() => expect(verdict()).toHaveTextContent("Block"));
      expect(within(playground()).queryByRole("region", { name: "Policy error" })).toBeNull();
    });

    it("translates an empty PII kind selection as an invalid option", async () => {
      mount();
      await pick(playground(), "pii-email-basic");
      const group = within(playground()).getByRole("group", { name: "PII kinds to look for" });
      const user = userEvent.setup();
      for (const box of within(group).getAllByRole("checkbox")) await user.click(box);
      const error = await within(playground()).findByRole("region", { name: "Policy error" });
      expect(error).toHaveTextContent("Some option is not valid.");
      expect(error.querySelector("code")!.textContent).not.toBe("");
    });

    it("shows an alert when a run is rejected unexpectedly, then recovers", async () => {
      mount();
      await settled();
      vi.mocked(guardrails.checkText).mockRejectedValueOnce(new Error("boom"));
      type("another text");
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not run the fixture: boom");
      expect(status(playground())).toHaveTextContent("The call failed: boom");
      type("another text again");
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    });

    it("ignores a stale result when the text changes quickly", async () => {
      mount();
      await pick(playground(), "pii-empty-text");
      let release: (r: CheckResult) => void = () => {};
      vi.mocked(guardrails.checkText).mockImplementationOnce(() => new Promise<CheckResult>((resolve) => (release = resolve)));
      type("first@example.com");
      type("second@example.org");
      await waitFor(() => expect(marks()[0]).toHaveTextContent("second@example.org"));
      expect(verdict()).toHaveTextContent("Allow");
      release({ verdict: "block", text: "stale", mapping: [], findings: [] });
      await new Promise((r) => setTimeout(r, 30));
      expect(verdict()).toHaveTextContent("Allow");
      expect(marks()).toHaveLength(1);
      expect(marks()[0]).toHaveTextContent("second@example.org");
      expect(screen.queryByText("stale")).toBeNull();
    });

    it("keeps a fast switch of sample from pairing the results of one with the text of another", async () => {
      mount();
      await pick(playground(), "pii-email-basic");
      await pick(playground(), "injection-en-ignore-previous");
      expect(within(playground()).getByRole("region", { name: "Injection score" })).toHaveTextContent("Score: 50 of 100");
      expect(marks().map((m) => m.getAttribute("data-family"))).toEqual(["injection"]);
    });

    it("states the honest limits of the scanners", async () => {
      mount();
      await settled();
      expect(within(playground()).getByText(/lexical heuristic/)).toHaveTextContent(/names and addresses/);
    });
  });

  describe("guarded conversation", () => {
    it("shows what was written, what was sent, the scripted reply and the restored final text", async () => {
      mount();
      await settled();
      const g = guarded();
      expect(within(within(g).getByRole("region", { name: "Request as written" })).getByRole("list")).toHaveTextContent("Mi correo es ana@example.com, confírmalo.");
      expect(within(g).getByRole("region", { name: "Sent to the model" })).toHaveTextContent("Mi correo es <EMAIL_1>, confírmalo.");
      expect(within(g).getByRole("region", { name: "Sent to the model" })).toHaveTextContent("Eres un asistente de una biblioteca.");
      expect(within(g).getByRole("region", { name: "Scripted model reply" })).toHaveTextContent("Confirmado: <EMAIL_1>.");
      const outcome = within(g).getByRole("region", { name: "Outcome" });
      expect(outcome).toHaveTextContent("Confirmado: ana@example.com.");
      expect(outcome).toHaveTextContent("Model calls: 1");
      expect(within(g).getByRole("region", { name: "Input findings" })).toHaveTextContent("ana@example.com");
      expect(within(g).getByRole("region", { name: "Output findings" })).toBeInTheDocument();
      expect(tableRows(within(g).getByRole("table", { name: "Mapping" }))).toEqual([["<EMAIL_1>", "ana@example.com"]]);
      expect(status(g)).toHaveTextContent("Completed, 1 model call");
    });

    it("says the model is scripted and offers no field to edit", async () => {
      mount();
      await settled();
      expect(within(guarded()).getByText(/model is scripted/)).toBeInTheDocument();
      expect(within(guarded()).queryByRole("textbox")).toBeNull();
    });

    it("shows the reason and zero calls for a request blocked before the call", async () => {
      mount();
      await pick(guarded(), "guarded-blocked-input-zero-calls");
      const outcome = within(guarded()).getByRole("region", { name: "Outcome" });
      expect(outcome).toHaveTextContent("Blocked before the call: an input check blocked the request.");
      expect(outcome).toHaveTextContent("Model calls: 0");
      expect(within(guarded()).queryByRole("region", { name: "Scripted model reply" })).toBeNull();
      expect(within(guarded()).getByRole("region", { name: "Sent to the model" })).toHaveTextContent("Nothing was sent");
      expect(status(guarded())).toHaveTextContent("Blocked: an input check blocked the request.");
    });

    it("shows the reason after a call for a reply blocked by an output check, and no final text", async () => {
      mount();
      await pick(guarded(), "guarded-blocked-output");
      const outcome = within(guarded()).getByRole("region", { name: "Outcome" });
      expect(outcome).toHaveTextContent("Blocked after the call: an output check blocked the reply.");
      expect(outcome).toHaveTextContent("Model calls: 1");
      expect(within(outcome).queryByText("Final text")).toBeNull();
      expect(status(guarded())).toHaveTextContent("Blocked: an output check blocked the reply.");
    });

    it("shows a provider error as a translated state, not as an alert", async () => {
      mount();
      await pick(guarded(), "guarded-provider-error");
      expect(within(guarded()).getByRole("region", { name: "Outcome" })).toHaveTextContent("The model call failed with timeout.");
      expect(status(guarded())).toHaveTextContent("The model call failed with timeout.");
      expect(screen.queryByRole("alert")).toBeNull();
      await pick(guarded(), "guarded-no-classifier-zero-calls");
      expect(within(guarded()).getByRole("region", { name: "Outcome" })).toHaveTextContent("The policy needs a classifier and none was given, so nothing ran.");
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("lists the output mapping when the reply was redacted", async () => {
      mount();
      await pick(guarded(), "guarded-output-redaction-new-placeholders");
      const exp = by("guarded-output-redaction-new-placeholders").expect as { outputMapping: [string, string][] };
      expect(exp.outputMapping.length).toBeGreaterThan(0);
      const table = within(guarded()).getByRole("table", { name: "Output mapping" });
      expect(tableRows(table)).toEqual(exp.outputMapping);
    });

    it("shows an alert when the harness rejects", async () => {
      mount();
      await settled();
      vi.mocked(guardrails.runFixture).mockRejectedValueOnce(new Error("kaput"));
      await pick(guarded(), "guarded-system-untouched");
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not run the fixture: kaput");
      expect(status(guarded())).toHaveTextContent("The call failed: kaput");
    });
  });

  describe("measure", () => {
    it("shows precision, recall and F1 per detector and per kind, with the values of the library", async () => {
      mount();
      await settled();
      const exp = by("eval-labelled-set").expect as { pii: { precision: number; recall: number; f1: number; byKind: { kind: string }[] }; injection: { precision: number; byKind: { kind: string }[] } };
      const pii = within(measure()).getByRole("table", { name: "PII detector" });
      const all = tableRows(pii)[0]!;
      expect(all[0]).toBe("All kinds");
      expect(all.slice(4)).toEqual([exp.pii.precision.toFixed(3), exp.pii.recall.toFixed(3), exp.pii.f1.toFixed(3)]);
      expect(tableRows(pii)).toHaveLength(1 + exp.pii.byKind.length);
      const inj = within(measure()).getByRole("table", { name: "Injection detector" });
      expect(tableRows(inj)[0]![4]).toBe(exp.injection.precision.toFixed(3));
      expect(pii.querySelectorAll('.tokenbar[aria-hidden="true"]').length).toBeGreaterThan(0);
      expect(status(measure())).toHaveTextContent(/^23 samples; PII F1 \d\.\d{3}, injection F1 \d\.\d{3}$/);
    });

    it("lists the labelled samples with each span marked correct, missed or extra as glyph and text", async () => {
      mount();
      await settled();
      const list = within(measure()).getByRole("list", { name: "Samples" });
      expect(list.querySelectorAll(":scope > li")).toHaveLength(23);
      const badges = Array.from(list.querySelectorAll(".badge"));
      const words = new Set(badges.map((b) => b.querySelector(".badge-label")!.textContent));
      expect(words).toEqual(new Set(["Correct", "Missed", "Extra"]));
      for (const b of badges) expect(b.querySelector('[aria-hidden="true"]')).not.toBeNull();
      expect(within(list).getAllByText("Correct").length).toBeGreaterThan(5);
    });

    it("says the set is small and has misses and false positives, and follows another set", async () => {
      mount();
      await settled();
      expect(within(measure()).getByText(/deliberately contains misses and false positives/)).toBeInTheDocument();
      await pick(measure(), "eval-spans-kept-apart");
      const exp = by("eval-spans-kept-apart").expect as { pii: { precision: number } };
      expect(tableRows(within(measure()).getByRole("table", { name: "PII detector" }))[0]![4]).toBe(exp.pii.precision.toFixed(3));
      expect(status(measure())).toHaveTextContent(/^2 samples;/);
    });
  });

  it("renders in Spanish", async () => {
    mount("es");
    await settled();
    expect(screen.getByRole("heading", { level: 1, name: "Guardrails" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Zona de pruebas" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Conversación protegida" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Medición" })).toBeInTheDocument();
    const region = screen.getByRole("region", { name: "Zona de pruebas" });
    expect(within(region).getByRole("status")).toHaveTextContent(/^\d+ hallazgos?, veredicto (permitir|bloquear)$/);
    expect(within(sample2(region)).getAllByRole("group").map((g) => g.getAttribute("label"))).toEqual(["PII", "Inyección", "Comprobaciones"]);
  });
});

function sample2(region: HTMLElement) {
  return within(region).getByLabelText("Muestra");
}
