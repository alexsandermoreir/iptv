// IPTV Premium para navegador: mesmo produto do app da TV, ligado à mesma conta Google.
import * as C from "./catalog.js";
import * as K from "./cloud.js";

const $ = (s, r = document) => r.querySelector(s);
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") e.className = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else if (k === "text") e.textContent = v; else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
let toastTimer;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 3400); }
const ACCENTS = [["Turquesa", "#26c6b0"], ["Azul", "#4fa3ff"], ["Âmbar", "#ffb300"], ["Rosa", "#ff5c8a"], ["Verde", "#5cd65c"], ["Roxo", "#a77bff"]];
const is4k = (name, cat) => /\b(4k|uhd|2160p?)\b/.test(C.fold(`${name} ${cat}`));

// ---------------------------------------------------------------- cache local do catálogo (IndexedDB)
const idb = (() => {
  let p;
  const open = () => (p ||= new Promise((res, rej) => { const r = indexedDB.open("iptv-web", 1); r.onupgradeneeded = () => r.result.createObjectStore("cat"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
  const tx = async (mode, fn) => { try { const db = await open(); return await new Promise((res, rej) => { const t = db.transaction("cat", mode), q = fn(t.objectStore("cat")); t.oncomplete = () => res(q?.result); t.onerror = () => rej(t.error); }); } catch { return undefined; } };
  return { get: (k) => tx("readonly", (s) => s.get(k)), set: (k, v) => tx("readwrite", (s) => s.put(v, k)), del: (k) => tx("readwrite", (s) => s.delete(k)), clear: () => tx("readwrite", (s) => s.clear()) };
})();

// ---------------------------------------------------------------- estado
const G = { sources: [], byId: {}, raw: {}, smart: [], movies: [], series: [], episodesM3u: [], profile: null, view: "home", v: 0, memo: null, loading: false };
const L = { group: "__all", q: "", edit: false, shown: 200 };
const V = { movies: { cat: "__all", q: "", shown: 120 }, series: { cat: "__all", q: "", shown: 120 } };
const prof = () => G.profile;
const pd = () => K.profileData(prof().id);

function bump() { G.v++; G.memo = null; }

/** Catálogo visível para o perfil atual (sem ocultos, 4K e filtro infantil aplicados como na TV). */
function vis() {
  if (G.memo) return G.memo;
  const hid = K.hiddenSet(), kid = !!prof()?.kid, no4k = K.setting("hide4k", true), on = new Set(G.sources.map((s) => s.id));
  const channels = G.smart.flatMap((sc) => {
    if (!on.has(sc.variants[0].sid) || hid.has(`live:${sc.group}`) || (kid && C.kidBlocked(sc.group, sc.name))) return [];
    let v = sc.variants; if (no4k) { v = v.filter((x) => x.rank < 4); if (!v.length) return []; }
    return [{ ...sc, variants: v, hidden: hid.has(`ch:${sc.key}`) }];
  });
  const okVod = (m, p) => on.has(m.sid) && !hid.has(`${p}:${m.category}`) && !(no4k && is4k(m.name, m.category)) && !(kid && C.kidBlocked(m.category, m.name));
  G.memo = { channels, movies: G.movies.filter((m) => okVod(m, "movie")), series: G.series.filter((s) => okVod(s, "series")), hid };
  return G.memo;
}
const shownChannels = () => vis().channels.filter((c) => !c.hidden);
const chByKey = () => (G.chIdx ||= new Map(G.smart.flatMap((sc) => sc.variants.map((v) => [v.key, sc]))));
const movieByKey = () => (G.mIdx ||= new Map(G.movies.map((m) => [m.key, m])));
const seriesByKey = () => (G.sIdx ||= new Map(G.series.map((s) => [s.key, s])));

// ---------------------------------------------------------------- imagens (via proxy quando a origem é HTTP)
const imgQueue = new Map(); let imgTimer = 0;
const io = "IntersectionObserver" in window ? new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { io.unobserve(e.target); loadImg(e.target); } }), { rootMargin: "300px" }) : null;
function loadImg(img) {
  const u = img.dataset.src; if (!u) return;
  if (u.startsWith("https://")) { img.src = u; return; }
  if (!/^http:\/\//i.test(u)) return;
  imgQueue.set(img, u); clearTimeout(imgTimer);
  imgTimer = setTimeout(async () => {
    const batch = [...imgQueue]; imgQueue.clear();
    const uniq = [...new Set(batch.map((b) => b[1]))];
    try {
      for (let i = 0; i < uniq.length; i += 20) await K.sign(uniq.slice(i, i + 20));
      for (const [el, url] of batch) K.proxied(url).then((t) => { el.src = t; }).catch(() => {});
    } catch { /* sem imagem: fica a inicial */ }
  }, 120);
}
function art(url, label, cls = "") {
  const box = h("div", { class: `art ${cls}` }, (label || "?").trim().charAt(0).toUpperCase());
  if (url) {
    const img = h("img", { alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
    img.dataset.src = url; img.style.display = "none"; box.append(img);
    img.addEventListener("load", () => { img.style.display = ""; box.replaceChildren(img); });
    if (io) io.observe(img); else loadImg(img);
  }
  return box;
}

// ---------------------------------------------------------------- catálogo
const sig = (s) => `${s.kind}|${s.serverUrl || s.m3uUrl}|${s.username || ""}`;
async function loadCatalogs(force = false) {
  G.loading = true; render();
  const errors = [];
  for (const s of G.sources) {
    try {
      const cached = force ? null : await idb.get(`cat:${s.id}`);
      if (cached && cached.sig === sig(s) && Date.now() - cached.t < 12 * 3600e3) { G.raw[s.id] = cached.data; continue; }
      G.status = `Carregando “${s.name}”…`; render();
      const data = s.kind === "xtream" ? await C.loadXtream(s, K.fetchJson, (m) => { G.status = `${s.name}: ${m}`; render(); }) : C.loadM3u(s, await K.fetchText(s.m3uUrl));
      G.raw[s.id] = data; await idb.set(`cat:${s.id}`, { t: Date.now(), sig: sig(s), data });
    } catch (e) { errors.push(`${s.name}: ${e.message}`); }
  }
  const all = G.sources.map((s) => G.raw[s.id]).filter(Boolean);
  G.smart = C.groupChannels(all.flatMap((d) => d.channels));
  G.movies = all.flatMap((d) => d.movies); G.series = all.flatMap((d) => d.series); G.episodesM3u = all.flatMap((d) => d.episodes || []);
  G.chIdx = G.mIdx = G.sIdx = null; bump(); G.loading = false; G.status = ""; G.errors = errors; render();
  if (errors.length) toast(errors[0]);
}
async function loadSources() {
  G.sources = (await K.listSources()).map((s) => ({ ...s }));
  G.byId = Object.fromEntries(G.sources.map((s) => [s.id, s]));
}

// ---------------------------------------------------------------- favoritos, lista, progresso
const isFav = (k) => pd().fav.some((f) => f.k === k);
function toggleFav(k) { const d = pd(); const i = d.fav.findIndex((f) => f.k === k); if (i >= 0) d.fav.splice(i, 1); else d.fav.push({ k, t: Date.now() }); K.dirtyProfile(prof().id); }
const inMy = (k) => pd().my.some((f) => f.k === k);
function toggleMy(k, kind) { const d = pd(); const i = d.my.findIndex((f) => f.k === k); if (i >= 0) d.my.splice(i, 1); else d.my.push({ k, kind, t: Date.now() }); K.dirtyProfile(prof().id); }
function saveProgress(p) {
  const d = pd(); const i = d.prog.findIndex((x) => x.k === p.k); const rec = { ...p, t: Date.now() };
  if (i >= 0) d.prog[i] = rec; else d.prog.unshift(rec);
  d.prog.sort((a, b) => b.t - a.t); d.prog.length = Math.min(d.prog.length, 300); K.dirtyProfile(prof().id);
}
function addHist(k) { const d = pd(); d.hist = [{ k, t: Date.now() }, ...d.hist.filter((x) => x.k !== k)].slice(0, 60); K.dirtyProfile(prof().id); }

// ---------------------------------------------------------------- navegação
const VIEWS = { home: renderHome, live: renderLive, movies: () => renderVod("movies"), series: () => renderVod("series"), search: renderSearch, library: renderLibrary, settings: renderSettings };
function go(v) { G.view = v; render(); $("#view").focus({ preventScroll: true }); scrollTo(0, 0); }
function render() {
  if (!G.profile) return;
  document.querySelectorAll("#nav button[data-v]").forEach((b) => b.classList.toggle("on", b.dataset.v === G.view));
  const view = $("#view"), keepScroll = view.scrollTop;
  const status = G.loading ? h("div", { class: "panel" }, h("div", { class: "spinner", style: "display:inline-block;vertical-align:middle;margin-right:12px;width:22px;height:22px;border-width:3px" }), G.status || "Carregando catálogo…") : null;
  const body = VIEWS[G.view]();
  view.replaceChildren(...[status, body].filter(Boolean)); view.scrollTop = keepScroll;
  const w = prof(); $("#who-name").textContent = w.name; $("#who-av").textContent = w.name.charAt(0).toUpperCase();
}
function emptyNote(msg, action) { return h("div", { class: "panel" }, h("p", {}, msg), action || null); }
const noSources = () => emptyNote("Você ainda não tem listas nesta conta. Adicione uma em Configurações → Listas (ou na TV).", h("button", { class: "primary", onclick: () => { SET.tab = "lists"; go("settings"); } }, "Adicionar lista"));

// ---------------------------------------------------------------- cartões
function chCard(sc, wide = true) {
  return h("button", { class: `card ${wide ? "wide" : ""}`, onclick: () => playLive(sc), title: sc.name },
    art(sc.logo, sc.name, "logo-art"), h("div", { class: "t" }, h("b", {}, sc.name), h("span", { class: "dim" }, sc.group)));
}
function vodCard(item, kind) {
  const pr = pd().prog.find((p) => p.k === item.key);
  return h("button", { class: "card", onclick: () => (kind === "movie" ? movieDialog(item) : seriesDialog(item)), title: item.name },
    art(item.poster, item.name), item.rating && Number(item.rating) > 0 ? h("span", { class: "badge" }, `★ ${Number(item.rating).toFixed(1)}`) : null,
    h("div", { class: "t" }, h("b", {}, item.name), h("span", { class: "dim" }, item.year || item.category)),
    pr && !pr.done && pr.dur ? h("div", { class: "bar2" }, h("i", { style: `width:${Math.min(100, (pr.pos / pr.dur) * 100)}%` })) : null);
}
function progCard(p) {
  return h("button", { class: "card wide", onclick: () => resume(p), title: p.title }, art(p.poster, p.title, ""),
    h("div", { class: "t" }, h("b", {}, p.title), h("span", { class: "dim" }, p.dur ? `${Math.round((p.pos / 1000 / 60))} min assistidos` : "")),
    p.dur ? h("div", { class: "bar2" }, h("i", { style: `width:${Math.min(100, (p.pos / p.dur) * 100)}%` })) : null);
}
const rail = (title, items) => (items.length ? [h("h2", {}, title), h("div", { class: "rail" }, items)] : []);

// ---------------------------------------------------------------- início
function renderHome() {
  if (!G.sources.length && !G.loading) return noSources();
  const v = vis(), d = pd();
  const cont = d.prog.filter((p) => !p.done && p.dur && p.pos > 5000).slice(0, 20).map(progCard);
  const favs = d.fav.map((f) => chByKey().get(f.k)).filter((sc) => sc && !vis().hid.has(`ch:${sc.key}`)).slice(0, 30).map((sc) => chCard(sc));
  const my = d.my.map((m) => (m.kind === "SERIES" || m.kind === "series" ? seriesByKey().get(m.k) : movieByKey().get(m.k))).filter(Boolean).slice(0, 30).map((it) => vodCard(it, it.key.startsWith("s") || it.key.startsWith("ms") ? "series" : "movie"));
  const recentM = [...v.movies].sort((a, b) => b.added - a.added).slice(0, 24).map((m) => vodCard(m, "movie"));
  const recentS = [...v.series].sort((a, b) => b.added - a.added).slice(0, 24).map((s) => vodCard(s, "series"));
  const rows = [...rail("Continuar assistindo", cont), ...rail("Canais favoritos", favs), ...rail("Minha lista", my), ...rail("Filmes recentes", recentM), ...rail("Séries recentes", recentS)];
  return h("div", {}, h("h1", {}, `Olá, ${prof().name}`), rows.length ? rows : (G.loading ? null : emptyNote("Nada para mostrar ainda.")));
}

// ---------------------------------------------------------------- TV ao vivo
function renderLive() {
  if (!G.sources.length && !G.loading) return noSources();
  const v = vis(), hid = v.hid, order = K.setting("orderLive", "");
  const allNames = [...new Set(v.channels.map((c) => c.group))];
  const names = C.applyOrder(order, allNames);
  const counts = new Map(); v.channels.forEach((c) => { if (!c.hidden || L.edit) counts.set(c.group, (counts.get(c.group) || 0) + 1); });
  const groupBtn = (id, label, n) => h("button", { class: L.group === id ? "on" : "", onclick: () => { L.group = id; L.shown = 200; render(); } }, h("span", {}, label), h("span", { class: "dim" }, n ?? ""));
  const favs = pd().fav.filter((f) => chByKey().has(f.k)).length;
  let list = v.channels.filter((c) => L.edit || !c.hidden);
  if (L.group === "__fav") { const fk = new Set(pd().fav.map((f) => f.k)); list = list.filter((c) => c.variants.some((x) => fk.has(x.key)) || fk.has(c.key)); }
  else if (L.group !== "__all") list = list.filter((c) => c.group === L.group);
  if (L.q) { const q = C.fold(L.q); list = list.filter((c) => C.fold(c.name).includes(q)); }
  const total = list.length, page = list.slice(0, L.shown);
  const search = h("input", { type: "search", placeholder: "Buscar canal…", value: L.q, "aria-label": "Buscar canal", oninput: (e) => { L.q = e.target.value; L.shown = 200; clearTimeout(L.t); L.t = setTimeout(() => { render(); const i = $("#view input[type=search]"); i?.focus(); i?.setSelectionRange(L.q.length, L.q.length); }, 250); } });
  const editBtn = h("button", { class: L.edit ? "primary" : "", onclick: () => { L.edit = !L.edit; render(); } }, L.edit ? "Concluir edição" : "Editar canais");
  const bulk = L.edit && L.group !== "__all" && L.group !== "__fav" ? [
    h("button", { onclick: () => { K.setHidden(list.map((c) => `ch:${c.key}`), true); bump(); render(); } }, "Ocultar todos do grupo"),
    h("button", { onclick: () => { K.setHidden(list.map((c) => `ch:${c.key}`), false); bump(); render(); } }, "Mostrar todos do grupo")] : [];
  const rows = page.map((sc) => {
    const q = sc.variants.length > 1 ? ` • ${sc.variants.length} versões` : "";
    return h("div", { class: `row ${sc.hidden ? "hid" : ""}`, tabindex: 0, role: "button", onclick: () => (L.edit ? toggleHide(sc) : playLive(sc)), onkeydown: (e) => { if (e.key === "Enter") (L.edit ? toggleHide(sc) : playLive(sc)); } },
      h("div", { class: "lg" }, sc.logo ? art(sc.logo, sc.name, "logo-art") : sc.name.charAt(0)),
      h("div", { class: "meta" }, h("b", {}, sc.name), h("span", { class: "dim small" }, `${sc.group}${q}${sc.hidden ? " • oculto" : ""}`)),
      h("div", { class: "acts" }, L.edit ? h("button", { onclick: (e) => { e.stopPropagation(); toggleHide(sc); } }, sc.hidden ? "Mostrar" : "Ocultar")
        : h("button", { "aria-label": "Favorito", onclick: (e) => { e.stopPropagation(); toggleFav(sc.key); render(); } }, isFav(sc.key) ? "★" : "☆")));
  });
  return h("div", {}, h("div", { class: "bar" }, h("h1", { style: "margin:0" }, "TV ao vivo"), h("div", { class: "grow" }), search, editBtn, bulk),
    h("div", { class: "split" },
      h("div", { class: "groups" }, groupBtn("__all", "Todos", v.channels.filter((c) => !c.hidden).length), groupBtn("__fav", "★ Favoritos", favs), names.map((n) => groupBtn(n, n, counts.get(n) || 0))),
      h("div", {}, h("div", { class: "chlist" }, rows.length ? rows : h("p", {}, G.loading ? "" : "Nenhum canal neste grupo.")),
        total > page.length ? h("div", { class: "bar", style: "margin-top:12px" }, h("button", { onclick: () => { L.shown += 300; render(); } }, `Mostrar mais (${total - page.length})`)) : null)));
}
function toggleHide(sc) { K.setHidden([`ch:${sc.key}`], !sc.hidden); bump(); render(); }

// ---------------------------------------------------------------- filmes e séries
function renderVod(kind) {
  if (!G.sources.length && !G.loading) return noSources();
  const st = V[kind], v = vis(), items = kind === "movies" ? v.movies : v.series, p = kind === "movies" ? "movie" : "series";
  const cats = C.applyOrder(K.setting(kind === "movies" ? "orderMovie" : "orderSeries", ""), [...new Set(items.map((i) => i.category))]);
  let list = st.cat === "__all" ? items : items.filter((i) => i.category === st.cat);
  if (st.q) { const q = C.fold(st.q); list = list.filter((i) => C.fold(i.name).includes(q)); }
  const sort = K.setting("sort_" + kind, "recent");
  list = [...list].sort(sort === "name" ? (a, b) => a.name.localeCompare(b.name, "pt-BR") : sort === "rating" ? (a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0) : (a, b) => b.added - a.added);
  const page = list.slice(0, st.shown);
  const search = h("input", { type: "search", placeholder: kind === "movies" ? "Buscar filme…" : "Buscar série…", value: st.q, oninput: (e) => { st.q = e.target.value; st.shown = 120; clearTimeout(st.t); st.t = setTimeout(() => { render(); const i = $("#view input[type=search]"); i?.focus(); i?.setSelectionRange(st.q.length, st.q.length); }, 250); } });
  const sel = h("select", { "aria-label": "Ordenar", style: "width:auto", onchange: (e) => { K.setSetting("sort_" + kind, e.target.value); render(); } },
    [["recent", "Mais recentes"], ["name", "Nome"], ["rating", "Nota"]].map(([val, lab]) => h("option", { value: val, selected: sort === val }, lab)));
  return h("div", {}, h("div", { class: "bar" }, h("h1", { style: "margin:0" }, kind === "movies" ? "Filmes" : "Séries"), h("div", { class: "grow" }), search, sel),
    h("div", { class: "chips" }, [["__all", "Todos"], ...cats.map((c) => [c, c])].map(([id, lab]) => h("button", { class: st.cat === id ? "on" : "", onclick: () => { st.cat = id; st.shown = 120; render(); } }, lab))),
    h("div", { class: "grid" }, page.map((i) => vodCard(i, kind === "movies" ? "movie" : "series"))),
    list.length > page.length ? h("div", { class: "bar", style: "margin-top:14px" }, h("button", { onclick: () => { st.shown += 240; render(); } }, `Mostrar mais (${list.length - page.length})`)) : (list.length ? null : h("p", {}, G.loading ? "" : "Nada encontrado.")));
}

// ---------------------------------------------------------------- detalhes
const dlg = $("#dlg");
function openDlg(...kids) { dlg.replaceChildren(...kids); if (!dlg.open) dlg.showModal(); }
const closeDlg = () => dlg.open && dlg.close();
dlg.addEventListener("click", (e) => { if (e.target === dlg) closeDlg(); });

async function movieDialog(m) {
  const src = G.byId[m.sid]; let plot = m.plot || "", genre = "", cast = "";
  const info = h("p", {}, plot || (src?.kind === "xtream" ? "Carregando detalhes…" : ""));
  const pr = pd().prog.find((p) => p.k === m.key);
  openDlg(h("div", { class: "detail" }, h("div", {}, m.poster ? h("img", { alt: "", "data-src": m.poster }) : null),
    h("div", {}, h("h3", {}, m.name), h("p", { class: "small" }, [m.year, m.category].filter(Boolean).join(" • ")), info,
      h("div", { class: "bar" },
        pr && !pr.done && pr.pos > 5000 ? h("button", { class: "primary", onclick: () => { closeDlg(); playMovie(m, true); } }, "Continuar") : null,
        h("button", { class: pr && !pr.done && pr.pos > 5000 ? "" : "primary", onclick: () => { closeDlg(); playMovie(m, false); } }, "Assistir"),
        h("button", { onclick: (e) => { toggleMy(m.key, "MOVIE"); e.target.textContent = inMy(m.key) ? "✓ Na minha lista" : "+ Minha lista"; } }, inMy(m.key) ? "✓ Na minha lista" : "+ Minha lista"),
        h("button", { onclick: closeDlg }, "Fechar")))));
  dlg.querySelectorAll("img[data-src]").forEach(loadImg);
  if (src?.kind === "xtream" && !m.plot) {
    try {
      const d = (await K.fetchJson(C.xtApi(src, "get_vod_info", `&vod_id=${m.remoteId}`))).info || {};
      plot = d.plot || d.description || ""; genre = d.genre || ""; cast = d.cast || d.actors || "";
      info.textContent = [plot, genre && `Gênero: ${genre}`, cast && `Elenco: ${cast}`].filter(Boolean).join("\n\n") || "Sem sinopse.";
      info.style.whiteSpace = "pre-wrap";
    } catch { info.textContent = ""; }
  }
}

async function seriesDialog(s) {
  const src = G.byId[s.sid]; let eps = [];
  const list = h("div", { class: "eps" }), seasons = h("div", { class: "chips" });
  const info = h("p", {}, s.plot || "");
  openDlg(h("div", { class: "detail" }, h("div", {}, s.poster ? h("img", { alt: "", "data-src": s.poster }) : null),
    h("div", {}, h("h3", {}, s.name), h("p", { class: "small" }, [s.year, s.category].filter(Boolean).join(" • ")), info,
      h("div", { class: "bar" }, h("button", { onclick: (e) => { toggleMy(s.key, "SERIES"); e.target.textContent = inMy(s.key) ? "✓ Na minha lista" : "+ Minha lista"; } }, inMy(s.key) ? "✓ Na minha lista" : "+ Minha lista"), h("button", { onclick: closeDlg }, "Fechar")))),
    seasons, list);
  dlg.querySelectorAll("img[data-src]").forEach(loadImg);
  list.append(h("p", {}, "Carregando episódios…"));
  try {
    if (src?.kind === "xtream") { const root = await K.fetchJson(C.xtApi(src, "get_series_info", `&series_id=${s.remoteId}`)); eps = C.loadXtreamEpisodes(s.sid, root); if (!s.plot && root.info?.plot) info.textContent = root.info.plot; }
    else eps = G.episodesM3u.filter((e) => e.seriesKey === s.key).sort((a, b) => a.season - b.season || a.number - b.number);
  } catch (e) { list.replaceChildren(h("p", { class: "err" }, "Não foi possível carregar os episódios.")); return; }
  if (!eps.length) { list.replaceChildren(h("p", {}, "Nenhum episódio encontrado.")); return; }
  const nums = [...new Set(eps.map((e) => e.season))];
  let cur = (pd().prog.filter((p) => p.sk === s.key).sort((a, b) => b.t - a.t)[0] && eps.find((e) => e.key === pd().prog.filter((p) => p.sk === s.key).sort((a, b) => b.t - a.t)[0].k)?.season) || nums[0];
  const draw = () => {
    seasons.replaceChildren(...nums.map((n) => h("button", { class: n === cur ? "on" : "", onclick: () => { cur = n; draw(); } }, `Temporada ${n}`)));
    list.replaceChildren(...eps.filter((e) => e.season === cur).map((e) => {
      const pr = pd().prog.find((p) => p.k === e.key);
      return h("div", { class: "row", tabindex: 0, role: "button", onclick: () => { closeDlg(); playEpisode(s, e, eps, !!(pr && !pr.done && pr.pos > 5000)); } },
        h("div", { class: "meta" }, h("b", {}, `${e.number}. ${e.title}`), h("span", { class: "dim small" }, pr ? (pr.done ? "Assistido" : `Parou em ${Math.round(pr.pos / 60000)} min`) : (e.duration ? `${Math.round(e.duration / 60)} min` : ""))));
    }));
  };
  draw();
}

// ---------------------------------------------------------------- pesquisa
const SQ = { q: "" };
function renderSearch() {
  const box = h("input", { type: "search", placeholder: "Pesquisar canais, filmes e séries…", value: SQ.q, autofocus: true, oninput: (e) => { SQ.q = e.target.value; clearTimeout(SQ.t); SQ.t = setTimeout(() => { render(); const i = $("#view input[type=search]"); i?.focus(); i?.setSelectionRange(SQ.q.length, SQ.q.length); }, 250); } });
  const out = [];
  if (SQ.q.trim().length >= 2) {
    const q = C.fold(SQ.q.trim()), v = vis();
    const ch = shownChannels().filter((c) => C.fold(c.name).includes(q)).slice(0, 40), mv = v.movies.filter((m) => C.fold(m.name).includes(q)).slice(0, 60), sr = v.series.filter((s) => C.fold(s.name).includes(q)).slice(0, 60);
    out.push(...rail(`Canais (${ch.length})`, ch.map((c) => chCard(c))), ...rail(`Filmes (${mv.length})`, mv.map((m) => vodCard(m, "movie"))), ...rail(`Séries (${sr.length})`, sr.map((s) => vodCard(s, "series"))));
    if (!out.length) out.push(h("p", {}, "Nada encontrado."));
  }
  return h("div", {}, h("h1", {}, "Pesquisa"), h("div", { class: "bar" }, box), out);
}

// ---------------------------------------------------------------- biblioteca
function renderLibrary() {
  const d = pd(), cont = d.prog.filter((p) => !p.done).slice(0, 40).map((p) => h("div", { class: "row", tabindex: 0, role: "button", onclick: () => resume(p) },
    h("div", { class: "meta" }, h("b", {}, p.title), h("span", { class: "dim small" }, p.dur ? `${Math.round((p.pos / p.dur) * 100)}% • ${new Date(p.t).toLocaleDateString("pt-BR")}` : "")),
    h("div", { class: "acts" }, h("button", { onclick: (e) => { e.stopPropagation(); d.prog = d.prog.filter((x) => x.k !== p.k); K.dirtyProfile(prof().id); render(); } }, "Remover"))));
  const favs = d.fav.map((f) => chByKey().get(f.k)).filter(Boolean).map((c) => chCard(c));
  const my = d.my.map((m) => (m.kind.toUpperCase() === "SERIES" ? seriesByKey().get(m.k) : movieByKey().get(m.k))).filter(Boolean).map((it) => vodCard(it, seriesByKey().has(it.key) ? "series" : "movie"));
  const hist = d.hist.map((x) => chByKey().get(x.k) || movieByKey().get(x.k)).filter(Boolean).slice(0, 30).map((it) => (it.variants ? chCard(it) : vodCard(it, "movie")));
  return h("div", {}, h("h1", {}, "Minha biblioteca"),
    cont.length ? [h("h2", {}, "Continuar assistindo"), h("div", { class: "chlist" }, cont)] : null,
    rail("Canais favoritos", favs), rail("Minha lista", my), rail("Assistido recentemente", hist),
    d.fav.length + d.my.length + d.prog.length + d.hist.length === 0 ? emptyNote("Seus favoritos, a lista e o ponto onde você parou aparecem aqui — e acompanham sua conta na TV.") : null);
}

// ---------------------------------------------------------------- player
const P = { hls: null, ts: null, cur: null, timer: 0, idle: 0, tick: 0 };
const video = $("#video");
function teardown() {
  clearInterval(P.timer); P.timer = 0;
  try { P.hls?.destroy(); } catch {} try { P.ts?.destroy(); } catch {}
  P.hls = P.ts = null; video.removeAttribute("src"); video.load();
}
function pmsg(text) { const m = $("#p-msg"); m.textContent = text || ""; m.hidden = !text; }
function openPlayer(title, sub) {
  $("#p-title").textContent = title; $("#p-sub").textContent = sub || ""; pmsg(""); $("#player").hidden = false; document.body.style.overflow = "hidden";
  const idleUp = () => { $("#player").classList.remove("idle"); clearTimeout(P.idle); P.idle = setTimeout(() => $("#player").classList.add("idle"), 3500); };
  $("#player").onmousemove = idleUp; $("#player").onkeydown = idleUp; idleUp();
}
async function closePlayer() {
  saveNow(); teardown(); P.cur = null; $("#player").hidden = true; document.body.style.overflow = ""; if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  K.flush();
}
$("#p-close").addEventListener("click", closePlayer);
addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#player").hidden && !document.fullscreenElement) closePlayer(); });

function saveNow() {
  const c = P.cur; if (!c || c.live || !isFinite(video.duration) || !video.duration) return;
  const pos = video.currentTime * 1000, dur = video.duration * 1000;
  saveProgress({ k: c.key, kind: c.kind, sk: c.sk || "", title: c.title, poster: c.poster || "", pos: Math.floor(pos), dur: Math.floor(dur), done: pos / dur > 0.93 });
}

/** Ao vivo: tenta HLS (.m3u8) pela variante escolhida; se falhar, MPEG-TS; depois passa para a próxima variante (failover). */
async function playLive(sc, idx = 0, mode = "hls", keep = false) {
  teardown(); P.recovered = false; P.cur = { live: true, key: sc.key, sc, idx };
  if (!keep) P.why = []; // motivos das tentativas, mostrados se tudo falhar
  const note = (m) => { P.why.push(`v${idx + 1}/${mode}: ${m}`); console.warn("[iptv]", P.why.at(-1)); };
  const v = sc.variants[idx], src = G.byId[v.sid];
  openPlayer(sc.name, `${v.group}`);
  const sel = $("#p-var"); sel.hidden = sc.variants.length < 2;
  sel.replaceChildren(...sc.variants.map((x, i) => h("option", { value: i, selected: i === idx }, C.variantLabel(x) + (i ? ` · alt ${i}` : ""))));
  sel.onchange = () => playLive(sc, Number(sel.value), "hls");
  const fav = $("#p-fav"); fav.hidden = false; fav.textContent = isFav(sc.key) ? "★" : "☆"; fav.onclick = () => { toggleFav(sc.key); fav.textContent = isFav(sc.key) ? "★" : "☆"; };
  addHist(sc.key);
  const fail = (why) => {
    if (P.cur?.sc !== sc || P.cur.idx !== idx) return;
    if (why) note(why);
    if (mode === "hls" && src?.kind === "xtream" && !v.url) return playLive(sc, idx, "ts", true);
    if (idx + 1 < sc.variants.length) { pmsg("Esta versão falhou. Tentando a próxima…"); return playLive(sc, idx + 1, "hls", true); }
    pmsg(`Não foi possível reproduzir este canal no navegador. Tente na TV ou outra versão.\n\nDetalhes técnicos (me envie isto):\n${P.why.slice(-6).join("\n")}`);
  };
  try {
    pmsg("Conectando…");
    const url = C.liveUrl(src, v, mode === "ts" ? "ts" : "m3u8");
    const media = await K.proxied(url);
    // sondagem: se o provedor recusar, mostra o status e o começo da resposta (sem a senha)
    { const ctl = new AbortController();
      try {
        const pr = await fetch(media, { signal: ctl.signal, cache: "no-store" });
        if (!pr.ok) { const body = (await pr.text()).replace(/\s+/g, " ").slice(0, 160); note(`sondagem: provedor respondeu HTTP ${pr.status} ${body ? `"${body}"` : "(sem texto)"}`); return fail(`HTTP ${pr.status}`); }
        else note(`sondagem: HTTP ${pr.status} ${pr.headers.get("content-type") || ""}`);
      } catch (e) { note(`sondagem: falha de rede (${e.message})`); } finally { ctl.abort(); } }
    const isHls = mode === "hls" && (!v.url || /\.m3u8(\?|$)/i.test(v.url));
    if (isHls && window.Hls?.isSupported()) {
      const hls = new Hls({ lowLatencyMode: false, maxBufferLength: 20 }); P.hls = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => { pmsg(""); video.play().catch(() => {}); });
      hls.on(Hls.Events.ERROR, (_, d) => {
        const code = d.response?.code ?? d.networkDetails?.status ?? "";
        const info = `${d.type}/${d.details}${code ? ` HTTP ${code}` : ""}${d.fatal ? " (fatal)" : ""}`;
        if (!d.fatal) { console.warn("[iptv] hls", info); return; }
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR && !P.recovered) { P.recovered = true; note(info + " → tentando recuperar"); hls.recoverMediaError(); return; }
        fail(info);
      });
      hls.loadSource(media); hls.attachMedia(video);
    } else if (isHls && video.canPlayType("application/vnd.apple.mpegurl")) { video.src = media; video.onloadeddata = () => pmsg(""); video.onerror = () => fail(`erro nativo ${video.error?.code || ""}`); }
    else if (window.mpegts?.isSupported()) {
      const ts = mpegts.createPlayer({ type: "mpegts", isLive: true, url: media }); P.ts = ts;
      ts.on(mpegts.Events.ERROR, (type, detail, extra) => fail(`${type}/${detail}${extra?.code ? ` HTTP ${extra.code}` : ""}${extra?.msg ? ` ${extra.msg}` : ""}`)); ts.attachMediaElement(video); ts.load(); ts.play().then(() => pmsg("")).catch(() => {});
    } else { video.src = media; video.onerror = () => fail(`erro nativo ${video.error?.code || ""}`); }
    video.onplaying = () => pmsg("");
    loadNowNext(sc, v, src);
  } catch (e) { note(e.message || "erro ao preparar"); pmsg(e.message || "Não foi possível abrir o canal."); }
}
async function loadNowNext(sc, v, src) {
  if (src?.kind !== "xtream" || !v.streamId) return;
  try {
    const d = await K.fetchJson(C.xtApi(src, "get_short_epg", `&stream_id=${v.streamId}&limit=2`));
    const dec = (b) => { try { return new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0))); } catch { return b; } };
    const l = (d.epg_listings || []).map((x) => dec(x.title)); if (P.cur?.sc === sc && l.length) $("#p-sub").textContent = `Agora: ${l[0]}${l[1] ? `  •  A seguir: ${l[1]}` : ""}`;
  } catch { /* guia opcional */ }
}

async function playVod(item, url, meta, startMs, queue) {
  teardown(); P.cur = { live: false, ...meta, queue };
  openPlayer(meta.title, ""); $("#p-var").hidden = true; $("#p-fav").hidden = true;
  addHist(meta.key); pmsg("Conectando…");
  try {
    video.src = await K.proxied(url);
    video.onloadedmetadata = () => { if (startMs > 0) video.currentTime = Math.max(0, startMs / 1000 - 3); };
    video.onplaying = () => pmsg("");
    video.onerror = () => pmsg("O navegador não consegue reproduzir este arquivo (formato ou codec). Tente na TV.");
    video.onended = () => { saveNow(); const q = P.cur?.queue; if (q && K.setting("nextEp", true)) { const next = q(); if (next) next(); } };
    await video.play().catch(() => {});
    P.timer = setInterval(saveNow, 15000);
  } catch (e) { pmsg(e.message); }
}
function playMovie(m, resumeIt) {
  const src = G.byId[m.sid], pr = pd().prog.find((p) => p.k === m.key);
  playVod(m, C.movieUrl(src, m), { key: m.key, kind: "MOVIE", title: m.name, poster: m.poster }, resumeIt && pr ? pr.pos : 0);
}
function playEpisode(s, e, all, resumeIt) {
  const src = G.byId[e.sid], pr = pd().prog.find((p) => p.k === e.key), i = all.indexOf(e), nxt = all[i + 1];
  playVod(e, C.episodeUrl(src, e), { key: e.key, kind: "EPISODE", sk: s.key, title: `${s.name} • T${e.season}E${e.number} ${e.title}`, poster: s.poster },
    resumeIt && pr ? pr.pos : 0, nxt ? () => () => playEpisode(s, nxt, all, false) : null);
}
async function resume(p) {
  const m = movieByKey().get(p.k);
  if (m) return playMovie(m, true);
  const sc = chByKey().get(p.k); if (sc) return playLive(sc);
  const s = seriesByKey().get(p.sk);
  if (s) { toast("Abrindo série…"); return seriesDialog(s); }
  toast("Este conteúdo não está mais nas suas listas.");
}

// ---------------------------------------------------------------- configurações
const SET = { tab: "lists" };
function renderSettings() {
  const tabs = [["lists", "Listas"], ["profiles", "Perfis"], ["content", "Conteúdo exibido"], ["prefs", "Preferências"], ["tv", "Conectar TV"], ["account", "Conta"]];
  const body = { lists: setLists, profiles: setProfiles, content: setContent, prefs: setPrefs, tv: setTv, account: setAccount }[SET.tab]();
  return h("div", {}, h("h1", {}, "Configurações"), h("div", { class: "tabs" }, tabs.map(([id, lab]) => h("button", { class: SET.tab === id ? "on" : "", onclick: () => { SET.tab = id; render(); } }, lab))), body);
}
const toggleRow = (label, on, fn, hint) => h("label", { class: "toggle", style: "margin:0;color:var(--text);font-size:15px" }, h("span", {}, label, hint ? h("div", { class: "dim small" }, hint) : null), h("input", { type: "checkbox", checked: on, onchange: (e) => fn(e.target.checked) }));

function setLists() {
  const items = G.sources.map((s) => h("div", { class: "item" }, h("div", { class: "ic" }, s.kind === "m3u" ? "M3U" : "XC"),
    h("div", { class: "meta" }, h("strong", {}, s.name), h("span", { class: "dim small" }, s.kind === "m3u" ? "Link M3U • privada" : "Xtream Codes • privada")),
    h("button", { onclick: () => sourceDialog(s) }, "Editar"), h("button", { class: "danger", onclick: () => removeSource(s) }, "Excluir")));
  return h("div", {}, h("div", { class: "panel" }, h("div", { class: "bar" }, h("h3", {}, "Minhas listas"), h("div", { class: "grow" }),
    h("button", { onclick: () => loadCatalogs(true) }, "Atualizar catálogos"), h("button", { class: "primary", onclick: () => sourceDialog(null) }, "Nova lista")),
    items.length ? items : h("p", {}, "Nenhuma lista ainda. Suas listas ficam salvas só na sua conta (regras do Firestore: somente você lê e grava)."),
    h("p", { class: "small" }, "Usuário e senha ficam no Firebase, protegidos pela sua conta. Aqui no navegador, o acesso à lista passa por um serviço seu (Cloudflare Worker) que só funciona para o seu e-mail.")));
}
function httpUrl(v, label, base) {
  let u; try { u = new URL(v.trim()); } catch { throw new Error(`Informe uma URL válida para ${label}.`); }
  if (!["http:", "https:"].includes(u.protocol)) throw new Error(`${label} precisa começar com http:// ou https://.`);
  if (u.username || u.password) throw new Error(`Remova usuário e senha embutidos da URL de ${label}.`);
  if (base && (u.search || u.hash)) throw new Error("Use só o endereço do servidor, sem parâmetros.");
  return u;
}
function sourceDialog(s) {
  const f = (id, label, val, type = "text") => [h("label", { for: id }, label), h("input", { id, type, value: val || "", autocomplete: "off" })];
  const kind = h("select", { id: "f-kind", onchange: () => fields() }, h("option", { value: "xtream", selected: (s?.kind || "xtream") === "xtream" }, "Xtream Codes (servidor, usuário e senha)"), h("option", { value: "m3u", selected: s?.kind === "m3u" }, "Link M3U"));
  const x = h("div", {}, f("f-server", "Servidor (ex.: http://servidor.com:8080)", s?.serverUrl), f("f-user", "Usuário", s?.username), f("f-pass", "Senha", s?.password, "password"));
  const m = h("div", {}, f("f-m3u", "Link da lista M3U", s?.m3uUrl));
  const fields = () => { x.hidden = kind.value === "m3u"; m.hidden = kind.value !== "m3u"; }; fields();
  const err = h("p", { class: "err", hidden: true });
  const save = h("button", { class: "primary", onclick: async () => {
    try {
      const name = $("#f-name").value.trim(); if (!name) throw new Error("Dê um nome para a lista.");
      const v = kind.value === "m3u" ? { name, kind: "m3u", m3uUrl: httpUrl($("#f-m3u").value, "a lista M3U", false).toString() }
        : (() => { const u = httpUrl($("#f-server").value, "o servidor", true), username = $("#f-user").value.trim(), password = $("#f-pass").value; if (!username || !password) throw new Error("Preencha usuário e senha."); return { name, kind: "xtream", serverUrl: u.toString().replace(/\/$/, ""), username, password }; })();
      save.disabled = true; await K.saveSource(v, s); closeDlg(); await loadSources(); await idb.clear(); toast("Lista salva."); await loadCatalogs(true);
    } catch (e) { err.textContent = e.message || "Não foi possível salvar."; err.hidden = false; save.disabled = false; }
  } }, "Salvar");
  openDlg(h("h3", {}, s ? "Editar lista" : "Nova lista"), ...f("f-name", "Nome", s?.name), h("label", { for: "f-kind" }, "Tipo"), kind, x, m, err, h("div", { class: "bar", style: "margin-top:16px" }, save, h("button", { onclick: closeDlg }, "Cancelar")));
}
async function removeSource(s) {
  if (!confirm(`Excluir “${s.name}”? Isso não pode ser desfeito.`)) return;
  try { await K.deleteSource(s.id); await idb.del(`cat:${s.id}`); await loadSources(); await loadCatalogs(); toast("Lista excluída."); } catch { toast("Não foi possível excluir."); }
}

function setProfiles() {
  const rows = K.S.profiles.map((p) => h("div", { class: "item" }, h("span", { class: "av" }, p.name.charAt(0).toUpperCase()),
    h("div", { class: "meta" }, h("strong", {}, p.name), h("span", { class: "dim small" }, `${p.kid ? "Infantil" : "Adulto"}${p.pinHash ? " • com PIN" : ""}${p.id === prof().id ? " • perfil atual" : ""}`)),
    h("button", { onclick: () => profileDialog(p) }, "Editar"), K.S.profiles.length > 1 ? h("button", { class: "danger", onclick: () => { if (confirm(`Excluir o perfil “${p.name}”? Favoritos, lista e histórico dele serão apagados.`)) { K.removeProfile(p.id); if (p.id === prof().id) G.profile = K.S.profiles[0]; bump(); render(); } } }, "Excluir") : null));
  return h("div", { class: "panel" }, h("div", { class: "bar" }, h("h3", {}, "Perfis da conta"), h("div", { class: "grow" }), h("button", { class: "primary", onclick: () => profileDialog(null) }, "Novo perfil")), rows,
    h("p", { class: "small" }, "Cada perfil tem seus próprios favoritos, Minha Lista e histórico. Os perfis são os mesmos na TV."));
}
function profileDialog(p) {
  const name = h("input", { id: "pf-name", value: p?.name || "", maxlength: 40 }), kid = h("input", { type: "checkbox", checked: !!p?.kid }), pin = h("input", { type: "password", inputmode: "numeric", maxlength: 8, placeholder: p?.pinHash ? "Deixe em branco para manter" : "Opcional (4 a 8 dígitos)" });
  const rm = h("input", { type: "checkbox" });
  openDlg(h("h3", {}, p ? "Editar perfil" : "Novo perfil"), h("label", { for: "pf-name" }, "Nome"), name,
    h("label", { class: "toggle", style: "color:var(--text)" }, "Perfil infantil (esconde conteúdo adulto)", kid),
    h("label", {}, "PIN do perfil"), pin, p?.pinHash ? h("label", { class: "toggle", style: "color:var(--text)" }, "Remover o PIN", rm) : null,
    h("div", { class: "bar", style: "margin-top:16px" }, h("button", { class: "primary", onclick: async () => {
      const n = name.value.trim() || "Perfil";
      if (pin.value && !/^\d{4,8}$/.test(pin.value)) return toast("O PIN deve ter de 4 a 8 números.");
      const t = p || K.newProfile(n, kid.checked); t.name = n; t.kid = kid.checked;
      if (rm.checked) { t.pinHash = ""; t.pinSalt = ""; } else if (pin.value) { t.pinSalt = C.newSalt(); t.pinHash = await C.pinHash(pin.value, t.pinSalt); }
      K.markDirty("profiles"); closeDlg(); bump(); render();
    } }, "Salvar"), h("button", { onclick: closeDlg }, "Cancelar")));
}

const CT = { kind: "live" };
function setContent() {
  const kinds = [["live", "Canais"], ["movie", "Filmes"], ["series", "Séries"]], k = CT.kind, hid = K.hiddenSet();
  const raw = k === "live" ? G.smart.map((c) => c.group) : (k === "movie" ? G.movies : G.series).map((i) => i.category);
  const names = C.applyOrder(K.setting(k === "live" ? "orderLive" : k === "movie" ? "orderMovie" : "orderSeries", ""), [...new Set(raw)]);
  const ok = k === "live" ? "orderLive" : k === "movie" ? "orderMovie" : "orderSeries";
  const move = (n, a) => { K.setSetting(ok, C.moveInOrder(K.setting(ok, ""), [...new Set(raw)], n, a)); render(); };
  return h("div", { class: "panel" }, h("div", { class: "tabs" }, kinds.map(([id, lab]) => h("button", { class: k === id ? "on" : "", onclick: () => { CT.kind = id; render(); } }, lab))),
    h("div", { class: "bar" }, h("button", { onclick: () => { K.setHidden(names.map((n) => `${k}:${n}`), true); bump(); render(); } }, "Ocultar todos"), h("button", { onclick: () => { K.setHidden(names.map((n) => `${k}:${n}`), false); bump(); render(); } }, "Mostrar todos")),
    names.length ? names.map((n, i) => h("div", { class: "toggle" }, h("label", { style: "display:flex;gap:10px;align-items:center;margin:0;color:var(--text);font-size:15px;flex:1" }, h("input", { type: "checkbox", style: "width:auto", checked: !hid.has(`${k}:${n}`), onchange: (e) => { K.setHidden([`${k}:${n}`], !e.target.checked); bump(); } }), n),
      h("span", { class: "acts" }, h("button", { disabled: i === 0, onclick: () => move(n, "up"), "aria-label": "Subir" }, "↑"), h("button", { disabled: i === names.length - 1, onclick: () => move(n, "down"), "aria-label": "Descer" }, "↓")))) : h("p", {}, "Carregue uma lista para ver os grupos."),
    h("p", { class: "small" }, "A ordem e os itens ocultos são os mesmos na TV. Para ocultar canais individuais, use TV ao vivo → Editar canais."));
}
function setPrefs() {
  const idx = Number(K.setting("accent", 0));
  return h("div", { class: "panel" },
    h("label", {}, "Cor de destaque"), h("div", { class: "chips" }, ACCENTS.map(([n, c], i) => h("button", { class: idx === i ? "on" : "", onclick: () => { K.setSetting("accent", i); applyAccent(); render(); } }, n))),
    toggleRow("Ocultar conteúdo 4K", K.setting("hide4k", true), (v) => { K.setSetting("hide4k", v); bump(); render(); }, "A maioria dos aparelhos e navegadores não reproduz 4K/HEVC bem."),
    toggleRow("Próximo episódio automático", K.setting("nextEp", true), (v) => K.setSetting("nextEp", v)),
    toggleRow("Qualidade automática (failover)", K.setting("autoQuality", true), (v) => K.setSetting("autoQuality", v), "Se uma versão do canal falhar, tenta a seguinte."),
    h("p", { class: "small" }, "Estas preferências acompanham sua conta (TV e navegador)."));
}
function setTv() {
  return h("div", { class: "panel" }, h("h3", {}, "Conectar uma TV"),
    h("p", {}, "Na TV: Configurações → Conta Google e sincronização → Entrar com Google. Leia o QR code com o celular (ou digite o código aqui) e escolha “Entrar na TV com minha conta”. A TV passa a ter suas listas, perfis, ocultos, ordem, favoritos e histórico."),
    h("button", { class: "primary", onclick: () => document.dispatchEvent(new Event("iptv:pair")) }, "Digitar o código da TV"));
}
function setAccount() {
  const u = K.user;
  return h("div", { class: "panel" }, h("h3", {}, u?.displayName || "Conta Google"), h("p", {}, u?.email || ""),
    h("div", { class: "bar" }, h("button", { onclick: async () => { await K.flush(); await K.pull(); bump(); render(); toast("Sincronizado."); } }, "Sincronizar agora"),
      h("button", { onclick: async () => { await K.flush(); await K.logout(); location.reload(); } }, "Sair")));
}

// ---------------------------------------------------------------- perfil e inicialização
function applyAccent() { document.documentElement.style.setProperty("--accent", (ACCENTS[Number(K.setting("accent", 0))] || ACCENTS[0])[1]); }
function chooseProfile() {
  return new Promise((resolve) => {
    const profiles = K.S.profiles, remembered = (() => { try { return sessionStorage.getItem("iptv-profile"); } catch { return null; } })();
    const pick = (p) => { G.profile = p; try { sessionStorage.setItem("iptv-profile", p.id); } catch {} closeDlg(); dlg.oncancel = null; resolve(); };
    const ask = async (p) => {
      if (!p.pinHash) return pick(p);
      const inp = h("input", { type: "password", inputmode: "numeric", maxlength: 8, autofocus: true }), err = h("p", { class: "err", hidden: true });
      const check = async () => { if ((await C.pinHash(inp.value, p.pinSalt)) === p.pinHash) pick(p); else { err.textContent = "PIN incorreto."; err.hidden = false; inp.value = ""; } };
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") check(); });
      openDlg(h("h3", {}, `PIN de ${p.name}`), inp, err, h("div", { class: "bar", style: "margin-top:14px" }, h("button", { class: "primary", onclick: check }, "Entrar"), h("button", { onclick: () => list() }, "Voltar")));
      inp.focus();
    };
    const list = () => { openDlg(h("h3", {}, "Quem está assistindo?"), h("div", { class: "chlist", style: "margin-top:12px" }, profiles.map((p) => h("div", { class: "row", tabindex: 0, role: "button", onclick: () => ask(p), onkeydown: (e) => e.key === "Enter" && ask(p) }, h("span", { class: "av" }, p.name.charAt(0).toUpperCase()), h("div", { class: "meta" }, h("b", {}, p.name), h("span", { class: "dim small" }, p.kid ? "Infantil" : "Adulto")))))); dlg.oncancel = (e) => e.preventDefault(); };
    const last = profiles.find((p) => p.id === remembered);
    if (last && !last.pinHash) pick(last); else if (profiles.length === 1 && !profiles[0].pinHash) pick(profiles[0]); else list();
  });
}
$("#who").addEventListener("click", async () => { await chooseProfile(); bump(); render(); });
document.querySelectorAll("#nav button[data-v]").forEach((b) => b.addEventListener("click", () => go(b.dataset.v)));
$("#signin").addEventListener("click", async () => { try { await K.login(); } catch (e) { const el = $("#gate-err"); el.textContent = e.message; el.hidden = false; } });

K.onStatus((s) => {
  const el = $("#syncline"); if (!el) return;
  if (s.error) el.textContent = s.error; else if (s.pending) el.textContent = "Alterações pendentes…"; else if (s.ok) el.textContent = `Sincronizado ${new Date(s.ok).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
});

let started = false;
K.initCloud(async (u, state) => {
  $("#boot").hidden = true;
  if (!u) { $("#app").hidden = true; $("#gate").hidden = false; if (state === "not_configured") { $("#setup-banner").hidden = false; $("#signin").disabled = true; } return; }
  $("#gate").hidden = true;
  if (started) return; started = true;
  try { await K.pull(); } catch (e) { toast("Não foi possível ler a sincronização. As regras novas do Firestore já foram publicadas?"); K.S.profiles.length || K.S.profiles.push({ id: "local", name: "Principal", color: 0, kid: false, pinHash: "", pinSalt: "" }); }
  applyAccent();
  await chooseProfile();
  $("#app").hidden = false;
  K.setOnChange(() => { applyAccent(); if (!G.profile || !K.S.profiles.some((p) => p.id === G.profile.id)) G.profile = K.S.profiles[0]; else G.profile = K.S.profiles.find((p) => p.id === G.profile.id); bump(); render(); });
  try { await loadSources(); } catch { toast("Não foi possível carregar suas listas."); }
  render();
  await loadCatalogs();
  setInterval(() => { if (document.visibilityState === "visible" && $("#player").hidden) K.pull().catch(() => {}); }, 90000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") K.pull().catch(() => {}); });
});
