import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type FaultMode = 'off' | 'always' | 'random' | 'once';
export interface SegmentFaultConfig { malformed?: FaultMode; forbidden?: FaultMode; missing?: FaultMode; latencyMs?: number; }
export interface DRMFaultConfig { licenseFailure?: FaultMode; keyRotationMismatch?: FaultMode; }
export interface ManifestFaultConfig { freeze?: FaultMode; }
export interface FaultConfig {
  profile?: string; segment?: SegmentFaultConfig; drm?: DRMFaultConfig;
  manifest?: ManifestFaultConfig; logging?: { verbose?: boolean };
}
export class ConfigValidationError extends Error {}
const DEFAULT_CONFIG: FaultConfig = {
  profile: 'default', segment: { malformed: 'off', forbidden: 'off', missing: 'off', latencyMs: 0 },
  drm: { licenseFailure: 'off', keyRotationMismatch: 'off' }, manifest: { freeze: 'off' }, logging: { verbose: false }
};
const schema = { profile: 'string', segment: { malformed: 'mode', forbidden: 'mode', missing: 'mode', latencyMs: 'delay' }, drm: { licenseFailure: 'mode', keyRotationMismatch: 'mode' }, manifest: { freeze: 'mode' }, logging: { verbose: 'boolean' } };
export function validateFaultConfig(input: unknown): asserts input is FaultConfig {
  const check = (value: unknown, rules: unknown, prefix: string) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigValidationError(`${prefix || 'config'} must be an object`);
    for (const [key, entry] of Object.entries(value)) {
      if (!Object.hasOwn(rules as object, key)) throw new ConfigValidationError(`Unknown configuration field: ${prefix}${key}`);
      const rule = rules[key]; const label = `${prefix}${key}`;
      if (typeof rule === 'object') check(entry, rule, label + '.');
      else if (rule === 'mode' && !['off', 'always', 'random', 'once'].includes(entry as string)) throw new ConfigValidationError(`${label} must be off, always, random or once`);
      else if (rule === 'delay' && (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0 || entry > 60000)) throw new ConfigValidationError(`${label} must be between 0 and 60000 ms`);
      else if (rule === 'string' && (typeof entry !== 'string' || entry.length > 128)) throw new ConfigValidationError(`${label} must be a string up to 128 characters`);
      else if (rule === 'boolean' && typeof entry !== 'boolean') throw new ConfigValidationError(`${label} must be boolean`);
    }
  };
  check(input, schema, '');
}
function merge(base: FaultConfig, patch: FaultConfig): FaultConfig {
  return { ...base, ...patch, segment: { ...base.segment, ...patch.segment }, drm: { ...base.drm, ...patch.drm }, manifest: { ...base.manifest, ...patch.manifest }, logging: { ...base.logging, ...patch.logging } };
}
let activeConfig = merge(DEFAULT_CONFIG, {});
let activePath = path.resolve(process.cwd(), '.hls-dash-faults.json');
let watcher: fs.FSWatcher | undefined;
let debounce: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<(config: FaultConfig) => void>();
function update(config: FaultConfig) {
  if (JSON.stringify(config) === JSON.stringify(activeConfig)) return;
  activeConfig = config;
  for (const listener of listeners) listener(getFaultConfig());
}
function read(file: string): FaultConfig {
  const input = JSON.parse(fs.readFileSync(file, 'utf8')); validateFaultConfig(input);
  return merge(DEFAULT_CONFIG, input);
}
function atomicWrite(file: string, config: FaultConfig) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}
export function setFaultConfigPath(file: string): void {
  const resolved = path.resolve(file); fs.mkdirSync(path.dirname(resolved), { recursive: true });
  if (!fs.existsSync(resolved)) atomicWrite(resolved, DEFAULT_CONFIG);
  const next = read(resolved); // Fail startup instead of replacing an invalid file.
  watcher?.close(); clearTimeout(debounce); activePath = resolved; update(next);
  watcher = fs.watch(path.dirname(resolved), { persistent: false }, (_event, filename) => {
    if (filename && filename.toString() !== path.basename(resolved)) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      try { update(read(resolved)); }
      catch (error) { console.error('[fault-config] Keeping last valid configuration:', error instanceof Error ? error.message : String(error)); }
    }, 25);
    debounce.unref();
  });
}
export function getFaultConfig(): FaultConfig { return structuredClone(activeConfig); }
export function getFaultConfigPath(): string { return activePath; }
export function onFaultConfigChange(listener: (config: FaultConfig) => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }
export function applyConfigOverride(patch: Partial<FaultConfig>): void { validateFaultConfig(patch); update(merge(activeConfig, patch)); }
export function persistFaultConfig(patch: Partial<FaultConfig>): FaultConfig {
  validateFaultConfig(patch); const next = merge(activeConfig, patch);
  fs.mkdirSync(path.dirname(activePath), { recursive: true }); atomicWrite(activePath, next); update(next); return getFaultConfig();
}
