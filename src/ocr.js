export function parsePrintedDateToISO(text) {
  if (!text) return "";

  // Normalize OCR output
  const t = String(text)
    .toUpperCase()
    .replace(/\s+/g, " ")
    .replace(/[O]/g, "0")      // O -> 0
    .replace(/[IL|]/g, "1")    // I/L/| -> 1
    .trim();

  // Accept: DD MM YYYY  (spaces) and DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY
  // Examples: "10 04 2026", "10/04/2026", "10-04-2026"
  const m = t.match(/\b(\d{1,2})[ \/\-.](\d{1,2})[ \/\-.](\d{4})\b/);
  if (!m) return "";

  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);

  // Basic validation
  if (yyyy < 1970 || yyyy > 2100) return "";
  if (mm < 1 || mm > 12) return "";
  if (dd < 1 || dd > 31) return "";

  // Real calendar date validation
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
