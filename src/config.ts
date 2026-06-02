import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';

export type WireMode = 'auto' | 'beast' | 'json';

export interface FeederConfig {
  apiUrl: string;
  apiKey: string | null;
  feederId: string | null;
  feederName: string | null;
  wireMode: WireMode;
  beastSource: { host: string; port: number };
  beastUpstream: { host: string; port: number };
  jsonSource: string;
  pollIntervalMs: number;
}

const DEFAULTS = {
  apiUrl: 'https://flyoverhead.com',
  beastSource: { host: '127.0.0.1', port: 30005 },
  // BEAST listener lives on a dedicated Fly app (flyoverhead-feeder-ingest)
  // reached via the feed.* subdomain so it can scale independently of the
  // API server. See fly.feeder-ingest.toml.
  beastUpstream: { host: 'feed.flyoverhead.com', port: 30004 },
  jsonSource: 'http://127.0.0.1:8080/data/aircraft.json',
  pollIntervalMs: 5000,
  wireMode: 'auto' as WireMode,
};

export function configPath(): string {
  return process.env.FLY_OVERHEAD_FEEDER_CONFIG
    || (process.getuid && process.getuid() === 0
      ? '/var/lib/fly-overhead-feeder/config.json'
      : `${homedir()}/.config/fly-overhead-feeder/config.json`);
}

export function loadConfig(): FeederConfig {
  const path = configPath();
  let file: Partial<FeederConfig> = {};
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      // Corrupt config — fall back to defaults + env. Don't crash on startup.
    }
  }

  return {
    apiUrl: process.env.FEEDER_API_URL || file.apiUrl || DEFAULTS.apiUrl,
    apiKey: process.env.FEEDER_API_KEY || file.apiKey || null,
    feederId: process.env.FEEDER_ID || file.feederId || null,
    feederName: process.env.FEEDER_NAME || file.feederName || null,
    wireMode: (process.env.FEEDER_WIRE_MODE as WireMode) || file.wireMode || DEFAULTS.wireMode,
    beastSource: file.beastSource || DEFAULTS.beastSource,
    beastUpstream: file.beastUpstream || DEFAULTS.beastUpstream,
    jsonSource: process.env.FEEDER_JSON_SOURCE || file.jsonSource || DEFAULTS.jsonSource,
    pollIntervalMs: Number(process.env.FEEDER_POLL_INTERVAL_MS) || file.pollIntervalMs || DEFAULTS.pollIntervalMs,
  };
}

export function saveConfig(config: Partial<FeederConfig>): void {
  const path = configPath();
  const current = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Partial<FeederConfig>)
    : {};
  const next = { ...current, ...config };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}
