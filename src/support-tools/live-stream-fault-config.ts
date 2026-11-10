import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";

export type FaultMode = "off" | "always" | "random" | "once";
export interface SegmentFaultConfig {
  malformed?: FaultMode;
  forbidden?: FaultMode;
  missing?: FaultMode;
  latencyMs?: number;
}
export interface DRMFaultConfig {
  licenseFailure?: FaultMode;
  keyRotationMismatch?: FaultMode;
}
export interface ManifestFaultConfig {
  freeze?: "off" | "always";
}
export type FaultCategory =
  "missing" | "forbidden" | "malformed" | "key-failure" | "key-mismatch";
/** Correlate generated one-shot arms across the control and simulator processes. */
export function oneShotFaultId(
  category: FaultCategory,
  arm?: string,
): string | undefined {
  if (
    !arm ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(arm)
  )
    return undefined;
  return (
    "fault_" +
    createHash("sha256")
      .update(`one-shot:${category}:${arm}`)
      .digest("hex")
      .slice(0, 32)
  );
}
export interface FaultConfig {
  profile?: string;
  segment?: SegmentFaultConfig;
  network?: { bandwidthKbps?: number; jitterMs?: number };
  drm?: DRMFaultConfig;
  manifest?: ManifestFaultConfig;
  logging?: { verbose?: boolean };
  /** Durable arm identifiers; preserve these when editing a configuration file. */
  _oneShot?: Partial<Record<FaultCategory, string>>;
}
export class ConfigValidationError extends Error {}
export class ConfigConflictError extends Error {}
const DEFAULT_CONFIG: FaultConfig = {
  profile: "default",
  segment: { malformed: "off", forbidden: "off", missing: "off", latencyMs: 0 },
  network: { bandwidthKbps: 0, jitterMs: 0 },
  drm: { licenseFailure: "off", keyRotationMismatch: "off" },
  manifest: { freeze: "off" },
  logging: { verbose: false },
};
const schema = {
  profile: "string",
  segment: {
    malformed: "mode",
    forbidden: "mode",
    missing: "mode",
    latencyMs: "delay",
  },
  network: { bandwidthKbps: "bandwidth", jitterMs: "jitter" },
  drm: { licenseFailure: "mode", keyRotationMismatch: "mode" },
  manifest: { freeze: "freeze" },
  logging: { verbose: "boolean" },
  _oneShot: {
    missing: "string",
    forbidden: "string",
    malformed: "string",
    "key-failure": "string",
    "key-mismatch": "string",
  },
};
export function validateFaultConfig(
  input: unknown,
): asserts input is FaultConfig {
  const check = (value: unknown, rules: unknown, prefix: string) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ConfigValidationError(
        `${prefix || "config"} must be an object`,
      );
    for (const [key, entry] of Object.entries(value)) {
      if (!Object.hasOwn(rules as object, key))
        throw new ConfigValidationError(
          `Unknown configuration field: ${prefix}${key}`,
        );
      const rule = rules[key];
      const label = `${prefix}${key}`;
      if (typeof rule === "object") check(entry, rule, label + ".");
      else if (
        rule === "freeze" &&
        !["off", "always"].includes(entry as string)
      )
        throw new ConfigValidationError(`${label} supports only off or always`);
      else if (
        rule === "mode" &&
        !["off", "always", "random", "once"].includes(entry as string)
      )
        throw new ConfigValidationError(
          `${label} must be off, always, random or once`,
        );
      else if (
        rule === "delay" &&
        (typeof entry !== "number" ||
          !Number.isFinite(entry) ||
          entry < 0 ||
          entry > 60000)
      )
        throw new ConfigValidationError(
          `${label} must be between 0 and 60000 ms`,
        );
      else if (
        (rule === "bandwidth" || rule === "jitter") &&
        (!Number.isInteger(entry) || Number(entry) < 0 ||
          Number(entry) > (rule === "bandwidth" ? 1000000 : 60000))
      )
        throw new ConfigValidationError(
          `${label} must be an integer between 0 and ${rule === "bandwidth" ? 1000000 : 60000}`,
        );
      else if (
        rule === "string" &&
        (typeof entry !== "string" || entry.length > 128)
      )
        throw new ConfigValidationError(
          `${label} must be a string up to 128 characters`,
        );
      else if (rule === "boolean" && typeof entry !== "boolean")
        throw new ConfigValidationError(`${label} must be boolean`);
    }
  };
  check(input, schema, "");
}
function merge(base: FaultConfig, patch: FaultConfig): FaultConfig {
  return {
    ...base,
    ...patch,
    segment: { ...base.segment, ...patch.segment },
    network: { ...base.network, ...patch.network },
    drm: { ...base.drm, ...patch.drm },
    manifest: { ...base.manifest, ...patch.manifest },
    logging: { ...base.logging, ...patch.logging },
    _oneShot: { ...base._oneShot, ...patch._oneShot },
  };
}
/** Fresh normalized defaults; callers never receive the shared template. */
export function createDefaultFaultConfig(): FaultConfig {
  return merge(DEFAULT_CONFIG, {});
}
export function faultModes(config: FaultConfig) {
  return {
    missing: config.segment?.missing,
    forbidden: config.segment?.forbidden,
    malformed: config.segment?.malformed,
    "key-failure": config.drm?.licenseFailure,
    "key-mismatch": config.drm?.keyRotationMismatch,
  };
}
function arm(
  base: FaultConfig,
  patch: FaultConfig,
  rearmOnce = false,
): FaultConfig {
  const next = merge(base, patch);
  const previous = faultModes(base);
  const requested = faultModes(patch);
  for (const [category, mode] of Object.entries(faultModes(next))) {
    if (
      mode === "once" &&
      (previous[category] !== "once" ||
        (rearmOnce && requested[category] === "once"))
    )
      next._oneShot[category] = randomUUID();
  }
  return next;
}
let activeConfig = merge(DEFAULT_CONFIG, {});
export function faultConfigHasManualConflict(config: FaultConfig): boolean {
  return Object.entries(config.segment ?? {}).some(([key, value]) => key === "latencyMs" ? Number(value) > 0 : value !== "off") || Object.values(config.drm ?? {}).some(value => value !== "off") || config.manifest?.freeze === "always" || Object.values(config.network ?? {}).some(value => Number(value) > 0);
}
let activeManualConflict = faultConfigHasManualConflict(activeConfig);
let activePath = path.resolve(process.cwd(), ".hls-dash-faults.json");
let watcher: fs.FSWatcher | undefined;
let debounce: ReturnType<typeof setTimeout> | undefined;
let poller: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<(config: FaultConfig) => void>();
function update(config: FaultConfig) {
  if (JSON.stringify(config) === JSON.stringify(activeConfig)) return;
  activeConfig = config;
  activeManualConflict = faultConfigHasManualConflict(config);
  for (const listener of listeners) listener(getFaultConfig());
}
let lastDiskText = "";
function read(file: string, text = fs.readFileSync(file, "utf8")): FaultConfig {
  const input = JSON.parse(text);
  validateFaultConfig(input);
  return merge(DEFAULT_CONFIG, input);
}
function atomicWrite(file: string, config: FaultConfig) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
export function setFaultConfigPath(file: string): void {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  if (!fs.existsSync(resolved)) atomicWrite(resolved, DEFAULT_CONFIG);
  const text = fs.readFileSync(resolved, "utf8");
  const next = read(resolved, text); // Fail startup instead of replacing an invalid file.
  watcher?.close();
  clearTimeout(debounce);
  clearInterval(poller);
  activePath = resolved;
  lastDiskText = text;
  update(next);
  let rejectedText: string | undefined;
  let readError = "";
  const refresh = () => {
    let text: string | undefined;
    try {
      text = fs.readFileSync(resolved, "utf8");
      readError = "";
      if (text === lastDiskText) {
        rejectedText = undefined;
        return;
      }
      if (text === rejectedText) return;
      const next = read(resolved, text);
      lastDiskText = text;
      rejectedText = undefined;
      update(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (text !== undefined) rejectedText = text;
      else {
        if (message === readError) return;
        readError = message;
      }
      console.error(
        "[fault-config] Keeping last valid configuration:",
        message,
      );
    }
  };
  watcher = fs.watch(
    path.dirname(resolved),
    { persistent: false },
    (_event, filename) => {
      if (filename && filename.toString() !== path.basename(resolved)) return;
      clearTimeout(debounce);
      debounce = setTimeout(refresh, 25);
      debounce.unref();
    },
  );
  // Native directory watches can coalesce or miss atomic rename events.
  poller = setInterval(refresh, 250);
  poller.unref();
}
export function getFaultConfig(): FaultConfig {
  return structuredClone(activeConfig);
}
/** Scalar read for per-event logging; never expose the mutable configuration. */
export function isFaultLoggingVerbose(): boolean {
  return activeConfig.logging?.verbose === true;
}
/** Allocation-free observation, refreshed before config change subscribers run. */
export function hasManualFaultConflict(): boolean { return activeManualConflict; }
/** Startup notice: a reused shared file can carry faults from an earlier session. */
export function activeManualFaultNotice(): string | undefined {
  if (!activeManualConflict) return undefined;
  const active = [
    ...Object.entries(faultModes(activeConfig)).filter(([, mode]) => mode && mode !== "off").map(([name, mode]) => `${name}=${mode}`),
    ...(activeConfig.segment?.latencyMs ? [`latencyMs=${activeConfig.segment.latencyMs}`] : []),
    ...(activeConfig.network?.bandwidthKbps ? [`bandwidthKbps=${activeConfig.network.bandwidthKbps}`] : []),
    ...(activeConfig.network?.jitterMs ? [`jitterMs=${activeConfig.network.jitterMs}`] : []),
    ...(activeConfig.manifest?.freeze === "always" ? ["manifestFreeze"] : []),
  ];
  return `Manual faults are active from ${activePath}: ${active.join(", ")}. Reset that file or pass a new --fault-config for a healthy stream.`;
}
export function getFaultConfigPath(): string {
  return activePath;
}
export function onFaultConfigChange(
  listener: (config: FaultConfig) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function applyConfigOverride(patch: Partial<FaultConfig>): void {
  validateFaultConfig(patch);
  update(arm(activeConfig, patch));
}
export function persistFaultConfig(
  patch: Partial<FaultConfig>,
  rearmOnce = false,
): FaultConfig {
  validateFaultConfig(patch);
  fs.mkdirSync(path.dirname(activePath), { recursive: true });
  const lock = `${activePath}.lock`;
  let fd: number;
  try {
    fd = fs.openSync(lock, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new ConfigConflictError(
        "Configuration is being saved by another writer; retry. If a writer crashed, remove the stale .lock file first.",
      );
    throw error;
  }
  try {
    fs.writeFileSync(fd, String(process.pid));
    // A directory watcher may still be waiting to observe the latest edit.
    const next = arm(read(activePath), patch, rearmOnce);
    atomicWrite(activePath, next);
    lastDiskText = JSON.stringify(next, null, 2) + "\n";
    update(next);
    return getFaultConfig();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
}

/** A session consumer reads settings without knowing whether they come from a file. */
export interface FaultConfigSource {
  get(): FaultConfig;
  subscribe(listener: (config: FaultConfig) => void): () => void;
  isVerbose(): boolean;
  hasManualConflict(): boolean;
}

/** Existing callers retain watched-file behavior unless they inject a source. */
export const legacyFaultConfigSource: FaultConfigSource = Object.freeze({
  get: getFaultConfig,
  subscribe: onFaultConfigChange,
  isVerbose: isFaultLoggingVerbose,
  hasManualConflict: hasManualFaultConflict,
});

/**
 * Follows legacy settings until an authorized control action explicitly isolates
 * this session. Reads, subscriptions and rejected patches never take control.
 * Once isolated, no update reads or writes the shared file or notifies its peers.
 */
export class SessionFaultConfigSource implements FaultConfigSource {
  private config: FaultConfig;
  private conflict: boolean;
  private privateSettings: boolean;
  private closed = false;
  private readonly listeners = new Set<(config: FaultConfig) => void>();
  private unsubscribeParent?: () => void;

  constructor(
    initial?: FaultConfig,
    private readonly parent: FaultConfigSource = legacyFaultConfigSource,
  ) {
    const first = initial === undefined ? parent.get() : initial;
    validateFaultConfig(first);
    this.config = merge(DEFAULT_CONFIG, structuredClone(first));
    this.conflict = faultConfigHasManualConflict(this.config);
    this.privateSettings = initial !== undefined;
    if (!this.privateSettings)
      this.unsubscribeParent = parent.subscribe(next => this.set(next));
  }

  get isolated(): boolean { return this.privateSettings; }
  get(): FaultConfig { return structuredClone(this.config); }
  isVerbose(): boolean { return this.config.logging?.verbose === true; }
  hasManualConflict(): boolean { return this.conflict; }

  subscribe(listener: (config: FaultConfig) => void): () => void {
    this.assertOpen();
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Pin the most recent settings without rearming or otherwise changing them. */
  isolate(): void {
    this.assertOpen();
    if (this.privateSettings) return;
    const current = this.parent.get();
    this.unsubscribeParent?.();
    this.unsubscribeParent = undefined;
    this.privateSettings = true;
    this.set(current);
  }

  update(
    patch: Partial<FaultConfig>,
    { rearmOnce = false }: { rearmOnce?: boolean } = {},
  ): FaultConfig {
    this.assertOpen();
    // Validate before isolating: a rejected write must preserve legacy following.
    validateFaultConfig(patch);
    const copy = structuredClone(patch);
    this.isolate();
    this.set(arm(this.config, copy, rearmOnce));
    return this.get();
  }

  reset(): FaultConfig {
    this.isolate();
    this.set(createDefaultFaultConfig());
    return this.get();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeParent?.();
    this.unsubscribeParent = undefined;
    this.listeners.clear();
  }

  private assertOpen(): void {
    if (this.closed) throw new ConfigConflictError("Session configuration is closed");
  }

  private set(next: FaultConfig): void {
    if (this.closed || JSON.stringify(next) === JSON.stringify(this.config)) return;
    this.config = structuredClone(next);
    this.conflict = faultConfigHasManualConflict(this.config);
    for (const listener of this.listeners) listener(this.get());
  }
}
