import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, accessSync, constants } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IdentityPaths {
  canonical: string;
  bootMirror: string | null;
  userMirror: string;
}

export function defaultIdentityPaths(): IdentityPaths {
  return {
    canonical: '/var/lib/fly-overhead-feeder/feeder.uuid',
    // The /boot/ mirror is what survives an SD-card reflash — the user can mount
    // the FAT partition from another machine and copy the file off. We only
    // write it when /boot is writable; on most desktop Linux it isn't.
    bootMirror: existsSync('/boot') ? '/boot/fly-overhead-feeder-uuid' : null,
    userMirror: `${homedir()}/.config/fly-overhead-feeder/feeder.uuid`,
  };
}

function tryRead(path: string): string | null {
  try {
    const raw = readFileSync(path, 'utf8').trim();
    return UUID_RE.test(raw) ? raw.toLowerCase() : null;
  } catch {
    return null;
  }
}

function tryWrite(path: string, uuid: string): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    // 0600: the UUID is the feeder's BEAST ingest credential, not a public id.
    // (The /boot mirror lands on a FAT partition that ignores Unix modes —
    // nothing we can do there — but the canonical + user copies are locked.)
    writeFileSync(path, `${uuid}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function isWritable(path: string): boolean {
  try {
    accessSync(dirname(path), constants.W_OK);
    return true;
  } catch {
    try {
      mkdirSync(dirname(path), { recursive: true });
      accessSync(dirname(path), constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
}

export function loadOrCreateUuid(paths: IdentityPaths = defaultIdentityPaths()): {
  uuid: string;
  source: 'env' | 'canonical' | 'boot' | 'user' | 'generated';
  writtenTo: string[];
} {
  const envUuid = process.env.FLY_OVERHEAD_FEEDER_UUID;
  if (envUuid && UUID_RE.test(envUuid)) {
    return { uuid: envUuid.toLowerCase(), source: 'env', writtenTo: [] };
  }

  const fromCanonical = tryRead(paths.canonical);
  if (fromCanonical) return { uuid: fromCanonical, source: 'canonical', writtenTo: [] };

  if (paths.bootMirror) {
    const fromBoot = tryRead(paths.bootMirror);
    if (fromBoot) {
      // Found in /boot/ but not canonical — restore canonical from the mirror.
      const restored: string[] = [];
      if (tryWrite(paths.canonical, fromBoot)) restored.push(paths.canonical);
      return { uuid: fromBoot, source: 'boot', writtenTo: restored };
    }
  }

  const fromUser = tryRead(paths.userMirror);
  if (fromUser) return { uuid: fromUser, source: 'user', writtenTo: [] };

  const uuid = randomUUID();
  const writtenTo: string[] = [];
  if (isWritable(paths.canonical) && tryWrite(paths.canonical, uuid)) {
    writtenTo.push(paths.canonical);
  }
  if (paths.bootMirror && isWritable(paths.bootMirror) && tryWrite(paths.bootMirror, uuid)) {
    writtenTo.push(paths.bootMirror);
  }
  if (writtenTo.length === 0 && tryWrite(paths.userMirror, uuid)) {
    writtenTo.push(paths.userMirror);
  }
  return { uuid, source: 'generated', writtenTo };
}
