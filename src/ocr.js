// Set to true to enable verbose OCR debug logging in the browser console.
const OCR_DEBUG = true;

// Luminance threshold for binarisation: pixels darker than this become black (digits), rest white.
const BINARY_THRESHOLD = 210;

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
function applyContrastThreshold(ctx, w, h) {
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    // Convert to grayscale (luminance)
    const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    // Binary threshold: pixels darker than BINARY_THRESHOLD become black (digits), rest white
    const val = gray < BINARY_THRESHOLD ? 0 : 255;
    data[i] = val;
    data[i + 1] = val;
    data[i + 2] = val;
    // alpha unchanged
  }
  ctx.putImageData(imageData, 0, 0);
}

// OCR the bottom-right area of the photo where the printed date stamp usually is.
// Accepts a File or Blob (e.g. from decrypted image bytes).
export async function detectPrintedDateText(file) {
  const bmp = await createImageBitmap(file);

  // Focus on bottom-right corner where camera date stamps typically appear.
  // Use safe bounds to avoid zero-sized crop.
  const sx = Math.max(0, Math.floor(bmp.width * 0.45));
  const sy = Math.max(0, Math.floor(bmp.height * 0.70));
  const sw = Math.max(1, bmp.width - sx);
  const sh = Math.max(1, bmp.height - sy);

  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);

  // Preprocess: grayscale + threshold to make digits stand out
  applyContrastThreshold(ctx, sw, sh);

  const dataUrl = canvas.toDataURL("image/png");

  const Tesseract = await ensureTesseract();
  const result = await Tesseract.recognize(dataUrl, "eng", {
    tessedit_char_whitelist: DATE_CHAR_WHITELIST,
    tessedit_pageseg_mode: "7", // PSM 7: single text line
  });
  const text = (result?.data?.text || "").trim();

  if (OCR_DEBUG) {
    console.debug("[OCR] crop:", { sx, sy, sw, sh });
    console.debug("[OCR] raw text:", JSON.stringify(text));
  }

  return { text };
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
