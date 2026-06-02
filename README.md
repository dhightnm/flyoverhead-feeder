# fly-overhead-feeder

MIT-licensed ADS-B feeder client for [Fly Overhead](https://flyoverhead.com).
Tunnels BEAST to `feed.flyoverhead.com:30004` or polls `aircraft.json` and POSTs to `flyoverhead.com`.

**License: [MIT](./LICENSE) — read this entire repo before you run anything.**

## What this client sends

Only what your local decoder broadcasts — nothing more:

- **Aircraft states**: ICAO24 hex, callsign, lat/lon, altitude, speed, heading, squawk (standard ADS-B fields)
- **Aggregate stats**: message count and unique aircraft count, sent once per minute
- **Heartbeat**: a lightweight ping every 60 seconds

No device info, no crash reports, no analytics beyond the above. Every network call is in [`src/api.ts`](./src/api.ts). See the [Feeder Data Policy](https://flyoverhead.com/legal/feeder-data) for retention and use details.

## Feeder benefits

Pair your feeder with a Fly Overhead account and your account automatically upgrades to full Pro — weather overlays, VFR charts, PIREPs, 90-day flight history, and 1,000 API requests/day. No forms, no waiting, stays active while your feeder is online.

You can feed Fly Overhead **alongside** Flightradar24, adsb.fi, airplanes.live, or any other network simultaneously. We actively encourage running multiple feeders.

## Install (one line)

```sh
curl -fsSL https://flyoverhead.com/install.sh | sudo bash
```

The installer is idempotent, attaches alongside existing ADS-B software (no decoder takeover), and registers your feeder anonymously by default so data starts flowing without an account. It picks one of two receiver modes automatically.

## Standalone vs. client mode

The installer probes for an existing ADS-B decoder, then picks a mode:

- **Client mode** — a decoder (`dump1090-fa`, `readsb`, `tar1090`, PiAware) is already on the box. The feeder attaches as a passive **TCP client** of `localhost:30005` (BEAST) or `localhost:8080/data/aircraft.json` (JSON). It never opens the SDR, never binds privileged ports, never touches the existing decoder. Run as many feeder clients in parallel as you like.
- **Standalone mode** — no decoder, but an RTL-SDR dongle is plugged in. The installer installs [`readsb`](https://github.com/wiedehopf/readsb) (via wiedehopf's installer, which also sets up RTL-SDR drivers and blacklists the `dvb_usb_rtl28xxu` kernel module). readsb drives the SDR and emits BEAST on `localhost:30005`; the feeder then consumes it exactly as in client mode. The box becomes a self-contained receiver — no other ADS-B software required.

If neither a decoder nor an SDR is found, the installer stops and tells you what to plug in. Set `FEEDER_SKIP_DECODER_INSTALL=1` to force client-only behavior (abort instead of installing readsb).

## Pair to an account, or feed anonymously

By default the installer **registers anonymously** and starts the `fly-overhead-feeder` service immediately. No browser step required.

To link the feeder to your account after install:

1. Sign in at `flyoverhead.com/feeders/pair`
2. On the Pi, run `node /opt/fly-overhead-feeder/dist/index.js pair` (as the `flyoverhead` user, with `FLY_OVERHEAD_FEEDER_CONFIG=/var/lib/fly-overhead-feeder/config.json`)
3. Enter the 6-character code shown in the terminal

To block on account linking during install, use `FEEDER_INSTALL_MODE=pair`. Re-runs with an existing API key skip registration unless you set `FEEDER_INSTALL_MODE=pair` to re-link.

The UUID is written to two locations so it survives reflashing:

- `/var/lib/fly-overhead-feeder/feeder.uuid` (canonical)
- `/boot/fly-overhead-feeder-uuid` (FAT partition — accessible from another machine before re-flashing)

## Already running `docker-adsb-ultrafeeder`?

You don't need this client at all. Add us as a BEAST output:

```
ULTRAFEEDER_CONFIG=adsb,feed.flyoverhead.com,30004,beast_reduce_plus_out,uuid=<your-uuid>
```

Use the same UUID you use for other aggregators if you want a consistent identity, or generate a new one with `cat /proc/sys/kernel/random/uuid`. Visit `/feeders/pair` and enter that UUID to link it to your account.

## Commands

```sh
fly-overhead-feeder pair        # link this device to a Fly Overhead account
fly-overhead-feeder register    # anonymous register (no account)
fly-overhead-feeder run         # start streaming (default — what systemd runs)
fly-overhead-feeder doctor      # diagnose local feeder sources
fly-overhead-feeder --version
```

## Configuration

Lives at `/var/lib/fly-overhead-feeder/config.json` (or `~/.config/fly-overhead-feeder/config.json` when running unprivileged). Environment variables override file values:

| Env var | Default | Purpose |
|---|---|---|
| `FEEDER_API_URL` | `https://flyoverhead.com` | Server base URL |
| `FEEDER_API_KEY` | — | API key (set by `pair` or `register`) |
| `FEEDER_ID` | — | Feeder UUID (set by `pair` or `register`) |
| `FEEDER_WIRE_MODE` | `auto` | `auto` \| `beast` \| `json` |
| `FEEDER_JSON_SOURCE` | `http://127.0.0.1:8080/data/aircraft.json` | aircraft.json URL |
| `FEEDER_POLL_INTERVAL_MS` | `5000` | JSON poll cadence |
| `FLY_OVERHEAD_FEEDER_UUID` | — | Override the on-disk UUID (advanced) |
| `FEEDER_SKIP_DECODER_INSTALL` | `0` | Set `1` to disable standalone readsb auto-install (installer-only) |
| `FEEDER_INSTALL_MODE` | `anonymous` | `anonymous` \| `pair` \| `skip` \| `interactive` (installer-only) |
| `FEEDER_CDN_URL` | `https://feeder.flyoverhead.com` | Prebuilt dist tarballs (installer-only) |
| `FEEDER_FORCE_SOURCE_BUILD` | `0` | Set `1` to compile on device instead of CDN prebuild |

Auto mode probes `localhost:30005` for BEAST first; falls back to JSON polling if BEAST isn't available.

## Operations

```sh
systemctl status fly-overhead-feeder
journalctl -u fly-overhead-feeder -f
```

## Releasing

See [RELEASING.md](RELEASING.md) for the R2 distribution pipeline.
