# 耶夢加德 Codex 遠端驗收測試計畫

## 目標

確認 `repos/jormungand` 推送到 `main` 後，Zeabur 已部署新版本，並且使用者可以在無任務對話中透過 Codex 修改本地工作區、看到即時過程、暫停/繼續，最後取得持久化結果。

正式驗收網域是 `https://jormungand.zeabur.app/`；`jormungand.zeabur.com` 不是目前 repo 文件記錄的網域，且 DNS 不存在。

## Push 前 gate

1. `npm run typecheck`
2. `npm run lint`
3. `npm test`，所有測試通過
4. `npm run build`
5. 確認只 stage 耶夢加德相關檔案，不能把 workspace 的 `.omx`、AMR 或其他未相關變更帶入 commit。
6. `git push origin main` 後記錄 commit SHA。

## 遠端部署 gate

1. `GET /health` 回應 HTTP 200 且 `ok=true`。
2. 等待 Zeabur 新部署完成；在受保護 UI/API 尚未可用前，不開始功能測試。
3. 以瀏覽器登入 Basic Auth，確認首頁可載入，並確認無任務對話顯示 Codex agent。
4. 確認 `/api/conversation` 回應 `allowedAgents: ["codex"]`。

## 瀏覽器 E2E

### E1：一般 Codex 對話

- 在無任務對話欄送出唯一 marker 指令，只建立 `.tmp-tests/remote-codex-e2e-marker.txt`。
- 觀察 UI 依序出現 working、活動事件/即時文字、Pause/Stop controls。
- 確認最终回覆會取代 working placeholder，且 user/agent entry 都是 completed。
- 透過遠端工作區可觀察方式確認 marker 內容正確，且沒有其他檔案被修改。

### E2：Pause/Continue

- 送出只執行等待、不修改檔案的長任務。
- 按 Pause，確認顯示 paused 與 Continue。
- 按 Continue，確認重新進入 working，最後回到 ready/completed。

### E3：持久化

- E1 完成後重新載入頁面。
- 確認 user prompt、Codex final response、completed status 仍存在。
- 確認不會重複建立同一個 idempotency key 的 response。

### E4：安全與失敗路徑

- 未登入的 root/API 應維持 401；`/health` 維持公開。
- 不允許未選定的非 Codex agent 取代無任務 Codex target。
- Bridge 不可用時，UI 顯示可理解的錯誤，不應假裝完成。

## 完成條件

只有在 push commit、Zeabur health、已登入首頁、E1、E2、E3 全部有證據後，才宣告遠端驗收完成。任何一項未通過都要保留為 blocked，不把本地測試結果代替遠端驗收。
