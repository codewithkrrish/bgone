# BGone

I kept running into the same problem with profile pictures and product shots: every "free background remover" wanted me to upload my photo to a server I knew nothing about, then watermarked the result or capped me at two images a day. So I built the version I actually wanted — **the photo never leaves your device.**

BGone removes backgrounds entirely in your browser. There are two ways to do it: an AI segmentation model that runs on your own machine, and a fast colour key for plain backdrops. Either way, you get a transparent PNG, or the subject over a solid colour, a gradient, a blurred version of the original, or an image of your own.

**Live:** https://bgone.vercel.app

## What it does

- Drop in up to 10 photos at once — JPG, PNG, WebP — or paste straight from the clipboard
- AI removal for real-world photos (people, pets, products on any background)
- Colour-key removal for plain or green-screen backdrops, with tolerance and edge-feather controls — click any photo to pick the exact background colour
- Transparent PNG export, or a new background: solid colours, gradients, blurred original, or your own uploaded image
- Before/after comparison slider on every result
- Download one by one, or everything as a ZIP
- A built-in sample photo, so you can try it without hunting for a test image

## Why browser-side?

Same reason as everything else I build this way: screenshots, product shots and personal photos shouldn't have to visit a stranger's server just to lose their background. The other reason is practical — there's no upload queue and no per-image wait. Your own CPU does the work, and once the AI model is cached, repeat runs are fast.

## Honest limitations

I'd rather list these than let you find them:

- **First AI run downloads about 40 MB of model weights.** That's the price of running a real segmentation model locally. It's cached by the browser afterwards, but the first run on a slow connection takes a while, and it will fail outright if the CDN is unreachable — Colour mode still works then, no download needed.
- **Fine hair, glass and busy backgrounds are hard.** The AI gets most everyday photos right, but wispy edges and transparent objects are where every background remover struggles, including this one. The feather control in Colour mode helps for plain backdrops; for AI results there is no manual cleanup brush yet.
- **Colour mode only removes background connected to the photo's edges.** That's deliberate — it stops a matching colour inside the subject from being punched out — but it means a subject fully enclosed by background-coloured pixels won't be cut by it.
- **Very large photos are slow in AI mode.** The model runs on your device's CPU or WebGPU if available. A 24MP photo will take noticeably longer than a phone-sized one; resizing first (PixelPress does this well) speeds it up a lot.
- **HEIC photos** (iPhone default) won't open in most browsers. That's a browser limitation, not much I can do until they support it.

## Running it locally

No build step, no dependencies to install. It's plain HTML, CSS and JavaScript (ES modules), so you just need any static server:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` straight from disk won't work in most browsers because ES modules need to be served over HTTP. That trips everyone up the first time.

## Tech notes

- Vanilla JS, split into `js/removal.js` (the pixel maths — colour key, flood fill, feathering, compositing) and `js/app.js` (state and wiring)
- AI removal uses [@imgly/background-removal](https://github.com/imgly/background-removal-js) 1.5.5, loaded on demand from jsDelivr — nothing is fetched until you press "Remove background" in AI mode, and no model weights live in this repo
- The colour key is my own code: it samples the background colour, flood-fills from the image edges through matching pixels, and feathers the boundary so cuts don't look clipped
- ZIP downloads use [JSZip](https://stuk.github.io/jszip/) 3.10.1 from a CDN; if the CDN is unreachable it falls back to downloading files one by one
- The removal logic is deliberately DOM-free, so it can be unit-tested in plain Node — the harness lives outside this repo

## License

MIT — do what you want with it. If you build something on top, a link back is appreciated but not required.
