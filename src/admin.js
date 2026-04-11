import { APP } from "./config.js";
import { db, storage, fs, st } from "./firebase.js";
import { el, clear } from "./ui.js";
import {
  sha256Hex, toB64, aesGcmEncrypt, aesGcmDecrypt, deriveKeyFromPassphrase,
  jsonToBytes, bytesToJson, fromB64
} from "./crypto.js";
import { fileToImageBitmap, resizeToJpegBytes, bytesToObjectUrl } from "./images.js";
import { detectPrintedDateText, detectPrintedDateTextFromBlob, parsePrintedDateToISO } from "./ocr.js";

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

  const file = el("input", { type: "file", accept: ".jpg,.jpeg,image/jpeg", multiple: true, class: "input" });
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

  // NEW: manage section
  const manageWrap = el("div", { class: "card" });
  const manageHeader = el("div", { class: "row" }, [
    el("div", { text: "Manage uploaded photos" }),
    el("div", { class: "spacer" }),
    el("button", { class: "btn secondary", text: "Refresh", onclick: () => refreshManage() })
  ]);
  const manageHelp = el("div", { class: "help", text: "Unlock first. You can edit descriptions/dates (encrypted descriptions) or delete items." });
  const manageList = el("div", { style: "display:grid; gap:12px; margin-top:10px;" });
  manageWrap.append(manageHeader, manageHelp, manageList);

  card.append(el("div", { class: "row" }, [pass, initBtn]));
  card.append(status);
  card.append(el("div", { class: "help", text: "Select JPEG photos to upload:" }));
  card.append(file);
  root.append(queueWrap);
  root.append(manageWrap);

  let album = null;
  let key = null;
  let uploading = false;
  let unsubManage = null;

  const queue = [];

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

      const saltBytes = fromB64(album.kdf.saltB64);
      key = await deriveKeyFromPassphrase(pass.value, saltBytes, album.kdf.iterations);

      status.textContent = "Ready. Choose files to upload.";
      setUploading(false);

      // start / restart manage list
      refreshManage(true);
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

    for (const f of file.files) {
      const item = {
        id: crypto.randomUUID(),
        file: f,
        dateISO: "",
        description: "",
        ocrRaw: "",
      };

      try {
        const r = await detectPrintedDateText(f);
        item.ocrRaw = r.text || "";
        item.dateISO = parsePrintedDateToISO(item.ocrRaw) || "";
      } catch {}

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
        const bmp = await fileToImageBitmap(item.file);

        const thumb = await resizeToJpegBytes(bmp, 480, 0.75);
        const full = await resizeToJpegBytes(bmp, 1600, 0.85);

        const thumbEnc = await aesGcmEncrypt(key, thumb.bytes);
        const fullEnc = await aesGcmEncrypt(key, full.bytes);

        const meta = {
          description: item.description || "",
          ocrRawText: item.ocrRaw || "",
          originalFilename: item.file.name
        };
        const metaEnc = await aesGcmEncrypt(key, jsonToBytes(meta));

        const photoId = crypto.randomUUID();
        const basePath = `albums/${APP.albumId}/${photoId}`;
        const thumbPath = `${basePath}/thumb.bin`;
        const fullPath = `${basePath}/full.bin`;

        await st.uploadBytes(st.ref(storage, thumbPath), new Blob([thumbEnc.cipherBytes]));
        await st.uploadBytes(st.ref(storage, fullPath), new Blob([fullEnc.cipherBytes]));

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

    return el("div", { class: "card" }, [
      el("div", { class: "row" }, [name, el("div", { class: "spacer" }), uploadBtn]),
      small,
      el("div", { class: "row" }, [
        el("div", { style: "flex:1; min-width: 180px;" }, [dateInput]),
        el("div", { style: "flex:3; min-width: 220px;" }, [descInput]),
      ]),
      lineStatus
    ]);
  }

  function refreshManage(restartListener = false) {
    if (!key) {
      manageHelp.textContent = "Unlock first to view/edit photos.";
      manageList.innerHTML = "";
      return;
    }

    manageHelp.textContent = "Loading…";

    if (unsubManage && (restartListener || true)) {
      unsubManage();
      unsubManage = null;
    }

    const q = fs.query(
      fs.collection(db, "albums", APP.albumId, "photos"),
      fs.orderBy("createdAt", "desc")
    );

    unsubManage = fs.onSnapshot(q, async (snap) => {
      manageList.innerHTML = "";
      manageHelp.textContent = `${snap.size} photo(s).`;

      for (const d of snap.docs) {
        const p = { id: d.id, ...d.data() };
        manageList.append(await renderManageRow(p));
      }
    });
  }

  async function renderManageRow(p) {
    const rowStatus = el("div", { class: "help", text: "" });

    // decrypt meta
    let meta = { description: "", ocrRawText: "", originalFilename: "" };
    try {
      const metaIv = fromB64(p.metaEnc.ivB64);
      const metaCipher = fromB64(p.metaEnc.cipherB64);
      const metaBytes = await aesGcmDecrypt(key, metaIv, metaCipher);
      meta = bytesToJson(metaBytes);
    } catch (e) {
      rowStatus.textContent = "Could not decrypt metadata (wrong passphrase?).";
    }

    // load thumb preview
    let thumbUrl = "";
    try {
      const encThumb = await st.getBytes(st.ref(storage, p.thumb.path));
      const iv = fromB64(p.thumb.ivB64);
      const decThumb = await aesGcmDecrypt(key, iv, new Uint8Array(encThumb));
      thumbUrl = bytesToObjectUrl(decThumb, "image/jpeg");
    } catch {}

    const img = el("img", { src: thumbUrl, style: "width:120px;height:120px;object-fit:cover;border-radius:12px;border:1px solid rgba(0,0,0,.1);" });

    const dateInput = el("input", { class: "input", placeholder: "YYYY-MM-DD", value: p.dateISO || "" });
    const descInput = el("input", { class: "input", placeholder: "Description", value: meta.description || "" });

    const saveBtn = el("button", { class: "btn", text: "Save" });
    const delBtn = el("button", { class: "btn secondary", text: "Delete" });
    const autoDateBtn = el("button", { class: "btn secondary", text: "Auto date" });

    autoDateBtn.onclick = async () => {
      rowStatus.textContent = "Detecting date…";
      autoDateBtn.disabled = true;
      try {
        const encBytes = await st.getBytes(st.ref(storage, p.full.path));
        const iv = fromB64(p.full.ivB64);
        const decBytes = await aesGcmDecrypt(key, iv, new Uint8Array(encBytes));
        const blob = new Blob([decBytes], { type: "image/jpeg" });
        const { text } = await detectPrintedDateTextFromBlob(blob);
        const iso = parsePrintedDateToISO(text);
        if (!iso) {
          rowStatus.textContent = `Could not detect date${text ? ` (OCR: "${text}")` : ""}. Please enter the date manually.`;
          return;
        }
        const docRef = fs.doc(db, "albums", APP.albumId, "photos", p.id);
        await fs.updateDoc(docRef, { dateISO: iso });
        dateInput.value = iso;
        rowStatus.textContent = `Date detected: ${iso}`;
      } catch (e) {
        console.error(e);
        rowStatus.textContent = "Auto date failed. Please enter the date manually.";
      } finally {
        autoDateBtn.disabled = false;
      }
    };

    saveBtn.onclick = async () => {
      const dateISO = dateInput.value.trim();
      if (dateISO && !isValidISODate(dateISO)) {
        rowStatus.textContent = "Date must be YYYY-MM-DD (or leave blank).";
        return;
      }

      rowStatus.textContent = "Saving…";
      saveBtn.disabled = true;

      try {
        const newMeta = {
          ...meta,
          description: descInput.value || ""
        };
        const metaEnc = await aesGcmEncrypt(key, jsonToBytes(newMeta));

        const docRef = fs.doc(db, "albums", APP.albumId, "photos", p.id);
        await fs.updateDoc(docRef, {
          adminTokenHash,
          dateISO: dateISO || "",
          metaEnc: { ivB64: toB64(metaEnc.ivBytes), cipherB64: toB64(metaEnc.cipherBytes) }
        });

        rowStatus.textContent = "Saved.";
      } catch (e) {
        console.error(e);
        rowStatus.textContent = "Save failed (see console).";
      } finally {
        saveBtn.disabled = false;
      }
    };

    delBtn.onclick = async () => {
      if (!confirm("Delete this photo permanently?")) return;

      rowStatus.textContent = "Deleting…";
      delBtn.disabled = true;
      saveBtn.disabled = true;

      try {
        // delete blobs first
        await st.deleteObject(st.ref(storage, p.thumb.path));
        await st.deleteObject(st.ref(storage, p.full.path));

        // delete firestore doc
        const docRef = fs.doc(db, "albums", APP.albumId, "photos", p.id);
        await fs.deleteDoc(docRef);

        rowStatus.textContent = "Deleted.";
      } catch (e) {
        console.error(e);
        rowStatus.textContent = "Delete failed (see console).";
        delBtn.disabled = false;
        saveBtn.disabled = false;
      }
    };

    return el("div", { class: "card" }, [
      el("div", { class: "row" }, [
        img,
        el("div", { style: "flex:1; min-width:240px;" }, [
          el("div", { class: "help", text: meta.originalFilename ? `File: ${meta.originalFilename}` : `Doc: ${p.id}` }),
          el("div", { class: "row" }, [
            el("div", { style: "flex:1; min-width: 160px;" }, [dateInput]),
            el("div", { style: "flex:2; min-width: 220px;" }, [descInput]),
          ]),
          el("div", { class: "row" }, [saveBtn, autoDateBtn, delBtn]),
          rowStatus
        ])
      ])
    ]);
  }
}
