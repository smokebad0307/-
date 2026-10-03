(() => {
  'use strict';
  const config = window.NUTRITION_CONFIG || {};
  const sessionKey = 'nutrition-session-v1';
  let session = null, revision = 0, refreshPromise = null;
  const el = id => document.getElementById(id);
  const configured = () => Boolean(config.firebaseApiKey && config.firebaseProjectId);
  function message(text, success = false) {
    el('auth-message').textContent = text;
    el('auth-message').style.color = success ? 'var(--success)' : 'var(--danger)';
  }
  function saveSession(value) {
    session = value;
    try { if (value) sessionStorage.setItem(sessionKey, JSON.stringify(value)); else sessionStorage.removeItem(sessionKey); }
    catch (_) { /* 記憶體登入仍可使用；瀏覽器關閉後必須重新登入。 */ }
  }
  function setView() {
    el('auth-card').hidden = Boolean(session);
    el('user-card').hidden = !session;
    el('tracker').hidden = !session;
    el('user-email').textContent = session ? session.email : '';
  }
  function signOut(text = '') {
    revision++; saveSession(null); refreshPromise = null;
    window.clearUserData();
    el('auth-password').value = '';
    el('auth-confirm').value = '';
    setView(); message(text);
  }
  const errorMessage = code => ({
    EMAIL_EXISTS: '這個 Email 已註冊，請登入或重設密碼。',
    INVALID_EMAIL: '請輸入有效的 Email。',
    WEAK_PASSWORD: '密碼強度不足，請使用至少 8 個字元。',
    INVALID_LOGIN_CREDENTIALS: 'Email 或密碼不正確。',
    EMAIL_NOT_FOUND: 'Email 或密碼不正確。',
    INVALID_PASSWORD: 'Email 或密碼不正確。',
    USER_DISABLED: '帳號已停用，請聯絡管理員。',
    TOO_MANY_ATTEMPTS_TRY_LATER: '嘗試次數過多，請稍後再試。',
    OPERATION_NOT_ALLOWED: '註冊登入尚未開放，請聯絡管理員。',
    API_KEY_INVALID: '登入服務尚未設定完成，請聯絡管理員。'
  }[code] || '登入服務暫時無法使用，請稍後再試。');
  async function firebase(action, data) {
    if (!configured()) throw new Error('登入服務尚未開放，請聯絡管理員。');
    let response;
    try {
      response = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:' + action +
        '?key=' + encodeURIComponent(config.firebaseApiKey), {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)
      });
    } catch (_) { throw new Error('無法連線，請檢查網路後再試。'); }
    const result = await response.json();
    if (!response.ok || result.error) {
      const code = ((result.error || {}).message || '').split(' : ')[0];
      throw new Error(errorMessage(code));
    }
    return result;
  }
  async function getIdToken() {
    if (!session) throw new Error('請先登入。');
    if (session.expiresAt > Date.now() + 60000) return session.idToken;
    if (!refreshPromise) {
      const previous = session, version = revision;
      refreshPromise = (async () => {
        let response;
        try {
          response = await fetch('https://securetoken.googleapis.com/v1/token?key=' +
            encodeURIComponent(config.firebaseApiKey), {
            method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
            body:new URLSearchParams({ grant_type:'refresh_token', refresh_token:previous.refreshToken })
          });
        } catch (_) { throw new Error('無法更新登入，請檢查網路後再試。'); }
        const result = await response.json();
        if (version !== revision || session !== previous) throw new Error('登入狀態已變更。');
        if (!response.ok) {
          if (response.status === 400 || response.status === 401 || response.status === 403)
            signOut('登入已失效，請重新登入。');
          throw new Error('無法更新登入，請稍後再試或重新登入。');
        }
        saveSession({ ...previous, idToken:result.id_token, refreshToken:result.refresh_token,
          expiresAt:Date.now() + Number(result.expires_in) * 1000 });
        return session.idToken;
      })();
      const pending = refreshPromise;
      pending.finally(() => { if (refreshPromise === pending) refreshPromise = null; }).catch(() => {});
    }
    return refreshPromise;
  }
  function setMode(mode) {
    el('auth-mode').value = mode;
    el('confirm-row').hidden = mode !== 'register';
    el('auth-confirm').required = mode === 'register';
    el('auth-password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
    el('auth-submit').textContent = mode === 'register' ? '建立帳號' : '登入';
    el('login-tab').classList.toggle('active', mode === 'login');
    el('register-tab').classList.toggle('active', mode === 'register');
    el('auth-confirm').value = ''; message(configured() ? '' : '登入服務尚未開放，請聯絡管理員。');
  }
  async function submit(event) {
    event.preventDefault();
    const email = el('auth-email').value.trim(), password = el('auth-password').value;
    const mode = el('auth-mode').value, version = revision;
    if (mode === 'register' && (password.length < 8 || password !== el('auth-confirm').value)) {
      message(password.length < 8 ? '註冊密碼請使用至少 8 個字元。' : '兩次輸入的密碼不一致。'); return;
    }
    const btn = el('auth-submit'); btn.disabled = true; btn.textContent = '處理中…'; message('');
    try {
      const result = await firebase(mode === 'register' ? 'signUp' : 'signInWithPassword',
        { email, password, returnSecureToken:true });
      if (revision !== version) return;
      revision++;
      saveSession({ idToken:result.idToken, refreshToken:result.refreshToken,
        expiresAt:Date.now() + Number(result.expiresIn)*1000, email:result.email, uid:result.localId });
      el('auth-password').value = ''; el('auth-confirm').value = '';
      setView(); await window.fetchData();
    } catch (error) { if (revision === version) message(error.message); }
    finally { btn.disabled = !configured(); btn.textContent = mode === 'register' ? '建立帳號' : '登入'; }
  }
  async function resetPassword() {
    const email = el('auth-email').value.trim();
    if (!email || !el('auth-email').checkValidity()) { message('請先輸入有效的 Email，再重設密碼。'); return; }
    const btn = el('auth-reset'); btn.disabled = true;
    try {
      await firebase('sendOobCode', { requestType:'PASSWORD_RESET', email });
      message('若此 Email 已註冊，你會收到重設密碼信，請查看收件匣與垃圾郵件。', true);
    } catch (error) { message(error.message); }
    finally { btn.disabled = !configured(); }
  }
  async function init() {
    el('auth-form').addEventListener('submit', submit);
    el('login-tab').addEventListener('click', () => setMode('login'));
    el('register-tab').addEventListener('click', () => setMode('register'));
    el('auth-reset').addEventListener('click', resetPassword);
    el('auth-logout').addEventListener('click', () => signOut());
    if (!configured()) {
      setView(); message('登入服務尚未開放，請聯絡管理員。');
      el('auth-submit').disabled = true; el('auth-reset').disabled = true; return;
    }
    try {
      const saved = JSON.parse(sessionStorage.getItem(sessionKey));
      if (saved && typeof saved.idToken === 'string' && typeof saved.refreshToken === 'string' &&
          typeof saved.email === 'string' && typeof saved.uid === 'string' &&
          Number.isFinite(saved.expiresAt)) session = saved;
    } catch (_) { saveSession(null); }
    setView();
    if (session) await window.fetchData();
  }
  window.NutritionAuth = { init, getIdToken, signOut, version:() => revision, signedIn:() => Boolean(session) };
})();
