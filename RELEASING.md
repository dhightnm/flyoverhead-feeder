# Releasing the feeder

## Runtime distribution (R2 + CDN)

Prebuilt packages live on the **feeder** R2 bucket, served at `https://feeder.flyoverhead.com` (custom domain on that bucket).

| Object | Purpose |
|---|---|
| `dist/linux-armv7l.tar.gz` | Pi / armhf prebuild (`dist/`, `node_modules/`, `package.json`) |
| `dist/linux-arm64.tar.gz` | Pi 64-bit / arm64 |
| `dist/linux-amd64.tar.gz` | x86_64 servers |
| `dist/manifest.json` | Version + archive paths |
| `dist/feeder-source.tar.gz` | Source fallback (compile on device) |
| `install.sh` | Optional CDN copy of the installer |

`install.sh` tries the CDN prebuild for the local arch first, then falls back to source from CDN or `https://flyoverhead.com/feeder-source.tar.gz`.

Registration/pairing runs **before** the dist download finishes (curl + python3 only), so users can approve a pairing code while the tarball downloads.

### Publish a new feeder version

1. Bump `feeder/package.json` version when `feeder/src/` changes.
2. Run the GitHub Action **Feeder dist publish** (or push to `staging` / `master` with `feeder/**` changes).
3. Confirm objects appear in the R2 bucket and `curl -fsI https://feeder.flyoverhead.com/dist/manifest.json` returns 200.

Local publish (same as CI):

```sh
# Build on native arch, or use CI matrix for all three.
feeder/scripts/build-dist-tarball.sh linux-amd64
feeder/scripts/build-source-tarball.sh
export R2_ENDPOINT=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...
feeder/scripts/publish-feeder-r2.sh
```

Set repo variable `FEEDER_R2_BUCKET` if the bucket name is not `feeder`.

### Server image (legacy fallback)

The main app Dockerfile still bundles `feeder-source.tar.gz` for `GET /feeder-source.tar.gz` and `GET /install.sh` on `flyoverhead.com`. That path remains the fallback when the CDN prebuild is missing.

## When to bump `feeder/package.json` version

Bump on any change to `feeder/src/` you want to spot in `fly-overhead-feeder --version` across the fleet.

## Manual test on a Pi

```sh
curl -fsSL https://flyoverhead.com/install.sh | sudo bash
sudo journalctl -u fly-overhead-feeder -f
```

Confirm: anonymous register completes in seconds, dist installs from CDN (or source), service streams within ~30s. Optional: `FEEDER_INSTALL_MODE=pair` and claim on `/feeders/pair` while install continues in the background.

## Installer environment

| Variable | Default | Purpose |
|---|---|---|
| `FEEDER_CDN_URL` | `https://feeder.flyoverhead.com` | Prebuilt dist + source tarball base |
| `FEEDER_FORCE_SOURCE_BUILD` | `0` | Skip CDN prebuild |
| `FEEDER_INSTALL_MODE` | `anonymous` | `anonymous` \| `pair` \| `skip` \| `interactive` |
