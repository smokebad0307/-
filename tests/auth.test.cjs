const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../auth.js'),'utf8');
function app({configured=true,saved=null,fetcher}={}) {
  const elements=new Map(),storage=new Map(); if(saved)storage.set('nutrition-session-v1',JSON.stringify(saved));
  function el(id) { if(!elements.has(id))elements.set(id,{value:id==='auth-mode'?'login':'',hidden:false,disabled:false,style:{},textContent:'',
    handlers:{},classList:{toggle(){}},addEventListener(type,callback){this.handlers[type]=callback;},checkValidity(){return this.value.includes('@');}});return elements.get(id); }
  let cleared=0,reads=0,calls=[];
  const context=vm.createContext({window:{NUTRITION_CONFIG:configured?{firebaseApiKey:'public-key',firebaseProjectId:'project'}:{},
    clearUserData:()=>cleared++,fetchData:async()=>{reads++;}},document:{getElementById:el},
    sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    URLSearchParams,Date,fetch:async(url,options)=>{calls.push({url,options});return fetcher?fetcher(url,options):{ok:true,json:async()=>({idToken:'token',refreshToken:'refresh',email:'a@example.com',localId:'alice',expiresIn:'3600'})};}});
  vm.runInContext(code,context);
  const auth=context.window.NutritionAuth;
  return {auth,el,storage,calls,cleared:()=>cleared,reads:()=>reads,submit:()=>el('auth-form').handlers.submit({preventDefault(){}})};
}
test('missing config keeps tracker hidden and disables login',async()=>{
  const a=app({configured:false});await a.auth.init();assert.equal(a.el('tracker').hidden,true);assert.equal(a.el('auth-submit').disabled,true);assert.equal(a.calls.length,0);
});
test('registration mismatch never sends credentials',async()=>{
  const a=app();await a.auth.init();a.el('register-tab').handlers.click();a.el('auth-password').value='longpassword';a.el('auth-confirm').value='different';
  await a.submit();assert.equal(a.calls.length,0);assert.match(a.el('auth-message').textContent,/不一致/);
});
test('login stores session without password and signout clears it and user data',async()=>{
  const a=app();await a.auth.init();a.el('auth-email').value='a@example.com';a.el('auth-password').value='longpassword';
  await a.submit();assert.equal(a.auth.signedIn(),true);assert.equal(a.el('tracker').hidden,false);assert.equal(a.reads(),1);
  assert.equal(a.el('user-email').textContent,'a@example.com');assert.ok(!a.storage.get('nutrition-session-v1').includes('longpassword'));
  a.auth.signOut();assert.equal(a.storage.size,0);assert.equal(a.cleared(),1);assert.equal(a.el('tracker').hidden,true);
});
test('invalid credentials preserve form and restore login button',async()=>{
  const a=app({fetcher:async()=>({ok:false,json:async()=>({error:{message:'INVALID_LOGIN_CREDENTIALS'}})})});await a.auth.init();
  a.el('auth-email').value='a@example.com';a.el('auth-password').value='longpassword';await a.submit();
  assert.equal(a.auth.signedIn(),false);assert.match(a.el('auth-message').textContent,/不正確/);assert.equal(a.el('auth-submit').disabled,false);
});
test('expired session refresh is shared across simultaneous requests',async()=>{
  let resolve,fetchCount=0;const waiting=new Promise(r=>resolve=r);
  const a=app({saved:{idToken:'expired',refreshToken:'old-refresh',email:'a@example.com',uid:'alice',expiresAt:0},
    fetcher:async()=>{fetchCount++;await waiting;return{ok:true,json:async()=>({id_token:'renewed',refresh_token:'new-refresh',expires_in:'3600'})};}});
  await a.auth.init();const first=a.auth.getIdToken(),second=a.auth.getIdToken();resolve();
  assert.equal(await first,'renewed');assert.equal(await second,'renewed');assert.equal(fetchCount,1);
});
test('late token refresh cannot restore a logged-out session',async()=>{
  let resolve;const waiting=new Promise(r=>resolve=r);
  const a=app({saved:{idToken:'expired',refreshToken:'old-refresh',email:'a@example.com',uid:'alice',expiresAt:0},
    fetcher:async()=>{await waiting;return{ok:true,json:async()=>({id_token:'renewed',refresh_token:'new-refresh',expires_in:'3600'})};}});
  await a.auth.init();const pending=a.auth.getIdToken();a.auth.signOut();resolve();await assert.rejects(pending,/登入狀態已變更/);
  assert.equal(a.auth.signedIn(),false);assert.equal(a.storage.size,0);
});
test('refresh network error retains the session for retry',async()=>{
  const a=app({saved:{idToken:'expired',refreshToken:'old-refresh',email:'a@example.com',uid:'alice',expiresAt:0},fetcher:async()=>{throw new Error('offline');}});
  await a.auth.init();await assert.rejects(a.auth.getIdToken(),/網路/);assert.equal(a.auth.signedIn(),true);
});
test('password reset calls Firebase with the entered email',async()=>{
  const a=app();await a.auth.init();a.el('auth-email').value='a@example.com';await a.el('auth-reset').handlers.click();
  assert.ok(a.calls[0].url.includes('sendOobCode'));assert.deepEqual(JSON.parse(a.calls[0].options.body),{requestType:'PASSWORD_RESET',email:'a@example.com'});
});
