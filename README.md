# LoRA Librarian

Stage, review, and catalogue Civitai LoRAs into a [Dynamic Prompts](https://github.com/adieyal/sd-dynamic-prompts)
wildcard file for Stable Diffusion (Forge / A1111).

Right-click a Civitai model link in your browser → it **stages** the LoRA
(metadata, preview image, trigger words, embedded training tags — but no full
download yet). Review staged LoRAs in a gallery, pick the tags/category you want,
then **Accept** to download the file and append a line to your wildcard file
(`library.yaml`). Also browses/organises your existing local LoRA collection by
matching files to Civitai by hash.

Two parts:
- **the service** — a Node/Express server that does the work and serves the web UI
  (collection, library, curate, staging gallery, categories, folder scan);
- **the browser extension** (Firefox + Chrome) — the right-click "capture" surface.

## Run it

### Option A — desktop app (bundles + runs the service)
```
npm install
npm run electron          # try it
npm run dist              # build an installer (Windows NSIS / macOS dmg / Linux AppImage)
```
First launch asks for your Civitai API token and your loras folder, generates a
service token, runs the service on `http://127.0.0.1:8420`, and opens the UI in
its own window. Its **Extension** menu shows the URL + token to paste into the
browser extension.

### Option B — bare service
```
cp .env.example .env      # fill in CIVITAI_TOKEN + a random SERVICE_TOKEN
npm install
npm start                 # http(s)://<HOST>:<PORT>, default 0.0.0.0:8420
```
See `.env.example` for all config (ports, TLS, data/download paths). For a
LAN/remote setup (browser on a different machine than the service) you need TLS —
the extension's secure context upgrades non-loopback `http` to `https`.

## Browser extension
Load `extension/` unpacked (Chrome: `chrome://extensions` → Load unpacked;
Firefox: `about:debugging` → Load Temporary Add-on), or install a signed build.
Open its **Options** and set the Service URL (default `http://127.0.0.1:8420`)
and the service token, then right-click a Civitai model link.

Personal data (`data/library.yaml`, `.env`, caches, downloads, certs) is
gitignored; `data/library.example.yaml` is the empty seed.

## License
[GNU AGPL-3.0-or-later](LICENSE).
