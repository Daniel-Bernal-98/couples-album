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

  const modal = buildModal();
  root.append(modal.wrap);

  function lock() {
    state.key = null;
    if (state.unsub) state.unsub();
    state.unsub = null;
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
    clear(grid);

    for (const p of photos) {
      try {
        // download encrypted thumb bytes
        const thumbRef = st.ref(storage, p.thumb.path);
        const encThumb = await st.getBytes(thumbRef);
        const iv = fromB64(p.thumb.ivB64);

        const decThumb = await aesGcmDecrypt(state.key, iv, new Uint8Array(encThumb));
        const thumbUrl = bytesToObjectUrl(decThumb, "image/jpeg");

        // decrypt meta
        const metaIv = fromB64(p.metaEnc.ivB64);
        const metaCipher = fromB64(p.metaEnc.cipherB64);
        const metaBytes = await aesGcmDecrypt(state.key, metaIv, metaCipher);
        const meta = bytesToJson(metaBytes);

        const tile = el("div", { class: "tile", onclick: () => openPhoto(p, meta) }, [
          el("img", { src: thumbUrl, alt: meta.description || "Photo" }),
          el("div", { class: "meta" }, [
            el("div", { class: "badge", text: p.dateISO ? p.dateISO : "—" }),
            el("div", { class: "desc", text: meta.description || "" })
          ])
        ]);

        grid.append(tile);
      } catch (e) {
        // skip unreadable items (wrong passphrase will fail here)
      }
    }
  }

  async function openPhoto(p, meta) {
    modal.title.textContent = p.dateISO || "Photo";
    modal.caption.textContent = meta.description || "";
    modal.img.src = "";
    modal.wrap.classList.add("open");

    try {
      const fullRef = st.ref(storage, p.full.path);
      const encFull = await st.getBytes(fullRef);
      const iv = fromB64(p.full.ivB64);
      const decFull = await aesGcmDecrypt(state.key, iv, new Uint8Array(encFull));
      modal.img.src = bytesToObjectUrl(decFull, "image/jpeg");
    } catch (e) {
      modal.caption.textContent = "Failed to decrypt image (wrong passphrase?)";
    }
  }
}

function buildModal() {
  const img = el("img", {});
  const title = el("div", { text: "" });
  const caption = el("div", { class: "small", text: "" });

  const wrap = el("div", { class: "modal", onclick: (e) => {
    if (e.target === wrap) wrap.classList.remove("open");
  }}, [
    el("div", { class: "panel" }, [
      el("header", {}, [
        el("button", { class: "btn secondary", text: "Close", onclick: () => wrap.classList.remove("open") }),
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
