# Agent 週額度血量系統實作計畫

## 目標

在每個 agent 連線卡上顯示目前模型的本週剩餘使用量，包含剩餘比例、已用量/總額度、單位、下次重置時間與資料新鮮度；當額度偏低或同步失敗時，使用者能清楚辨識狀態。

## Requirements Summary

- 額度以 agent 為主鍵，但資料模型必須保留模型與 provider，避免不同模型共用同一額度時無法辨識。
- 支援 `tokens`、`requests`、`credits` 等單位，不把 token 假設寫死在 UI。
- 後端/API 負責計算 `remaining`、百分比與狀態；前端只負責呈現。
- 第一階段先建立可替換的 quota provider/adapter 與 mock/靜態資料，因目前 repository 尚未看到供應商額度查詢 API。
- 不把 workflow run 的 `AgentRun` 當作額度資料；`AgentRun` 是執行紀錄，quota 是 agent/model 的即時狀態。
- 本次先完成 dashboard 顯示與資料介面，不包含真實供應商認證、背景 worker 或通知系統，除非現有 bridge 已提供可用的 usage endpoint。

## 目前程式碼依據

- Agent profile 與 agent kind 位於 `lib/agents.ts`。
- 工作流執行型別與 `AgentRun` 位於 `lib/types.ts`。
- Agent bridge 的 provider/bridge 分流位於 `lib/agent-bridge.ts`。
- Dashboard 的 agent activity 區塊位於 `components/harness-dashboard.tsx` 約 1039 行附近；agent 選單同檔案約 1329 行附近。
- Agent list 與 row 的現有樣式位於 `app/globals.css` 約 1111、1370 行附近。
- 現有驗證腳本為 `npm run lint`、`npm run typecheck`、`npm run build`，定義於 `package.json`。

## Acceptance Criteria

1. 每個可顯示的 agent 卡片都能呈現模型名稱、剩餘百分比、剩餘量/總額度、單位與下次重置時間。
2. 剩餘比例固定由後端/資料層計算，並限制在 0 到 100 之間；總額度為 0 時不會產生 `NaN` 或除以零錯誤。
3. 狀態規則可測試且固定：`healthy > 50%`、`warning 20%–50%`、`critical 0%–20%`、`exhausted = 0`。
4. 額度資料同步失敗或過期時，卡片顯示 stale/error 狀態，不會把上一筆資料誤標為最新。
5. 不同單位能正確格式化；至少驗證 `tokens`、`requests`、`credits` 三種單位。
6. 沒有 quota 資料的 agent 仍能正常渲染卡片，並顯示「尚未同步」或等價 fallback，不阻塞整個 dashboard。
7. desktop 與窄螢幕版面不會讓 progress bar、數字或 reset time 溢出卡片。
8. `npm run lint`、`npm run typecheck` 與 `npm run build` 通過。

## Implementation Steps

### 1. 定義 quota domain model 與計算函式

新增 `lib/agent-quota.ts`，定義：

- `AgentQuotaUnit`：`tokens | requests | credits`。
- `AgentQuotaStatus`：`healthy | warning | critical | exhausted | unavailable | stale`。
- `AgentQuota`：`agentId`、`provider`、`model`、`weeklyLimit`、`weeklyUsed`、`weeklyRemaining`、`remainingPercent`、`unit`、`resetAt`、`updatedAt`、`status`。
- 純函式 `calculateQuotaState()`，集中處理剩餘量、百分比、狀態與邊界值。
- 純函式 `formatQuotaValue()`，依單位格式化數字。

必要時在 `lib/types.ts` 只補充共用型別引用，避免重複定義；不要修改現有 `AgentRun` 語意。

### 2. 建立 quota repository/API 邊界

新增 `lib/agent-quota-store.ts` 或等價資料層，提供以 `AgentKind` 讀取 quota 的介面。第一階段使用可替換的 mock/seed data，並明確標記資料來源與 `updatedAt`。

新增 `app/api/agent-quotas/route.ts`：

- `GET` 一次回傳 dashboard 所需的 agent quota map/list。
- 對缺資料的 agent 回傳 unavailable，而不是省略造成前端無法區分。
- 不在 API route 內放 provider-specific token 或認證邏輯。

若現有 bridge 實際提供 usage endpoint，再新增 adapter 接口（例如 `getWeeklyQuota(agent)`）接入；否則保留 adapter TODO，不虛構真實供應商數值。

### 3. 將 quota 狀態接到 dashboard

修改 `components/harness-dashboard.tsx`：

- 在 dashboard state 中加入 quota map、loading/error 狀態。
- 依 agent profile 產生 quota card，保持 `lib/agents.ts` 的 agent 清單為單一來源。
- 使用現有 icon、panel、row 視覺語言，新增簡單的 progress bar 與狀態標籤。
- 首次載入取得一次資料；若目前頁面已有輪詢/刷新機制，沿用其生命週期加入 quota refresh，否則先採用明確的手動 refresh 或低頻輪詢設計。
- 額度資料不可用時仍渲染 agent 名稱與連線狀態。

### 4. 加入樣式與可及性

修改 `app/globals.css`：

- 新增 quota card、progress track/fill、status modifier classes。
- 顏色至少區分 healthy、warning、critical、exhausted，並同步提供文字狀態，不依賴顏色 alone。
- progress bar 使用 `role="progressbar"`、`aria-valuenow`、`aria-valuemin`、`aria-valuemax`。
- 補上窄版 layout、長模型名稱與大數字的 overflow 規則。

### 5. 補測試與驗證

若 repository 尚未配置測試 runner，先把可測試純函式抽乾淨，並以既有 lint/typecheck/build 作為第一階段 gate；若可引入現有測試慣例，新增 quota calculator 與 route response 測試，不額外引入大型測試框架。

驗證至少涵蓋：正常額度、20%/50% 邊界、0 額度、used 超過 limit、缺資料、過期資料、三種單位與窄版 UI。

## Risks and Mitigations

- **真實額度來源未確定**：先以 provider-neutral adapter 與 mock data 建立邊界；真實同步另列整合工作，避免 UI 綁死某家 API。
- **多個 agent 實際共用一個 provider quota**：資料模型保留 provider/model，後續可加入 quota scope（agent/model/provider），並在顯示時標註共享額度。
- **供應商回傳剩餘量與使用量不一致**：以 provider 回傳的 remaining 為優先；若只有 used/limit，統一在 domain layer 計算並 clamp 到 0–100%。
- **同步失敗造成錯誤信任**：保存 `updatedAt`，超過設定 freshness window 即顯示 stale；不要靜默顯示成 healthy。
- **前端輪詢造成不必要請求**：第一階段採低頻刷新或手動刷新；未來接 WebSocket/SSE 前先確認 bridge 是否支援。
- **卡片資訊過密**：主視覺只顯示剩餘比例與剩餘量，provider、同步時間等次要資訊放在 secondary text 或 tooltip。

## Verification Steps

1. 檢查 `calculateQuotaState()` 的所有邊界與格式化輸出。
2. 用 mock quota data 啟動 dashboard，確認每個 agent 都有卡片，包含 available、unavailable、stale 三種狀態。
3. 檢查瀏覽器 console 無 hydration、React key 或 accessibility 相關錯誤。
4. 使用窄視窗檢查模型名稱、額度數字、進度條與 reset time 不溢出。
5. 執行：

   ```text
   npm run lint
   npm run typecheck
   npm run build
   ```

6. 若接入真實 provider，額外以 provider sandbox/test credential 驗證：成功回傳、401/403、rate limit、timeout 與 malformed response；不把任何 credential 寫入 repository。

## Out of Scope

- 額度耗盡後自動切換模型。
- 額度預測、成本分析、歷史圖表。
- Email/Slack/Toast 通知。
- 修改現有 workflow stage、approval gate 或 agent run 狀態機。
- 新增資料庫 migration；只有在確認需要跨重啟保存同步結果時才另立 persistence plan。

## 建議實作順序

先完成 domain model/calculator，再接 API mock，接著接 dashboard card 與樣式，最後加入真實 provider adapter。每一步都保持 dashboard 可啟動，避免在 provider integration 尚未確定時阻塞 UI 開發。
