import { describe, expect, it } from '@jest/globals';
import { dump1090ToStateArray, STATE_INDEX, type Dump1090Aircraft } from '../state';

const sample: Dump1090Aircraft = {
  hex: 'AC9251',
  flight: 'UAL484 ',
  lat: 39.86,
  lon: -104.67,
  alt_baro: 10000,
  alt_geom: 10250,
  gs: 250,
  track: 270,
  vert_rate: -500,
  squawk: '1234',
  // dump1090 hex category; values 0-19 only -- 0xA3 would be rejected.
  category: '03',
  seen: 1,
  seen_pos: 2,
};

describe('dump1090ToStateArray', () => {
  it('produces a 23-element array indexed exactly like the server expects', () => {
    const state = dump1090ToStateArray(sample);
    expect(state).not.toBeNull();
    if (!state) return;
    expect(state).toHaveLength(23);

    expect(state[STATE_INDEX.ICAO24]).toBe('ac9251');
    expect(state[STATE_INDEX.CALLSIGN]).toBe('UAL484');
    expect(state[STATE_INDEX.LATITUDE]).toBe(39.86);
    expect(state[STATE_INDEX.LONGITUDE]).toBe(-104.67);
    // baro altitude is stored in metres -- 10000 ft * 0.3048
    expect(state[STATE_INDEX.BARO_ALTITUDE]).toBeCloseTo(3048, 1);
    // velocity in m/s -- 250 kt * 0.514444
    expect(state[STATE_INDEX.VELOCITY]).toBeCloseTo(128.611, 2);
    expect(state[STATE_INDEX.TRUE_TRACK]).toBe(270);
    // vertical rate in m/s -- -500 fpm * 0.00508
    expect(state[STATE_INDEX.VERTICAL_RATE]).toBeCloseTo(-2.54, 2);
    expect(state[STATE_INDEX.SQUAWK]).toBe('1234');
    expect(state[STATE_INDEX.CATEGORY]).toBe(3);
  });

  it('rejects records without lat/lon -- they are not yet locatable', () => {
    expect(dump1090ToStateArray({ hex: 'abcdef' })).toBeNull();
  });

  it('rejects records with bad icao24 length', () => {
    expect(dump1090ToStateArray({ hex: 'abc', lat: 1, lon: 1 })).toBeNull();
  });

  it('marks on_ground when alt_baro is the string "ground"', () => {
    const state = dump1090ToStateArray({
      hex: 'abcdef',
      lat: 0,
      lon: 0,
      alt_baro: 'ground',
    });
    expect(state).not.toBeNull();
    expect(state![STATE_INDEX.ON_GROUND]).toBe(true);
    expect(state![STATE_INDEX.BARO_ALTITUDE]).toBeNull();
  });
});
