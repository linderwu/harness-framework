# Harness Framework 使用手冊

這個專案是 Jormungandr / Harness dashboard。Dashboard 讓使用者建立 workflow run，選擇 `codex` 或 OpenClaw agent executor，並透過 approval gates 管控 plan、design、verification 等階段。

## 系統組成

```txt
Browser
  -> Next.js dashboard
  -> /api/workflow-runs
  -> agent bridge boundary
     -> Codex bridge: local codex exec
     -> OpenClaw bridge URL: HTTP request/response runner
     -> OpenClaw A2A command: stdin/stdout wrapper to OpenClaw server
```

主要元件：

- `npm run dev`：啟動 Next.js dashboard，預設 `http://localhost:3000`。
- `npm run codex-bridge`：啟動本機 Codex bridge，預設 `http://127.0.0.1:4177`。
- OpenClaw server：目前本機 profile 指向 SSH host `192.168.28.128`，Docker container `openclaw`。
- OpenClaw A2A command：dashboard 可透過 `OPENCLAW_A2A_COMMAND` 將 A2A JSON envelope 送到 OpenClaw。

## 前置需求

- Node.js 20+
- npm
- Codex CLI，可用 `codex --version` 檢查
- 如需 OpenClaw：可 SSH 連到 OpenClaw host，且 host 上有 `openclaw` container / CLI

第一次安裝：

```powershell
npm install
```

本機 secret 不要寫進 repo。`.env.local`、`.env`、`.secrets/` 都應只留在本機或部署平台的 secret manager。

## 快速啟動

建議開三個 terminal。

Terminal 1：啟動 Codex bridge。

```powershell
$env:CODEX_BRIDGE_REPO_ROOT = "C:\Users\linder\Documents\harness框架"
$env:CODEX_BRIDGE_RUNTIME_SKILLS = "1"
npm run codex-bridge
```

Terminal 2：啟動 dashboard，並指向本機 bridge。

```powershell
$env:CODEX_BRIDGE_URL = "http://127.0.0.1:4177"
npm run dev
```

Terminal 3：檢查健康狀態。

```powershell
Invoke-RestMethod http://127.0.0.1:4177/health
Invoke-RestMethod http://localhost:3000/api/agent-health
```

打開 dashboard：

```txt
http://localhost:3000
```

## 啟動 Codex

Codex bridge 會在 workflow event 被指派給 `codex` 時執行 Codex CLI。實際命令形狀是：

```powershell
codex exec -c service_tier="fast" -C <repo> --skip-git-repo-check --sandbox workspace-write --output-last-message <tmp-file> -
```

常用環境變數：

```txt
CODEX_BRIDGE_HOST=127.0.0.1
CODEX_BRIDGE_PORT=4177
CODEX_BRIDGE_REPO_ROOT=C:\Users\linder\Documents\harness框架
CODEX_BRIDGE_COMMAND=codex
CODEX_BRIDGE_SANDBOX=workspace-write
CODEX_BRIDGE_SERVICE_TIER=fast
CODEX_BRIDGE_TIMEOUT_MS=900000
CODEX_BRIDGE_RUNTIME_SKILLS=1
HARNESS_BRIDGE_TOKEN=<local-only-or-tunnel-secret>
```

如果設定 `HARNESS_BRIDGE_TOKEN`，呼叫 bridge 時要帶 bearer token。dashboard 端對應設定：

```powershell
$env:CODEX_BRIDGE_URL = "http://127.0.0.1:4177"
$env:CODEX_BRIDGE_TOKEN = "<same-value-as-HARNESS_BRIDGE_TOKEN>"
```

沒有設定 `CODEX_BRIDGE_URL` 時，Codex executor 預設會 fail closed。只有在刻意做 demo artifact 時才設定：

```powershell
$env:HARNESS_ALLOW_SIMULATED_AGENTS = "1"
```

## 啟動 OpenClaw Server

本機 OpenClaw profile：

```txt
OPENCLAW_SSH_USER=linder
OPENCLAW_SSH_HOST=192.168.28.128
OPENCLAW_CONTAINER=openclaw
```

先確認 SSH 和 container 可用：

```powershell
ssh linder@192.168.28.128
docker ps
docker exec -it openclaw openclaw --help
```

OpenClaw agent session 對應：

```txt
rowlet      -> agent:rowlet:a2a-codex
roaringmoon -> agent:roaringmoon:a2a-codex
charizard   -> agent:charizard:a2a-codex
```

OpenClaw CLI 直接測試範例：

```sh
docker exec -i openclaw openclaw agent \
  --agent rowlet \
  --model minimax/MiniMax-M2.7 \
  --session-key agent:rowlet:a2a-codex \
  --message "ping" \
  --json
```

## 啟動 OpenClaw Bridge / A2A

Dashboard 支援兩種 OpenClaw 路徑。

### 路徑 A：HTTP Bridge

如果有獨立 OpenClaw HTTP runner，設定：

```powershell
$env:OPENCLAW_BRIDGE_URL = "https://<openclaw-bridge-host>"
$env:OPENCLAW_BRIDGE_TOKEN = "<secret-if-required>"
```

OpenClaw HTTP bridge 要接收 `POST /agent-runs`，並回傳和 Codex bridge 相容的 JSON：

```json
{
  "id": "external-run-id",
  "status": "completed",
  "output": "agent final message"
}
```

### 路徑 B：A2A Command

如果 OpenClaw 還沒有正式 HTTP endpoint，使用 `OPENCLAW_A2A_COMMAND`。dashboard 會把 A2A JSON envelope 寫到 command stdin，command 將 stdout 回傳 dashboard。

```powershell
$env:OPENCLAW_A2A_COMMAND = "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\linder\Documents\harness框架\scripts\openclaw-a2a.ps1"
$env:OPENCLAW_A2A_PROTOCOL = "legacy-clawcodex-v0.1"
$env:OPENCLAW_A2A_MODEL = "minimax/MiniMax-M2.7"
$env:OPENCLAW_A2A_TIMEOUT_MS = "600000"
```

可用 protocol：

```txt
legacy-clawcodex-v0.1
public-a2a-v0.3
```

command 執行時，dashboard 會依所選 OpenClaw profile 注入：

```txt
OPENCLAW_A2A_AGENT=rowlet|roaringmoon|charizard
OPENCLAW_A2A_SESSION_KEY=agent:<agent>:a2a-codex
OPENCLAW_A2A_MODEL=minimax/MiniMax-M2.7
OPENCLAW_A2A_PROTOCOL=legacy-clawcodex-v0.1
```

若使用 SSH wrapper，secret 來源順序建議為：

```txt
OPENCLAW_SSH_PASSWORD
OPENCLAW_SSH_PASSWORD_FILE
.secrets/openclaw-ssh-password.dpapi
```

不要 commit OpenClaw SSH 密碼或 bridge token。

## 完整本機啟動範例

Terminal 1：

```powershell
$env:CODEX_BRIDGE_REPO_ROOT = "C:\Users\linder\Documents\harness框架"
$env:CODEX_BRIDGE_RUNTIME_SKILLS = "1"
$env:HARNESS_BRIDGE_TOKEN = "<local-secret>"
npm run codex-bridge
```

Terminal 2：

```powershell
$env:CODEX_BRIDGE_URL = "http://127.0.0.1:4177"
$env:CODEX_BRIDGE_TOKEN = "<local-secret>"
$env:OPENCLAW_A2A_COMMAND = "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\linder\Documents\harness框架\scripts\openclaw-a2a.ps1"
$env:OPENCLAW_A2A_PROTOCOL = "legacy-clawcodex-v0.1"
npm run dev
```

Terminal 3：

```powershell
Invoke-RestMethod http://127.0.0.1:4177/health
Invoke-RestMethod http://localhost:3000/api/agent-health
```

## Dashboard 使用流程

1. 開啟 `http://localhost:3000`。
2. 建立或選擇 project。
3. 輸入 requirement、repository reference、context files。
4. 選擇 workflow default executor：`codex` 或 OpenClaw profile。
5. 需要時覆寫單一 workflow skill 的 executor。
6. 建立 run。
7. 依 approval gates 推進 plan、design、verification。
8. 檢查每個 artifact 的 source、status、external run id、status message。

## 部署 / Tunnel

Zeabur 或其他遠端部署無法直接連到本機 `127.0.0.1`。若 dashboard 在遠端、Codex bridge 在本機，需用 Cloudflare Tunnel、ngrok 或同等 tunnel 暴露 bridge。

遠端 dashboard 設定：

```txt
CODEX_BRIDGE_URL=https://codex-bridge.jormungandcycle.com
CODEX_BRIDGE_TOKEN=<same-secret-as-local-HARNESS_BRIDGE_TOKEN>
SITE_AUTH_USERNAME=<configured-in-platform>
SITE_AUTH_PASSWORD=<configured-in-platform>
```

本機 bridge：

```powershell
$env:HARNESS_BRIDGE_TOKEN = "<same-secret-as-remote>"
$env:CODEX_BRIDGE_REPO_ROOT = "C:\Users\linder\Documents\harness框架"
$env:CODEX_BRIDGE_RUNTIME_SKILLS = "1"
npm run codex-bridge
```

公開健康檢查預期：

```txt
https://jormungand.zeabur.app/api/agent-health
```

Codex bridge health 預期包含：

```txt
ok=true
protocolVersion=harness-agent-bridge/v0.3
capabilities=cancel, stop, active-run-status, idempotency-key, text-output, runtime-skill-bundles
```

## 驗證指令

```powershell
npm run typecheck
npm run lint
npm run test
npm run build
```

開發中可先跑最窄檢查：

```powershell
npm run typecheck
```

## 常見問題

`Codex bridge is not reachable`

- 確認 `npm run codex-bridge` 還在跑。
- 確認 dashboard shell 設了 `CODEX_BRIDGE_URL=http://127.0.0.1:4177`。
- 若 bridge 有 token，確認 `CODEX_BRIDGE_TOKEN` 和 `HARNESS_BRIDGE_TOKEN` 一致。

`bridge does not support runtime skill bundles`

- 啟動 bridge 前設定 `CODEX_BRIDGE_RUNTIME_SKILLS=1`。
- 遠端 dashboard 需要使用 `harness-agent-bridge/v0.3` 能力。

`OpenClaw has no configured bridge`

- 設定 `OPENCLAW_BRIDGE_URL` 或 `OPENCLAW_A2A_COMMAND`。
- 確認 workflow 選到的是 `openclaw.rowlet`、`openclaw.roaringmoon` 或 `openclaw.charizard`。

`OpenClaw A2A command failed`

- 確認 SSH host `192.168.28.128` 可連。
- 確認 `openclaw` container 在 server 上執行中。
- 確認 SSH password 由環境變數、password file 或 DPAPI secret 提供。
- 先在 OpenClaw server 上用 `docker exec -i openclaw openclaw agent ... --json` 做最小測試。

`Only simulated artifacts are produced`

- 檢查是否設定了 `HARNESS_ALLOW_SIMULATED_AGENTS=1`。
- 若不是刻意 demo，移除此設定並配置真實 bridge。

## Git 操作建議

提交前確認只包含本次要改的檔案：

```powershell
git status --short
git diff -- README.md
```

推到 main：

```powershell
git add README.md
git commit -m "Add system usage manual"
git push origin HEAD:main
```
