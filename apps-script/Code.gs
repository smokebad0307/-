// 綁定原本營養紀錄試算表的 Apps Script。
// 設定 Script Properties：FIREBASE_API_KEY、FIREBASE_PROJECT_ID、GEMINI_API_KEY。
// 舊資料移轉另外設定 LEGACY_OWNER_UID，再從編輯器執行 migrateLegacyData。
function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
function fail_(code, message) {
  var err = new Error(message); err.code = code; throw err;
}
function property_(name) {
  var value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value) fail_('CONFIG_ERROR', '伺服器尚未完成設定，請聯絡管理員。');
  return value;
}
function authenticate_(token) {
  if (typeof token !== 'string' || token.length > 10000 || token.split('.').length !== 3)
    fail_('AUTH_REQUIRED', '請先登入。');
  var claims;
  try { claims = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(token.split('.')[1])).getDataAsString()); }
  catch (_) { fail_('AUTH_INVALID', '登入已失效，請重新登入。'); }
  var project = property_('FIREBASE_PROJECT_ID');
  var now = Math.floor(Date.now() / 1000);
  if (claims.aud !== project || claims.iss !== 'https://securetoken.google.com/' + project ||
      typeof claims.exp !== 'number' || claims.exp <= now ||
      typeof claims.iat !== 'number' || claims.iat > now + 60 ||
      typeof claims.auth_time !== 'number' || claims.auth_time > now + 60 ||
      typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128)
    fail_('AUTH_INVALID', '登入已失效，請重新登入。');
  // 解碼只用來檢查預期專案；必須透過 Google 驗證 token，不能信任解碼結果或前端傳入的 uid。
  var response = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' +
    encodeURIComponent(property_('FIREBASE_API_KEY')), {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ idToken: token }), muteHttpExceptions: true
  });
  if (response.getResponseCode() >= 500) fail_('AUTH_UNAVAILABLE', '登入驗證暫時無法使用，請稍後再試。');
  if (response.getResponseCode() !== 200) fail_('AUTH_INVALID', '登入已失效，請重新登入。');
  var result = JSON.parse(response.getContentText());
  var user = result.users && result.users[0];
  if (!user || user.disabled || user.localId !== claims.sub ||
      claims.auth_time < Number(user.validSince || 0))
    fail_('AUTH_INVALID', '登入已失效，請重新登入。');
  return user.localId;
}
function doGet() {
  // 禁止沿用舊版的匿名全資料讀取；token 不放在網址。
  return json_({ status: 'error', code: 'AUTH_REQUIRED', message: '請先登入並使用 POST 讀取紀錄。' });
}
function doPost(e) {
  var lock, locked = false;
  try {
    var data = JSON.parse(e.postData.contents);
    var uid = authenticate_(data.idToken);
    if (data.action === 'ai_estimate') return json_({ status: 'success', data: estimate_(data) });
    lock = LockService.getScriptLock();
    locked = lock.tryLock(10000);
    if (!locked) fail_('BUSY', '資料正在儲存，請稍後再試。');
    var sheets = sheets_();
    if (data.action === 'read') return json_({ status: 'success', logs: logs_(sheets.logs, uid), settings: settings_(sheets.settings, uid) });
    if (data.action === 'save_settings') {
      date_(data.date);
      var values = [data.date, number_(data.targetCals, 100000, true),
        strategy_(data.strategy), number_(data.carbPct, 100), number_(data.proPct, 100), number_(data.fatPct, 100), uid];
      var rows = sheets.settings.getDataRange().getDisplayValues();
      var index = rows.findIndex(function(row, i) { return i > 0 && row[0] === data.date && row[6] === uid; });
      if (index >= 0) sheets.settings.getRange(index + 1, 1, 1, 7).setValues([values]);
      else sheets.settings.appendRow(values);
    } else if (data.action === 'add' || data.action === 'update') {
      date_(data.date);
      if (typeof data.foodName !== 'string' || !data.foodName.trim() || data.foodName.length > 200)
        fail_('VALIDATION', '請輸入 1 到 200 字的食物名稱。');
      var rows = sheets.logs.getDataRange().getDisplayValues();
      var index = -1;
      if (data.action === 'update') {
        index = ownedRow_(rows, data.id, uid);
        if (index < 0) fail_('NOT_FOUND', '找不到這筆紀錄。');
      }
      var now = new Date();
      var values = [data.action === 'add' ? Utilities.getUuid() : String(data.id), data.date,
        index >= 0 ? rows[index][2] : Utilities.formatDate(now, SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'HH:mm'),
        sheetText_(data.foodName.trim()), number_(data.calories, 1000000),
        number_(data.carbs || 0, 1000000), number_(data.protein || 0, 1000000),
        number_(data.fat || 0, 1000000), number_(data.sodium || 0, 1000000), uid];
      if (index >= 0) sheets.logs.getRange(index + 1, 1, 1, 10).setValues([values]);
      else sheets.logs.appendRow(values);
    } else if (data.action === 'delete') {
      var index = ownedRow_(sheets.logs.getDataRange().getDisplayValues(), data.id, uid);
      if (index < 0) fail_('NOT_FOUND', '找不到這筆紀錄。');
      sheets.logs.deleteRow(index + 1);
    } else fail_('INVALID_ACTION', '不支援這項操作。');
    return json_({ status: 'success' });
  } catch (error) {
    // 不回傳第三方完整錯誤，避免洩漏設定與機密。
    return json_({ status: 'error', code: error.code || 'SERVER_ERROR',
      message: error.code ? error.message : '處理失敗，請稍後再試。' });
  } finally { if (locked) lock.releaseLock(); }
}
function sheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var logs = ss.getSheets()[0];
  if (logs.getName() === 'Settings') fail_('CONFIG_ERROR', '第一個工作表必須是食物紀錄。');
  if (!logs.getLastRow()) logs.appendRow(['ID', 'Date', 'Time', 'FoodName', 'Calories', 'Carbs', 'Protein', 'Fat', 'Sodium', 'OwnerUid']);
  ownerColumn_(logs, 10);
  var settings = ss.getSheetByName('Settings');
  if (!settings) settings = ss.insertSheet('Settings');
  if (!settings.getLastRow()) settings.appendRow(['Date', 'TargetCals', 'Strategy', 'CarbPct', 'ProPct', 'FatPct', 'OwnerUid']);
  ownerColumn_(settings, 7);
  return { logs: logs, settings: settings };
}
function ownerColumn_(sheet, column) {
  var header = sheet.getRange(1, column).getDisplayValue();
  if (header && header !== 'OwnerUid') fail_('CONFIG_ERROR', '使用者欄位位置已有其他資料，請聯絡管理員。');
  if (!header) sheet.getRange(1, column).setValue('OwnerUid');
}
function ownedRow_(rows, id, uid) {
  if (typeof id !== 'string' || !id || id.length > 128) fail_('VALIDATION', '紀錄編號無效。');
  return rows.findIndex(function(row, i) { return i > 0 && row[0] === id && row[9] === uid; });
}
function logs_(sheet, uid) {
  return sheet.getDataRange().getDisplayValues().slice(1).filter(function(r) { return r[9] === uid; }).map(function(r) {
    return { id:r[0], date:r[1], time:r[2], foodName:r[3], calories:r[4], carbs:r[5], protein:r[6], fat:r[7], sodium:r[8] };
  });
}
function settings_(sheet, uid) {
  return sheet.getDataRange().getDisplayValues().slice(1).filter(function(r) { return r[6] === uid; }).map(function(r) {
    return { date:r[0], targetCals:r[1], strategy:r[2], carbPct:r[3], proPct:r[4], fatPct:r[5] };
  });
}
function number_(value, max, positive) {
  if (value === '' || value === null || typeof value === 'boolean' || !Number.isFinite(Number(value)) ||
      Number(value) < (positive ? 1 : 0) || Number(value) > max)
    fail_('VALIDATION', '營養數值或目標超出有效範圍。');
  return Number(value);
}
function date_(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value)
    fail_('VALIDATION', '日期格式無效。');
}
function strategy_(value) {
  if (['high','med','low','custom'].indexOf(value) < 0) fail_('VALIDATION', '碳循環策略無效。');
  return value;
}
function sheetText_(value) { return /^[=+@-]/.test(value) ? "'" + value : value; }
function estimate_(data) {
  if (typeof data.prompt !== 'undefined' && (typeof data.prompt !== 'string' || data.prompt.length > 3000))
    fail_('VALIDATION', '食物描述請保持在 3000 字內。');
  if (!data.prompt && !data.image) fail_('VALIDATION', '請提供食物描述或照片。');
  var parts = [{ text: '分析「' + (data.prompt || '請辨識照片中的食物') +
    '」的營養成分。根據圖片份量估算。嚴格回傳 JSON，包含 foodName(字串)、calories、carbs、protein、fat、sodium(非負數字)，無資料填0。' }];
  if (data.image) {
    if (typeof data.image !== 'string' || data.image.length > 7000000 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(data.image) ||
        ['image/jpeg','image/png','image/webp'].indexOf(data.imageMimeType) < 0)
      fail_('VALIDATION', '請提供 5 MB 以下的 JPG、PNG 或 WebP 照片。');
    parts.push({ inlineData: { mimeType: data.imageMimeType, data: data.image } });
  }
  var response = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
    method:'post', contentType:'application/json',
    headers:{ 'x-goog-api-key':property_('GEMINI_API_KEY') },
    payload:JSON.stringify({ contents:[{ parts:parts }], generationConfig:{ responseMimeType:'application/json' } }),
    muteHttpExceptions:true
  });
  if (response.getResponseCode() !== 200) fail_('AI_ERROR', 'AI 估算暫時無法使用，請稍後再試。');
  var result = JSON.parse(JSON.parse(response.getContentText()).candidates[0].content.parts.map(function(p) { return p.text || ''; }).join(''));
  if (typeof result.foodName !== 'string' || !result.foodName.trim() || result.foodName.length > 200)
    fail_('AI_ERROR', 'AI 回傳格式無效，請再試一次。');
  ['calories','carbs','protein','fat','sodium'].forEach(function(key) { result[key] = number_(result[key], 1000000); });
  return result;
}
// 只可在 Apps Script 編輯器手動執行；不提供網頁端認領舊紀錄的入口。
function migrateLegacyData() {
  var uid = property_('LEGACY_OWNER_UID').trim();
  if (!uid || uid.length > 128 || /^[=+@-]/.test(uid)) throw new Error('LEGACY_OWNER_UID 無效。');
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('請稍後再試。');
  try {
    var sheets = sheets_();
    [[sheets.logs,10],[sheets.settings,7]].forEach(function(pair) {
      var sheet = pair[0], column = pair[1];
      if (sheet.getLastRow() < 2) return;
      var range = sheet.getRange(2,column,sheet.getLastRow()-1,1);
      var values = range.getDisplayValues().map(function(row) { return [row[0] || uid]; });
      range.setValues(values);
    });
  } finally { lock.releaseLock(); }
}
