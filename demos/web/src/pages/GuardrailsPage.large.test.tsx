import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LangContext } from "../i18n";
import { GuardrailsPage } from "./GuardrailsPage";

function mount() {
  return render(
    <LangContext.Provider value="en">
      <GuardrailsPage />
    </LangContext.Provider>,
  );
}

const settled = () => waitFor(() => expect(screen.getByRole("main")).not.toHaveAttribute("aria-busy", "true"), { timeout: 60_000 });
const playground = () => screen.getByRole("region", { name: "Playground" });
const textarea = () => within(playground()).getByLabelText("Text") as HTMLTextAreaElement;
const group = (name: string) => within(playground()).getByRole("group", { name });

async function pick(name: string) {
  fireEvent.change(within(playground()).getByLabelText("Sample"), { target: { value: name } });
  await settled();
}

describe("playground with invalid options", () => {
  it("keeps the real injection score visible when every PII kind is unchecked", async () => {
    mount();
    await pick("injection-en-ignore-previous");
    const user = userEvent.setup();
    for (const box of within(group("PII kinds to look for")).getAllByRole("checkbox")) await user.click(box);
    const error = await within(playground()).findByRole("region", { name: "Policy error" });
    expect(error).toHaveTextContent("Some option is not valid.");
    const injection = within(playground()).getByRole("region", { name: "Injection score" });
    expect(injection).toHaveTextContent("Score: 50 of 100");
    expect(within(injection).getByRole("table", { name: "Signals that fired" })).toBeInTheDocument();
    // The PII parts were not computed, so they are not shown as if nothing was found.
    expect(within(playground()).queryByRole("region", { name: "Redacted text" })).toBeNull();
    expect(within(playground()).getByRole("region", { name: "Text with findings" })).not.toHaveTextContent("Nothing was found");
  });

  it("marks the numeric fields invalid and ties them to the policy error", async () => {
    mount();
    await pick("injection-en-ignore-previous");
    fireEvent.change(within(group("Injection check")).getByLabelText("Action"), { target: { value: "block" } });
    fireEvent.change(within(group("Injection check")).getByLabelText("Threshold (1–100)"), { target: { value: "0" } });
    const error = await within(playground()).findByRole("region", { name: "Policy error" });
    const threshold = within(group("Injection check")).getByLabelText("Threshold (1–100)");
    expect(threshold).toHaveAttribute("aria-invalid", "true");
    expect(error.id).not.toBe("");
    expect(threshold.getAttribute("aria-describedby")).toContain(error.id);
    // A check that is off has nothing to be invalid about.
    expect(within(group("Maximum length")).getByLabelText("Maximum length (code points)")).not.toHaveAttribute("aria-invalid", "true");
    fireEvent.change(within(group("Injection check")).getByLabelText("Threshold (1–100)"), { target: { value: "40" } });
    await waitFor(() => expect(within(group("Injection check")).getByLabelText("Threshold (1–100)")).not.toHaveAttribute("aria-invalid", "true"));
  });
});

describe("playground with large text", () => {
  it("renders 1,500 emails in a 70 KB text in under a second", async () => {
    mount();
    await pick("pii-empty-text");
    const emails = Array.from({ length: 1500 }, (_, i) => `user${i}@example.com`).join(" ");
    const text = emails + " lorem ipsum".repeat(Math.ceil((70_000 - emails.length) / 12));
    expect(text.length).toBeGreaterThanOrEqual(70_000);
    const t0 = performance.now();
    fireEvent.change(textarea(), { target: { value: text } });
    await waitFor(() => expect(within(playground()).getByRole("status")).toHaveTextContent("1500 findings"), { timeout: 60_000 });
    const ms = performance.now() - t0;
    console.log(`70 KB / 1500 emails: ${Math.round(ms)} ms`);
    expect(ms).toBeLessThan(1000);
    const list = within(playground()).getByRole("list", { name: "Findings" });
    expect(list.querySelectorAll(":scope > li")).toHaveLength(200);
    expect(playground()).toHaveTextContent("+1300 more");
  }, 60_000);

  it("does not hang on a dense 1 MB text and says it is shown as plain text", async () => {
    mount();
    await pick("pii-empty-text");
    const text = "a@example.com ".repeat(Math.ceil(1_000_000 / 14));
    const t0 = performance.now();
    fireEvent.change(textarea(), { target: { value: text } });
    await waitFor(() => expect(within(playground()).getByRole("status")).toHaveTextContent(/findings/), { timeout: 120_000 });
    const ms = performance.now() - t0;
    console.log(`1 MB dense: ${Math.round(ms)} ms`);
    expect(ms).toBeLessThan(30_000);
    expect(within(playground()).getByRole("region", { name: "Text with findings" })).toHaveTextContent("too large to highlight inline");
    expect(screen.queryByRole("alert")).toBeNull();
  }, 150_000);
});
