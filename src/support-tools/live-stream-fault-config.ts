import fs from 'fs';
import path from 'path';

const LOG_PREFIX = '[fault-config]';
function logConfig(message: string, payload?: unknown): void {
  if (payload !== undefined) {
    console.info(`${LOG_PREFIX} ${message}`, payload);
  } else {
    console.info(`${LOG_PREFIX} ${message}`);
  }
}

export type FaultMode = 'off' | 'always' | 'random' | 'once';

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
  freeze?: FaultMode;
}

export interface FaultConfig {
  profile?: string;
  segment?: SegmentFaultConfig;
  drm?: DRMFaultConfig;
  manifest?: ManifestFaultConfig;
  logging?: {
    verbose?: boolean;
  };
}

const DEFAULT_CONFIG: FaultConfig = {
  profile: 'default',
  segment: {
    malformed: 'off',
    forbidden: 'off',
    missing: 'off',
    latencyMs: 0,
  },
  drm: {
    licenseFailure: 'off',
    keyRotationMismatch: 'off',
  },
  manifest: {
    freeze: 'off',
  },
  logging: {
    verbose: false,
  },
};

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), '.hls-dash-faults.json');

let activeConfig: FaultConfig = DEFAULT_CONFIG;
let activeConfigPath = DEFAULT_CONFIG_PATH;

const listeners = new Set<(config: FaultConfig) => void>();
let watcher: fs.FSWatcher | null = null;

function loadConfigFile(filePath: string): FaultConfig {
  try {
    const contents = fs.readFileSync(filePath, 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(contents) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function notifyListeners(): void {
  for (const listener of listeners) {
    listener(activeConfig);
  }
}

export function setFaultConfigPath(filePath: string): void {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, JSON.stringify(DEFAULT_CONFIG, null, 2));
  }
  activeConfigPath = resolved;
  activeConfig = loadConfigFile(resolved);
  logConfig('set path', { path: resolved, config: activeConfig });
  notifyListeners();
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  try {
    watcher = fs.watch(resolved, { persistent: false }, () => {
      activeConfig = loadConfigFile(resolved);
      logConfig('file changed', { path: resolved, config: activeConfig });
      notifyListeners();
    });
  } catch {
    watcher = null;
  }
}

export function getFaultConfig(): FaultConfig {
  return activeConfig;
}

export function getFaultConfigPath(): string {
  return activeConfigPath;
}

export function onFaultConfigChange(listener: (config: FaultConfig) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function applyConfigOverride(partial: Partial<FaultConfig>): void {
  activeConfig = {
    ...activeConfig,
    ...partial,
    segment: {
      ...activeConfig.segment,
      ...partial.segment,
    },
    drm: {
      ...activeConfig.drm,
      ...partial.drm,
    },
    manifest: {
      ...activeConfig.manifest,
      ...partial.manifest,
    },
    logging: {
      ...activeConfig.logging,
      ...partial.logging,
    },
  };
  logConfig('override applied', { partial, result: activeConfig });
  notifyListeners();
}

export function persistFaultConfig(partial: Partial<FaultConfig>): FaultConfig {
  applyConfigOverride(partial);
  try {
    fs.mkdirSync(path.dirname(activeConfigPath), { recursive: true });
    fs.writeFileSync(activeConfigPath, JSON.stringify(activeConfig, null, 2));
    logConfig('persisted config', { path: activeConfigPath });
  } catch (err) {
    console.error(`${LOG_PREFIX} failed to persist fault config`, err);
  }
  return activeConfig;
}

setFaultConfigPath(DEFAULT_CONFIG_PATH);
