# Live Codex session 左下角版面設計

## 目標

將 Conversation 內的 `Live Codex session` 活動面板，以頁面配置方式固定在整個 viewport 的左下角。只調整 `app/globals.css` 的版面規則，不修改 React 結構、資料流、事件控制或可見文字。

## 核准方案

採用 CSS-only 的固定浮層：`.codexActivity` 使用 `position: fixed`，以 `left` 與 `bottom` 貼齊頁面左下側，並設定有限寬高與較高層級，使它脫離 Conversation 內部 grid 的原本排列。既有 `.codexActivityHeader`、事件清單、即時回覆與 Pause / Continue / Stop 控制保持原樣。

## 版面規則

- 桌面版固定在 viewport 左側與底部的既有頁面間距內。
- 寬度使用 `min()` 或等價的 responsive 限制，避免小視窗超出左右邊界。
- 高度與事件清單維持可控，事件清單在面板內滾動，不推動主 Conversation 內容。
- 面板在 Conversation 內仍保留原本的背景、邊框與內部排版語意，只覆寫外部定位與必要的浮層視覺。
- 窄螢幕沿用左下定位，但寬度改為可用 viewport 寬度；底部間距需避開安全區域與現有輸入區的主要互動範圍。
- 不新增 DOM、資料屬性、狀態、API 或依賴。

## 元件與資料流

元件樹與資料流不變：`TaskConversation` 繼續渲染 `section.codexActivity`，由現有 session / events state 提供內容。CSS 只改變該 section 的視覺位置，不改變 React 生命週期或控制函式。

## 互動與錯誤處理

不新增錯誤處理。現有按鈕、`aria-live` 區域與滾動事件清單保留原行為；固定定位不可讓面板阻擋其自身控制項。當沒有 session 時，元件仍由既有條件不渲染。

## 驗證

- 靜態檢查 `.codexActivity` 的定位、左下偏移、z-index、寬高限制與 overflow 規則。
- 執行既有 lint、typecheck 與測試。
- 在桌面與窄螢幕 viewport 檢查面板位於左下、事件清單可滾動、輸入區仍可操作。
- 確認變更只落在頁面配置樣式，`task-conversation.tsx` 與 API / state 檔案沒有修改。
