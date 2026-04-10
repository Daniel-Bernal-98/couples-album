import { APP } from "./config.js";
import { db, storage, fs, st } from "./firebase.js";
import { el, clear } from "./ui.js";
import {
  sha256Hex, toB64, aesGcmEncrypt, deriveKeyFromPassphrase,
  jsonToBytes, fromB64
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

function isValidISODate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
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
  card.append(el("div", { class: "help", text: "Keep your admin token private." }));

  const pass = el("input", { class: "input", type: "password", placeholder: "Passphrase (same as viewer)" });
  const initBtn = el("button", { class: "btn", text: "Initialize / Unlock" });
  const status = el("div", { class: "help", text: "" });

  const file = el("input", { type: "file", accept: "image/jpeg", multiple: true, class: "input" });
  file.disabled = true;

  const queueWrap = el("div", { class: "card" });
  const queueTitle = el("div", { class: "row" }, [
    el("div", { text: "Upload queue" }),
    el("div", { class: "spacer" }),
    el("button", { class: "btn secondary", text: "Clear queue", onclick: () => clearQueue() })
  ]);
  const queueList = el("div", { style: "display:grid; gap:12px; margin-top:10px;" });

  queueWrap.append(queueTitle);
  queueWrap.append(el("div", { class: "help", text: "Tip: OCR date is best-effort—edit it if needed before uploading." }));
  queueWrap.append(queueList);

  card.append(el("div", { class: "row" }, [pass, initBtn]));
  card.append(status);
  card.append(el("div", { class: "help", text: "Select JPEG photos to upload:" }));
  card.append(file);
  root.append(queueWrap);

  let album = null;
  let key = null;
  let uploading = false;
  const queue = []; // { id, file, dateISO, description, ocrRaw, rowEls... }

  function setUploading(v) {
    uploading = v;
    file.disabled = v || !key;
    initBtn.disabled = v;
  }

  function clearQueue() {
    if (uploading) return;
    queue.length = 0;
    queueList.innerHTML = "";
    status.textContent = "";
  }

  initBtn.onclick = async () => {
    status.textContent = "Initializing…";
    setUploading(true);

    try {
      album = await getOrInitAlbumDoc(adminTokenHash);

      // Derive encryption key
      const saltBytes = fromB64(album.kdf.saltB64);
      key = await deriveKeyFromPassphrase(pass.value, saltBytes, album.kdf.iterations);

      status.textContent = "Ready. Choose files to upload.";
      setUploading(false);
    } catch (e) {
      console.error(e);
      status.textContent = "Failed to initialize/unlock. Check passphrase and try again.";
      key = null;
      setUploading(false);
    }
  };

  file.onchange = async () => {
    if (!file.files?.length) return;
    if (!key) {
      status.textContent = "Unlock first.";
      file.value = "";
      return;
    }

    status.textContent = `Preparing ${file.files.length} file(s)…`;

    // Build queue items (OCR can take time; do it sequentially to avoid freezing)
    for (const f of file.files) {
      const item = {
        id: crypto.randomUUID(),
        file: f,
        dateISO: "",
        description: "",
        ocrRaw: "",
      };

      // OCR date (best effort)
      try {
        const r = await detectPrintedDateText(f);
        item.ocrRaw = r.text || "";
        item.dateISO = parsePrintedDateToISO(item.ocrRaw) || "";
      } catch {
        // ignore OCR errors
      }

      queue.push(item);
      queueList.append(renderQueueRow(item));
    }

    status.textContent = "Queue ready. Fill description/date and click Upload.";
    file.value = "";
  };

  function renderQueueRow(item) {
    const name = el("div", { text: item.file.name });
    const small = el("div", { class: "help", text: item.ocrRaw ? `OCR: ${item.ocrRaw}` : "OCR: —" });

    const dateInput = el("input", {
      class: "input",
      placeholder: "YYYY-MM-DD",
      value: item.dateISO || ""
    });
    dateInput.addEventListener("input", () => { item.dateISO = dateInput.value.trim(); });

    const descInput = el("input", {
      class: "input",
      placeholder: "Description (optional)",
      value: item.description || ""
    });
    descInput.addEventListener("input", () => { item.description = descInput.value; });

    const uploadBtn = el("button", { class: "btn", text: "Upload" });
    const lineStatus = el("div", { class: "help", text: "" });

    uploadBtn.onclick = async () => {
      if (uploading) return;
      if (!key) return;

      const dateISO = (item.dateISO || "").trim();
      if (dateISO && !isValidISODate(dateISO)) {
        lineStatus.textContent = "Date must be YYYY-MM-DD (or leave blank).";
        return;
      }

      setUploading(true);
      uploadBtn.disabled = true;
      lineStatus.textContent = "Uploading…";

      try {
        // Prepare images
        const bmp = await fileToImageBitmap(item.file);

        // Thumbs for smooth iPhone scrolling
        const thumb = await resizeToJpegBytes(bmp, 480, 0.75);

        // Full: your images are small; still cap for safety
        const full = await resizeToJpegBytes(bmp, 1600, 0.85);

        // Encrypt blobs
        const thumbEnc = await aesGcmEncrypt(key, thumb.bytes);
        const fullEnc = await aesGcmEncrypt(key, full.bytes);

        // Encrypt metadata (includes description + ocr)
        const meta = {
          description: item.description || "",
          ocrRawText: item.ocrRaw || "",
          originalFilename: item.file.name
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
          dateISO: dateISO || "",
          w: full.w, h: full.h,
          metaEnc: { ivB64: toB64(metaEnc.ivBytes), cipherB64: toB64(metaEnc.cipherBytes) },
          thumb: { path: thumbPath, ivB64: toB64(thumbEnc.ivBytes) },
          full: { path: fullPath, ivB64: toB64(fullEnc.ivBytes) }
        });

        lineStatus.textContent = "Uploaded.";
      } catch (e) {
        console.error(e);
        lineStatus.textContent = "Upload failed. See console.";
        uploadBtn.disabled = false;
      } finally {
        setUploading(false);
      }
    };

    const row = el("div", { class: "card" }, [
      el("div", { class: "row" }, [name, el("div", { class: "spacer" }), uploadBtn]),
      small,
      el("div", { class: "row" }, [
        el("div", { style: "flex:1; min-width: 180px;" }, [dateInput]),
        el("div", { style: "flex:3; min-width: 220px;" }, [descInput]),
      ]),
      lineStatus
    ]);

    return row;
  }
}
