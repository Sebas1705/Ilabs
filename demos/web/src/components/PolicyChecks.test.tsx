import type { CheckFinding } from "@ilabs/guardrails";
import { render, screen } from "@testing-library/react";
import { LangContext, type Lang } from "../i18n";
import { PolicyChecks } from "./PolicyChecks";

const findings: CheckFinding[] = [
  { check: 0, kind: "pii", action: "redact", fired: true, details: { findings: [{ kind: "email", start: 14, end: 29, text: "ana@example.com" }] } },
  { check: 1, kind: "injection", action: "flag", fired: false, details: { score: 20, signals: [{ id: "x", category: "override", start: 0, end: 4 }] } },
  { check: 2, kind: "denyTerms", action: "block", fired: true, details: { matches: [{ term: "secreto", start: 3, end: 10 }] } },
  { check: 3, kind: "maxLength", action: "flag", fired: false, details: { length: 55 } },
  { check: 4, kind: "canary", action: "block", fired: true, details: { found: true } },
  { check: 5, kind: "classifier", action: "flag", fired: true, details: { flagged: true, label: "toxic" } },
];

function mount(list: CheckFinding[] = findings, lang: Lang = "en") {
  return render(
    <LangContext.Provider value={lang}>
      <PolicyChecks findings={list} label="Check results" />
    </LangContext.Provider>,
  );
}

const items = () => Array.from(screen.getByRole("list", { name: "Check results" }).querySelectorAll(":scope > li"));

describe("PolicyChecks", () => {
  it("lists one row per check with its kind, action and whether it fired", () => {
    mount();
    expect(items()).toHaveLength(6);
    expect(items()[0]).toHaveTextContent("PII");
    expect(items()[0]).toHaveTextContent("Redact");
    expect(items()[0]).toHaveTextContent("Fired");
    expect(items()[1]).toHaveTextContent("Not fired");
    expect(items()[2]).toHaveTextContent("Block");
  });

  it("writes the details of each kind as text", () => {
    mount();
    expect(items()[0]).toHaveTextContent("1 finding");
    expect(items()[0]).toHaveTextContent("Email");
    expect(items()[0]).toHaveTextContent("ana@example.com");
    expect(items()[1]).toHaveTextContent("Score 20");
    expect(items()[2]).toHaveTextContent("secreto");
    expect(items()[2]).toHaveTextContent("Code points 3–10");
    expect(items()[3]).toHaveTextContent("Length 55");
    expect(items()[4]).toHaveTextContent("Canary found");
    expect(items()[5]).toHaveTextContent("Flagged");
    expect(items()[5]).toHaveTextContent("toxic");
  });

  it("gives every fired or not-fired badge a glyph that is hidden from assistive technology", () => {
    mount();
    for (const li of items()) {
      const badge = li.querySelector(".badge-fired")!;
      expect(badge.querySelector('[aria-hidden="true"]')).not.toBeNull();
    }
  });

  it("says when there is no check", () => {
    mount([]);
    expect(screen.queryByRole("list", { name: "Check results" })).toBeNull();
    expect(screen.getByText("No check is switched on.")).toBeInTheDocument();
  });

  it("is translated", () => {
    mount(findings, "es");
    expect(items()[0]).toHaveTextContent("Disparada");
    expect(items()[1]).toHaveTextContent("No disparada");
  });
});
