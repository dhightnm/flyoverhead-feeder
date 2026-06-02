import { hostname } from 'node:os';
import { ApiClient } from '../api';
import { saveConfig, type FeederConfig } from '../config';

export interface PairOptions {
  api: ApiClient;
  uuid: string;
  config: FeederConfig;
  pollIntervalMs?: number;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

export interface PairOutcome {
  feederId: string;
  apiKey: string;
  userId: number | null;
  name: string | null;
}

export async function runPair(opts: PairOptions): Promise<PairOutcome> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const start = await opts.api.startPairing(opts.uuid, hostname());

  log('');
  log('  To link this feeder to your Fly Overhead account:');
  log(`    1. Visit ${start.verificationUrl}`);
  log(`    2. Enter code: ${start.code}`);
  log('');
  log('  (Polling — this will exit automatically once you approve in the browser.)');
  log('');

  const pollMs = opts.pollIntervalMs ?? 3000;
  const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60_000);

  for (;;) {
    if (Date.now() > deadline) {
      throw new Error('pairing timed out — re-run to try again');
    }
    await new Promise((r) => setTimeout(r, pollMs));
    const status = await opts.api.checkPairing(opts.uuid);
    if (status.status === 'pending') continue;
    if (status.status === 'expired') throw new Error('pairing code expired — re-run to try again');
    saveConfig({
      ...opts.config,
      apiKey: status.apiKey,
      feederId: status.feederId,
      feederName: status.name ?? opts.config.feederName,
    });
    return {
      feederId: status.feederId,
      apiKey: status.apiKey,
      userId: status.userId,
      name: status.name,
    };
  }
}
