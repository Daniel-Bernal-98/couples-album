import { APP } from "./config.js";
import { el, clear } from "./ui.js";
import { renderViewer } from "./viewer.js";
import { renderAdmin } from "./admin.js";

const app = document.getElementById("app");
const OCR_DEBUG = true;

function header() {
  return el("div", { class: "header" }, [
    el("div", { class: "wrap" }, [
      el("div", { class: "brand" }, [
        el("h1", { text: APP.albumTitle }),
        el("div", { class: "sub", text: "Only unlocks with the passphrase." })
      ])
    ])
  ]);
}

function parseRoute() {
  const hash = location.hash || "";
  // Single album:
  // Viewer: # (empty) or #/
  // Admin: #admin?token=...
  if (hash.startsWith("#admin")) return { name: "admin" };
  return { name: "viewer" };
}

async function render() {
  clear(app);
  app.append(header());

  const main = el("main", { class: "main" });
  app.append(main);

  const route = parseRoute();
  if (route.name === "admin") {
    await renderAdmin(main);
  } else {
    await renderViewer(main);
  }
}

window.addEventListener("hashchange", render);
render();
