"use strict";

const $ = (sel) => document.querySelector(sel);
const KEY_STORE = "soundbox-key";
let apiKey = new URLSearchParams(location.search).get("key") || safeGet(KEY_STORE) || "";
let library = { effects: [], ambient: [], categories: [] };
let picked = [];

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* privat modus */ } }
const authHeaders = () => (apiKey ? { "X-Api-Key": apiKey } : {});

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    const k = prompt("Soundboxen krever API-nøkkel:");
    if (k) { apiKey = k; safeSet(KEY_STORE, k); return api(path, { method, body }); }
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(typeof err.detail === "string" ? err.detail : `Feil ${res.status}`);
  }
  return res.json();
}

function toast(msg, ms = 3000) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), ms);
}

const label = (c) => c.charAt(0).toUpperCase() + c.slice(1).replace(/-/g, " ");
const kind = () => document.querySelector("input[name=kind]:checked").value;
const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.ceil(b / 1024)} kB`);

// ---------- liste ----------

function row(sound, kindName) {
  const li = document.createElement("li");
  li.className = "item";
  const name = document.createElement("span");
  name.className = "item-name";
  name.textContent = sound.name;

  const preview = document.createElement("button");
  preview.className = "icon-btn";
  preview.title = "Spill på boksen";
  preview.textContent = "▶";
  preview.addEventListener("click", () => (kindName === "effect"
    ? api("/api/play", { method: "POST", body: { id: sound.id } })
    : api("/api/ambient", { method: "POST", body: { on: true, id: sound.id } })).catch((e) => toast(e.message)));

  const del = document.createElement("button");
  del.className = "icon-btn danger";
  del.title = "Slett";
  del.textContent = "🗑";
  del.addEventListener("click", async () => {
    if (!confirm(`Slette «${sound.name}»?`)) return;
    try {
      await api(`/api/sounds/${kindName}/${sound.id}`, { method: "DELETE" });
      toast(`Slettet «${sound.name}»`);
      load();
    } catch (e) { toast(e.message); }
  });

  li.append(name, preview, del);
  return li;
}

function group(title, sounds, kindName) {
  const wrap = document.createElement("div");
  wrap.className = "group";
  const h = document.createElement("h3");
  h.textContent = `${title} (${sounds.length})`;
  const ul = document.createElement("ul");
  ul.className = "items";
  sounds.forEach((s) => ul.append(row(s, kindName)));
  wrap.append(h, ul);
  return wrap;
}

function render() {
  const list = $("#list");
  list.replaceChildren();
  for (const cat of library.categories) {
    list.append(group(label(cat), library.effects.filter((e) => e.category === cat), "effect"));
  }
  if (library.ambient.length) list.append(group("🌫 Ambiens", library.ambient, "ambient"));
  if (!list.children.length) list.textContent = "Ingen lyder ennå. Last opp den første over!";
  $("#count").textContent = `${library.effects.length} effekter · ${library.ambient.length} ambiens`;

  const dl = $("#categories");
  dl.replaceChildren(...library.categories.map((c) => new Option(label(c), label(c))));
}

async function load() {
  try { library = await api("/api/sounds"); render(); } catch (e) { toast(e.message); }
}

// ---------- opplasting ----------

function setFiles(files) {
  picked = [...files];
  const q = $("#queue");
  q.replaceChildren(...picked.map((f) => {
    const li = document.createElement("li");
    li.textContent = `${f.name} · ${fmtSize(f.size)}`;
    return li;
  }));
  $("#send").disabled = !picked.length;
  $("#send").textContent = picked.length > 1 ? `Last opp ${picked.length} filer` : "Last opp";
}

function updateKind() {
  const effect = kind() === "effect";
  $("#cat-field").hidden = !effect;
  $("#category").required = effect;
}

$("#files").addEventListener("change", (e) => setFiles(e.target.files));
document.querySelectorAll("input[name=kind]").forEach((r) => r.addEventListener("change", updateKind));

const drop = $("#drop");
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => setFiles(e.dataTransfer.files));

$("#upload").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!picked.length) return;
  const form = new FormData();
  picked.forEach((f) => form.append("files", f, f.name));
  form.append("kind", kind());
  form.append("category", $("#category").value.trim());

  // XHR i stedet for fetch for å få fremdriftsindikator
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/upload");
  Object.entries(authHeaders()).forEach(([k, v]) => xhr.setRequestHeader(k, v));
  const bar = $("#progress");
  bar.hidden = false;
  bar.firstElementChild.style.width = "0";
  $("#send").disabled = true;
  $("#send").textContent = "Laster opp …";

  xhr.upload.onprogress = (ev) => {
    if (ev.lengthComputable) bar.firstElementChild.style.width = `${(ev.loaded / ev.total) * 100}%`;
    if (ev.loaded === ev.total) $("#send").textContent = "Behandler …";
  };
  xhr.onload = () => {
    bar.hidden = true;
    let res = {};
    try { res = JSON.parse(xhr.responseText); } catch { /* ignorer */ }
    if (xhr.status >= 400) {
      toast(typeof res.detail === "string" ? res.detail : `Feil ${xhr.status}`);
    } else {
      const ok = res.saved?.length || 0;
      const errs = (res.errors || []).map((x) => `${x.file}: ${x.error}`);
      toast([ok ? `✓ ${ok} fil${ok > 1 ? "er" : ""} lastet opp` : "", ...errs].filter(Boolean).join("\n"), errs.length ? 8000 : 3000);
      $("#files").value = "";
      setFiles([]);
      load();
    }
    $("#send").disabled = !picked.length;
  };
  xhr.onerror = () => { bar.hidden = true; toast("Opplastingen feilet. Er du på samme nett som Pi-en?"); setFiles(picked); };
  xhr.send(form);
});

api("/api/upload").then((info) => {
  $("#formats").textContent = `Støttet: ${info.extensions.join(" ")} · maks ${info.max_mb} MB per fil`
    + (info.normalize && info.ffmpeg ? " · lydstyrken jevnes ut automatisk" : "");
}).catch(() => {});

updateKind();
load();
