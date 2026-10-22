// Conexão com a TV (lado do celular). Adicione ao site com:
//   <script type="module" src="pair-connect.js"></script>        (em index.html, depois de app.js)
// e, em firebase-config.js, o campo:  pairApiBase: "https://SEU-WORKER.workers.dev"
//
// Privacidade: o token vem no fragmento (#pair=...) e é removido do endereço assim que a página abre;
// nada é gravado em localStorage/sessionStorage. O celular lê a fonte sob as regras do Firestore,
// cifra os dados para a chave pública da TV e envia somente o conteúdo cifrado ao Worker.
import { getApps, initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, getDocs, orderBy, query } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

// Este módulo também pode iniciar antes de main.js; reaproveita a instância Firebase, se já existir.
const app = getApps()[0] || initializeApp(firebaseConfig);
const API = String(firebaseConfig.pairApiBase || "").replace(/\/$/, "");

// 1) lê o token do fragmento e remove do endereço imediatamente (não vai para histórico nem logs de terceiros)
let pendingToken = null;
{
  const m = location.hash.match(/^#pair=([A-Za-z0-9_-]{20,100})$/);
  if (m) { pendingToken = m[1]; history.replaceState(null, "", location.pathname + location.search); }
}

const ERR = {
  404: "Código inválido ou expirado. Gere um novo na TV.",
  409: "Este código já foi usado. Gere um novo na TV.",
  410: "O código expirou. Gere um novo na TV.",
  429: "Muitas tentativas. Aguarde alguns minutos.",
};

async function post(path, body, idToken) {
  const r = await fetch(API + path, {
    method: "POST", cache: "no-store", referrerPolicy: "no-referrer",
    headers: { "content-type": "application/json", ...(idToken ? { authorization: `Bearer ${idToken}` } : {}) },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || "erro"); e.status = r.status; throw e; }
  return data;
}

// ---------------------------------------------------------------- interface mínima (somente textContent)
const dlg = document.createElement("dialog");
dlg.style.cssText = "max-width:420px;width:calc(100% - 32px);border:1px solid #2a323b;border-radius:16px;background:#14181d;color:#f2f4f5;padding:20px;font-family:system-ui,sans-serif";
const body = document.createElement("div");
dlg.append(body);
document.body.append(dlg);

function el(tag, text, css) { const e = document.createElement(tag); if (text) e.textContent = text; if (css) e.style.cssText = css; return e; }
function btn(label, onClick, primary = false) {
  const b = el("button", label, `padding:12px 16px;margin:6px 6px 0 0;border-radius:10px;border:0;font-size:16px;cursor:pointer;${primary ? "background:#26c6b0;color:#000;font-weight:600" : "background:#1f262e;color:#f2f4f5"}`);
  b.type = "button"; b.addEventListener("click", onClick); return b;
}
function show(title, text, ...actions) {
  body.replaceChildren(el("h2", title, "margin:0 0 8px;font-size:20px"), el("p", text, "margin:0 0 12px;color:#a9b3bc"), ...actions);
  if (!dlg.open) dlg.showModal();
}

// ---------------------------------------------------------------- fluxo
let session = null; // { pairId, claimSecret, device } — só em memória

async function currentUser() {
  const auth = getAuth(app);
  await auth.authStateReady?.();
  return auth.currentUser;
}

async function cancelAndClose() {
  if (session) { try { await post("/pair/cancel", { pairId: session.pairId, claimSecret: session.claimSecret }); } catch { /* melhor esforço */ } }
  session = null; dlg.close();
}

function decodeB64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}
function encodeB64Url(value) {
  return btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function encryptForTv(publicKey, payload) {
  const rsa = await crypto.subtle.importKey("spki", decodeB64Url(publicKey), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const rawAes = await crypto.subtle.exportKey("raw", aes);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const clear = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, clear);
  const wrappedKey = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsa, rawAes);
  return { wrappedKey: encodeB64Url(wrappedKey), iv: encodeB64Url(iv), ciphertext: encodeB64Url(ciphertext) };
}

async function claim(tokenOrCode, isCode) {
  show("Conectando…", "Procurando a TV.");
  try {
    const c = await post("/pair/claim", isCode ? { code: tokenOrCode } : { token: tokenOrCode });
    session = { pairId: c.pairId, claimSecret: c.claimSecret, device: c.device, publicKey: c.publicKey };
    await afterClaim();
  } catch (e) { show("Não foi possível conectar", ERR[e.status] || "Tente novamente em instantes.", btn("Fechar", () => dlg.close(), true)); }
}

async function afterClaim() {
  const user = await currentUser();
  if (!user) {
    show(`TV encontrada: ${session.device}`, "Entre com sua conta Google para escolher a lista.",
      btn("Entrar com Google", async () => {
        try { await signInWithPopup(getAuth(app), new GoogleAuthProvider()); await afterClaim(); }
        catch { show("Login não concluído", "Permita pop-ups e tente de novo.", btn("Tentar de novo", afterClaim, true), btn("Cancelar", cancelAndClose)); }
      }, true), btn("Cancelar", cancelAndClose));
    return;
  }
  try {
    const idToken = await user.getIdToken();
    await post("/pair/choosing", { pairId: session.pairId, claimSecret: session.claimSecret }, idToken);
    const snap = await getDocs(query(collection(getFirestore(app), "users", user.uid, "sources"), orderBy("createdAt", "desc")));
    const sources = snap.docs.map((d) => ({ id: d.id, name: d.data().name || "Lista sem nome" }));
    if (!sources.length) { show("Nenhuma lista salva", "Salve uma lista no site e volte a ler o QR code da TV.", btn("Fechar", cancelAndClose, true)); return; }
    const sel = el("select", "", "width:100%;padding:12px;border-radius:10px;background:#1f262e;color:#f2f4f5;border:1px solid #2a323b;font-size:16px");
    for (const s of sources) sel.append(new Option(s.name, s.id));
    show(`Vincular à TV “${session.device}”`, "Escolha a lista e confirme. A TV receberá o acesso a ela uma única vez.", sel,
      btn("Vincular à TV", () => authorize(sel.value, sel.selectedOptions[0].text), true), btn("Cancelar", cancelAndClose));
  } catch (e) { show("Não foi possível continuar", ERR[e.status] || "Tente novamente.", btn("Fechar", cancelAndClose, true)); }
}

async function authorize(sourceId, name) {
  show("Enviando…", `Autorizando “${name}”.`);
  try {
    const user = await currentUser();
    const source = await getDoc(doc(getFirestore(app), "users", user.uid, "sources", sourceId));
    if (!source.exists()) throw new Error("source_not_found");
    const data = source.data();
    const payload = data.kind === "m3u"
      ? { kind: "m3u", name: data.name || "Minha lista", m3uUrl: data.m3uUrl }
      : { kind: "xtream", name: data.name || "Minha lista", serverUrl: data.serverUrl, username: data.username, password: data.password };
    const encrypted = await encryptForTv(session.publicKey, payload);
    await post("/pair/authorize", { pairId: session.pairId, claimSecret: session.claimSecret, payload: encrypted }, await user.getIdToken());
    session = null;
    // não diz "conectado": quem confirma o recebimento é a TV
    show("Enviado para a TV", "Olhe a TV: ela mostrará “Conectado” quando receber a lista. Você pode fechar esta janela.", btn("Fechar", () => dlg.close(), true));
  } catch (e) { show("Não foi possível vincular", ERR[e.status] || "Tente novamente.", btn("Fechar", cancelAndClose, true)); }
}

// ---------------------------------------------------------------- entrada: QR (token no fragmento) ou código digitado
function askCode() {
  const input = el("input", "", "width:100%;padding:12px;border-radius:10px;background:#1f262e;color:#f2f4f5;border:1px solid #2a323b;font-size:20px;letter-spacing:3px;text-transform:uppercase");
  input.placeholder = "ABCD 1234"; input.maxLength = 12; input.autocomplete = "off"; input.autocapitalize = "characters";
  show("Conectar uma TV", "Digite o código mostrado na TV (Conectar pelo celular).", input,
    btn("Continuar", () => { const c = input.value.replace(/[^A-Za-z0-9]/g, ""); if (c.length >= 8) claim(c, true); }, true), btn("Fechar", () => dlg.close()));
}

if (!API) {
  if (pendingToken) show("Conexão indisponível", "O servidor de pareamento ainda não foi configurado neste site (pairApiBase).", btn("Fechar", () => dlg.close(), true));
} else {
  const open = btn("Conectar uma TV com código", askCode);
  open.style.cssText += ";position:fixed;right:16px;bottom:16px;z-index:50";
  document.body.append(open);
  if (pendingToken) { const t = pendingToken; pendingToken = null; claim(t, false); }
}
