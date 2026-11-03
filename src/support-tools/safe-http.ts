import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import type { Readable } from "node:stream";
import { RequestDeadline } from "./request-deadline.js";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import {
  SessionDiagnostics,
  RequestTrace,
  TRACE_HEADERS,
} from "./session-diagnostics.js";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function portNumber(value: number, label = "port"): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535)
    throw new Error(`${label} must be an integer from 1 to 65535`);
  return value;
}

export function bindHost(host = "127.0.0.1"): string {
  if (host !== "localhost" && !net.isIP(host))
    throw new Error("host must be localhost or an IP address");
  return host;
}

export function loopback(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}

export function httpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "Invalid HTTP URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new HttpError(
      400,
      "Only HTTP(S) URLs without embedded credentials are supported",
    );
  return url;
}

export interface OriginAuth {
  token?: string;
  header?: string;
  file?: string;
}

export class OriginPolicy {
  private origins: Set<string>;
  private credentialOrigin: string;
  private credentials: Record<string, string> = {};
  constructor(root: string, auth: OriginAuth = {}, allowed: string[] = []) {
    this.credentialOrigin = httpUrl(root).origin;
    this.origins = new Set([
      this.credentialOrigin,
      ...allowed.map((value) => {
        const url = httpUrl(value);
        if (url.pathname !== "/" || url.search || url.hash)
          throw new Error(
            "allow-origin must contain only scheme, host and port",
          );
        return url.origin;
      }),
    ]);
    if ([auth.token, auth.header, auth.file].filter(Boolean).length > 1)
      throw new Error("Choose one authentication method");
    if (auth.token) this.credentials.Authorization = `Bearer ${auth.token}`;
    if (auth.header) {
      const colon = auth.header.indexOf(":");
      if (colon < 1) throw new Error("auth-header must be Header-Name: value");
      this.credentials[auth.header.slice(0, colon).trim()] = auth.header
        .slice(colon + 1)
        .trim();
    }
    if (auth.file)
      this.credentials = JSON.parse(fs.readFileSync(auth.file, "utf8"));
    if (
      !this.credentials ||
      typeof this.credentials !== "object" ||
      Array.isArray(this.credentials)
    )
      throw new Error("Auth file must contain a header object");
    for (const [key, value] of Object.entries(this.credentials)) {
      if (
        !/^[!#$%&'*+.^_`|~\w-]+$/.test(key) ||
        /^(host|connection|content-length|transfer-encoding|accept-encoding|range|if-.*|proxy-.*)$/i.test(
          key,
        ) ||
        typeof value !== "string" ||
        /[\r\n]/.test(value)
      )
        throw new Error("Invalid origin authentication header");
    }
  }
  check(value: string): URL {
    const url = httpUrl(value);
    if (!this.origins.has(url.origin))
      throw new HttpError(
        403,
        "Origin is not allowed; declare it with --allow-origin",
      );
    return url;
  }
  headers(value: string): Record<string, string> {
    return this.check(value).origin === this.credentialOrigin
      ? { ...this.credentials }
      : {};
  }
}

export interface RemoteResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  url: string;
}
/** Buffer a bounded origin response without retaining Fetch/AbortSignal weak graphs. */
function readOrigin(
  url: string,
  method: "GET" | "HEAD",
  headers: Record<string, string>,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let response: http.IncomingMessage, reader: Readable, settled = false;
    const streams: Readable[] = [], chunks: Buffer[] = [];
    let size = 0, encodedSize = 0;
    const request = (url.startsWith("https:") ? https : http).request(url, { method, headers }, res => {
      response = res;
      const status = res.statusCode;
      res.on("error", fail);
      if ([301, 302, 303, 307, 308].includes(status)) {
        finish(Buffer.alloc(0));
        res.destroy(); // Redirect bodies cannot hold a connection or outlive the deadline.
        return;
      }
      reader = res;
      const encoding = String(res.headers["content-encoding"] ?? "identity").toLowerCase();
      const encodings = encoding.split(",").map(value => value.trim());
      if (method !== "HEAD" && ![204, 205, 304].includes(status) && encodings.every(value => ["identity", "gzip", "x-gzip", "deflate", "br"].includes(value))) {
        for (const value of encodings.reverse()) {
          const decoder = value === "gzip" || value === "x-gzip" ? zlib.createGunzip() : value === "deflate" ? zlib.createUnzip() : value === "br" ? zlib.createBrotliDecompress() : undefined;
          if (decoder) { streams.push(decoder); decoder.on("error", fail); reader = reader.pipe(decoder); }
        }
      }
      if (reader !== res) res.on("data", chunk => {
        encodedSize += chunk.length;
        if (encodedSize > maxBytes) fail(new HttpError(502, "Origin response exceeds the size limit"));
      });
      reader.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) fail(new HttpError(502, "Origin response exceeds the size limit"));
        else chunks.push(chunk);
      });
      reader.once("end", () => {
        if (!res.complete) fail(new HttpError(502, "Incomplete origin response"));
        else finish(Buffer.concat(chunks, size));
      });
    });
    function finish(body: Buffer) {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", aborted);
      resolve({status: response.statusCode, headers: response.headers, body});
    }
    function fail(error: Error) {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", aborted);
      request.destroy(); response?.destroy();
      for (const stream of streams) stream.destroy();
      chunks.length = 0;
      reject(error);
    }
    function aborted() { fail(signal.reason); }
    request.on("error", fail);
    if (signal.aborted) aborted();
    else { signal.addEventListener("abort", aborted, {once: true}); request.end(); }
  });
}

export async function fetchRemote(
  value: string,
  policy: OriginPolicy,
  options: { range?: string; maxBytes?: number; signal?: AbortSignal; method?: "GET" | "HEAD"; manifestPreview?: boolean } = {},
): Promise<RemoteResponse> {
  let url = value;
  const deadline = new RequestDeadline(10000, options.signal);
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      policy.check(url);
      const response = await readOrigin(url, options.method ?? "GET", {
        ...policy.headers(url),
        "Accept-Encoding": "identity",
        ...(options.manifestPreview ? {"X-Sim-Manifest-Preview":"baseline-v1"} : {}),
        ...(options.range ? {Range: options.range} : {}),
      }, options.maxBytes ?? 64 * 1024 * 1024, deadline.signal);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.location;
        if (!location || redirects === 5) throw new HttpError(502, "Invalid or excessive origin redirects");
        url = new URL(location, url).href;
        continue;
      }
      const headers: Record<string, string> = {};
      for (const key of ["content-type", "content-range", "accept-ranges", "etag", "last-modified", "cache-control", "date", "retry-after", "www-authenticate", "age", "expires", "vary"]) {
        const header = response.headers[key];
        if (header) headers[key] = Array.isArray(header) ? header.join(", ") : header;
      }
      if (options.method === "HEAD" && /^\d+$/.test(response.headers["content-length"] ?? "")) headers["content-length"] = response.headers["content-length"];
      if (response.headers["content-encoding"] && String(response.headers["content-encoding"]).toLowerCase() !== "identity") {
        delete headers.etag; delete headers["last-modified"]; delete headers["content-length"];
      }
      return {status: response.status, headers, body: response.body, url};
    }
    throw new HttpError(502, "Too many origin redirects");
  } finally { deadline.close(); }
}

export async function listen(
  server: http.Server,
  port: number,
  host = "127.0.0.1",
): Promise<void> {
  portNumber(port);
  bindHost(host);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "EADDRINUSE"
          ? new Error(
              `Port ${port} is already in use; choose another --port. No process was stopped.`,
            )
          : error,
      );
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
}

export async function assertPortAvailable(
  port: number,
  host = "127.0.0.1",
): Promise<void> {
  const server = http.createServer();
  await listen(server, port, host);
  await closeServer(server);
}

export function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Own every request from entry, including artificial latency and shutdown. */
export function sessionServer(
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    signal: AbortSignal,
    trace?: RequestTrace,
  ) => Promise<void>,
  diagnostics?: SessionDiagnostics,
): { server: http.Server; close(): Promise<void>; cancelRun(runId: string): Promise<void>;cancelManual():Promise<void>;ownership():{activeRequests:number;pendingWork:number} } {
  const controllers = new Set<AbortController>();
  const records = new Map<AbortController, { res: http.ServerResponse; trace?: RequestTrace; work?: Promise<void> }>();
  const pending = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
  const server = http.createServer((req, res) => {
    const controller = new AbortController();
    controllers.add(controller);
    const trace = diagnostics?.request(req, res);
    const record = { res, trace, work: undefined as Promise<void> | undefined };
    records.set(controller, record);
    const abort = () =>
      trace?.cancel(
        controller.signal.reason === "session_shutdown"
          ? "session_shutdown"
          : controller.signal.reason === "scenario_reset" ? "scenario_reset" : controller.signal.reason === "control_reset" ? "control_reset" : "client_disconnect",
      );
    controller.signal.addEventListener("abort", abort, { once: true });
    const cleanup = () => {
      res.removeListener("finish", finish);
      res.removeListener("close", disconnect);
      controller.signal.removeEventListener("abort", abort);
      controllers.delete(controller);
      records.delete(controller);
    };
    const finish = () => {
      trace?.finish();
      cleanup();
    };
    const disconnect = () => {
      if (!res.writableFinished) controller.abort("client_disconnect");
      cleanup();
    };
    res.once("close", disconnect);
    res.once("finish", finish);
    if (closing) controller.abort("session_shutdown");
    const work = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return handler(req, res, controller.signal, trace);
      })
      .catch(() => {
        trace?.cancel("handler_error");
        if (!res.destroyed) res.destroy();
      })
      .finally(() => {
        pending.delete(work);
      });
    record.work = work;
    pending.add(work);
  });
  return {
    server,
    ownership:()=>({activeRequests:records.size,pendingWork:pending.size}),
    async cancelRun(runId) {
      const affected = [...records].filter(([, value]) => value.trace?.runId === runId && value.trace.affectedByRun());
      for (const [controller, value] of affected) { controller.abort("scenario_reset"); value.res.destroy(); }
      await Promise.allSettled(affected.map(([, value]) => value.work));
    },
    async cancelManual() {
      // This server owns one simulator session. Leave healthy requests and all
      // separately identified scenario work alone when clearing manual effects.
      const affected = [...records].filter(([, value]) => value.trace && !value.trace.runId && value.trace.hasFault());
      for (const [controller, value] of affected) { controller.abort("control_reset"); value.res.destroy(); }
      await Promise.allSettled(affected.map(([, value]) => value.work));
    },
    close() {
      if (!closing)
        closing = (async () => {
          for (const controller of controllers)
            controller.abort("session_shutdown");
          await closeServer(server);
          await Promise.allSettled([...pending]);
        })();
      return closing;
    },
  };
}

export function send(
  res: http.ServerResponse,
  status: number,
  body: Buffer | string,
  headers: Record<string, string> = {},
  method = "GET",
): void {
  if (res.destroyed) return;
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const headLength = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-length")?.[1];
  sendHeaders(res, status, method === "HEAD" && /^\d+$/.test(headLength ?? "") ? Number(headLength) : method === "HEAD" && !buffer.length ? undefined : buffer.length, headers);
  res.end(method === "HEAD" || [204, 304].includes(status) ? undefined : buffer);
}

export function sendHeaders(
  res: http.ServerResponse,
  status: number,
  length: number | undefined,
  headers: Record<string, string> = {},
): void {
  const bodyless = [204, 304].includes(status);
  if (bodyless) headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !/^content-length$/i.test(name)));
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": `Date, Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified, Retry-After, Age, Cache-Control, WWW-Authenticate, X-Sim-Manifest-Preview, ${TRACE_HEADERS}`,
    "Cache-Control": "no-store",
    ...headers,
    ...(bodyless || length === undefined ? {} : { "Content-Length": String(length) }),
  });
}

export function preflight(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  host = "127.0.0.1",
  scenarioControls = false,
): boolean {
  const localHosts = new Set([
    "localhost",
    "127.0.0.1",
    "::1",
  ]);
  let interfacesRead = false;
  const local = (name: string) => {
    if (localHosts.has(name)) return true;
    if (!interfacesRead) {
      interfacesRead = true;
      for (const entries of Object.values(os.networkInterfaces()))
        for (const entry of entries ?? []) localHosts.add(entry.address);
    }
    return localHosts.has(name);
  };
  const hostname = (url: URL) => url.hostname.replace(/^\[|\]$/g, "");
  try {
    const requested = hostname(new URL("http://" + req.headers.host));
    if (!local(requested)) throw new Error();
    if (
      req.headers.origin &&
      !local(hostname(new URL(req.headers.origin)))
    )
      throw new Error();
    if (loopback(host) && !loopback(requested.replace(/^\[|\]$/g, "")))
      throw new Error();
  } catch {
    send(res, 403, "Only local player origins may access this session");
    return true;
  }
  const controlPath = new URL(req.url ?? "/", "http://localhost").pathname;
  const controls = scenarioControls && (/^\/scenario\/(arm|start|reset|stop|access)$/.test(controlPath) || /^\/session-control\/(mode|apply|inject|clear|arm|start|stop)$/.test(controlPath));
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": controls ? "GET, HEAD, POST, OPTIONS" : "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Range, If-Match, If-Unmodified-Since, If-None-Match, If-Modified-Since, If-Range, Authorization, X-Sim-Manifest-Preview" + (controls ? ", Content-Type, X-Sim-Session-Id" : ""),
      "Access-Control-Expose-Headers": `Date, Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified, Retry-After, Age, Cache-Control, WWW-Authenticate, X-Sim-Manifest-Preview, ${TRACE_HEADERS}`,
    });
    res.end();
    return true;
  }
  if (!(controls ? ["GET", "HEAD", "POST"] : ["GET", "HEAD"]).includes(req.method ?? "")) {
    send(res, 405, "Method not allowed", { Allow: "GET, HEAD, OPTIONS" });
    return true;
  }
  return false;
}
