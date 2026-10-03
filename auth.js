(() => {
  'use strict';
  const config = window.NUTRITION_CONFIG || {};
  const el = id => document.getElementById(id);
  let sdk, auth, currentUser = null, revision = 0, busy = false, initializing = null;
  function message(text) { el('auth-message').textContent = text; }
  function render() {
    el('auth-card').hidden = Boolean(currentUser);
    el('user-card').hidden = !currentUser;
    el('tracker').hidden = !currentUser;
    el('user-email').textContent = currentUser ? currentUser.email || currentUser.displayName || 'Google 使用者' : '';
  }
  function errorText(error) {
    return ({
      'auth/popup-blocked': '登入視窗被阻擋，請允許此網站開啟彈出式視窗後再試。',
      'auth/popup-closed-by-user': '登入已取消，請再按一次「使用 Google 登入」。',
      'auth/cancelled-popup-request': '登入已取消，請稍後再試。',
      'auth/unauthorized-domain': '這個網站尚未開放 Google 登入，請聯絡管理員。',
      'auth/operation-not-allowed': 'Google 登入尚未開放，請聯絡管理員。',
      'auth/account-exists-with-different-credential': '這個 Email 已使用其他方式註冊，請聯絡管理員協助連結原帳號，以保留紀錄。',
      'auth/network-request-failed': '無法連線，請檢查網路後再試。',
      'auth/user-disabled': '帳號已停用，請聯絡管理員。',
      'auth/invalid-api-key': '登入服務尚未設定完成，請聯絡管理員。',
      'auth/too-many-requests': '嘗試次數過多，請稍後再試。'
    })[error.code] || 'Google 登入暫時無法使用，請稍後再試。';
  }
  function setUser(user) {
    revision++; currentUser = user;
    window.clearUserData(); render(); message('');
    if (user) window.fetchData();
  }
  function signOut(text = '') {
    revision++; currentUser = null;
    window.clearUserData(); render(); message(text);
    if (!sdk || !auth) return Promise.resolve();
    return sdk.signOut(auth).catch(() => {
      message('登出未完成，請重新整理後再試一次。');
    });
  }
  async function getIdToken() {
    const user = currentUser, version = revision;
    if (!user) throw new Error('請先登入。');
    try {
      const token = await user.getIdToken();
      if (version !== revision || currentUser !== user) throw new Error('登入狀態已變更。');
      return token;
    } catch (error) {
      if (version !== revision || currentUser !== user) throw new Error('登入狀態已變更。');
      if (['auth/user-token-expired', 'auth/invalid-user-token', 'auth/user-disabled'].includes(error.code))
        signOut('登入已失效，請重新登入。');
      throw new Error(error.code ? errorText(error) : error.message);
    }
  }
  async function login() {
    if (busy || !auth) return;
    busy = true;
    const btn = el('google-login'); btn.disabled = true; btn.textContent = 'Google 登入中…'; message('');
    try {
      const provider = new sdk.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      // 直接由按鈕事件開啟彈出視窗，避免等待其他工作後失去瀏覽器的使用者手勢。
      await sdk.signInWithPopup(auth, provider);
    } catch (error) { message(errorText(error)); }
    finally { busy = false; btn.disabled = false; btn.textContent = '使用 Google 登入'; }
  }
  async function initialize() {
    el('google-login').addEventListener('click', login);
    el('auth-logout').addEventListener('click', () => signOut());
    render();
    if (!config.firebaseApiKey || !config.firebaseProjectId) {
      message('登入服務尚未開放，請聯絡管理員。'); return;
    }
    try {
      const [appSdk, authSdk] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js')
      ]);
      sdk = authSdk;
      const app = appSdk.initializeApp({
        apiKey: config.firebaseApiKey, projectId: config.firebaseProjectId,
        authDomain: config.firebaseAuthDomain || config.firebaseProjectId + '.firebaseapp.com'
      });
      auth = sdk.getAuth(app);
      await sdk.setPersistence(auth, sdk.browserSessionPersistence);
      // 移除舊版 REST 登入憑證；新版只由 Firebase SDK 管理登入與 token 更新。
      try { sessionStorage.removeItem('nutrition-session-v1'); } catch (_) {}
      await new Promise((resolve, reject) => {
        let first = true;
        sdk.onAuthStateChanged(auth, user => {
          setUser(user);
          if (first) { first = false; resolve(); }
        }, error => {
          message(errorText(error)); reject(error);
        });
      });
      el('google-login').disabled = false;
    } catch (_) { message('登入服務載入失敗，請檢查網路後重新整理。'); }
  }
  function init() { if (!initializing) initializing = initialize(); return initializing; }
  window.NutritionAuth = { init, getIdToken, signOut, version:() => revision, signedIn:() => Boolean(currentUser) };
})();
