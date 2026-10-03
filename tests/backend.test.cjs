const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const code = fs.readFileSync(path.join(__dirname,'../apps-script/Code.gs'),'utf8');
function environment() {
  const props = { FIREBASE_PROJECT_ID:'test-project', FIREBASE_API_KEY:'public-key', GEMINI_API_KEY:'test-secret', LEGACY_OWNER_UID:'owner' };
  let busy = false, firebaseStatus = 200, disabled = false, validSince = 0, aiCalls = 0, nextId = 0;
  class Sheet {
    constructor(name, rows) { this.name=name; this.rows=rows; }
    getName() { return this.name; }
    getLastRow() { return this.rows.length; }
    appendRow(row) { this.rows.push([...row]); }
    deleteRow(row) { this.rows.splice(row-1,1); }
    getDataRange() { return this.getRange(1,1,this.rows.length,Math.max(...this.rows.map(r=>r.length))); }
    getRange(row,col,count=1,width=1) {
      const read = () => Array.from({length:count},(_,i)=>Array.from({length:width},(_,j)=>String(this.rows[row-1+i]?.[col-1+j] ?? '')));
      return {
        getDisplayValues:read, getDisplayValue:()=>read()[0][0],
        setValue:value=>{ while(this.rows.length<row)this.rows.push([]); this.rows[row-1][col-1]=value; },
        setValues:values=>{ values.forEach((r,i)=>{ while(this.rows.length<row+i)this.rows.push([]); r.forEach((v,j)=>this.rows[row-1+i][col-1+j]=v); }); }
      };
    }
  }
  const logs = new Sheet('Logs', [
    ['ID','Date','Time','FoodName','Calories','Carbs','Protein','Fat','Sodium','OwnerUid'],
    ['a-log','2026-10-04','12:00','A food',100,10,5,3,100,'alice'],
    ['b-log','2026-10-04','12:00','B food',200,20,10,6,200,'bob'],
    ['old-log','2026-10-03','12:00','Legacy',300,30,15,9,300,'']
  ]);
  const settings = new Sheet('Settings', [
    ['Date','TargetCals','Strategy','CarbPct','ProPct','FatPct','OwnerUid'],
    ['2026-10-04',2000,'med',40,35,25,'alice'],
    ['2026-10-04',2500,'high',51,33,16,'bob'],
    ['2026-10-03',1800,'low',22,38,40,'']
  ]);
  const ss = { getSheets:()=>[logs,settings],getSheetByName:name=>name==='Settings'?settings:null,getSpreadsheetTimeZone:()=> 'Asia/Taipei' };
  const token = (uid,extra={}) => 'header.'+Buffer.from(JSON.stringify({
    sub:uid,aud:props.FIREBASE_PROJECT_ID,iss:'https://securetoken.google.com/'+props.FIREBASE_PROJECT_ID,
    exp:Math.floor(Date.now()/1000)+3600,iat:Math.floor(Date.now()/1000),auth_time:Math.floor(Date.now()/1000),...extra
  })).toString('base64url')+'.'+(extra.forged?'forged':'signed');
  const context = vm.createContext({
    ContentService:{MimeType:{JSON:'json'},createTextOutput:content=>({setMimeType:()=>content})},
    PropertiesService:{getScriptProperties:()=>({getProperty:name=>props[name]})},
    Utilities:{base64DecodeWebSafe:value=>Buffer.from(value,'base64url'),newBlob:value=>({getDataAsString:()=>value.toString()}),
      getUuid:()=> 'new-'+(++nextId),formatDate:()=> '12:34'},
    SpreadsheetApp:{getActiveSpreadsheet:()=>ss},
    LockService:{getScriptLock:()=>({tryLock:()=>!busy,releaseLock:()=>{}})},
    UrlFetchApp:{fetch:(url,options)=>{
      if(url.includes('identitytoolkit')) {
        const value = JSON.parse(options.payload).idToken;
        const claims = JSON.parse(Buffer.from(value.split('.')[1],'base64url'));
        const status=value.endsWith('.signed')?firebaseStatus:400;
        return {getResponseCode:()=>status,getContentText:()=>JSON.stringify({users:[{localId:claims.sub,disabled,validSince:String(validSince)}]})};
      }
      aiCalls++;
      return {getResponseCode:()=>200,getContentText:()=>JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({foodName:'food',calories:100,carbs:10,protein:5,fat:3,sodium:100})}]}}]})};
    }}
  });
  vm.runInContext(code,context);
  const call = (uid,data) => JSON.parse(context.doPost({postData:{contents:JSON.stringify({idToken:uid?token(uid):undefined,...data})}}));
  return {context,props,logs,settings,call,token,setBusy:v=>busy=v,setFirebase:v=>firebaseStatus=v,
    setDisabled:v=>disabled=v,setRevoked:v=>validSince=v,aiCalls:()=>aiCalls};
}
test('GET and every POST action reject anonymous requests',()=>{
  const e=environment(); assert.equal(JSON.parse(e.context.doGet()).code,'AUTH_REQUIRED');
  for(const action of ['read','add','update','delete','save_settings','ai_estimate']) assert.equal(e.call(null,{action}).code,'AUTH_REQUIRED');
  assert.equal(e.aiCalls(),0);
});
test('read returns only the verified account, ignoring supplied ownerUid',()=>{
  const e=environment(); const result=e.call('alice',{action:'read',uid:'bob',ownerUid:'bob'});
  assert.deepEqual(result.logs.map(r=>r.id),['a-log']); assert.equal(result.settings.length,1); assert.equal(result.settings[0].targetCals,'2000');
  assert.deepEqual(e.call('bob',{action:'read'}).logs.map(r=>r.id),['b-log']);
});
test('cross-user update and delete cannot affect another account',()=>{
  const e=environment(); const before=JSON.stringify(e.logs.rows);
  assert.equal(e.call('alice',{action:'delete',id:'b-log'}).code,'NOT_FOUND');
  assert.equal(e.call('alice',{action:'update',id:'b-log',date:'2026-10-04',foodName:'stolen',calories:2}).code,'NOT_FOUND');
  assert.equal(JSON.stringify(e.logs.rows),before);
});
test('add/update/delete are owner scoped and preserve the original time',()=>{
  const e=environment();
  assert.equal(e.call('alice',{action:'add',date:'2026-10-04',foodName:'new',calories:100,ownerUid:'bob'}).status,'success');
  assert.equal(e.logs.rows.at(-1)[9],'alice'); assert.equal(e.logs.rows.at(-1)[2],'12:34');
  assert.equal(e.call('alice',{action:'update',id:'a-log',date:'2026-10-05',foodName:'changed',calories:150}).status,'success');
  assert.equal(e.logs.rows[1][2],'12:00'); assert.equal(e.logs.rows[1][3],'changed');
  assert.equal(e.call('alice',{action:'delete',id:'a-log'}).status,'success');
  assert.ok(e.logs.rows.some(r=>r[0]==='b-log'));
});
test('same date settings are separate for each account',()=>{
  const e=environment();
  assert.equal(e.call('alice',{action:'save_settings',date:'2026-10-04',targetCals:2100,strategy:'med',carbPct:40,proPct:35,fatPct:25}).status,'success');
  assert.equal(e.settings.rows[1][1],2100); assert.equal(e.settings.rows[2][1],2500);
});
test('reject expired, foreign-project, forged, disabled and revoked identities',()=>{
  const e=environment();
  for(const extra of [{exp:0},{aud:'foreign'},{iss:'foreign'},{forged:true},{auth_time:0}]) {
    if(extra.auth_time===0)e.setRevoked(10);
    assert.equal(e.call('alice',{action:'read',idToken:e.token('alice',extra)}).code,'AUTH_INVALID');
  }
  e.setRevoked(0); e.setDisabled(true); assert.equal(e.call('alice',{action:'read'}).code,'AUTH_INVALID');
  e.setDisabled(false);e.setFirebase(500);assert.equal(e.call('alice',{action:'read'}).code,'AUTH_UNAVAILABLE');
});
test('migration is explicit, repeatable and does not reassign owned data',()=>{
  const e=environment();
  assert.equal(e.call('owner',{action:'read'}).logs.length,0);
  assert.equal(e.call('alice',{action:'migrateLegacyData'}).code,'INVALID_ACTION');
  e.context.migrateLegacyData();e.context.migrateLegacyData();
  assert.deepEqual(e.call('owner',{action:'read'}).logs.map(r=>r.id),['old-log']);
  assert.equal(e.logs.rows[1][9],'alice');assert.equal(e.settings.rows[3][6],'owner');
});
test('invalid values/dates rejected and formula names stored as text',()=>{
  const e=environment();
  for(const [date,calories] of [['2026-02-30',100],['2026-10-04',-1],['2026-10-04','NaN']])
    assert.equal(e.call('alice',{action:'add',date,calories,foodName:'x'}).code,'VALIDATION');
  e.call('alice',{action:'add',date:'2026-10-04',calories:100,foodName:'=IMPORTXML("url")'});
  assert.ok(e.logs.rows.at(-1)[3].startsWith("'="));
});
test('lock contention reports failure without changing data',()=>{
  const e=environment();e.setBusy(true);const before=JSON.stringify(e.logs.rows);
  assert.equal(e.call('alice',{action:'delete',id:'a-log'}).code,'BUSY');assert.equal(JSON.stringify(e.logs.rows),before);
});
test('AI requires authentication and keeps the selected image MIME type',()=>{
  const e=environment();assert.equal(e.call('alice',{action:'ai_estimate',prompt:'rice'}).status,'success');
  assert.equal(e.call('alice',{action:'ai_estimate',image:'AA==',imageMimeType:'image/svg+xml'}).code,'VALIDATION');
  assert.equal(e.call('alice',{action:'ai_estimate',image:'AA==',imageMimeType:'image/png'}).status,'success');
});
