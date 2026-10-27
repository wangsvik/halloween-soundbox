"use strict";

const $ = (sel) => document.querySelector(sel);
const KEY_STORE = "soundbox-key";

let apiKey = new URLSearchParams(location.search).get("key") || safeGet(KEY_STORE) || "";
let library = { effects: [], ambient: [], categories: [] };
let state = { volume: 70, playing: false, current: null, active: [], ambient: null };
let ws = null;
let volumeTimer = null;
let draggingVolume = false;

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* privat modus */ } }

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(apiKey ? { "X-Api-Key": apiKey } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    const k = prompt("Soundboxen krever API-nøkkel:");
    if (k) { apiKey = k; safeSet(KEY_STORE, k); connect(); return api(path, body); }
    throw new Error("Mangler API-nøkkel");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Feil ${res.status}`);
  }
  return res.json();
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 2500);
}

const run = (fn) => async (...args) => {
  try { await fn(...args); } catch (e) { toast(e.message); }
};

// ---------- rendering ----------

const CATEGORY_LABELS = { diverse: "Diverse" };
const label = (c) => CATEGORY_LABELS[c] || c.charAt(0).toUpperCase() + c.slice(1).replace(/-/g, " ");

function renderLibrary() {
  const host = $("#effects");
  host.replaceChildren();
  $("#empty").hidden = library.effects.length > 0;

  for (const cat of library.categories) {
    const section = document.createElement("section");
    section.className = "cat";
    const h = document.createElement("h2");
    h.textContent = label(cat);
    const grid = document.createElement("div");
    grid.className = "grid";
    for (const s of library.effects.filter((e) => e.category === cat)) {
      const b = document.createElement("button");
      b.className = "pad";
      b.dataset.id = s.id;
      b.textContent = s.name;
      const bar = document.createElement("span");
      bar.className = "bar";
      b.append(bar);
      b.addEventListener("click", run(() => api("/api/play", { id: s.id })));
      grid.append(b);
    }
    section.append(h, grid);
    host.append(section);
  }

  const sel = $("#random-cat");
  const chosen = sel.value;
  sel.replaceChildren(new Option("Alle kategorier", ""));
  for (const cat of library.categories) sel.append(new Option(label(cat), cat));
  sel.value = library.categories.includes(chosen) ? chosen : "";

  const chips = $("#ambient-list");
  chips.replaceChildren();
  for (const a of library.ambient) {
    const c = document.createElement("button");
    c.className = "chip";
    c.dataset.id = a.id;
    c.textContent = a.name;
    c.addEventListener("click", run(() =>
      state.ambient?.id === a.id ? api("/api/ambient", { on: false }) : api("/api/ambient", { on: true, id: a.id })));
    chips.append(c);
  }
  if (!library.ambient.length) chips.textContent = "Ingen filer i sounds/ambient";
  renderState();
}

function renderState() {
  document.body.classList.toggle("playing", state.playing);
  const names = [];
  if (state.current) names.push(state.current.sound.name);
  if (state.ambient) names.push(`🌫 ${state.ambient.name}`);
  $("#now").textContent = names.join(" · ") || "Stille …";

  if (!draggingVolume) $("#volume").value = state.volume;
  $("#volume-out").textContent = `${state.volume} %`;

  const toggle = $("#ambient-toggle");
  toggle.setAttribute("aria-checked", String(!!state.ambient));
  document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c.dataset.id === state.ambient?.id));

  const activeIds = new Map((state.active || []).map((a) => [a.sound.id, a]));
  document.querySelectorAll(".pad").forEach((p) => {
    const a = activeIds.get(p.dataset.id);
    p.classList.toggle("playing", !!a);
    const bar = p.querySelector(".bar");
    if (a && p.dataset.playId !== String(a.play_id)) {
      p.dataset.playId = a.play_id;
      bar.style.transition = "none";
      bar.style.width = "0";
      bar.offsetWidth; // start animasjonen på nytt
      bar.style.transition = `width ${a.duration}s linear`;
      bar.style.width = "100%";
    } else if (!a) {
      delete p.dataset.playId;
      bar.style.transition = "none";
      bar.style.width = "0";
    }
  });
}

// ---------- sanntid ----------

function connect() {
  if (ws) { ws.onclose = null; ws.close(); }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ""}`);
  ws.onopen = () => { $("#conn").classList.add("on"); $("#conn").textContent = "tilkoblet"; loadLibrary(); };
  ws.onmessage = (ev) => {
    if (ev.data === "pong") return;
    const msg = JSON.parse(ev.data);
    if (msg.type === "state") { const { type, ...s } = msg; state = s; renderState(); }
  };
  ws.onclose = () => {
    $("#conn").classList.remove("on");
    $("#conn").textContent = "frakoblet";
    setTimeout(connect, 2000);
  };
}
setInterval(() => ws?.readyState === 1 && ws.send("ping"), 25000);

const loadLibrary = run(async () => {
  library = await api("/api/sounds");
  renderLibrary();
});

// ---------- kontroller ----------

$("#volume").addEventListener("input", (e) => {
  draggingVolume = true;
  $("#volume-out").textContent = `${e.target.value} %`;
  clearTimeout(volumeTimer);
  volumeTimer = setTimeout(run(() => api("/api/volume", { level: Number(e.target.value) })), 120);
});
$("#volume").addEventListener("change", () => { draggingVolume = false; });

$("#ambient-toggle").addEventListener("click", run(() => api("/api/ambient", { on: !state.ambient })));
$("#random").addEventListener("click", run(() => api("/api/play/random", { category: $("#random-cat").value || null })));
$("#stop").addEventListener("click", run(() => api("/api/stop", { what: "all" })));

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && ws?.readyState !== 1) connect();
});

connect();
