import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "./safe-http.js";
import type {RequestTrace} from "./session-diagnostics.js";
export const MANIFEST_PREVIEW = "baseline-v1";
export const MANIFEST_PREVIEW_HEADER = "X-Sim-Manifest-Preview";
/** Explicit generated baseline; never select a run fault or seed freeze/cache state. */
export function manifestPreview(req: IncomingMessage, res: ServerResponse, manifest: boolean, trace?:RequestTrace): boolean {
  const value = req.headers["x-sim-manifest-preview"];
  if (value === undefined) return false;
  if (value !== MANIFEST_PREVIEW || !manifest || !["GET", "HEAD"].includes(req.method ?? ""))
    throw new HttpError(400, "Manifest preview requires a supported manifest GET/HEAD");
  res.setHeader(MANIFEST_PREVIEW_HEADER, MANIFEST_PREVIEW);
  res.setHeader("Cache-Control", "no-store");
  trace?.record("manifest.preview");
  return true;
}
