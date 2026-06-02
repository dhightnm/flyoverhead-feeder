import { Socket, connect } from 'node:net';

export interface BeastForwarderOptions {
  source: { host: string; port: number };
  upstream: { host: string; port: number };
  uuid: string;
  onBytes?: (bytes: number) => void;
  onStatus?: (status: 'connecting' | 'connected' | 'disconnected', detail?: string) => void;
}

// readsb / ultrafeeder convention: announce the receiver UUID at the start of
// the BEAST stream as a frame of type 0xe4 carrying the 16 raw bytes. The
// server uses this to tie subsequent frames to a known feeder.
function uuidHandshake(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32) throw new Error(`invalid uuid: ${uuid}`);
  return Buffer.concat([Buffer.from([0x1a, 0xe4]), Buffer.from(hex, 'hex')]);
}

export class BeastForwarder {
  private source: Socket | null = null;
  private upstream: Socket | null = null;
  private stopped = false;
  // Single-flight reconnect guard. Without it, the four error/close listeners
  // (upstream + source × error + close) each call teardownAndRetry on a single
  // disconnect, and destroy() emits further close events — so one drop
  // scheduled several connect() calls. Each connect() overwrote
  // this.source/this.upstream, orphaning the prior sockets: a connection leak
  // that piled up half-open on the ingest server until it hit its connection
  // cap and stopped accepting feeders.
  private reconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = 1000;
  private readonly maxBackoffMs = 30_000;
  private bytesForwarded = 0;

  constructor(private readonly opts: BeastForwarderOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cleanupSockets();
  }

  bytes(): number {
    return this.bytesForwarded;
  }

  // Drop our listeners BEFORE destroy so the close events destroy() emits
  // don't re-enter teardownAndRetry, then tear the pair down.
  private cleanupSockets(): void {
    this.source?.removeAllListeners();
    this.upstream?.removeAllListeners();
    this.source?.destroy();
    this.upstream?.destroy();
    this.source = null;
    this.upstream = null;
  }

  private connect(): void {
    if (this.stopped) return;
    this.reconnecting = false;
    this.opts.onStatus?.('connecting');

    const upstream = connect(this.opts.upstream.port, this.opts.upstream.host);
    const source = connect(this.opts.source.port, this.opts.source.host);
    this.upstream = upstream;
    this.source = source;

    let upstreamReady = false;
    let sourceReady = false;
    const tryStart = () => {
      if (!upstreamReady || !sourceReady) return;
      try {
        upstream.write(uuidHandshake(this.opts.uuid));
      } catch (err) {
        this.opts.onStatus?.('disconnected', (err as Error).message);
        this.teardownAndRetry();
        return;
      }
      this.opts.onStatus?.('connected');
      this.reconnectDelayMs = 1000;
      source.on('data', (chunk: Buffer) => {
        if (!upstream.writable) return;
        this.bytesForwarded += chunk.length;
        this.opts.onBytes?.(chunk.length);
        upstream.write(chunk);
      });
    };

    upstream.once('connect', () => {
      upstreamReady = true;
      tryStart();
    });
    source.once('connect', () => {
      sourceReady = true;
      tryStart();
    });

    const onEnd = (who: 'source' | 'upstream') => (err?: Error) => {
      this.opts.onStatus?.('disconnected', err ? `${who}: ${err.message}` : who);
      this.teardownAndRetry();
    };
    upstream.on('error', onEnd('upstream'));
    upstream.on('close', onEnd('upstream'));
    source.on('error', onEnd('source'));
    source.on('close', onEnd('source'));
  }

  private teardownAndRetry(): void {
    // Single-flight: the first close/error event of a disconnect wins; the
    // rest (including the close events our own destroy() triggers) are no-ops
    // until the next connect() clears the flag. One disconnect → one reconnect.
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.cleanupSockets();
    if (this.stopped) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.maxBackoffMs, this.reconnectDelayMs * 2);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

export async function detectBeastSource(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, host);
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      done(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      done(false);
    });
  });
}
