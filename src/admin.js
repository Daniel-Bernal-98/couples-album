import { APP } from "./config.js";
import { db, storage, fs, st } from "./firebase.js";
import { el, clear } from "./ui.js";
import {
  sha256Hex, toB64, aesGcmEncrypt, deriveKeyFromPassphrase,
  jsonToBytes, toHex
} from "./crypto.js";
import { fileToImageBitmap, resizeToJpegBytes } from "./images.js";
import { detectPrintedDateText, parsePrintedDateToISO } from "./ocr.js";

function getAdminTokenFromUrl() {
  const h = location.hash || "";
  const q = h.includes("?") ? h.split("?")[1] : "";
  const params = new URLSearchParams(q);
  return params.get("token") || "";
}

async function getOrInitAlbumDoc(adminTokenHash) {
  const ref = fs.doc(db, "albums", APP.albumId);
  const snap = await fs.getDoc(ref);

  if (snap.exists()) return snap.data();

  // Initialize album doc if it doesn't exist:
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltB64 = toB64(salt);
  const albumDoc = {
    title: APP.albumTitle,
    createdAt: fs.serverTimestamp(),
    adminTokenHash,
    kdf: { saltB64, iterations: 210000, hash: "SHA-256" }
  };

  await fs.setDoc(ref, albumDoc);
  return albumDoc;
}

export async function renderAdmin(root) {
  clear(root);

  const token = getAdminTokenFromUrl();
  const card = el("section", { class: "card" });
  root.append(card);

  if (!token) {
    card.append(el("div", { text: "Missing admin token. Use: /#admin?token=YOUR_TOKEN" }));
    return;
  }

  const adminTokenHash = await sha256Hex(token);

  card.append(el("h2", { text: "Admin uploader" }));
  card.append(el("div", { class: "help", text: "This page is for uploading only. Keep your admin token private." }));

  const pass = el("input", { class: "input", type: "password", placeholder: "Passphrase (same as viewer)" });
  const initBtn = el("button", { class: "btn", text: "Initialize / Unlock" });
  const status = el("div", { class: "help", text: "" });

  const file = el("input", { type: "file", accept: "image/*", multiple: true, class: "input" });
  file.disabled = true;

  card.append(el("div", { class: "row" }, [pass, initBtn]));
  card.append(status);
  card.append(el("div", { class: "help", text: "Select photos to upload:" }));
  card.append(file);

  let album = null;
  let key = null;

  initBtn.onclick = async () => {
    status.textContent = "Initializing…";
    album = await getOrInitAlbumDoc(adminTokenHash);

    // Derive encryption key
    const saltBytes = (await import("./crypto.js")).fromB64(album.kdf.saltB64);
    key = await deriveKeyFromPassphrase(pass.value, saltBytes, album.kdf.iterations);

    status.textContent = "Ready. Choose files to upload.";
    file.disabled = false;
  };

  file.onchange = async () => {
    if (!file.files?.length) return;

    for (const f of file.files) {
      status.textContent = `Processing: ${f.name}…`;

      // OCR date (best effort)
      let ocrRaw = "";
      let dateISO = "";
      try {
        const r = await detectPrintedDateText(f);
        ocrRaw = r.text || "";
        dateISO = parsePrintedDateToISO(ocrRaw);
      } catch {
        // ignore OCR errors
      }

      const bmp = await fileToImageBitmap(f);

      // Thumbs for smooth iPhone scrolling
      const thumb = await resizeToJpegBytes(bmp, 480, 0.75);

      // Full: keep original-ish (your images are ~1.7MP; still cap to 1600px for safety)
      const full = await resizeToJpegBytes(bmp, 1600, 0.85);

      // Encrypt blobs
      const thumbEnc = await aesGcmEncrypt(key, thumb.bytes);
      const fullEnc = await aesGcmEncrypt(key, full.bytes);

      const meta = {
        description: "",
        ocrRawText: ocrRaw,
        originalFilename: f.name
      };
      const metaEnc = await aesGcmEncrypt(key, jsonToBytes(meta));

      // Upload encrypted bytes to Storage
      const photoId = crypto.randomUUID();
      const basePath = `albums/${APP.albumId}/${photoId}`;

      const thumbPath = `${basePath}/thumb.bin`;
      const fullPath = `${basePath}/full.bin`;

      await st.uploadBytes(st.ref(storage, thumbPath), new Blob([thumbEnc.cipherBytes]));
      await st.uploadBytes(st.ref(storage, fullPath), new Blob([fullEnc.cipherBytes]));

      // Write Firestore doc (includes adminTokenHash for rules)
      await fs.addDoc(fs.collection(db, "albums", APP.albumId, "photos"), {
        adminTokenHash,
        createdAt: fs.serverTimestamp(),
        dateISO,
        w: full.w, h: full.h,
        metaEnc: { ivB64: toB64(metaEnc.ivBytes), cipherB64: toB64(metaEnc.cipherBytes) },
        thumb: { path: thumbPath, ivB64: toB64(thumbEnc.ivBytes) },
        full: { path: fullPath, ivB64: toB64(fullEnc.ivBytes) }
      });

      status.textContent = `Uploaded: ${f.name}`;
    }

    status.textContent = "Done uploading.";
    file.value = "";
  };
}
