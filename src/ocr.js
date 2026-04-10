// Loads Tesseract from CDN at runtime only when admin uploads.
async function ensureTesseract() {
  if (window.Tesseract) return window.Tesseract;
  await import("https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js");
  return window.Tesseract;
}

export async function detectPrintedDateText(file) {
  const bmp = await createImageBitmap(file);

  // Kodak printed date often near bottom. Crop bottom 22%.
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

function pad2(n){ return String(n).padStart(2,"0"); }

// For your use case: assume US-like MM/DD/YY if ambiguous.
export function parsePrintedDateToISO(raw) {
  const s = raw
    .toUpperCase()
    .replace(/\s+/g, " ")
    .replace(/[^A-Z0-9/.\- ]/g, "")
    .trim();

  const m = s.match(/(\d{1,2})[\/.\- ](\d{1,2})[\/.\- ](\d{2,4})/);
  if (m) {
    let mm = Number(m[1]);
    let dd = Number(m[2]);
    let yy = Number(m[3]);
    if (yy < 100) yy = 2000 + yy;
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      return `${yy}-${pad2(mm)}-${pad2(dd)}`;
    }
  }
  return "";
}
