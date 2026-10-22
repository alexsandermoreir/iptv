// Configuração PÚBLICA do app Web do Firebase (a chave web não é segredo; as regras do Firestore protegem os dados).
// Não coloque aqui senhas de IPTV, chaves privadas ou credenciais de conta de serviço.
export const firebaseConfig = {
  apiKey: "AIzaSyCAv3oJhwUhg55hZ49jxo6MhRtdU06XYJ8",
  authDomain: "iptv-config-2b7e9.firebaseapp.com",
  projectId: "iptv-config-2b7e9",
  storageBucket: "iptv-config-2b7e9.firebasestorage.app",
  messagingSenderId: "437103170869",
  appId: "1:437103170869:web:16a2fafdaac153d9c2287c",
  // Serviço gratuito (Cloudflare Worker) usado no pareamento por QR e no acesso às listas pelo navegador.
  pairApiBase: "https://iptv-pair.iptv-pair.workers.dev",
};
