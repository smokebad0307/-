const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const code = fs.readFileSync(path.join(__dirname, '../auth.js'), 'utf8')
  .replace("import('https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js')", 'Promise.resolve(appFixture)')
  .replace("import('https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js')", 'Promise.resolve(authFixture)');
function app({configured=true,popupError=null,persistenceError=null}={}) {
  const elements=new Map(); let callback,reads=0,clears=0,popupCalls=0,persistence=null,providerParameters=null;
  const auth={};
  function el(id) { if(!elements.has(id))elements.set(id,{hidden:false,disabled:id==='google-login',style:{},textContent:'',
    listeners:{},addEventListener(type,handler){this.listeners[type]=handler;}});return elements.get(id); }
  const authSdk={
    browserSessionPersistence:'session',
    getAuth:()=>auth,setPersistence:async(_,value)=>{if(persistenceError)throw persistenceError;persistence=value;},
    onAuthStateChanged:(_,handler)=>{callback=handler;handler(null);return()=>{};},
    GoogleAuthProvider:class{setCustomParameters(value){providerParameters=value;}},
    signInWithPopup:async()=>{popupCalls++;if(popupError)throw popupError;callback(user('alice'));},
    signOut:async()=>callback(null)
  };
  const context=vm.createContext({window:{NUTRITION_CONFIG:configured?{firebaseApiKey:'public-key',firebaseProjectId:'project'}:{},
    clearUserData:()=>clears++,fetchData:()=>{reads++;}},document:{getElementById:el},
    sessionStorage:{removeItem(){}},appFixture:{initializeApp:()=>({})},authFixture:authSdk});
  vm.runInContext(code,context);
  const user=(uid,token=Promise.resolve('firebase-id-token'))=>({uid,email:uid+'@gmail.com',getIdToken:()=>token});
  return {auth:context.window.NutritionAuth,el,user,state:value=>callback(value),reads:()=>reads,clears:()=>clears,
    popupCalls:()=>popupCalls,persistence:()=>persistence,providerParameters:()=>providerParameters,
    login:()=>el('google-login').listeners.click()};
}
test('unconfigured app keeps Google login disabled and private data hidden',async()=>{
  const a=app({configured:false});await a.auth.init();assert.equal(a.el('tracker').hidden,true);assert.equal(a.el('google-login').disabled,true);assert.equal(a.reads(),0);
});
test('Google popup login selects an account and syncs the signed-in user',async()=>{
  const a=app();await a.auth.init();assert.equal(a.persistence(),'session');assert.equal(a.el('google-login').disabled,false);
  await a.login();assert.equal(a.popupCalls(),1);assert.equal(a.providerParameters().prompt,'select_account');
  assert.equal(a.el('tracker').hidden,false);assert.equal(a.el('user-email').textContent,'alice@gmail.com');assert.equal(a.reads(),1);
  assert.equal(await a.auth.getIdToken(),'firebase-id-token');
});
test('cancelled Google login preserves privacy and allows retry',async()=>{
  const a=app({popupError:{code:'auth/popup-closed-by-user'}});await a.auth.init();await a.login();
  assert.equal(a.auth.signedIn(),false);assert.equal(a.el('tracker').hidden,true);
  assert.match(a.el('auth-message').textContent,/取消/);assert.equal(a.el('google-login').disabled,false);
});
test('blocked popup gives usable instructions',async()=>{
  const a=app({popupError:{code:'auth/popup-blocked'}});await a.auth.init();await a.login();assert.match(a.el('auth-message').textContent,/允許/);
});
test('account changes clear old data and signout hides all records',async()=>{
  const a=app();await a.auth.init();a.state(a.user('alice'));const revision=a.auth.version();const clears=a.clears();
  a.state(a.user('bob'));assert.ok(a.auth.version()>revision);assert.ok(a.clears()>clears);assert.equal(a.el('user-email').textContent,'bob@gmail.com');
  await a.auth.signOut();assert.equal(a.auth.signedIn(),false);assert.equal(a.el('tracker').hidden,true);assert.equal(a.el('user-email').textContent,'');
});
test('late token response cannot be used after signout',async()=>{
  const a=app();await a.auth.init();let resolve;const waiting=new Promise(r=>resolve=r);
  a.state(a.user('alice',waiting));const token=a.auth.getIdToken();await a.auth.signOut();resolve('old-token');
  await assert.rejects(token,/登入狀態已變更/);assert.equal(a.auth.signedIn(),false);
});
test('existing-provider conflict does not create a different owner or reveal data',async()=>{
  const a=app({popupError:{code:'auth/account-exists-with-different-credential'}});await a.auth.init();await a.login();
  assert.equal(a.reads(),0);assert.equal(a.auth.signedIn(),false);assert.match(a.el('auth-message').textContent,/連結原帳號/);
});
test('SDK initialization failure leaves login unavailable',async()=>{
  const a=app({persistenceError:new Error('offline')});await a.auth.init();assert.equal(a.el('google-login').disabled,true);assert.match(a.el('auth-message').textContent,/載入失敗/);
});
