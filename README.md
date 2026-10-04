# LoRA Librarian

Stage, review, and catalogue Civitai LoRAs into a [Dynamic Prompts](https://github.com/adieyal/sd-dynamic-prompts)
wildcard file for Stable Diffusion (Forge / A1111).

Right-click a Civitai model link — or the model page itself — and it **stages** the
LoRA (metadata, preview image, trigger words, embedded training tags — but no full
download yet). Review staged LoRAs in a gallery, pick the tags/category you want,
then **Accept** to download the file and append a line to your wildcard file
(`library.yaml`). Also browses/organises your existing local LoRA collection by
matching files to Civitai by hash.

### Merged cards
Several LoRAs of the same subject can be **merged** into one card. The combined
entry is a single Dynamic Prompts variant group, so a generation picks exactly one
LoRA + its own prompt:

```yaml
- "{<lora:AyakaV1:1>, Ayaka, Genshin, blue hair | <lora:AyakaV2:1>, Ayaka, Genshin, kimono}"
```

That also keeps the odds honest — five variants of one character draw as often as
any other single line instead of crowding out five different characters. Merged
cards are striped (one stripe per LoRA), you can flip through the members and mark
any of them inactive, and **Split apart** puts them back. Every edit comments the
old line out rather than deleting it, so nothing is ever lost.

### Prompt builder
A node-graph canvas (**Prompt Builder** tab) that composes a Stable Diffusion
prompt from your catalogued LoRAs. Each node is a prompt category (quality,
character, pose, style, …) holding a text box and any number of LoRAs, each with a
per-LoRA **% proc chance** (edit one and the rest rebalance to sum 100). Nodes emit
from their top/right/bottom edges and only receive on the left, so dragging a
node's right edge onto another's left **snaps** them into a chain — and the chain
order is the order of the generated prompt. "Generate" produces either one concrete
roll or a single Dynamic Prompts `{60::a|40::b}` weighted string. The layout
persists and can be exported/imported (imports are reconciled field-by-field —
missing fields are defaulted, unknown fields are set aside for review, nothing
silently breaks).

Two parts:
- **the service** — a Node/Express server that does the work and serves the web UI
  (collection, library, curate, staging gallery, prompt builder, categories, folder scan);
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
cp .env.example .env      # fill in the tokens and the ABSOLUTE data/download paths
npm install
npm run init              # install step: creates WILDCARDS_DIR (0700) and seeds
                          # library.yaml, staging.json, promptbuilder.json (0600)
npm start                 # http(s)://<HOST>:<PORT>, default 0.0.0.0:8420
```
The service never creates its own data: a missing or relative location
is a refusal at start that names the absolute path and the fix (usually
`npm run init`), not an empty library at the wrong path.
See `.env.example` for all config (ports, TLS, data/download paths). For a
LAN/remote setup (browser on a different machine than the service) you need TLS —
the extension's secure context upgrades non-loopback `http` to `https`.

## Browser extension
Load `extension/` unpacked (Chrome: `chrome://extensions` → Load unpacked;
Firefox: `about:debugging` → Load Temporary Add-on), or install a signed build.
Open its **Options** and set the Service URL (default `http://127.0.0.1:8420`)
and the service token, then right-click a Civitai model link — or right-click
anywhere on a Civitai model page to stage the model you're already looking at.

## Tests
```
npm run gate                        # syntax-checks every file, then runs every suite:
node scripts/test-merge.js          # wildcard-file editing primitives
node scripts/test-promptbuilder.js  # prompt-builder core logic
node scripts/test-download-path.js  # no download can escape the download folder
node scripts/test-locations.js      # installed locations: init makes, the server checks
```
The merge suite exercises the wildcard-file editing primitives (merge/split/park,
move, remove, the replaced-file marker) against a throwaway copy in a temp dir, and
asserts your real `data/library.yaml` is byte-identical afterwards. The prompt-builder
suite covers the pure graph/composition/reconcile logic headlessly.

Personal data (`data/library.yaml`, `.env`, caches, downloads, certs) is
gitignored; `data/library.example.yaml` is the empty seed.

## License
[GNU AGPL-3.0-or-later](LICENSE).
