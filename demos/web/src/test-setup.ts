import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom does not implement scrolling; the app calls window.scrollTo after a page change.
window.scrollTo = () => {};

afterEach(() => {
  cleanup();
  try {
    localStorage.clear();
  } catch {
    /* storage unavailable */
  }
});

// jsdom has no canvas: without a stub every getContext call prints a "not implemented" error. Tests that
// need pixels replace this with their own fake context.
HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
