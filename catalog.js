// Catálogo do IPTV Premium (versão navegador). Lógica pura, sem DOM: espelha o que o app da TV faz
// (nomes-base, qualidade, canais inteligentes, ordem de grupos, chaves de conteúdo) para que favoritos,
// ocultos e histórico sincronizados pela conta Google valham nos dois lugares.

const DIACRITICS = /\p{M}+/gu;
const QUALITY_TOKEN = /\b(uhd|4k|fhd|fullhd|full hd|hd|sd|2160p|1080p|1080i|720p|576p|480p|h\.?265|h\.?264|hevc|x265|x264|[56]0\s?fps|fps|backup|bkp|reserva|alt|alternativo|raw)\b/g;
const NON_WORD = /[^a-z0-9&+ ]+/g;
const BRACKET = /[\[\(\{]([^\]\)\}]*)[\]\)\}]/g;
const R4K = /\b(4k|uhd|2160p?)\b/, RFHD = /\b(fhd|fullhd|full hd|1080[pi]?)\b/, RHD = /\b(hd|720p?)\b/, RSD = /\b(sd|576p?|480p?)\b/;
const R60 = /\b[56]0\s?fps\b/, RHEVC = /\b(hevc|h\.?265|x265)\b/, RBACKUP = /\b(backup|bkp|reserva|alt|alternativo)\b/;
const DISPLAY_TAGS = /\b(uhd|4k|fhd|fullhd|hd|sd|h\.?265|hevc|backup)\b/gi;
export const F_60FPS = 1, F_HEVC = 2, F_BACKUP = 4;

export const fold = (s) => String(s ?? "").normalize("NFD").replace(DIACRITICS, "").toLowerCase();

export function baseName(name) {
  let s = fold(name);
  s = s.replace(BRACKET, (_, inner) => inner.replace(QUALITY_TOKEN, " ").replace(NON_WORD, " ").trim());
  s = s.replace(QUALITY_TOKEN, " ").replace(NON_WORD, " ");
  return s.replace(/\s+/g, " ").trim();
}

export function parseName(name) {
  const low = fold(name);
  const rank = R4K.test(low) ? 4 : RFHD.test(low) ? 3 : RHD.test(low) ? 2 : RSD.test(low) ? 1 : 0;
  let flags = 0;
  if (R60.test(low)) flags |= F_60FPS;
  if (RHEVC.test(low)) flags |= F_HEVC;
  if (RBACKUP.test(low)) flags |= F_BACKUP;
  return { base: baseName(name), rank, flags };
}

export function displayName(name) {
  let s = String(name).replace(BRACKET, (m, inner) => {
    const rest = fold(inner).replace(QUALITY_TOKEN, " ").replace(NON_WORD, " ").trim();
    return rest ? inner : "";
  });
  s = s.replace(DISPLAY_TAGS, " ").replace(/\s+/g, " ").trim().replace(/^[-|: ]+|[-|: ]+$/g, "");
  return s || String(name);
}

export const qualityLabel = (r) => (r === 4 ? "4K" : r === 3 ? "FHD" : r === 2 ? "HD" : r === 1 ? "SD" : "");
export function variantLabel(c) {
  const parts = [];
  const q = qualityLabel(c.rank); if (q) parts.push(q);
  if (c.flags & F_60FPS) parts.push("60 FPS");
  if (c.flags & F_HEVC) parts.push("HEVC");
  if (c.flags & F_BACKUP) parts.push("Backup");
  return parts.length ? parts.join(" ") : "Padrão";
}

/** Agrupa variantes do mesmo canal (mesma fonte + nome-base + grupo-base), como o SmartGrouper da TV. */
export function groupChannels(channels) {
  const buckets = new Map(), singles = [], order = new Map();
  channels.forEach((c, i) => {
    const base = c.base || baseName(c.name);
    if (!base) { singles.push([i, merge([c])]); return; }
    const key = `${c.sid}|${base}|${baseName(c.group)}`;
    if (!order.has(key)) order.set(key, i);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(c);
  });
  const out = [];
  for (const [key, list] of buckets) out.push([order.get(key), merge(list)]);
  out.push(...singles);
  return out.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
}

function merge(list) {
  const sorted = [...list].sort((a, b) => ((a.flags & F_BACKUP) ? 1 : 0) - ((b.flags & F_BACKUP) ? 1 : 0) || b.rank - a.rank || a.num - b.num);
  const p = sorted[0];
  const name = list.map((c) => displayName(c.name)).reduce((m, n) => (n.length < m.length ? n : m));
  const lead = list.reduce((m, c) => (c.num < m.num ? c : m));
  return {
    key: lead.key, name, logo: (list.find((c) => c.logo) || {}).logo || "", group: p.group,
    tvgId: (sorted.find((c) => c.tvgId) || {}).tvgId || "", tvgIds: [...new Set(sorted.map((c) => c.tvgId).filter(Boolean))],
    variants: sorted,
  };
}

// ---------------------------------------------------------------- ordem de grupos (igual ao GroupOrder do app)
const SEP = "\u001f";
export function applyOrder(saved, names) {
  if (!saved) return names;
  const present = new Set(names);
  const ordered = [...new Set(saved.split(SEP).filter((x) => x && present.has(x)))];
  const used = new Set(ordered);
  return [...ordered, ...names.filter((n) => !used.has(n))];
}
export function moveInOrder(saved, names, name, action) {
  const l = applyOrder(saved, names); const i = l.indexOf(name);
  if (i < 0) return saved;
  l.splice(i, 1);
  const to = action === "top" ? 0 : action === "bottom" ? l.length : action === "up" ? Math.max(i - 1, 0) : Math.min(i + 1, l.length);
  l.splice(to, 0, name);
  return l.join(SEP);
}

// ---------------------------------------------------------------- SHA-1 síncrono (chaves de M3U: 8 primeiros bytes em hexadecimal)
export function sha8(str) {
  const bytes = new TextEncoder().encode(str);
  const ml = bytes.length * 8, padLen = ((bytes.length + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(padLen); buf.set(bytes); buf[bytes.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(padLen - 8, Math.floor(ml / 2 ** 32)); dv.setUint32(padLen - 4, ml >>> 0);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80), rol = (x, n) => (x << n) | (x >>> (32 - n));
  for (let o = 0; o < padLen; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      const [f, k] = i < 20 ? [(b & c) | (~b & d), 0x5a827999] : i < 40 ? [b ^ c ^ d, 0x6ed9eba1] : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
      const t = (rol(a, 5) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = rol(b, 30) >>> 0; b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2].map((x) => x.toString(16).padStart(8, "0")).join("").slice(0, 16);
}

// ---------------------------------------------------------------- URLs Xtream
export const xtBase = (server) => { const s = String(server).trim().replace(/\/+$/, ""); return /^https?:\/\//i.test(s) ? s : `http://${s}`; };
export const xtApi = (src, action = "", extra = "") =>
  `${xtBase(src.serverUrl)}/player_api.php?username=${encodeURIComponent(src.username)}&password=${encodeURIComponent(src.password)}${action ? `&action=${action}` : ""}${extra}`;
export const liveUrl = (src, c, ext = "m3u8") => c.url || `${xtBase(src.serverUrl)}/live/${src.username}/${src.password}/${c.streamId}.${ext}`;
export const movieUrl = (src, m) => m.url || `${xtBase(src.serverUrl)}/movie/${src.username}/${src.password}/${m.remoteId}.${m.ext}`;
export const episodeUrl = (src, e) => e.url || `${xtBase(src.serverUrl)}/series/${src.username}/${src.password}/${e.remoteId}.${e.ext}`;

const str = (v) => (v === null || v === undefined ? "" : String(v));
const firstOf = (v) => (Array.isArray(v) ? str(v[0]) : str(v));

/** Catálogo de uma fonte Xtream. `getJson(url)` devolve o JSON (via proxy do site). */
export async function loadXtream(src, getJson, progress = () => {}) {
  const sid = src.id;
  progress("Autenticando…");
  const auth = await getJson(xtApi(src));
  if (!auth?.user_info || Number(auth.user_info.auth) !== 1) throw new Error("A autenticação falhou. Confira usuário e senha da lista.");
  const cats = async (action) => { try { const a = await getJson(xtApi(src, action)); return Object.fromEntries((a || []).map((c) => [str(c.category_id), str(c.category_name)])); } catch { return {}; } };
  const out = { channels: [], movies: [], series: [], info: auth.user_info, warnings: [] };
  progress("Baixando canais ao vivo…");
  const lc = await cats("get_live_categories");
  const live = await getJson(xtApi(src, "get_live_streams"));
  (live || []).forEach((o, i) => {
    const id = str(o.stream_id); if (!id) return;
    const name = str(o.name), p = parseName(name);
    out.channels.push({ key: `@${sid}:${id}`, sid, num: Number(o.num) || i + 1, name, logo: str(o.stream_icon), group: lc[str(o.category_id)] || "Sem grupo",
      tvgId: str(o.epg_channel_id), streamId: id, url: "", base: p.base, rank: p.rank, flags: p.flags });
  });
  try {
    progress("Baixando filmes…");
    const vc = await cats("get_vod_categories");
    const vod = await getJson(xtApi(src, "get_vod_streams"));
    for (const o of vod || []) {
      const id = str(o.stream_id); if (!id) continue;
      out.movies.push({ key: `m:@${sid}:${id}`, sid, remoteId: id, name: str(o.name), poster: str(o.stream_icon), rating: str(o.rating), year: str(o.year),
        category: vc[str(o.category_id)] || "Sem categoria", ext: str(o.container_extension) || "mp4", added: (Number(o.added) || 0) * 1000 });
    }
  } catch { out.warnings.push("Filmes indisponíveis nesta lista"); }
  try {
    progress("Baixando séries…");
    const sc = await cats("get_series_categories");
    const ser = await getJson(xtApi(src, "get_series"));
    for (const o of ser || []) {
      const id = str(o.series_id); if (!id) continue;
      out.series.push({ key: `s:@${sid}:${id}`, sid, remoteId: id, name: str(o.name), poster: str(o.cover), backdrop: firstOf(o.backdrop_path), plot: str(o.plot),
        genre: str(o.genre), year: (str(o.releaseDate) || str(o.release_date)).slice(0, 4), rating: str(o.rating),
        category: sc[str(o.category_id)] || "Sem categoria", added: (Number(o.last_modified) || 0) * 1000 });
    }
  } catch { out.warnings.push("Séries indisponíveis nesta lista"); }
  return out;
}

export function loadXtreamEpisodes(sid, info) {
  const eps = [];
  for (const [season, arr] of Object.entries(info?.episodes || {})) {
    (arr || []).forEach((o, i) => {
      const id = str(o.id); if (!id) return;
      eps.push({ key: `e:@${sid}:${id}`, sid, remoteId: id, season: Number(o.season) || Number(season) || 1, number: Number(o.episode_num) || i + 1,
        title: str(o.title) || `Episódio ${i + 1}`, plot: str(o.info?.plot), thumb: str(o.info?.movie_image), duration: Number(o.info?.duration_secs) || 0,
        ext: str(o.container_extension) || "mp4" });
    });
  }
  return eps.sort((a, b) => a.season - b.season || a.number - b.number);
}

// ---------------------------------------------------------------- M3U
const ATTR = /([\w-]+)\s*=\s*"([^"]*)"/g;
const SCHEMES = ["http://", "https://", "rtmp://", "rtsp://", "udp://", "rtp://", "mms://"];
export function parseM3u(text) {
  const entries = []; let epg = "", saw = false, attrs = {}, name = null, group = "";
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim().replace(/^﻿/, "");
    if (!line) continue;
    if (/^#EXTM3U/i.test(line)) { saw = true; const a = Object.fromEntries([...line.matchAll(ATTR)].map((m) => [m[1].toLowerCase(), m[2]])); epg = a["url-tvg"] || a["x-tvg-url"] || a["tvg-url"] || ""; }
    else if (/^#EXTINF/i.test(line)) { saw = true; attrs = Object.fromEntries([...line.matchAll(ATTR)].map((m) => [m[1].toLowerCase(), m[2]])); name = (line.includes(",") ? line.slice(line.indexOf(",") + 1) : "").trim() || attrs["tvg-name"] || ""; group = attrs["group-title"] || ""; }
    else if (/^#EXTGRP:/i.test(line)) { if (!group) group = line.slice(line.indexOf(":") + 1).trim(); }
    else if (line.startsWith("#")) continue;
    else {
      const url = line.split("|")[0].trim();
      if (SCHEMES.some((s) => url.toLowerCase().startsWith(s))) {
        entries.push({ name: (name || attrs["tvg-name"] || url.split("/").pop()), url, group, logo: attrs["tvg-logo"] || "", tvgId: attrs["tvg-id"] || "",
          chno: Number(attrs["tvg-chno"]) || null });
      }
      name = null; attrs = {}; group = "";
    }
  }
  return { entries, epg, saw };
}

const SERIES_EP = /^(.*?)[\s._-]*s(\d{1,2})\s?e(\d{1,3})\b(.*)$/i;
export function loadM3u(src, text) {
  const { entries, saw } = parseM3u(text);
  if (!saw || !entries.length) throw new Error("A resposta não parece uma lista M3U válida.");
  const sid = src.id, out = { channels: [], movies: [], series: [], episodes: [], warnings: [] }, seriesByName = new Map();
  let seq = 0;
  for (const e of entries) {
    if (e.url.includes("/movie/")) {
      const y = (e.name.match(/\((\d{4})\)/) || [])[1] || "";
      out.movies.push({ key: `mm:@${sid}:${sha8(e.url)}`, sid, remoteId: sha8(e.url), name: e.name.replace(/\s*\(\d{4}\)\s*/g, " ").trim(), poster: e.logo, year: y,
        rating: "", category: e.group || "Sem categoria", ext: (e.url.split(".").pop() || "mp4").slice(0, 4), url: e.url, added: Date.now() - out.movies.length });
    } else if (e.url.includes("/series/") || (SERIES_EP.test(e.name) && /serie/i.test(fold(e.group)))) {
      const m = e.name.match(SERIES_EP); if (!m) continue;
      const title = m[1].trim() || e.name, k = fold(title);
      let skey = seriesByName.get(k);
      if (!skey) { skey = `ms:@${sid}:${sha8(k)}`; seriesByName.set(k, skey); out.series.push({ key: skey, sid, remoteId: skey, name: title, poster: e.logo, category: e.group || "Sem categoria", added: Date.now() - out.series.length }); }
      out.episodes.push({ key: `me:@${sid}:${sha8(e.url)}`, sid, seriesKey: skey, remoteId: sha8(e.url), season: Number(m[2]), number: Number(m[3]),
        title: (m[4] || "").replace(/^[\s\-.:]+|[\s\-.:]+$/g, "") || `Episódio ${Number(m[3])}`, thumb: e.logo, ext: (e.url.split(".").pop() || "mp4").slice(0, 4), url: e.url });
    } else {
      seq++; const p = parseName(e.name);
      out.channels.push({ key: `@${sid}:${sha8(e.url)}`, sid, num: e.chno || seq, name: e.name, logo: e.logo, group: e.group || "Sem grupo", tvgId: e.tvgId,
        streamId: "", url: e.url, base: p.base, rank: p.rank, flags: p.flags });
    }
  }
  return out;
}

// ---------------------------------------------------------------- PIN dos perfis (igual ao app: PBKDF2-SHA1, 20.000 voltas, 256 bits)
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export async function pinHash(pin, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-1", salt: new TextEncoder().encode(salt), iterations: 20000 }, key, 256));
}
export const newSalt = () => hex(crypto.getRandomValues(new Uint8Array(16)));

const KID_ADULT = /\b(adult[oa]?s?|xxx|porn\w*|erotic\w*|\+?18|18\+|sexo|sex|hentai|playboy|sexy|hot)\b/i;
export const kidBlocked = (...labels) => labels.some((l) => l && KID_ADULT.test(fold(l)));

