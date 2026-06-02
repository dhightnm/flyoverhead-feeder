import { ApiClient } from '../api';
import { aircraftToStates, fetchAircraftJson } from '../sources/jsonSource';

export interface JsonRunnerOptions {
  api: ApiClient;
  feederId: string;
  jsonSource: string;
  pollIntervalMs: number;
  statsIntervalMs?: number;
}

export class JsonRunner {
  private timer: NodeJS.Timeout | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private polls = 0;
  private submissions = 0;
  private aircraft = 0;
  private errors = 0;
  private consecutiveErrors = 0;
  private uniqueIcaosThisWindow = new Set<string>();
  private messagesThisWindow = 0;

  constructor(private readonly opts: JsonRunnerOptions) {}

  start(): void {
    this.tick().catch(() => {});
    this.timer = setInterval(() => {
      if (!this.inFlight) this.tick().catch(() => {});
    }, this.opts.pollIntervalMs);
    this.statsTimer = setInterval(() => this.flushStats().catch(() => {}), this.opts.statsIntervalMs ?? 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.timer = null;
    this.statsTimer = null;
  }

  snapshot() {
    return {
      polls: this.polls,
      submissions: this.submissions,
      aircraft: this.aircraft,
      errors: this.errors,
      consecutiveErrors: this.consecutiveErrors,
    };
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    this.polls++;
    try {
      const aircraft = await fetchAircraftJson(this.opts.jsonSource);
      const states = aircraftToStates(aircraft);
      if (states.length === 0) {
        this.consecutiveErrors = 0;
        return;
      }
      const result = await this.opts.api.submitStates(this.opts.feederId, states);
      this.submissions++;
      this.aircraft += result.processed;
      this.consecutiveErrors = 0;
      this.messagesThisWindow += result.processed;
      for (const s of states) {
        const icao = s[0];
        if (typeof icao === 'string') this.uniqueIcaosThisWindow.add(icao);
      }
    } catch (err) {
      this.errors++;
      this.consecutiveErrors++;
      const msg = (err as Error).message;
      // Spammy at high cadence — log every 10th failure after first.
      if (this.consecutiveErrors === 1 || this.consecutiveErrors % 10 === 0) {
        console.error(`[json] poll error #${this.consecutiveErrors}: ${msg}`);
      }
    } finally {
      this.inFlight = false;
    }
  }

  private async flushStats(): Promise<void> {
    if (this.messagesThisWindow === 0) return;
    const messages = this.messagesThisWindow;
    const unique = this.uniqueIcaosThisWindow.size;
    this.messagesThisWindow = 0;
    this.uniqueIcaosThisWindow = new Set();
    try {
      await this.opts.api.updateStats(this.opts.feederId, messages, unique);
    } catch {
      // Best-effort; restore the buffer is overkill — counters resume next window.
    }
  }
}
