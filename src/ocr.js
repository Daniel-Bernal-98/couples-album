// Loads Tesseract from CDN at runtime only when admin uploads.
async function ensureTesseract() {
  if (window.Tesseract) return window.Tesseract;
  await import("https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js");
  return window.Tesseract;
}

// OCR the bottom strip of the photo where the printed date usually is.
// Accepts a File or Blob (e.g. from decrypted image bytes).
export async function detectPrintedDateText(file) {
  const bmp = await createImageBitmap(file);

  // Printed date often near bottom. Crop bottom ~22%.
  const cropH = Math.floor(bmp.height * 0.22);
  const sx = 0;
  const sy = bmp.height - cropH;
  const sw = bmp.width;
  const sh = cropH;

  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);

  const dataUrl = canvas.toDataURL("image/png");

  const Tesseract = await ensureTesseract();
  const result = await Tesseract.recognize(dataUrl, "eng");
  const text = (result?.data?.text || "").trim();

  return { text };
}

// OCR the bottom strip of an image given as raw bytes (e.g. decrypted from storage).
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
    .replace(/[O]/g, "0")      // O -> 0
    .replace(/[IL|]/g, "1")    // I/L/| -> 1
    .replace(/[^0-9\/.\- ]/g, "")
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
