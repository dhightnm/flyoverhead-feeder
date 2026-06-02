// Mirrors server/src/utils/aircraftState.ts STATE_INDEX. The server validates
// states as 18+ element arrays in OpenSky extended order; the client is
// responsible for converting dump1090's JSON shape into this layout.
export const STATE_INDEX = {
  ICAO24: 0,
  CALLSIGN: 1,
  ORIGIN_COUNTRY: 2,
  TIME_POSITION: 3,
  LAST_CONTACT: 4,
  LONGITUDE: 5,
  LATITUDE: 6,
  BARO_ALTITUDE: 7,
  ON_GROUND: 8,
  VELOCITY: 9,
  TRUE_TRACK: 10,
  VERTICAL_RATE: 11,
  SENSORS: 12,
  GEO_ALTITUDE: 13,
  SQUAWK: 14,
  SPI: 15,
  POSITION_SOURCE: 16,
  CATEGORY: 17,
  // 18 intentionally skipped to match server (no field at that index).
  AIRCRAFT_TYPE: 19,
  AIRCRAFT_DESCRIPTION: 20,
  REGISTRATION: 21,
  EMERGENCY_STATUS: 22,
} as const;

export type StateArray = Array<string | number | boolean | null>;

const FT_TO_M = 0.3048;
const KT_TO_MPS = 0.514444;
const FPM_TO_MPS = 0.00508;

export interface Dump1090Aircraft {
  hex: string;
  flight?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | 'ground';
  altitude?: number;
  alt_geom?: number;
  gs?: number;
  track?: number;
  vert_rate?: number;
  squawk?: string;
  category?: string;
  seen?: number;
  seen_pos?: number;
}

export function dump1090ToStateArray(ac: Dump1090Aircraft): StateArray | null {
  if (typeof ac.hex !== 'string' || ac.hex.length !== 6) return null;
  if (typeof ac.lat !== 'number' || typeof ac.lon !== 'number') return null;

  const nowSec = Math.floor(Date.now() / 1000);
  const lastContact = typeof ac.seen === 'number' ? nowSec - ac.seen : nowSec;
  const timePosition = typeof ac.seen_pos === 'number' ? nowSec - ac.seen_pos : null;

  let baroFt: number | null = null;
  if (typeof ac.alt_baro === 'number') baroFt = ac.alt_baro;
  else if (typeof ac.altitude === 'number') baroFt = ac.altitude;

  let category: number | null = null;
  if (typeof ac.category === 'string') {
    const parsed = parseInt(ac.category, 16);
    if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 19) category = parsed;
  }

  const state: StateArray = new Array(23).fill(null);
  state[STATE_INDEX.ICAO24] = ac.hex.toLowerCase();
  state[STATE_INDEX.CALLSIGN] = ac.flight ? ac.flight.trim() : null;
  state[STATE_INDEX.ORIGIN_COUNTRY] = null;
  state[STATE_INDEX.TIME_POSITION] = timePosition;
  state[STATE_INDEX.LAST_CONTACT] = lastContact;
  state[STATE_INDEX.LONGITUDE] = ac.lon;
  state[STATE_INDEX.LATITUDE] = ac.lat;
  state[STATE_INDEX.BARO_ALTITUDE] = baroFt !== null ? baroFt * FT_TO_M : null;
  state[STATE_INDEX.ON_GROUND] = ac.alt_baro === 'ground';
  state[STATE_INDEX.VELOCITY] = typeof ac.gs === 'number' ? ac.gs * KT_TO_MPS : null;
  state[STATE_INDEX.TRUE_TRACK] = typeof ac.track === 'number' ? ac.track : null;
  state[STATE_INDEX.VERTICAL_RATE] = typeof ac.vert_rate === 'number' ? ac.vert_rate * FPM_TO_MPS : null;
  state[STATE_INDEX.SENSORS] = null;
  state[STATE_INDEX.GEO_ALTITUDE] = typeof ac.alt_geom === 'number' ? ac.alt_geom * FT_TO_M : null;
  state[STATE_INDEX.SQUAWK] = ac.squawk || null;
  state[STATE_INDEX.SPI] = false;
  state[STATE_INDEX.POSITION_SOURCE] = 0;
  state[STATE_INDEX.CATEGORY] = category;
  return state;
}
