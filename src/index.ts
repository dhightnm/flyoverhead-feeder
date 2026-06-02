#!/usr/bin/env node
import { hostname } from 'node:os';
import { ApiClient } from './api';
import { loadConfig, saveConfig } from './config';
import { loadOrCreateUuid } from './identity';
import { BeastRunner } from './runners/beastRunner';
import { JsonRunner } from './runners/jsonRunner';
import { runPair } from './runners/pair';
import { detectBeastSource } from './sources/beastForwarder';
import { detectJsonSource } from './sources/jsonSource';

// Keep in sync with feeder/package.json "version" (printed at startup and by
// `--version`; used to spot daemon versions across the fleet per RELEASING.md).
const VERSION = '0.1.1';

function usage() {
  console.log(`fly-overhead-feeder ${VERSION}

Usage:
  fly-overhead-feeder pair       Link this device to a Fly Overhead account
  fly-overhead-feeder register   Register anonymously (no account link)
  fly-overhead-feeder run        Stream data to Fly Overhead (default if configured)
  fly-overhead-feeder doctor     Diagnose local feeder sources
  fly-overhead-feeder --version
`);
}

async function commandDoctor(): Promise<number> {
  const config = loadConfig();
  const { uuid, source, writtenTo } = loadOrCreateUuid();
  console.log(`uuid:           ${uuid}  (source=${source}, written=[${writtenTo.join(', ')}])`);
  console.log(`api url:        ${config.apiUrl}`);
  console.log(`feeder id:      ${config.feederId ?? '(unset — run pair or register)'}`);
  console.log(`feeder name:    ${config.feederName ?? '(unset)'}`);
  console.log(`api key:        ${config.apiKey ? `${config.apiKey.slice(0, 8)}…` : '(unset)'}`);
  console.log(`wire mode:      ${config.wireMode}`);
  const beastOk = await detectBeastSource(config.beastSource.host, config.beastSource.port);
  console.log(`beast source:   ${config.beastSource.host}:${config.beastSource.port} → ${beastOk ? 'reachable' : 'NOT reachable'}`);
  const jsonUrl = await detectJsonSource();
  console.log(`json source:    ${jsonUrl ?? '(none detected on common paths)'}`);
  return 0;
}

async function commandPair(): Promise<number> {
  const config = loadConfig();
  const { uuid } = loadOrCreateUuid();
  const api = new ApiClient({ baseUrl: config.apiUrl });
  console.log(`fly-overhead-feeder pairing  (uuid=${uuid})`);
  const outcome = await runPair({ api, uuid, config });
  console.log(`paired: feeder_id=${outcome.feederId}${outcome.userId ? ` user=${outcome.userId}` : ' (anonymous)'}`);
  return 0;
}

async function commandRegister(): Promise<number> {
  const config = loadConfig();
  const { uuid } = loadOrCreateUuid();
  const api = new ApiClient({ baseUrl: config.apiUrl });
  const result = await api.register({
    feederId: uuid,
    name: config.feederName ?? `feeder-${hostname()}`,
  });
  saveConfig({ ...config, apiKey: result.apiKey, feederId: result.feederId });
  console.log(`registered anonymously: feeder_id=${result.feederId}`);
  return 0;
}

async function pickWireMode(config: ReturnType<typeof loadConfig>): Promise<'beast' | 'json'> {
  if (config.wireMode === 'beast') return 'beast';
  if (config.wireMode === 'json') return 'json';
  const beastOk = await detectBeastSource(config.beastSource.host, config.beastSource.port);
  if (beastOk) return 'beast';
  return 'json';
}

async function commandRun(): Promise<number> {
  const config = loadConfig();
  const { uuid } = loadOrCreateUuid();
  if (!config.feederId || !config.apiKey) {
    console.error('not configured — run `fly-overhead-feeder pair` first');
    return 2;
  }
  const api = new ApiClient({ baseUrl: config.apiUrl, apiKey: config.apiKey });
  const mode = await pickWireMode(config);
  console.log(`fly-overhead-feeder ${VERSION}  mode=${mode}  feeder=${config.feederId}`);

  let runner: BeastRunner | JsonRunner;
  if (mode === 'beast') {
    runner = new BeastRunner({
      api,
      feederId: config.feederId,
      uuid,
      source: config.beastSource,
      upstream: config.beastUpstream,
    });
  } else {
    const jsonUrl = (await detectJsonSource()) ?? config.jsonSource;
    runner = new JsonRunner({
      api,
      feederId: config.feederId,
      jsonSource: jsonUrl,
      pollIntervalMs: config.pollIntervalMs,
    });
  }
  runner.start();

  const shutdown = (sig: string) => {
    console.log(`\n${sig} — shutting down`);
    runner.stop();
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    console.error('uncaughtException — exiting for restart:', err);
    process.exit(1);
  });
  return await new Promise(() => 0);
}

async function main(): Promise<number> {
  const cmd = process.argv[2];
  if (cmd === '--version' || cmd === '-v') {
    console.log(VERSION);
    return 0;
  }
  if (cmd === 'pair') return commandPair();
  if (cmd === 'register') return commandRegister();
  if (cmd === 'doctor') return commandDoctor();
  if (cmd === 'run' || cmd === undefined) return commandRun();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return 0;
  }
  usage();
  return 2;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
