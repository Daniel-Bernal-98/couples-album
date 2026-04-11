// Set to true to enable verbose OCR debug logging in the browser console.
const OCR_DEBUG = false;

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
// Runs up to 3 preprocessing/crop attempts and returns the result that yields the best
// parseable date. Accepts a File or Blob (e.g. from decrypted image bytes).
export async function detectPrintedDateText(file) {
  const bmp = await createImageBitmap(file);
  const Tesseract = await ensureTesseract();

  // Attempt 1: tight bottom-right crop, baseline threshold (least noise)
  // Attempt 2: slightly wider crop to the left (catches stamps that start earlier)
  // Attempt 3: tight crop, higher threshold OR inverted (adapts to background luminance)
  const cropAttempts = [
    { sxF: 0.55, syF: 0.70, threshold: 160, invert: false },
    { sxF: 0.50, syF: 0.70, threshold: 160, invert: false },
    null, // computed dynamically based on luminance (see below)
  ];

  // For attempt 3: sample luminance of the tight crop to decide preprocessing
  const { ctx: lCtx, sw: lSw, sh: lSh } = cropBitmap(bmp, 0.55, 0.70);
  const avgLum = averageLuminance(lCtx, lSw, lSh);
  // Luminance > 200 means a very bright (near-white) background: a higher binarisation threshold
  // (200) keeps orange/coloured digits dark without clipping subtle contrast differences.
  // A darker background (avgLum ≤ 200) means digits may be lighter than the surroundings,
  // so inverting the threshold (bright → black) is more reliable.
  cropAttempts[2] = avgLum > 200
    ? { sxF: 0.55, syF: 0.70, threshold: 200, invert: false }
    : { sxF: 0.55, syF: 0.70, threshold: 160, invert: true };

  let bestText = "";
  let bestISO = "";

  for (let i = 0; i < cropAttempts.length; i++) {
    const { sxF, syF, threshold, invert } = cropAttempts[i];
    const { canvas, ctx, sx, sy, sw, sh } = cropBitmap(bmp, sxF, syF);

    applyContrastThreshold(ctx, sw, sh, threshold, invert);

    const dataUrl = canvas.toDataURL("image/png");
    const result = await Tesseract.recognize(dataUrl, "eng", {
      tessedit_char_whitelist: DATE_CHAR_WHITELIST,
      tessedit_pageseg_mode: "7", // PSM 7: single text line
    });
    const text = (result?.data?.text || "").trim();

    if (OCR_DEBUG) {
      console.debug(`[OCR] attempt ${i + 1}:`, { sx, sy, sw, sh, threshold, invert });
      console.debug(`[OCR] attempt ${i + 1} raw text:`, JSON.stringify(text));
    }

    const iso = parsePrintedDateToISO(text);
    if (iso) {
      bestText = text;
      bestISO = iso;
      if (OCR_DEBUG) {
        console.debug(`[OCR] attempt ${i + 1} matched ISO:`, iso);
      }
      break;
    }

    // Keep first attempt's text as fallback in case no attempt yields a valid date
    if (i === 0) {
      bestText = text;
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
