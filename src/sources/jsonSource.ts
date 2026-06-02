import { request } from 'undici';
import { dump1090ToStateArray, type Dump1090Aircraft, type StateArray } from '../state';

const CANDIDATE_URLS = [
  'http://127.0.0.1:8080/data/aircraft.json',
  'http://127.0.0.1:8080/tar1090/data/aircraft.json',
  'http://127.0.0.1:8080/skyaware/data/aircraft.json',
  'http://127.0.0.1/tar1090/data/aircraft.json',
];

export async function detectJsonSource(timeoutMs = 1500): Promise<string | null> {
  for (const url of CANDIDATE_URLS) {
    try {
      const { statusCode, body } = await request(url, {
        method: 'GET',
        bodyTimeout: timeoutMs,
        headersTimeout: timeoutMs,
      });
      if (statusCode !== 200) {
        await body.dump();
        continue;
      }
      const data = (await body.json()) as { aircraft?: unknown };
      if (data && Array.isArray(data.aircraft)) return url;
    } catch {
      // try next
    }
  }
  return null;
}

export async function fetchAircraftJson(url: string, timeoutMs = 5000): Promise<Dump1090Aircraft[]> {
  const { statusCode, body } = await request(url, {
    method: 'GET',
    bodyTimeout: timeoutMs,
    headersTimeout: timeoutMs,
  });
  if (statusCode !== 200) {
    await body.dump();
    throw new Error(`aircraft.json returned ${statusCode}`);
  }
  const data = (await body.json()) as { aircraft?: Dump1090Aircraft[] };
  return Array.isArray(data.aircraft) ? data.aircraft : [];
}

export function aircraftToStates(aircraft: Dump1090Aircraft[]): StateArray[] {
  const out: StateArray[] = [];
  for (const ac of aircraft) {
    const state = dump1090ToStateArray(ac);
    if (state) out.push(state);
  }
  return out;
}
