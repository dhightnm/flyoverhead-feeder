import {
  describe, expect, it, jest, beforeEach, afterEach,
} from '@jest/globals';
import { EventEmitter } from 'node:events';

// Mock node:net before importing the forwarder so connect() is controllable.
const connectMock = jest.fn();
jest.mock('node:net', () => ({
  connect: (...args: unknown[]) => connectMock(...args),
}));

import { BeastForwarder } from '../sources/beastForwarder';

class FakeSocket extends EventEmitter {
  destroyed = false;

  writable = true;

  write = jest.fn(() => true);

  destroy = jest.fn(() => {
    this.destroyed = true;
    // Real sockets emit 'close' on destroy — the forwarder must not let that
    // re-enter teardownAndRetry (it removes listeners first).
    this.emit('close');
  });
}

const OPTS = {
  source: { host: '127.0.0.1', port: 30005 },
  upstream: { host: 'feed.example.com', port: 30004 },
  uuid: '11223344-5566-7788-9900-aabbccddeeff',
};

describe('BeastForwarder reconnect single-flight', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    connectMock.mockReset();
    connectMock.mockImplementation(() => new FakeSocket());
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('one disconnect (many close/error events) schedules exactly one reconnect', () => {
    const fwd = new BeastForwarder(OPTS);
    fwd.start();

    // First cycle: connect() opens upstream + source = 2 calls.
    expect(connectMock).toHaveBeenCalledTimes(2);
    const upstream = connectMock.mock.results[0].value as FakeSocket;
    const source = connectMock.mock.results[1].value as FakeSocket;
    upstream.emit('connect');
    source.emit('connect');

    // A messy disconnect fires several events at once — the exact shape that
    // used to schedule N overlapping reconnects and leak sockets. The first
    // event triggers teardown (which removes listeners); the rest are no-ops.
    upstream.emit('error', new Error('reset'));
    upstream.emit('close');
    source.emit('close');

    jest.advanceTimersByTime(1000);

    // Exactly ONE reconnect cycle = 2 more connect() calls (total 4), not 6/8.
    expect(connectMock).toHaveBeenCalledTimes(4);

    fwd.stop();
  });

  it('a stable connection triggers no spurious reconnects', () => {
    const fwd = new BeastForwarder(OPTS);
    fwd.start();
    const upstream = connectMock.mock.results[0].value as FakeSocket;
    const source = connectMock.mock.results[1].value as FakeSocket;
    upstream.emit('connect');
    source.emit('connect');

    jest.advanceTimersByTime(10_000);

    // No disconnect → still just the initial pair.
    expect(connectMock).toHaveBeenCalledTimes(2);
    fwd.stop();
  });

  it('repeated disconnects reconnect once each with backoff, never compounding', () => {
    const fwd = new BeastForwarder(OPTS);
    fwd.start();
    expect(connectMock).toHaveBeenCalledTimes(2);

    // Disconnect #1
    let upstream = connectMock.mock.results[0].value as FakeSocket;
    upstream.emit('close');
    jest.advanceTimersByTime(1000); // first backoff = 1s
    expect(connectMock).toHaveBeenCalledTimes(4);

    // Disconnect #2 — backoff doubled to 2s, still exactly one reconnect.
    upstream = connectMock.mock.results[2].value as FakeSocket;
    upstream.emit('close');
    jest.advanceTimersByTime(2000);
    expect(connectMock).toHaveBeenCalledTimes(6);

    fwd.stop();
  });

  it('stop() cancels a pending reconnect', () => {
    const fwd = new BeastForwarder(OPTS);
    fwd.start();
    const upstream = connectMock.mock.results[0].value as FakeSocket;
    upstream.emit('close'); // schedules a reconnect
    fwd.stop(); // must cancel it
    jest.advanceTimersByTime(60_000);
    // No new connect() after stop — still the initial 2.
    expect(connectMock).toHaveBeenCalledTimes(2);
  });
});
