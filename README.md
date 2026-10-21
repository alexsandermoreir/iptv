# Vanta · configuração privada para Android TV

Página estática responsiva para salvar fontes IPTV na conta Google do usuário e solicitar um pareamento de curta duração para o app Android TV. O projeto usa Firebase Authentication, Cloud Firestore, App Check e duas Firebase Callable Functions.

> **Estado da integração:** a página e o backend de pareamento estão implementados. A conexão com a TV só se completa quando o aplicativo Android implementar `redeemPairingCode`, aplicar a fonte recebida e proteger as credenciais no dispositivo. Até essa integração, gerar um código na página não conecta nem autentica uma TV.

## O que está incluído

- Login Google pelo Firebase Authentication. Em dispositivos móveis, o login usa redirecionamento; em navegadores com mouse, usa janela pop-up.
- Fontes Xtream Codes (`URL do servidor`, `usuário`, `senha`) e URL M3U, com criação, edição e exclusão.
- Cada fonte fica em `users/{uid}/sources/{sourceId}`. As regras permitem acesso somente ao mesmo UID.
- O código de pareamento tem 12 caracteres aleatórios, expira em 3 minutos, é guardado no Firestore somente como SHA-256 e é removido atomicamente quando resgatado.
- A coleção `pairingCodes` não pode ser lida ou escrita por clientes. Somente as Cloud Functions usam o Admin SDK.
- A interface não usa `localStorage` para fontes, não adiciona dados de acesso à URL do site, links, QR codes ou logs.

O Firebase Auth pode manter a sessão da conta no navegador. Isso não grava as credenciais IPTV em `localStorage`. O Firestore é a persistência das fontes. Um endereço M3U fornecido pelo usuário pode conter parâmetros ou tokens do provedor; ele é tratado como dado privado do perfil e nunca é copiado para um link de navegação ou QR code.

## 1. Configure o Firebase

1. Crie ou selecione um projeto no [console do Firebase](https://console.firebase.google.com/).
2. Em **Authentication → Sign-in method**, habilite **Google**.
3. Adicione o domínio publicado em **Authentication → Settings → Authorized domains**. Para GitHub Pages de projeto, será algo como `alexsandermoreir.github.io`; inclua também o domínio personalizado, se usar um.
4. Crie o banco do **Cloud Firestore** em modo de produção.
5. Em **Configurações do projeto → Seus apps**, registre um app Web e copie a configuração pública.
6. Edite `firebase-config.js` com os valores do app Web, usando `firebase-config.js.example` como referência, e substitua todos os valores `YOUR_...`. A configuração Web não é segredo; nunca coloque uma senha IPTV, chave privada ou chave de service account nesse arquivo.
7. Cadastre o app Web em **App Check** usando reCAPTCHA Enterprise e informe a chave pública do site como `appCheckSiteKey` no arquivo de configuração. Cadastre também o app Android em App Check usando Play Integrity. As duas Functions exigem tokens App Check válidos.

As regras do Firestore e a autenticação controlam acesso aos dados; ocultar a configuração pública do Firebase não é uma medida de segurança.

## 2. Publique as regras e as Functions

Instale o [Firebase CLI](https://firebase.google.com/docs/cli), entre na conta e associe a pasta ao projeto:

```sh
npm install -g firebase-tools
firebase login
firebase use --add
```

Selecione o projeto cujo `projectId` está em `firebase-config.js`. Depois, instale as dependências e publique as regras e as duas Functions:

```sh
cd functions
npm install
cd ..
firebase deploy --only firestore:rules,functions
```

As Functions usam a região `southamerica-east1`. O deploy do Cloud Functions pode exigir a ativação de faturamento no projeto Firebase/Google Cloud. Nunca compartilhe nem publique a chave de service account; o código usa a identidade de execução administrada pelo Firebase.

## 3. Publique no GitHub Pages

1. Envie os arquivos deste projeto para a raiz do repositório `alexsandermoreir/iptv`.
2. No GitHub, abra **Settings → Pages** e escolha a branch `main` e a pasta `/ (root)` como origem.
3. Aguarde a publicação e abra o endereço Pages do repositório. O `index.html` fica na raiz e os caminhos são relativos, então a página funciona no endereço de projeto `/iptv/`.
4. Confira se o domínio Pages também está em **Authorized domains** do Firebase Authentication.

Não publique `firebase-config.js` com credenciais IPTV dentro dele. O arquivo contém somente configuração pública do app Web. Não adicione fontes reais a commits ou issues.

## Modelo de dados

```text
users/{uid}/sources/{sourceId}
  name, kind, createdAt, updatedAt
  kind=xtream: serverUrl, username, password
  kind=m3u:    m3uUrl

pairingCodes/{sha256(code)}
  uid, sourceId, expiresAt, createdAt
```

As regras em `firestore.rules` negam tudo por padrão, exceto leitura e alteração das fontes do próprio usuário. A coleção global de pareamento não é acessível pelos SDKs clientes. Admin SDK usado pelas Functions ignora as regras do Firestore e fica somente no backend.

## Contrato de pareamento para Android TV

O app Android precisa inicializar Firebase Authentication (para o usuário continuar gerenciando fontes no site) e Firebase App Check com Play Integrity. Para resgatar um código, ele chama a callable `redeemPairingCode` na região `southamerica-east1`, passando o texto digitado pelo usuário:

```json
{ "code": "ABCD-EFGH-JK23" }
```

O Firebase Functions SDK inclui automaticamente o token App Check na chamada. O app não precisa autenticar o mesmo usuário Google para resgatar o código, mas deve ter App Check configurado; a Function é intencionalmente callable sem Auth.

Resposta Xtream:

```json
{
  "source": {
    "id": "sourceId",
    "name": "Minha lista",
    "kind": "xtream",
    "serverUrl": "https://servidor.exemplo.com",
    "username": "usuario",
    "password": "senha"
  }
}
```

Resposta M3U:

```json
{
  "source": {
    "id": "sourceId",
    "name": "Minha lista",
    "kind": "m3u",
    "m3uUrl": "https://servidor.exemplo.com/lista.m3u"
  }
}
```

O resgate é atômico: uma Function verifica a validade, carrega a fonte privada e apaga o documento do código dentro da mesma transação. Um segundo uso retorna erro `failed-precondition`; códigos inexistentes e expirados também falham. A página pode gerar outro código se a TV não concluir a conexão.

Requisitos para o app:

- Usar o Firebase Functions SDK Android e selecionar `southamerica-east1`.
- Tratar `failed-precondition`, falha de rede e exigência de App Check; deixar o usuário gerar um código novo quando necessário.
- Manter senha/URL apenas em memória durante o pareamento e salvar, se necessário, em armazenamento privado protegido pelo Android Keystore. Nunca colocar esses valores em extras de Intent, analytics, crash reports, logs, clipboard, notificações ou links.
- Não incluir as credenciais em uma URI para abrir o app. O código digitado é um token temporário de pareamento, não uma senha nem um substituto de Auth/App Check.
- Explicar ao usuário que a Function envia a configuração para o dispositivo uma vez; após o resgate não há sincronização automática com alterações futuras no site.

## Verificação local

```sh
node --check app.js
node --check functions/src/index.js
```

Sem substituir os placeholders, a página exibe o aviso de configuração e mantém login e pareamento desativados. Os fluxos com Google, Firestore e Cloud Functions só podem ser concluídos depois de configurar o projeto Firebase, publicar as regras e implantar as Functions.

## Referências oficiais

- [Login Google para a Web](https://firebase.google.com/docs/auth/web/google-signin)
- [Regras de segurança do Cloud Firestore](https://firebase.google.com/docs/firestore/security/rules-conditions)
- [Callable Cloud Functions](https://firebase.google.com/docs/functions/callable)
- [App Check para Web com reCAPTCHA Enterprise](https://firebase.google.com/docs/app-check/web/recaptcha-provider)
- [App Check no Android](https://firebase.google.com/docs/app-check/android/play-integrity-provider)
