import { request } from 'undici';
import type { StateArray } from './state';

export interface ApiClientOptions {
  baseUrl: string;
  apiKey?: string | null;
  timeoutMs?: number;
}

export interface PairStartResult {
  code: string;
  expiresAt: number;
  verificationUrl: string;
}

export interface PairCheckPending { status: 'pending' }
export interface PairCheckExpired { status: 'expired' }
export interface PairCheckApproved {
  status: 'approved';
  apiKey: string;
  feederId: string;
  userId: number | null;
  name: string | null;
}
export type PairCheckResult = PairCheckPending | PairCheckExpired | PairCheckApproved;

export interface RegisterParams {
  feederId: string;
  name: string;
  latitude?: number | null;
  longitude?: number | null;
  jwt?: string | null;
}

export class ApiClient {
  private readonly base: string;
  private readonly timeoutMs: number;
  private apiKey: string | null;

  constructor(opts: ApiClientOptions) {
    this.base = opts.baseUrl.replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 10000;
    this.apiKey = opts.apiKey ?? null;
  }

  setApiKey(key: string | null) {
    this.apiKey = key;
  }

  private async json<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'fly-overhead-feeder/0.1.0',
      ...(extraHeaders || {}),
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const res = await request(`${this.base}${path}`, {
      method: method as any,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      bodyTimeout: this.timeoutMs,
      headersTimeout: this.timeoutMs,
    });
    const text = await res.body.text();
    if (res.statusCode >= 400) {
      throw new Error(`${method} ${path} → ${res.statusCode}: ${text.slice(0, 200)}`);
    }
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  async startPairing(uuid: string, hostname?: string): Promise<PairStartResult> {
    const r = await this.json<{ code: string; expires_at: number; verification_url: string }>(
      'POST',
      '/api/feeder/pair/start',
      { uuid, hostname },
    );
    return { code: r.code, expiresAt: r.expires_at, verificationUrl: r.verification_url };
  }

  async checkPairing(uuid: string): Promise<PairCheckResult> {
    const r = await this.json<{
      status: 'pending' | 'expired' | 'approved';
      api_key?: string;
      feeder_id?: string;
      user_id?: number | null;
      name?: string | null;
    }>('GET', `/api/feeder/pair/check?uuid=${encodeURIComponent(uuid)}`);
    if (r.status === 'approved') {
      return {
        status: 'approved',
        apiKey: r.api_key!,
        feederId: r.feeder_id!,
        userId: r.user_id ?? null,
        name: r.name ?? null,
      };
    }
    return { status: r.status };
  }

  async register(
    params: RegisterParams,
  ): Promise<{ feederId: string; apiKey: string; apiKeyId: string; userId: number | null }> {
    const headers: Record<string, string> = {};
    if (params.jwt) headers.authorization = `Bearer ${params.jwt}`;
    // The server mints the key and returns the plaintext exactly once.
    const r = await this.json<{
      feeder_id: string; api_key: string; api_key_id: string; user_id: number | null;
    }>(
      'POST',
      '/api/feeder/register',
      {
        feeder_id: params.feederId,
        name: params.name,
        latitude: params.latitude ?? null,
        longitude: params.longitude ?? null,
      },
      headers,
    );
    return {
      feederId: r.feeder_id, apiKey: r.api_key, apiKeyId: r.api_key_id, userId: r.user_id,
    };
  }

  async submitStates(feederId: string, states: StateArray[]): Promise<{ processed: number; errors?: unknown[] }> {
    return this.json('POST', '/api/feeder/aircraft', {
      feeder_id: feederId,
      states: states.map((state) => ({ state })),
    });
  }

  async updateStats(feederId: string, messagesReceived: number, uniqueAircraft: number): Promise<void> {
    await this.json('POST', '/api/feeder/stats', {
      feeder_id: feederId,
      messages_received: messagesReceived,
      unique_aircraft: uniqueAircraft,
    });
  }
}
