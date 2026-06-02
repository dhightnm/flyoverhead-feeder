import {
  afterEach, beforeEach, describe, expect, it,
} from '@jest/globals';
import {
  mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadOrCreateUuid } from '../identity';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'fo-feeder-identity-'));
  delete process.env.FLY_OVERHEAD_FEEDER_UUID;
});

afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

function paths(extras: Partial<{ canonical: string; bootMirror: string | null; userMirror: string }> = {}) {
  return {
    canonical: extras.canonical ?? join(tmp, 'canonical/feeder.uuid'),
    bootMirror: extras.bootMirror === undefined ? join(tmp, 'boot/feeder-uuid') : extras.bootMirror,
    userMirror: extras.userMirror ?? join(tmp, 'user/feeder.uuid'),
  };
}

describe('loadOrCreateUuid', () => {
  it('generates a fresh UUID when nothing is on disk and persists it', () => {
    const p = paths();
    const result = loadOrCreateUuid(p);
    expect(result.source).toBe('generated');
    expect(result.writtenTo.length).toBeGreaterThan(0);
    expect(result.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('prefers env var over anything on disk', () => {
    process.env.FLY_OVERHEAD_FEEDER_UUID = 'abcdef12-3456-7890-abcd-ef1234567890';
    const p = paths();
    const result = loadOrCreateUuid(p);
    expect(result.source).toBe('env');
    expect(result.uuid).toBe('abcdef12-3456-7890-abcd-ef1234567890');
  });

  it('reads canonical first', () => {
    const p = paths();
    mkdirSync(dirname(p.canonical), { recursive: true });
    writeFileSync(p.canonical, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n');
    const result = loadOrCreateUuid(p);
    expect(result.source).toBe('canonical');
    expect(result.uuid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('restores canonical from boot mirror when only boot has the file (SD reflash survival)', () => {
    const p = paths();
    mkdirSync(dirname(p.bootMirror!), { recursive: true });
    writeFileSync(p.bootMirror!, '11111111-2222-3333-4444-555555555555\n');
    const result = loadOrCreateUuid(p);
    expect(result.source).toBe('boot');
    expect(result.uuid).toBe('11111111-2222-3333-4444-555555555555');
    expect(result.writtenTo).toContain(p.canonical);
  });
});
