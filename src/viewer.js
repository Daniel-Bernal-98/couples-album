import { APP } from "./config.js";
import { db, storage, fs, st } from "./firebase.js";
import { el, clear } from "./ui.js";
import { fromB64, deriveKeyFromPassphrase, aesGcmDecrypt, bytesToJson } from "./crypto.js";
import { bytesToObjectUrl } from "./images.js";

async function loadAlbumDoc() {
  const ref = fs.doc(db, "albums", APP.albumId);
  const snap = await fs.getDoc(ref);
  if (!snap.exists()) return null;
  return snap.data();
}

export async function renderViewer(root) {
  const state = {
    key: null,
    passphrase: "",
    album: null,
    unsub: null
  };

  const card = el("section", { class: "card" });
  root.append(card);

  const album = await loadAlbumDoc();
  if (!album) {
    card.append(
      el("div", { text: "Album not initialized yet. Open the admin page from your PC to initialize it." })
    );
    return;
  }
  state.album = album;

  const pass = el("input", { class: "input", type: "password", autocomplete: "current-password", placeholder: "Passphrase" });
  const btn = el("button", { class: "btn", text: "Unlock" });

  const msg = el("div", { class: "help", text: "Enter the passphrase to view the album." });

  card.append(
    el("div", { class: "row" }, [
      pass,
      btn
    ])
  );
  card.append(msg);

  const gridCard = el("section", { class: "card" });
  const grid = el("div", { class: "grid" });
  gridCard.append(el("div", { class: "row" }, [
    el("div", { text: "Memories" }),
    el("div", { class: "spacer" }),
    el("button", { class: "btn secondary", text: "Lock", onclick: () => lock() })
  ]));
  gridCard.append(grid);

  // Cache: key = photoId + ":" + thumb.ivB64 → { thumbBytes, meta }
  // Avoids re-downloading / re-decrypting when onSnapshot fires without data changes.
  const thumbCache = new Map();
  // Object URLs created for the current grid render; revoked before the next render.
  let gridUrls = [];
  // Object URL for the currently-open modal full image; revoked when replaced/closed.
  let modalUrl = null;

  function closeModal() {
    if (modalUrl) { URL.revokeObjectURL(modalUrl); modalUrl = null; }
    modal.wrap.classList.remove("open");
    modal.img.src = "";
  }

  const modal = buildModal(closeModal);
  root.append(modal.wrap);

  function lock() {
    state.key = null;
    if (state.unsub) state.unsub();
    state.unsub = null;
    for (const url of gridUrls) URL.revokeObjectURL(url);
    gridUrls = [];
    thumbCache.clear();
    closeModal();
    grid.innerHTML = "";
    gridCard.remove();
    msg.textContent = "Locked.";
  }

  async function unlock() {
    msg.textContent = "Unlocking…";

    const salt = fromB64(album.kdf.saltB64);
    const iterations = album.kdf.iterations;

    try {
      state.key = await deriveKeyFromPassphrase(pass.value, salt, iterations);
    } catch (e) {
      msg.textContent = "Failed to derive key.";
      return;
    }

    msg.textContent = "";
    root.append(gridCard);

    const q = fs.query(
      fs.collection(db, "albums", APP.albumId, "photos"),
      fs.orderBy("createdAt", "desc")
    );

    state.unsub = fs.onSnapshot(q, async (snap) => {
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      await renderGrid(docs);
    });
  }

  btn.addEventListener("click", unlock);
  pass.addEventListener("keydown", (e) => { if (e.key === "Enter") unlock(); });

  async function renderGrid(photos) {
    // Revoke previous grid thumbnail URLs before clearing.
    for (const url of gridUrls) URL.revokeObjectURL(url);
    gridUrls = [];
    clear(grid);

    // Render placeholder tiles immediately so the grid structure appears at once.
    const tiles = photos.map(() => {
      const tile = el("div", { class: "tile loading" });
      grid.append(tile);
      return tile;
    });

    // Process up to CONCURRENCY photos in parallel.
    const CONCURRENCY = 4;
    let idx = 0;

    async function worker() {
      while (idx < photos.length) {
        const i = idx++;
        const p = photos[i];
        const tile = tiles[i];
        const cacheKey = p.id + ":" + p.thumb.ivB64;

        try {
          let thumbBytes, meta;

          if (thumbCache.has(cacheKey)) {
            ({ thumbBytes, meta } = thumbCache.get(cacheKey));
          } else {
            // Fetch encrypted thumb from Storage and decrypt meta concurrently.
            [thumbBytes, meta] = await Promise.all([
              (async () => {
                const encThumb = await st.getBytes(st.ref(storage, p.thumb.path));
                const iv = fromB64(p.thumb.ivB64);
                return aesGcmDecrypt(state.key, iv, new Uint8Array(encThumb));
              })(),
              (async () => {
                const iv = fromB64(p.metaEnc.ivB64);
                const cipher = fromB64(p.metaEnc.cipherB64);
                const bytes = await aesGcmDecrypt(state.key, iv, cipher);
                return bytesToJson(bytes);
              })()
            ]);
            thumbCache.set(cacheKey, { thumbBytes, meta });
          }

          const thumbUrl = bytesToObjectUrl(thumbBytes, "image/jpeg");
          gridUrls.push(thumbUrl);

          tile.className = "tile";
          tile.addEventListener("click", () => openPhoto(p, meta));
          tile.append(
            el("img", { src: thumbUrl, alt: meta.description || "Photo" }),
            el("div", { class: "meta" }, [
              el("div", { class: "badge", text: p.dateISO ? p.dateISO : "—" }),
              el("div", { class: "desc", text: meta.description || "" })
            ])
          );
        } catch (e) {
          // Skip unreadable items (wrong passphrase will fail here).
          tile.remove();
        }
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

  async function openPhoto(p, meta) {
    // Revoke the previous modal image URL before loading a new one.
    if (modalUrl) { URL.revokeObjectURL(modalUrl); modalUrl = null; }
    modal.title.textContent = p.dateISO || "Photo";
    modal.caption.textContent = meta.description || "";
    modal.img.src = "";
    modal.wrap.classList.add("open");

    try {
      const fullRef = st.ref(storage, p.full.path);
      const encFull = await st.getBytes(fullRef);
      const iv = fromB64(p.full.ivB64);
      const decFull = await aesGcmDecrypt(state.key, iv, new Uint8Array(encFull));
      modalUrl = bytesToObjectUrl(decFull, "image/jpeg");
      modal.img.src = modalUrl;
    } catch (e) {
      modal.caption.textContent = "Failed to decrypt image (wrong passphrase?)";
    }
  }
}

function buildModal(onClose) {
  const img = el("img", {});
  const title = el("div", { text: "" });
  const caption = el("div", { class: "small", text: "" });

  const wrap = el("div", { class: "modal", onclick: (e) => {
    if (e.target === wrap) onClose();
  }}, [
    el("div", { class: "panel" }, [
      el("header", {}, [
        el("button", { class: "btn secondary", text: "Close", onclick: () => onClose() }),
        el("div", { class: "spacer" }),
        title
      ]),
      el("div", { class: "content" }, [img]),
      el("footer", {}, [
        caption
      ])
    ])
  ]);

  return { wrap, img, title, caption };
}
