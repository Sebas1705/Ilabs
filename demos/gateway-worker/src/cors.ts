// Origin allowlist (environment rules E3 and E4) and the CORS headers of the responses.
//
// The allowlist is a browser-abuse and CORS control, not authentication: a script can call the
// Worker without any Origin at all.

import { LIMITS } from "./limits.js";

const VALID_ENTRY = /^(?:http|https):\/\/(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::([1-9][0-9]{0,4}))?$/;

function trimSpaceAndTab(value: string): string {
  return value.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
}

function isValidEntry(entry: string): boolean {
  const m = VALID_ENTRY.exec(entry);
  if (m === null) return false;
  const port = m[1];
  return port === undefined || Number(port) <= 65_535;
}

/**
 * The set of valid entries of `ALLOWED_ORIGINS`: split on commas only, each entry trimmed of
 * ASCII space and tab only, empty and invalid entries dropped. `*` and `null` are never valid.
 */
export function parseAllowlist(raw: unknown): ReadonlySet<string> {
  const allowed = new Set<string>();
  if (typeof raw !== "string") return allowed;
  for (const part of raw.split(",")) {
    const entry = trimSpaceAndTab(part);
    if (entry !== "" && isValidEntry(entry)) allowed.add(entry);
  }
  return allowed;
}

/** Headers present on every response, whatever its status. */
export function commonHeaders(allowedOrigin: string | null): Headers {
  const headers = new Headers();
  headers.set("vary", "Origin");
  headers.set("cache-control", "no-store");
  if (allowedOrigin !== null) headers.set("access-control-allow-origin", allowedOrigin);
  return headers;
}

export function preflightHeaders(allowedOrigin: string | null): Headers {
  const headers = commonHeaders(allowedOrigin);
  headers.set("access-control-allow-methods", "POST, OPTIONS");
  headers.set("access-control-allow-headers", "content-type, x-ilabs-api-key");
  headers.set("access-control-max-age", String(LIMITS.preflightMaxAgeSeconds));
  return headers;
}
