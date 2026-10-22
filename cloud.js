// Conta Google + Firestore + sincronização + proxy de mídia. Mesmo formato de documentos que o app da TV usa
// (users/{uid}/sources e users/{uid}/sync/{settings|profiles|p_<perfil>}), então tudo acompanha a conta.
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, OAuthProvider, getRedirectResult, onAuthStateChanged, signInWithCredential, signInWithPopup, signInWithRedirect, signOut } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import { getFirestore, initializeFirestore, collection, doc, getDocs, orderBy, query, serverTimestamp, setDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import * as GL from "./google-login.js";

// A volta do login direto (#id_token=...) é lida e apagada do endereço ANTES de qualquer outra coisa.
const directReturn = GL.captureReturn();

export const configured = ["apiKey", "authDomain", "projectId", "appId"].every((k) => typeof firebaseConfig?.[k] === "string" && firebaseConfig[k] && !firebaseConfig[k].startsWith("YOUR_"));
export const API = String(firebaseConfig?.pairApiBase || "").replace(/\/$/, "");
const WEB_CLIENT_ID = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(String(firebaseConfig?.googleWebClientId || "")) ? firebaseConfig.googleWebClientId : "";
let auth, db;
export let user = null;
const listeners = new Set();
export const onStatus = (fn) => listeners.add(fn);
const emit = (s) => listeners.forEach((fn) => fn(s));

/** Texto curto para a tela: mensagem + código técnico (para o usuário poder nos enviar). */
export function describeLoginError(e) {
  const c = String(e?.code || e?.name || "erro");
  const m = c.includes("popup-blocked") ? "O navegador bloqueou a janela de login. Permita pop-ups ou use “Outra forma de entrar”."
    : c.includes("popup-closed") || c.includes("cancelled-popup") ? "A janela de login fechou antes de concluir. Tente “Outra forma de entrar”."
    : c.includes("unauthorized-domain") ? "Este endereço não está autorizado no Firebase Auth."
    : c.includes("invalid-credential") || c.includes("invalid-idp-response") ? "O Firebase não aceitou o login do Google (o ID do cliente Web confere com o do Firebase?)."
    : c.includes("network-request-failed") ? "Sem conexão com o Google/Firebase. Verifique a internet."
    : c.startsWith("google/") ? (e?.message || "Falha no login direto.")
    : "Não foi possível entrar com Google.";
  return `${m} [código: ${c}]`;
}

let pendingError = "";
/** Erro de login detectado ao abrir a página (volta do Google ou do redirecionamento); lido uma vez. */
export const takeLoginError = () => { const e = pendingError; pendingError = ""; return e; };

async function finishDirect(r) {
  const v = await GL.verifyReturn(r, GL.takePending(), WEB_CLIENT_ID);
  try {
    // Sem nonce: o Firebase confere assinatura, emissor e destinatário (aud) do token; o nonce já foi conferido acima.
    await signInWithCredential(auth, GoogleAuthProvider.credential(v.idToken));
  } catch (e) {
    if (!String(e?.code || "").includes("nonce")) throw e;
    // Se o Firebase exigir o nonce, mandamos o original (ele confere o SHA-256 com o que foi ao Google).
    await signInWithCredential(auth, new OAuthProvider("google.com").credential({ idToken: v.idToken, rawNonce: v.rawNonce }));
  }
}

export function initCloud(onUser) {
  if (!configured) { onUser(null, "not_configured"); return; }
  const app = getApps()[0] || initializeApp(firebaseConfig);
  auth = getAuth(app);
  // Safari/iPhone às vezes bloqueia o canal contínuo do Firestore; a detecção automática troca para "long polling"
  try { db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true }); } catch { db = getFirestore(app); }
  const watch = () => onAuthStateChanged(auth, (u) => { user = u; onUser(u, u ? "signed_in" : "signed_out", u ? "" : takeLoginError()); });
  if (directReturn) {
    // Só começa a observar depois de concluir, para não piscar a tela de login nem perder a mensagem de erro.
    finishDirect(directReturn).catch((e) => { pendingError = describeLoginError(e); }).finally(watch);
    return;
  }
  getRedirectResult(auth).catch((e) => { pendingError = describeLoginError(e); }).finally(watch);
}
export const currentAuth = () => auth;
export const currentDb = () => db;

/** No app instalado do iPhone o pop-up/redirecionamento do Firebase perde o resultado; lá usamos o login direto. */
export const directLoginAvailable = () => !!WEB_CLIENT_ID;
export const prefersDirectLogin = () => GL.isIosStandalone();

/**
 * method: "auto" (padrão), "direct" (Google na mesma janela) ou "popup" (método do Firebase).
 * Lança Error cuja mensagem já inclui o código técnico.
 */
export async function login(method = "auto") {
  if (method === "auto") method = prefersDirectLogin() && WEB_CLIENT_ID ? "direct" : "popup";
  if (method === "direct") {
    try { await GL.startDirectLogin({ clientId: WEB_CLIENT_ID, redirectUri: GL.redirectUriFor(location.href, firebaseConfig?.googleRedirectUri) }); }
    catch (e) { throw new Error(describeLoginError(e)); }
    return;
  }
  const p = new GoogleAuthProvider();
  p.setCustomParameters({ prompt: "select_account" });
  try {
    await signInWithPopup(auth, p);
  } catch (e) {
    const c = e?.code || "";
    if (c.includes("popup-blocked") || c.includes("operation-not-supported") || c.includes("web-storage-unsupported")) {
      if (WEB_CLIENT_ID) return login("direct");
      try { await signInWithRedirect(auth, p); return; } catch (e2) { throw new Error(describeLoginError(e2)); }
    }
    throw new Error(describeLoginError(e));
  }
}
export const logout = () => signOut(auth);

// ---------------------------------------------------------------- listas (users/{uid}/sources)
const sourcesCol = () => collection(db, "users", user.uid, "sources");
export async function listSources() {
  const snap = await getDocs(query(sourcesCol(), orderBy("createdAt", "desc")));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
export async function saveSource(v, existing) {
  const now = serverTimestamp();
  const ref = existing ? doc(db, "users", user.uid, "sources", existing.id) : doc(sourcesCol());
  await setDoc(ref, { ...v, createdAt: existing?.createdAt || now, updatedAt: now }); // as regras exigem exatamente estes campos
}
export const deleteSource = (id) => deleteDoc(doc(db, "users", user.uid, "sources", id));

// ---------------------------------------------------------------- proxy de mídia (Worker)
const tickets = new Map(); // URL de origem -> {url, exp}
export async function sign(urls) {
  if (!API) throw new Error("O serviço de conexão (pairApiBase) não está configurado neste site.");
  const need = urls.filter((u) => !(tickets.get(u)?.exp > Date.now() + 600000));
  for (let i = 0; i < need.length; i += 20) {
    const part = need.slice(i, i + 20);
    const r = await fetch(`${API}/media/sign`, { method: "POST", cache: "no-store", referrerPolicy: "no-referrer",
      headers: { "content-type": "application/json", authorization: `Bearer ${await user.getIdToken()}` }, body: JSON.stringify({ urls: part }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status === 403 ? "Este e-mail não está autorizado a usar o player do site." : r.status === 503 ? "O serviço de mídia ainda não foi configurado no Worker (MEDIA_KEY / ALLOWED_EMAILS)." : "Não foi possível preparar o acesso à lista.");
    part.forEach((u, k) => tickets.set(u, { url: d.urls[k], exp: d.expiresAt }));
  }
  return urls.map((u) => tickets.get(u).url);
}
export const proxied = async (u) => (await sign([u]))[0];
async function proxyFetch(url, init) {
  const action = (String(url).match(/[?&]action=([a-z_]+)/) || [])[1] || "acesso"; // só o nome da chamada (nunca usuário/senha)
  let last;
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      const r = await fetch(await proxied(url), init);
      if (!r.ok) throw Object.assign(new Error(r.status === 410 ? "A sessão de mídia expirou. Recarregue a página." : `O servidor da lista respondeu com erro (HTTP ${r.status}).`), { http: true });
      return r;
    } catch (e) {
      last = e; if (e.http) throw new Error(`${action}: ${e.message}`);
      await new Promise((res) => setTimeout(res, 700 * tentativa)); // falha de rede: tenta de novo
    }
  }
  throw new Error(`${action}: ${last?.message || "falha de rede"} (3 tentativas)`);
}export const fetchJson = async (url) => { const r = await proxyFetch(url); try { return await r.json(); } catch (e) { throw new Error(`${(String(url).match(/[?&]action=([a-z_]+)/) || [])[1] || "acesso"}: resposta incompleta ou inválida (${e.message})`); } };
export const fetchText = async (url) => (await proxyFetch(url)).text();

// ---------------------------------------------------------------- sincronização
const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
export const S = { settings: {}, profiles: [], data: {}, ready: false };
const dirty = new Set(), lastV = new Map();
let timer = 0, onChange = () => {};
export const setOnChange = (fn) => { onChange = fn; };
const emptyData = () => ({ fav: [], my: [], prog: [], hist: [] });
export const profileData = (cid) => (S.data[cid] ||= emptyData());

export function markDirty(id) { dirty.add(id); clearTimeout(timer); timer = setTimeout(flush, 8000); emit({ pending: true }); }
export const dirtyProfile = (cid) => markDirty(`p_${cid}`);

const docOf = (id) => {
  if (id === "settings") return JSON.stringify(S.settings);
  if (id === "profiles") return JSON.stringify({ list: S.profiles.map((p) => ({ id: p.id, name: p.name, color: p.color || 0, kid: !!p.kid, pinHash: p.pinHash || "", pinSalt: p.pinSalt || "" })) });
  const d = profileData(id.slice(2));
  return JSON.stringify({ fav: d.fav, my: d.my, prog: d.prog.slice(0, 300), hist: d.hist.slice(0, 60) });
};

export async function flush() {
  clearTimeout(timer);
  if (!user || !dirty.size) return;
  const ids = [...dirty]; dirty.clear();
  try {
    for (const id of ids) {
      const v = docOf(id);
      if (v.length > 880000) continue;
      await setDoc(doc(db, "users", user.uid, "sync", id), { v, updatedAt: serverTimestamp() });
      lastV.set(id, v);
    }
    emit({ ok: Date.now() });
  } catch (e) {
    ids.forEach((i) => dirty.add(i));
    emit({ error: String(e?.code || "").includes("permission") ? "O Firebase recusou a sincronização. Publique as regras novas (firestore.rules)." : "Não foi possível sincronizar agora." });
  }
}

const unionBy = (a, b, key, t) => { const m = new Map(a.map((x) => [x[key], x])); let extra = false; for (const x of b) { const c = m.get(x[key]); if (!c || (c[t] || 0) < (x[t] || 0)) m.set(x[key], x); } for (const x of a) { const c = b.find((y) => y[key] === x[key]); if (!c || (c[t] || 0) < (x[t] || 0)) extra = true; } return [[...m.values()].sort((p, q) => (q[t] || 0) - (p[t] || 0)), extra]; };

/** Baixa o que mudou na nuvem e mescla. Devolve true se algo local mudou. */
export async function pull() {
  if (!user) return false;
  const snap = await getDocs(collection(db, "users", user.uid, "sync"));
  let changed = false;
  const remote = new Map(snap.docs.map((d) => [d.id, String(d.data().v || "")]));
  for (const [id, v] of remote) {
    if (lastV.get(id) === v) continue;
    lastV.set(id, v);
    let o; try { o = JSON.parse(v); } catch { continue; }
    if (id === "settings") { if (!dirty.has(id)) { S.settings = o && typeof o === "object" ? o : {}; changed = true; } }
    else if (id === "profiles") {
      if (!dirty.has(id) && Array.isArray(o.list)) { S.profiles = o.list.filter((p) => p?.id).map((p) => ({ id: String(p.id), name: String(p.name || "Perfil"), color: p.color || 0, kid: !!p.kid, pinHash: p.pinHash || "", pinSalt: p.pinSalt || "" })); changed = true; }
    } else if (id.startsWith("p_")) {
      const d = profileData(id.slice(2));
      if (!dirty.has(id)) { if (Array.isArray(o.fav)) d.fav = o.fav; if (Array.isArray(o.my)) d.my = o.my; }
      const [prog, e1] = unionBy(d.prog, Array.isArray(o.prog) ? o.prog : [], "k", "t");
      const [hist, e2] = unionBy(d.hist, Array.isArray(o.hist) ? o.hist : [], "k", "t");
      d.prog = prog.slice(0, 300); d.hist = hist.slice(0, 60);
      if (e1 || e2) markDirty(id);
      changed = true;
    }
  }
  if (!S.profiles.length) { S.profiles = [{ id: rid(), name: "Principal", color: 0, kid: false, pinHash: "", pinSalt: "" }]; markDirty("profiles"); changed = true; }
  S.ready = true;
  if (changed) onChange();
  emit({ ok: Date.now() });
  return changed;
}

export function newProfile(name, kid) {
  const p = { id: rid(), name, color: S.profiles.length % 6, kid: !!kid, pinHash: "", pinSalt: "" };
  S.profiles.push(p); markDirty("profiles"); return p;
}
export function removeProfile(id) {
  if (S.profiles.length <= 1) return;
  S.profiles = S.profiles.filter((p) => p.id !== id); delete S.data[id]; markDirty("profiles");
  deleteDoc(doc(db, "users", user.uid, "sync", `p_${id}`)).catch(() => {});
}
export function setting(key, def) { return S.settings[key] === undefined ? def : S.settings[key]; }
export function setSetting(key, value) { S.settings[key] = value; markDirty("settings"); }
export const hiddenSet = () => new Set(Array.isArray(S.settings.hidden) ? S.settings.hidden : []);
export function setHidden(ids, hide) {
  const h = hiddenSet(); for (const id of ids) hide ? h.add(id) : h.delete(id);
  S.settings.hidden = [...h].sort(); markDirty("settings");
}
addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
addEventListener("pagehide", () => { flush(); });
