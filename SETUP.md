# 啟用帳號功能

前端新增 Email 註冊、登入、忘記密碼、登出；Firebase Authentication 管理密碼。
營養紀錄繼續存於原本的 Google 試算表，Apps Script 驗證每次請求的 Firebase token，依 OwnerUid 分開資料。
config.js 已填入 test1-189aa 的 Firebase 公開網頁設定。仍須啟用 Email/Password 並設定、部署 Apps Script 後端，才能使用登入與資料同步。此版本必須前後端一起部署。

## 1. 建立 Firebase 專案

1. 開啟 [Firebase Console](https://console.firebase.google.com/)，建立或選取自己的專案。
2. Authentication → Sign-in method，啟用 Email/Password。
3. 專案設定 → 一般，新增網頁應用程式，取得 apiKey 和 projectId。
4. 將這兩個公開設定填到 config.js 的 firebaseApiKey 和 firebaseProjectId。
5. 若設定 API 金鑰限制，必須允許 Firebase Authentication/Identity Toolkit 及 Secure Token API。
   同一把 Firebase API key 也會由 Apps Script 伺服器使用，僅限瀏覽器 HTTP referrer 的限制會阻擋後端驗證。
   Gemini API key 是不同用途的私密金鑰，切勿填進 config.js。

密碼由 Firebase 管理，不會保存到 Google 試算表。瀏覽器使用 sessionStorage 保存登入 token，
同一分頁重新整理會保留登入；新分頁、其他裝置或關閉分頁後請重新登入。紀錄由雲端同步。

## 2. 更新 Apps Script 後端

1. 先複製備份原本的 Google 試算表與 Apps Script 程式。
2. 以 apps-script/Code.gs 取代原本的程式碼。此程式仍須綁定原本的試算表。
3. 保持食物紀錄為第一個工作表；Settings 是每日目標工作表。
4. 專案設定 → 指令碼屬性（Script Properties），新增：

| 名稱 | 內容 |
| --- | --- |
| FIREBASE_API_KEY | 與 config.js 相同的 Firebase apiKey |
| FIREBASE_PROJECT_ID | 與 config.js 相同的 projectId |
| GEMINI_API_KEY | 新產生的 Gemini API key；不要提交 GitHub |
| LEGACY_OWNER_UID | 你自己的 Firebase 使用者 UID；只供舊紀錄移轉 |

原先貼出的 Gemini API key 已暴露，請至 Google AI Studio/Google Cloud 重新產生，更新私密設定後停用舊金鑰。

後端會在食物表第 10 欄、Settings 第 7 欄新增 OwnerUid。
如果這兩欄已用於別的資料，程式會拒絕覆寫；請先處理欄位衝突。

## 3. 保留你的舊紀錄

1. Firebase Console → Authentication → Users，新增你自己的 Email 使用者，或在設定好的網頁上註冊。
2. 複製該帳號的 UID，填入 LEGACY_OWNER_UID。
3. 在 Apps Script 編輯器選取 migrateLegacyData，按執行並完成 Google 授權。
4. 這只會將沒有 OwnerUid 的舊紀錄與目標指定給該 UID；既有歸屬不會被改寫，可重複執行。

未移轉的資料仍保留在試算表，只是不會出現在任何帳號中。
不要把試算表本身公開分享，或讓一般使用者成為 Apps Script 編輯者。

## 4. 部署順序

1. 先在 Apps Script 更新原本的網頁應用程式部署：部署 → 管理部署 → 編輯 → 新版本 → 部署。
2. 執行身分選擇「我」，存取者選擇「任何人」。網頁 API 自己驗證 Firebase token；
   使用「只有 Google 帳號使用者」會產生 Google 登入重新導向，無法供目前的前端跨來源呼叫。
3. 更新原部署通常可保留原本的 /exec 網址。若改用新部署，請更新 index.html 裡的 GAS_URL。
4. 在部署管理中封存其他仍在運作的舊版部署，以免舊網址繼續提供匿名讀取或修改。
5. 最後才合併前端修改到 GitHub Pages 使用的分支。後端變更與前端上線之間，舊版前端暫時無法使用。
6. 網頁開啟後，檢查註冊、登入、忘記密碼與兩台装置間的紀錄同步。

## 5. 驗收

- A、B 兩個帳號各新增不同紀錄；A 看不到、改不到、刪不到 B 的資料。
- 同一日期的目標策略分開保存。
- 登出後沒有任何營養紀錄出現在畫面。
- 未登入的 GET/POST 都應得到 AUTH_REQUIRED，不能讀取整張表。
- AI 文字與 JPG/PNG/WebP 估算仍可使用；照片限制為 5 MB。
- 模擬斷網時儲存失敗會保留輸入，不會顯示成功。

## 本機測試

有 Node.js 時，在專案目錄執行：

```sh
node --test tests/backend.test.cjs tests/auth.test.cjs
```

測試以 Google/Firebase/試算表模擬物件驗證權限、移轉與登入流程，
不能取代真實雲端部署後的驗收。前端預覽需要以靜態 HTTP 伺服器提供 index.html、auth.js、config.js。

## 官方文件

- [Firebase Email/Password](https://firebase.google.com/docs/auth/web/password-auth)
- [Firebase Authentication REST API](https://firebase.google.com/docs/reference/rest/auth)
- [Apps Script 網頁應用程式](https://developers.google.com/apps-script/guides/web)
