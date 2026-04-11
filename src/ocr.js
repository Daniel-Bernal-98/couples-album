// Set to true to enable verbose OCR debug logging in the browser console.
const OCR_DEBUG = true;

// Baseline luminance threshold for binarisation: pixels darker than this become black (digits), rest white.
const BINARY_THRESHOLD = 160;

// Tesseract character whitelist for date stamp OCR (digits and common separators only).
const DATE_CHAR_WHITELIST = "0123456789/.- ";

// Loads Tesseract from CDN at runtime only when admin uploads.
async function ensureTesseract() {
  if (window.Tesseract) return window.Tesseract;
  await import("https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js");
  return window.Tesseract;
}

// Apply grayscale + binary threshold to a canvas context to improve OCR accuracy
// for orange/colored digits printed on a light background.
// When invert=true, pixels brighter than threshold become black (for light digits on dark backgrounds).
// The threshold parameter controls where the binary cut-off is:
//   - higher values (e.g. 200) keep more "dark" pixels → good for high-contrast backgrounds
//   - lower values (e.g. 130–145) preserve thin strokes like the vertical '1' in orange stamps
function applyContrastThreshold(ctx, w, h, threshold = BINARY_THRESHOLD, invert = false) {
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    // Convert to grayscale (luminance)
    const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    // Binary threshold: normal = dark pixels become black; invert = bright pixels become black
    const val = (invert ? gray > threshold : gray < threshold) ? 0 : 255;
    data[i] = val;
    data[i + 1] = val;
    data[i + 2] = val;
    // alpha unchanged
  }
  ctx.putImageData(imageData, 0, 0);
}

// Thicken thin strokes on an already-thresholded (black-on-white) canvas by drawing
// it onto itself shifted 1 px to the right using the 'darken' composite operation.
// 'darken' keeps the minimum (darker) value per channel, so black ink expands into
// adjacent white pixels — this helps Tesseract recognise thin verticals like '1'.
function boldenCanvas(canvas, ctx, w, h) {
  // Copy current pixels to a temp canvas so we read clean source data while writing.
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const tCtx = tmp.getContext("2d");
  tCtx.drawImage(canvas, 0, 0);

  ctx.globalCompositeOperation = "darken";
  ctx.drawImage(tmp, 1, 0); // draw shifted 1 px to the right → expands left edge of each glyph
  ctx.globalCompositeOperation = "source-over";
}

// Compute average luminance of the current canvas pixels (0–255).
function averageLuminance(ctx, w, h) {
  const data = ctx.getImageData(0, 0, w, h).data;
  let sum = 0;
  const pixels = w * h;
  for (let i = 0; i < data.length; i += 4) {
    sum += Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  }
  return pixels > 0 ? sum / pixels : 128;
}

// Score an OCR attempt result to select the best candidate when multiple attempts produce
// a parseable date.  Higher is better.
//   2 – clean two-digit day AND valid ISO  (e.g. "10 04 2026" → 2026-04-10)
//   1 – valid ISO but day was single-digit (e.g. "2 04 2026"  → 2026-04-02, less confident)
//   0 – no valid date extracted
// Using a score instead of first-match ensures a lower-threshold attempt that preserves
// thin strokes (and therefore recovers the leading '1' in day '10') is preferred over an
// earlier attempt that dropped it and returned a single-digit day.
function scoreOCRResult(text, iso) {
  if (!iso) return 0;
  // Check the raw OCR text (before parsePrintedDateToISO normalisation) for a clean
  // two-digit day.  parsePrintedDateToISO accepts \d{1,2} for the day, so "2 04 2026"
  // and "10 04 2026" both yield a valid ISO — but the first form means Tesseract lost
  // the leading '1'.  Requiring \d{2} here distinguishes those two outcomes.
  const hasTwoDigitDay = /\b\d{2}[ \/\-.]\d{2}[ \/\-.]\d{4}\b/.test(text);
  return hasTwoDigitDay ? 2 : 1;
}

// Crop a region of bmp into a new canvas and return {canvas, ctx, sx, sy, sw, sh}.
function cropBitmap(bmp, sxFraction, syFraction) {
  const sx = Math.max(0, Math.floor(bmp.width * sxFraction));
  const sy = Math.max(0, Math.floor(bmp.height * syFraction));
  const sw = Math.max(1, bmp.width - sx);
  const sh = Math.max(1, bmp.height - sy);
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
  return { canvas, ctx, sx, sy, sw, sh };
}

// OCR the bottom-right area of the photo where the printed date stamp usually is.
// Runs up to 5 preprocessing/crop attempts and returns the result with the best score
// (see scoreOCRResult).  Accepts a File or Blob (e.g. from decrypted image bytes).
export async function detectPrintedDateText(file) {
  const bmp = await createImageBitmap(file);
  const Tesseract = await ensureTesseract();

  // Attempt A: tight bottom-right crop, baseline threshold (least noise)
  // Attempt B: same tight crop, lower threshold — preserves thin strokes like '1' in '10'
  // Attempt C: same tight crop, even lower threshold + bolden pass — thickens thin strokes further
  // Attempt D: slightly wider crop (catches stamps that start a bit further left)
  // Attempt E: tight crop, adaptive threshold/invert based on background luminance
  const cropAttempts = [
    { sxF: 0.55, syF: 0.70, threshold: 160, invert: false, bolden: false },
    { sxF: 0.55, syF: 0.70, threshold: 140, invert: false, bolden: false },
    { sxF: 0.55, syF: 0.70, threshold: 130, invert: false, bolden: true  },
    { sxF: 0.50, syF: 0.70, threshold: 160, invert: false, bolden: false },
    null, // computed dynamically based on luminance (see below)
  ];

  // For attempt E: sample luminance of the tight crop to decide preprocessing
  const { ctx: lCtx, sw: lSw, sh: lSh } = cropBitmap(bmp, 0.55, 0.70);
  const avgLum = averageLuminance(lCtx, lSw, lSh);
  // Luminance > 200 means a very bright (near-white) background: a higher binarisation threshold
  // (200) keeps orange/coloured digits dark without clipping subtle contrast differences.
  // A darker background (avgLum ≤ 200) means digits may be lighter than the surroundings,
  // so inverting the threshold (bright → black) is more reliable.
  cropAttempts[4] = avgLum > 200
    ? { sxF: 0.55, syF: 0.70, threshold: 200, invert: false, bolden: false }
    : { sxF: 0.55, syF: 0.70, threshold: 160, invert: true,  bolden: false };

  let bestText = "";
  let bestISO = "";
  let bestScore = 0;

  for (let i = 0; i < cropAttempts.length; i++) {
    const { sxF, syF, threshold, invert, bolden } = cropAttempts[i];
    const { canvas, ctx, sx, sy, sw, sh } = cropBitmap(bmp, sxF, syF);

    applyContrastThreshold(ctx, sw, sh, threshold, invert);
    if (bolden) {
      boldenCanvas(canvas, ctx, sw, sh);
    }

    const dataUrl = canvas.toDataURL("image/png");
    const result = await Tesseract.recognize(dataUrl, "eng", {
      tessedit_char_whitelist: DATE_CHAR_WHITELIST,
      tessedit_pageseg_mode: "7", // PSM 7: single text line
    });
    const text = (result?.data?.text || "").trim();

    // Always use the first attempt's raw text as a last-resort fallback so callers
    // always receive something when no attempt produces a parseable date.
    if (i === 0) bestText = text;

    if (OCR_DEBUG) {
      console.debug(`[OCR] attempt ${i + 1}:`, { sx, sy, sw, sh, threshold, invert, bolden });
      console.debug(`[OCR] attempt ${i + 1} raw text:`, JSON.stringify(text));
    }

    const iso = parsePrintedDateToISO(text);
    const score = scoreOCRResult(text, iso);

    if (OCR_DEBUG) {
      console.debug(`[OCR] attempt ${i + 1} score:`, score, iso ? `ISO: ${iso}` : "(no date)");
    }

    if (score > bestScore) {
      bestText = text;
      bestISO = iso;
      bestScore = score;
      // Score 2 = clean two-digit day match — no better result is possible, stop early.
      if (bestScore >= 2) break;
    }
  }

  return { text: bestText, bestISO };
}

// OCR the bottom-right area of an image given as raw bytes (e.g. decrypted from storage).
// Creates a temporary Blob and delegates to detectPrintedDateText.
export async function detectPrintedDateTextFromBlob(blob) {
  return detectPrintedDateText(blob);
}

// Parse printed date formats like:
//  - "10 04 2026"
//  - "10/04/2026", "10-04-2026", "10.04.2026"
// Treat as DD MM YYYY (your stamp format) and return ISO YYYY-MM-DD.
export function parsePrintedDateToISO(text) {
  if (!text) return "";

  const t = String(text)
    .toUpperCase()
    .replace(/\s+/g, " ")
    .replace(/[O]/g, "0")           // O -> 0
    .replace(/[IL|]/g, "1")         // I/L/| -> 1
    .replace(/[^0-9\/.\- ]/g, "")   // strip any remaining non-date chars
    .trim();

  const m = t.match(/\b(\d{1,2})[ \/\-.](\d{1,2})[ \/\-.](\d{4})\b/);
  if (!m) return "";

  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);

  if (yyyy < 1970 || yyyy > 2100) return "";
  if (mm < 1 || mm > 12) return "";
  if (dd < 1 || dd > 31) return "";

  const d = new Date(Date.UTC(yyyy, mm - 1, dd));
  if (
    d.getUTCFullYear() !== yyyy ||
    d.getUTCMonth() !== mm - 1 ||
    d.getUTCDate() !== dd
  ) return "";

  return (
    String(yyyy).padStart(4, "0") + "-" +
    String(mm).padStart(2, "0") + "-" +
    String(dd).padStart(2, "0")
  );
}
