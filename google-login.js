// Login Google "direto" (sem janela e sem o domínio firebaseapp.com), usado no app instalado do iPhone.
//
// Por quê: no app da Tela de Início o iOS isola o armazenamento e bloqueia o de terceiros. O fluxo normal do Firebase
// (pop-up ou redirecionamento via iptv-config-2b7e9.firebaseapp.com + iframe) perde o resultado no caminho.
// Aqui a própria página vai até accounts.google.com e o Google devolve um id_token NA MESMA janela, no fragmento
// (#id_token=...). Lemos, apagamos o fragmento na hora (history.replaceState), conferimos state/nonce/aud/iss/exp e
// entregamos ao Firebase (signInWithCredential), que confere a assinatura do token no servidor.
//
// Segurança: o id_token só existe no fragmento por instantes (o fragmento nunca vai ao servidor nem no Referer) e não é
// gravado. Fica guardado só o par state/nonce (valores aleatórios de uso único, válidos por 10 min), apagado ao voltar.
// Nenhum segredo de cliente é usado: o ID do cliente OAuth é público.

const KEY = "iptv.glogin";
const TTL = 10 * 60 * 1000;
const ISS = new Set(["accounts.google.com", "https://accounts.google.com"]);

/** Erro com código curto (mostrado na tela para diagnóstico). */
export function loginError(code, message) { return Object.assign(new Error(message || code), { code }); }

const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const randomToken = (n = 32) => b64u(crypto.getRandomValues(new Uint8Array(n)));
export async function sha256Hex(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Endereço do site para onde o Google devolve (precisa estar cadastrado no cliente OAuth exatamente assim). */
export function redirectUriFor(href, override) {
  if (override) return String(override);
  const u = new URL("./", href); u.search = ""; u.hash = "";
  return u.href;
}

export function buildAuthUrl({ clientId, redirectUri, state, nonce }) {
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "id_token", scope: "openid email profile", state, nonce, prompt: "select_account" });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

/** Lê a resposta do Google no fragmento. Devolve null se o fragmento não for nosso (ex.: #pair=...). */
export function parseAuthFragment(hash) {
  const h = String(hash || "").replace(/^#/, "");
  if (!h) return null;
  const p = new URLSearchParams(h);
  const idToken = p.get("id_token"), error = p.get("error"), state = p.get("state");
  if (!idToken && !(error && state)) return null;
  return { idToken: idToken || "", state: state || "", error: error || "", errorDescription: p.get("error_description") || "" };
}

export function decodeJwtPayload(jwt) {
  const parts = String(jwt || "").split(".");
  if (parts.length !== 3) throw loginError("google/malformed-token", "Resposta do Google inválida.");
  try {
    const s = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(s + "===".slice((s.length + 3) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch { throw loginError("google/malformed-token", "Resposta do Google inválida."); }
}

/** Confere se o token foi emitido para ESTE site e ESTE pedido (a assinatura é conferida pelo Firebase no servidor). */
export function checkClaims(payload, { clientId, nonceHash, now = Date.now() }) {
  if (!payload || typeof payload !== "object") throw loginError("google/malformed-token", "Resposta do Google inválida.");
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!clientId || !aud.includes(clientId) || (payload.azp && payload.azp !== clientId)) throw loginError("google/bad-aud", "O token do Google não é deste site.");
  if (!ISS.has(payload.iss)) throw loginError("google/bad-iss", "O token não veio do Google.");
  if (!(Number(payload.exp) * 1000 > now - 60000)) throw loginError("google/expired", "O login demorou demais. Tente de novo.");
  if (!nonceHash || payload.nonce !== nonceHash) throw loginError("google/nonce-mismatch", "O login não corresponde a este pedido. Tente de novo.");
  return payload;
}

// ---------------------------------------------------------------- pedido pendente (state + nonce)
function stores(s) { return s || [globalThis.sessionStorage, globalThis.localStorage]; }
/** Guarda o pedido em sessionStorage e localStorage (o iOS às vezes perde um deles ao sair para o Google e voltar). */
export function savePending(rec, storages) {
  let saved = 0;
  for (const st of stores(storages)) { try { st.setItem(KEY, JSON.stringify(rec)); saved++; } catch { /* armazenamento bloqueado */ } }
  if (!saved) throw loginError("google/storage-unavailable", "Este navegador bloqueou o armazenamento local (modo privado?).");
}
/** Lê e APAGA o pedido (uso único). */
export function takePending(storages, now = Date.now()) {
  let rec = null;
  for (const st of stores(storages)) {
    try { const v = st.getItem(KEY); if (v && !rec) rec = JSON.parse(v); st.removeItem(KEY); } catch { /* ignora */ }
  }
  if (!rec || typeof rec !== "object" || !(rec.exp > now)) return null;
  return rec;
}

/**
 * Valida a volta do Google e devolve { idToken, rawNonce, email } ou lança erro com código.
 * `pending` = registro lido com takePending().
 */
export async function verifyReturn(resp, pending, clientId, now = Date.now()) {
  if (resp.error) throw loginError(`google/${resp.error}`, resp.error === "access_denied" ? "Login cancelado no Google." : "O Google recusou o login.");
  if (!pending) throw loginError("google/state-missing", "O pedido de login se perdeu ao voltar do Google. Tente de novo.");
  if (!resp.state || resp.state !== pending.state) throw loginError("google/state-mismatch", "Resposta do Google não corresponde a este pedido.");
  const payload = checkClaims(decodeJwtPayload(resp.idToken), { clientId, nonceHash: await sha256Hex(pending.nonce), now });
  return { idToken: resp.idToken, rawNonce: pending.nonce, email: payload.email || "" };
}

// ---------------------------------------------------------------- navegador
/** Começa o login: guarda state/nonce e sai para o Google na mesma janela. */
export async function startDirectLogin({ clientId, redirectUri }) {
  if (!clientId) throw loginError("google/no-client-id", "O login direto ainda não foi configurado (googleWebClientId em firebase-config.js).");
  const state = randomToken(24), nonce = randomToken(32);
  savePending({ state, nonce, exp: Date.now() + TTL });
  location.assign(buildAuthUrl({ clientId, redirectUri, state, nonce: await sha256Hex(nonce) }));
  return new Promise(() => {}); // a página vai sair daqui
}

/** Lê a resposta do Google do endereço atual e apaga o fragmento imediatamente. */
export function captureReturn() {
  let r = null;
  try { r = parseAuthFragment(location.hash); } catch { r = null; }
  if (r) { try { history.replaceState(history.state, "", location.pathname + location.search); } catch { location.hash = ""; } }
  return r;
}

export function isIosStandalone() {
  const nav = globalThis.navigator || {};
  const ios = /iphone|ipad|ipod/i.test(nav.userAgent || "") || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
  let standalone = nav.standalone === true;
  try { standalone ||= matchMedia("(display-mode: standalone)").matches; } catch { /* sem matchMedia */ }
  return ios && standalone;
}
