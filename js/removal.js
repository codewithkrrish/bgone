/* BGone — js/removal.js
   Pure background-removal and compositing logic. No DOM, no canvas, no
   network here on purpose: every function works on raw RGBA pixel arrays,
   so it can be unit-tested in plain Node and reused anywhere.

   Colour mode works like a careful chroma key:
   1. Sample the background colour (corners by default, or a user-picked pixel).
   2. Mark pixels close to that colour as background.
   3. Flood-fill from the image edges through background pixels, so a
      background-coloured patch *inside* the subject is kept, not punched out.
   4. Feather the boundary: pixels in the tolerance band get partial alpha,
      which avoids the crunchy halo cheap keyers leave behind. */

export function colorDistance(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/* Average colour of the four corner patches (each ~4% of the smaller side,
   at least 1px). Corners are the least likely place for a subject to sit. */
export function sampleBackgroundColor(data, width, height) {
  const patch = Math.max(1, Math.floor(Math.min(width, height) * 0.04));
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const corners = [
    [0, 0],
    [width - patch, 0],
    [0, height - patch],
    [width - patch, height - patch],
  ];
  for (const [cx, cy] of corners) {
    for (let y = 0; y < patch; y += 1) {
      for (let x = 0; x < patch; x += 1) {
        const i = ((cy + y) * width + (cx + x)) * 4;
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        n += 1;
      }
    }
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/* Remove the background from RGBA data.
   options: { bg: [r, g, b], tolerance (0-441), feather (0-200) }
   Returns a new Uint8ClampedArray; the input is never mutated.
   Alpha rule: distance <= tolerance -> 0; tolerance < distance <=
   tolerance + feather -> scaled 0..255; anything further stays opaque.
   Only pixels connected to an edge through the background band are
   removed, so interior patches that happen to match the background colour
   survive. */
export function removeBackgroundByColor(data, width, height, options) {
  const { bg, tolerance = 60, feather = 24 } = options;
  const out = new Uint8ClampedArray(data);
  const total = width * height;
  const dist = new Float32Array(total);
  const band = new Uint8Array(total); // 1 = background candidate
  for (let p = 0; p < total; p += 1) {
    const i = p * 4;
    const d = colorDistance(data[i], data[i + 1], data[i + 2], bg[0], bg[1], bg[2]);
    dist[p] = d;
    band[p] = d <= tolerance + feather ? 1 : 0;
  }

  // Flood-fill from every border pixel through band pixels.
  const reached = new Uint8Array(total);
  const stack = [];
  const pushIfBand = (p) => {
    if (band[p] && !reached[p]) {
      reached[p] = 1;
      stack.push(p);
    }
  };
  for (let x = 0; x < width; x += 1) {
    pushIfBand(x);
    pushIfBand((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    pushIfBand(y * width);
    pushIfBand(y * width + (width - 1));
  }
  while (stack.length > 0) {
    const p = stack.pop();
    const x = p % width;
    const y = Math.floor(p / width);
    if (x > 0) pushIfBand(p - 1);
    if (x < width - 1) pushIfBand(p + 1);
    if (y > 0) pushIfBand(p - width);
    if (y < height - 1) pushIfBand(p + width);
  }

  for (let p = 0; p < total; p += 1) {
    if (!reached[p]) continue;
    const d = dist[p];
    if (d <= tolerance) {
      out[p * 4 + 3] = 0;
    } else if (feather > 0) {
      out[p * 4 + 3] = Math.round(((d - tolerance) / feather) * 255);
    } else {
      out[p * 4 + 3] = 0;
    }
  }
  return out;
}

/* Count fully-transparent pixels — handy for tests and for the UI's
   "background removed" sanity display. */
export function countTransparent(data) {
  let n = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] === 0) n += 1;
  }
  return n;
}

/* --- Compositing helpers: each returns (x, y, width, height) => [r, g, b] --- */

export function solidBackground(r, g, b) {
  return () => [r, g, b];
}

export function gradientBackground(from, to, angleDegrees = 135) {
  const angle = (angleDegrees * Math.PI) / 180;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  return (x, y, width, height) => {
    // Project onto the gradient axis, normalised 0..1 between the extreme
    // corners so the gradient always spans the whole image.
    const corners = [0, dx * (width - 1), dy * (height - 1), dx * (width - 1) + dy * (height - 1)];
    const min = Math.min(...corners);
    const max = Math.max(...corners);
    const t = max === min ? 0 : (dx * x + dy * y - min) / (max - min);
    const clamped = Math.min(1, Math.max(0, t));
    return [
      Math.round(from[0] + (to[0] - from[0]) * clamped),
      Math.round(from[1] + (to[1] - from[1]) * clamped),
      Math.round(from[2] + (to[2] - from[2]) * clamped),
    ];
  };
}

/* Composite foreground RGBA over a background pixel function.
   Returns opaque RGBA (alpha always 255) — what a flattened export wants. */
export function compositeOver(fg, width, height, bgPixel) {
  const out = new Uint8ClampedArray(fg.length);
  for (let p = 0; p < width * height; p += 1) {
    const i = p * 4;
    const a = fg[i + 3] / 255;
    const [br, bgc, bb] = bgPixel(p % width, Math.floor(p / width), width, height);
    out[i] = Math.round(fg[i] * a + br * (1 - a));
    out[i + 1] = Math.round(fg[i + 1] * a + bgc * (1 - a));
    out[i + 2] = Math.round(fg[i + 2] * a + bb * (1 - a));
    out[i + 3] = 255;
  }
  return out;
}

/* Parse a #rgb / #rrggbb hex string into [r, g, b]. Returns null on bad input. */
export function parseHex(hex) {
  if (typeof hex !== 'string') return null;
  const clean = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{3}$/.test(clean) && !/^[0-9a-fA-F]{6}$/.test(clean)) return null;
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}
