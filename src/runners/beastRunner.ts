import { ApiClient } from '../api';
import { BeastForwarder } from '../sources/beastForwarder';

export interface BeastRunnerOptions {
  api: ApiClient;
  feederId: string;
  uuid: string;
  source: { host: string; port: number };
  upstream: { host: string; port: number };
  heartbeatIntervalMs?: number;
}

export class BeastRunner {
  private readonly forwarder: BeastForwarder;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: BeastRunnerOptions) {
    this.forwarder = new BeastForwarder({
      source: opts.source,
      upstream: opts.upstream,
      uuid: opts.uuid,
      onStatus: (status, detail) => {
        if (status === 'connected') {
          console.log(`[beast] connected ${opts.source.host}:${opts.source.port} -> ${opts.upstream.host}:${opts.upstream.port}`);
        } else if (status === 'disconnected') {
          console.error(`[beast] disconnected${detail ? ` (${detail})` : ''}`);
        }
      },
    });
  }

  start(): void {
    this.forwarder.start();
    this.heartbeatTimer = setInterval(() => {
      // The BEAST upstream sees the bytes directly; we still ping /last-seen so
      // the row in `feeders` reflects "alive" for hosts where BEAST telemetry
      // hasn't propagated yet.
      this.opts.api.updateStats(this.opts.feederId, 0, 0).catch(() => {});
    }, this.opts.heartbeatIntervalMs ?? 60_000);
  }

  stop(): void {
    this.forwarder.stop();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  bytes(): number {
    return this.forwarder.bytes();
  }
}
