import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, getRedirectResult, onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import { getFirestore, collection, doc, getDocs, orderBy, query, serverTimestamp, setDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app-check.js";
import { firebaseConfig } from "./firebase-config.js";

const $ = (selector) => document.querySelector(selector);
const refs = {
  setupBanner: $("#setup-banner"), authGate: $("#auth-gate"), workspace: $("#workspace"),
  signIn: $("#signin-button"), signInGate: $("#signin-button-gate"), signOut: $("#signout-button"),
  topLogin: $(".top-login"), userChip: $("#user-chip"), sidebarEmail: $("#sidebar-email"), topEmail: $("#top-email"),
  avatar: $("#avatar"), topAvatar: $("#top-avatar"), sourceCount: $("#source-count"), sourceList: $("#source-list"),
  emptyState: $("#empty-state"), addSource: $("#add-source-button"), emptyAdd: $("#empty-add-button"),
  dialog: $("#source-dialog"), form: $("#source-form"), dialogTitle: $("#dialog-title"), formError: $("#form-error"),
  sourceName: $("#source-name"), sourceKind: $("#source-kind"), xtreamFields: $("#xtream-fields"), m3uFields: $("#m3u-fields"),
  serverUrl: $("#server-url"), username: $("#xtream-username"), password: $("#xtream-password"), m3uUrl: $("#m3u-url"),
  saveButton: $("#save-source-button"), pairSource: $("#pair-source"), connectButton: $("#connect-button"),
  pairResult: $("#pair-result"), pairCode: $("#pair-code"), countdown: $("#expiry-countdown"), copyCode: $("#copy-code-button"),
  connectionState: $("#connection-state"), toast: $("#toast")
};

let auth;
let db;
let functions;
let currentUser = null;
let sources = [];
let editingSourceId = null;
let activePairCode = "";
let pairExpiresAt = 0;
let countdownTimer = null;
let toastTimer = null;
let appCheckReady = false;

const hasPlaceholders = !firebaseConfig || Object.entries(firebaseConfig)
  .filter(([key]) => key !== "appCheckSiteKey")
  .some(([, value]) => typeof value !== "string" || !value || value.startsWith("YOUR_"));

if (hasPlaceholders) {
  refs.setupBanner.hidden = false;
  refs.signIn.disabled = true;
  refs.signInGate.disabled = true;
  refs.signIn.title = "Configure o Firebase para continuar";
  refs.signInGate.title = "Configure o Firebase para continuar";
} else {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  functions = getFunctions(app, "southamerica-east1");

  if (firebaseConfig.appCheckSiteKey && !firebaseConfig.appCheckSiteKey.startsWith("YOUR_")) {
    try {
      initializeAppCheck(app, {
        provider: new ReCaptchaEnterpriseProvider(firebaseConfig.appCheckSiteKey),
        isTokenAutoRefreshEnabled: true
      });
      appCheckReady = true;
    } catch {
      showToast("Não foi possível iniciar a proteção App Check.");
    }
  }

  getRedirectResult(auth).catch((error) => showToast(authErrorMessage(error)));
  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    updateAccountView(user);
    if (user) {
      loadSources();
    } else {
      clearWorkspace();
    }
  });
}

function updateAccountView(user) {
  const signedIn = Boolean(user);
  refs.authGate.hidden = signedIn;
  refs.workspace.hidden = !signedIn;
  refs.signIn.hidden = signedIn || hasPlaceholders;
  refs.signOut.hidden = !signedIn;
  refs.userChip.hidden = !signedIn;
  if (user) {
    const label = user.displayName || user.email || "Conta Google";
    const initial = label.trim().charAt(0).toUpperCase() || "V";
    refs.sidebarEmail.textContent = user.email || label;
    refs.topEmail.textContent = user.email || label;
    refs.avatar.textContent = initial;
    refs.topAvatar.textContent = initial;
  }
}

function clearWorkspace() {
  sources = [];
  refs.sourceList.replaceChildren();
  refs.sourceCount.textContent = "0";
  refs.emptyState.hidden = false;
  refs.pairSource.replaceChildren(new Option("Entre e adicione uma lista", ""));
  refs.pairSource.disabled = true;
  refs.connectButton.disabled = true;
  clearPairResult();
  refs.connectionState.textContent = "Aguardando";
}

async function signIn() {
  if (!auth || hasPlaceholders) return;
  try {
    const provider = new GoogleAuthProvider();
    if (window.matchMedia("(pointer: coarse)").matches) {
      await signInWithRedirect(auth, provider);
    } else {
      await signInWithPopup(auth, provider);
    }
  } catch (error) {
    showToast(authErrorMessage(error));
  }
}

function authErrorMessage(error) {
  const code = error?.code || "";
  if (code.includes("popup-blocked")) return "O navegador bloqueou a janela de login. Permita pop-ups para este site.";
  if (code.includes("popup-closed-by-user")) return "Login cancelado.";
  if (code.includes("unauthorized-domain")) return "Adicione este domínio aos domínios autorizados no Firebase Auth.";
  return "Não foi possível entrar com Google. Confira a configuração do Firebase e tente novamente.";
}

async function loadSources() {
  if (!currentUser || !db) return;
  try {
    const sourceCollection = collection(db, "users", currentUser.uid, "sources");
    const snapshot = await getDocs(query(sourceCollection, orderBy("createdAt", "desc")));
    if (!currentUser) return;
    sources = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    renderSources();
  } catch {
    showToast("Não foi possível carregar suas listas. Confira as regras do Firestore.");
  }
}

function renderSources() {
  refs.sourceCount.textContent = String(sources.length);
  refs.emptyState.hidden = sources.length > 0;
  refs.sourceList.replaceChildren();

  for (const source of sources) {
    const row = document.createElement("article");
    row.className = "source-item";
    const icon = document.createElement("span");
    icon.className = `source-kind-icon${source.kind === "m3u" ? " m3u" : ""}`;
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = source.kind === "m3u" ? "↗" : "▤";
    const meta = document.createElement("div");
    meta.className = "source-meta";
    const title = document.createElement("strong");
    title.textContent = source.name || "Lista sem nome";
    const detail = document.createElement("span");
    detail.textContent = source.kind === "m3u" ? "URL M3U · acesso protegido" : "Xtream Codes · acesso protegido";
    meta.append(title, detail);
    const privacy = document.createElement("span");
    privacy.className = "source-private";
    privacy.innerHTML = "<i></i> Privada";
    const actions = document.createElement("div");
    actions.className = "source-actions";
    actions.setAttribute("aria-label", `Ações para ${source.name || "lista"}`);
    actions.append(
      actionButton("⌁", "Conectar à TV", "connect", source.id),
      actionButton("✎", "Editar lista", "edit", source.id),
      actionButton("×", "Excluir lista", "delete", source.id, true)
    );
    row.append(icon, meta, privacy, actions);
    refs.sourceList.append(row);
  }

  refs.pairSource.replaceChildren();
  if (!sources.length) {
    refs.pairSource.append(new Option("Adicione uma lista primeiro", ""));
    refs.pairSource.disabled = true;
    refs.connectButton.disabled = true;
    return;
  }
  for (const source of sources) refs.pairSource.append(new Option(source.name || "Lista sem nome", source.id));
  refs.pairSource.disabled = false;
  refs.connectButton.disabled = false;
}

function actionButton(label, title, action, sourceId, isDelete = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.dataset.action = action;
  button.dataset.sourceId = sourceId;
  if (isDelete) button.classList.add("delete");
  return button;
}

function openSourceDialog(source = null) {
  editingSourceId = source?.id || null;
  refs.dialogTitle.textContent = editingSourceId ? "Editar lista" : "Adicionar lista";
  refs.saveButton.textContent = editingSourceId ? "Salvar alterações" : "Salvar lista";
  refs.sourceName.value = source?.name || "";
  refs.sourceKind.value = source?.kind || "xtream";
  refs.serverUrl.value = source?.serverUrl || "";
  refs.username.value = source?.username || "";
  refs.password.value = source?.password || "";
  refs.m3uUrl.value = source?.m3uUrl || "";
  showFormError("");
  updateSourceFields();
  refs.dialog.showModal();
  window.setTimeout(() => refs.sourceName.focus(), 40);
}

function updateSourceFields() {
  const isM3u = refs.sourceKind.value === "m3u";
  refs.xtreamFields.hidden = isM3u;
  refs.m3uFields.hidden = !isM3u;
}


function parseHttpUrl(value, label, allowQuery = true) {
  let parsed;
  try { parsed = new URL(value.trim()); } catch { throw new Error(`Informe uma URL válida para ${label}.`); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`${label} precisa começar com http:// ou https://.`);
  if (parsed.username || parsed.password) throw new Error(`Remova usuário e senha embutidos da URL de ${label}.`);
  if (!allowQuery && (parsed.search || parsed.hash)) throw new Error("Use a URL base do servidor, sem parâmetros ou fragmentos.");
  return parsed;
}

function readSourceForm() {
  const name = refs.sourceName.value.trim();
  if (!name) throw new Error("Dê um nome para identificar esta lista.");
  const kind = refs.sourceKind.value;
  if (kind === "m3u") {
    const url = parseHttpUrl(refs.m3uUrl.value, "a lista M3U");
    return { name, kind, m3uUrl: url.toString() };
  }
  const server = parseHttpUrl(refs.serverUrl.value, "o servidor", false);
  const username = refs.username.value.trim();
  const password = refs.password.value;
  if (!username || !password) throw new Error("Preencha o usuário e a senha do Xtream Codes.");
  return { name, kind, serverUrl: server.toString().replace(/\/$/, ""), username, password };
}

async function saveSource(event) {
  event.preventDefault();
  if (!currentUser || !db) return;
  let values;
  try { values = readSourceForm(); } catch (error) { showFormError(error.message); return; }
  refs.saveButton.disabled = true;
  refs.saveButton.textContent = "Salvando…";
  try {
    const now = serverTimestamp();
    const reference = editingSourceId
      ? doc(db, "users", currentUser.uid, "sources", editingSourceId)
      : doc(collection(db, "users", currentUser.uid, "sources"));
    const createdAt = editingSourceId
      ? (sources.find((source) => source.id === editingSourceId)?.createdAt || now)
      : now;
    await setDoc(reference, { ...values, createdAt, updatedAt: now });
    refs.dialog.close();
    refs.form.reset();
    await loadSources();
    showToast(editingSourceId ? "Lista atualizada." : "Lista salva com privacidade.");
  } catch {
    showFormError("Não foi possível salvar. Confira as regras do Firestore e tente novamente.");
  } finally {
    refs.saveButton.disabled = false;
    refs.saveButton.textContent = editingSourceId ? "Salvar alterações" : "Salvar lista";
  }
}

async function deleteSource(sourceId) {
  const source = sources.find((item) => item.id === sourceId);
  if (!source || !currentUser || !db) return;
  if (!window.confirm(`Excluir “${source.name || "esta lista"}”? Esta ação não pode ser desfeita.`)) return;
  try {
    await deleteDoc(doc(db, "users", currentUser.uid, "sources", sourceId));
    await loadSources();
    showToast("Lista excluída.");
  } catch {
    showToast("Não foi possível excluir a lista. Confira as regras do Firestore.");
  }
}

async function createPairingCode(sourceId) {
  if (!currentUser || !functions || !appCheckReady) {
    showToast("Configure e ative o App Check para gerar códigos de conexão.");
    return;
  }
  refs.connectButton.disabled = true;
  refs.connectButton.textContent = "Gerando código…";
  clearPairResult();
  try {
    const createCode = httpsCallable(functions, "createPairingCode");
    const response = await createCode({ sourceId });
    activePairCode = response.data.code;
    pairExpiresAt = response.data.expiresAt;
    refs.pairCode.textContent = activePairCode.match(/.{1,4}/g).join(" ");
    refs.pairResult.hidden = false;
    refs.connectionState.textContent = "Código ativo";
    updateCountdown();
    countdownTimer = window.setInterval(updateCountdown, 1000);
  } catch {
    showToast("Não foi possível gerar o código. Confira o deploy da Function e o App Check.");
  } finally {
    refs.connectButton.disabled = false;
    refs.connectButton.innerHTML = "<span aria-hidden=\"true\">⌁</span> Gerar código de conexão";
  }
}

function updateCountdown() {
  const secondsLeft = Math.max(0, Math.ceil((pairExpiresAt - Date.now()) / 1000));
  refs.countdown.textContent = `${String(Math.floor(secondsLeft / 60)).padStart(2, "0")}:${String(secondsLeft % 60).padStart(2, "0")}`;
  if (!secondsLeft) {
    clearPairResult();
    refs.connectionState.textContent = "Aguardando";
    showToast("O código de conexão expirou. Gere um novo quando quiser.");
  }
}

function clearPairResult() {
  if (countdownTimer) window.clearInterval(countdownTimer);
  countdownTimer = null;
  activePairCode = "";
  pairExpiresAt = 0;
  refs.pairResult.hidden = true;
  refs.pairCode.textContent = "•••• •••• ••••";
}

async function copyPairCode() {
  if (!activePairCode) return;
  try {
    await navigator.clipboard.writeText(activePairCode);
    showToast("Código copiado.");
  } catch {
    showToast("Não foi possível copiar. Digite o código exibido no app da TV.");
  }
}

function showToast(message) {
  refs.toast.textContent = message;
  refs.toast.classList.add("show");
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => refs.toast.classList.remove("show"), 3200);
}

refs.signIn.addEventListener("click", signIn);
refs.signInGate.addEventListener("click", signIn);
refs.signOut.addEventListener("click", () => auth && signOut(auth).catch(() => showToast("Não foi possível sair da conta.")));
refs.addSource.addEventListener("click", () => openSourceDialog());
refs.emptyAdd.addEventListener("click", () => openSourceDialog());
$("#close-dialog-button").addEventListener("click", () => refs.dialog.close());
$("#cancel-dialog-button").addEventListener("click", () => refs.dialog.close());
refs.sourceKind.addEventListener("change", updateSourceFields);
refs.form.addEventListener("submit", saveSource);
refs.connectButton.addEventListener("click", () => createPairingCode(refs.pairSource.value));
refs.copyCode.addEventListener("click", copyPairCode);
refs.sourceList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const source = sources.find((item) => item.id === button.dataset.sourceId);
  if (!source) return;
  if (button.dataset.action === "edit") openSourceDialog(source);
  if (button.dataset.action === "delete") deleteSource(source.id);
  if (button.dataset.action === "connect") {
    refs.pairSource.value = source.id;
    document.querySelector("#conectar").scrollIntoView({ behavior: "smooth", block: "center" });
    createPairingCode(source.id);
  }
});

function showFormError(message) {
  refs.formError.textContent = message;
  refs.formError.hidden = !message;
}
