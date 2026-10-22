// Minhas listas IPTV. Usa o Firebase já configurado em firebase-config.js e as regras atuais do Firestore:
// cada pessoa lê/grava somente em users/{uid}/sources. O pareamento cifra a fonte no navegador para a TV.
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import { getFirestore, collection, doc, getDocs, orderBy, query, serverTimestamp, setDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const $ = (s) => document.querySelector(s);
const el = {
  banner: $("#setup-banner"), gate: $("#gate"), work: $("#workspace"), signin: $("#signin"), signout: $("#signout"),
  chip: $("#user-chip"), avatar: $("#avatar"), email: $("#email"), list: $("#list"), empty: $("#empty"), count: $("#count"),
  add: $("#add"), dialog: $("#dialog"), form: $("#form"), dtitle: $("#dtitle"), name: $("#name"), kind: $("#kind"),
  xtream: $("#xtream"), m3u: $("#m3u"), server: $("#server"), user: $("#user"), pass: $("#pass"), m3uurl: $("#m3uurl"),
  ferr: $("#ferr"), save: $("#save"), cancel: $("#cancel"), toast: $("#toast"),
};

const configured = firebaseConfig && ["apiKey", "authDomain", "projectId", "appId"].every((k) => typeof firebaseConfig[k] === "string" && firebaseConfig[k] && !firebaseConfig[k].startsWith("YOUR_"));
let auth, db, user = null, sources = [], editingId = null, toastTimer;

function toast(msg) {
  el.toast.textContent = msg; el.toast.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.toast.classList.remove("show"), 3200);
}

if (!configured) {
  el.banner.hidden = false; el.signin.disabled = true;
} else {
  const app = getApps()[0] || initializeApp(firebaseConfig);
  auth = getAuth(app); db = getFirestore(app);
  onAuthStateChanged(auth, (u) => {
    user = u;
    el.gate.hidden = Boolean(u); el.work.hidden = !u; el.chip.hidden = !u; el.signout.hidden = !u;
    if (u) {
      const label = u.displayName || u.email || "Conta Google";
      el.email.textContent = u.email || label; el.avatar.textContent = label.trim().charAt(0).toUpperCase() || "?";
      load();
    } else { sources = []; render(); }
  });
}

async function login() {
  if (!auth) return;
  el.signin.disabled = true;
  try {
    // GitHub Pages não hospeda o auxiliar /__/auth do Firebase. Em celulares,
    // signInWithRedirect pode falhar quando o navegador bloqueia armazenamento de terceiros;
    // o popup iniciado pelo toque é o fluxo compatível recomendado para hospedagem externa.
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (e) {
    const c = e?.code || "";
    const messages = {
      "auth/popup-blocked": "O navegador bloqueou a janela do Google. Permita pop-ups para este site e tente novamente.",
      "auth/popup-closed-by-user": "A janela do Google foi fechada antes de terminar. Toque em Entrar com Google e escolha sua conta.",
      "auth/unauthorized-domain": "O endereço do site ainda não está autorizado no Firebase. O domínio alexsandermoreir.github.io precisa ser adicionado.",
      "auth/operation-not-allowed": "O login com Google ainda não está ativado no Firebase Authentication.",
      "auth/operation-not-supported-in-this-environment": "Este navegador não permite o login. Abra o site no Chrome ou Safari, fora de outro aplicativo.",
    };
    toast(messages[c] || `Não foi possível entrar com Google (${c || "erro"}). Tente de novo.`);
  } finally {
    el.signin.disabled = false;
  }
}

async function load() {
  if (!user) return;
  try {
    const snap = await getDocs(query(collection(db, "users", user.uid, "sources"), orderBy("createdAt", "desc")));
    sources = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  } catch { toast("Não foi possível carregar suas listas."); }
}

function render() {
  el.count.textContent = sources.length ? `(${sources.length})` : "";
  el.empty.hidden = sources.length > 0;
  el.list.replaceChildren();
  for (const s of sources) {
    const row = document.createElement("div"); row.className = "item";
    const ic = document.createElement("div"); ic.className = "ic"; ic.textContent = s.kind === "m3u" ? "M3U" : "XC"; ic.style.fontSize = "12px";
    const meta = document.createElement("div"); meta.className = "meta";
    const t = document.createElement("strong"); t.textContent = s.name || "Lista sem nome";
    const d = document.createElement("span"); d.className = "d"; d.textContent = s.kind === "m3u" ? "Link M3U · privada" : "Xtream Codes · privada";
    meta.append(t, d);
    const edit = document.createElement("button"); edit.textContent = "Editar"; edit.addEventListener("click", () => openDialog(s));
    const del = document.createElement("button"); del.textContent = "Excluir"; del.className = "danger"; del.addEventListener("click", () => remove(s));
    row.append(ic, meta, edit, del);
    el.list.append(row);
  }
}

function fields() { const m3u = el.kind.value === "m3u"; el.xtream.hidden = m3u; el.m3u.hidden = !m3u; }

function openDialog(s = null) {
  editingId = s?.id || null;
  el.dtitle.textContent = s ? "Editar lista" : "Nova lista";
  el.name.value = s?.name || ""; el.kind.value = s?.kind || "xtream";
  el.server.value = s?.serverUrl || ""; el.user.value = s?.username || ""; el.pass.value = s?.password || ""; el.m3uurl.value = s?.m3uUrl || "";
  el.ferr.hidden = true; fields(); el.dialog.showModal(); setTimeout(() => el.name.focus(), 40);
}

function httpUrl(v, label, base) {
  let u; try { u = new URL(v.trim()); } catch { throw new Error(`Informe uma URL válida para ${label}.`); }
  if (!["http:", "https:"].includes(u.protocol)) throw new Error(`${label} precisa começar com http:// ou https://.`);
  if (u.username || u.password) throw new Error(`Remova usuário e senha embutidos da URL de ${label}.`);
  if (base && (u.search || u.hash)) throw new Error("Use só o endereço do servidor, sem parâmetros.");
  return u;
}

function read() {
  const name = el.name.value.trim();
  if (!name) throw new Error("Dê um nome para a lista.");
  if (el.kind.value === "m3u") return { name, kind: "m3u", m3uUrl: httpUrl(el.m3uurl.value, "a lista M3U", false).toString() };
  const server = httpUrl(el.server.value, "o servidor", true);
  const username = el.user.value.trim(), password = el.pass.value;
  if (!username || !password) throw new Error("Preencha usuário e senha.");
  return { name, kind: "xtream", serverUrl: server.toString().replace(/\/$/, ""), username, password };
}

async function save(ev) {
  ev.preventDefault();
  if (!user) return;
  let v; try { v = read(); } catch (e) { el.ferr.textContent = e.message; el.ferr.hidden = false; return; }
  el.save.disabled = true; el.save.textContent = "Salvando…";
  try {
    const now = serverTimestamp();
    const ref = editingId ? doc(db, "users", user.uid, "sources", editingId) : doc(collection(db, "users", user.uid, "sources"));
    const createdAt = editingId ? (sources.find((s) => s.id === editingId)?.createdAt || now) : now;
    await setDoc(ref, { ...v, createdAt, updatedAt: now }); // as regras exigem exatamente estes campos
    el.dialog.close(); el.form.reset(); await load(); toast(editingId ? "Lista atualizada." : "Lista salva.");
  } catch { el.ferr.textContent = "Não foi possível salvar. Tente novamente."; el.ferr.hidden = false; }
  finally { el.save.disabled = false; el.save.textContent = "Salvar"; }
}

async function remove(s) {
  if (!user || !window.confirm(`Excluir “${s.name || "esta lista"}”? Isso não pode ser desfeito.`)) return;
  try { await deleteDoc(doc(db, "users", user.uid, "sources", s.id)); await load(); toast("Lista excluída."); }
  catch { toast("Não foi possível excluir."); }
}

el.signin.addEventListener("click", login);
el.signout.addEventListener("click", () => auth && signOut(auth).catch(() => toast("Não foi possível sair.")));
el.add.addEventListener("click", () => openDialog());
el.cancel.addEventListener("click", () => el.dialog.close());
el.kind.addEventListener("change", fields);
el.form.addEventListener("submit", save);
