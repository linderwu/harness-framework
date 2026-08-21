# 非同步對話設計

## 目標

agent 執行期間，使用者仍可繼續輸入、送出多則訊息、切換或管理對話；訊息由伺服器持久化後依序執行，並可中斷目前回應。

## 目前採用：方案 2

使用既有 SQLite `execution_jobs` 建立對話佇列。每則訊息先寫入 `conversation_entries` 與 execution job，HTTP API 立即回傳 `202 Accepted`。同一對話只允許一個 dispatcher，前一個 turn 結束後才會啟動下一筆。

前端以資料庫狀態與既有 polling 恢復畫面；不把佇列放在瀏覽器記憶體中。`queued`、`running`、`completed`、`interrupted`、`canceled`、`failed` 會成為可觀察的訊息狀態。

中斷目前回應時，伺服器呼叫 Codex bridge interrupt，保留已產生的部分文字，將目前訊息標記為 `interrupted`，並將同一對話尚未開始的 execution jobs 與訊息標記為 `canceled`。不會自動執行被取消的佇列。

對話切換、新增、重新命名、封存與刪除都不再由 `isTurnRunning` 鎖住。刪除執行中對話時，先停止 session、取消 queued jobs，再刪除對話；前端可立即建立或切換到其他對話。

## 未來採用：方案 3

在方案 2 穩定後，增加以 SSE 傳送 Codex bridge event 的 `/api/conversation/events`。SSE 僅負責 server-to-client 即時更新，不取代 durable queue；訊息命令仍走 HTTP，佇列與取消仍由方案 2 負責。

SSE 使用 bridge 現有的事件 cursor 與 `Last-Event-ID` 續傳，前端斷線時回退到 polling。未來計畫另存於 `docs/superpowers/plans/2026-08-21-async-conversation-option-3.md`，本次不實作。

## 錯誤與一致性

- 每則訊息沿用 idempotency key，重試不會建立重複 user/agent entry 或 execution job。
- dispatcher 以資料庫 claim/lease 序列化同一對話，避免同一 Codex session 同時啟動兩個 turn。
- worker 於長 turn 期間續租；lease 過期後可恢復 queued job。
- UI 的 stale request generation 仍保留，切換對話後不讓舊請求覆蓋新對話。
- SSE 若未來斷線或 cursor 落後，重新 hydration 與 polling 必須能重建完整狀態。

## 驗證

方案 2 必須驗證：多訊息 FIFO、同一 session 不並行、重整後佇列可恢復、中斷後取消 queued 訊息、保留部分回答，以及 agent 執行中仍可進行對話管理操作。

