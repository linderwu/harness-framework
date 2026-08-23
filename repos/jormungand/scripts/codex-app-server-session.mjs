export function createCodexAppServerSession(input) {
  let threadId = input.threadId

  return {
    async start() {
      await input.request("initialize", {
        clientInfo: {
          name: "jormungand",
          title: "Jormungand",
          version: "0.1.0"
        },
        capabilities: { experimentalApi: true }
      })
      input.notify?.("initialized", {})

      const method = threadId ? "thread/resume" : "thread/start"
      const result = await input.request(method, {
        ...threadPolicy(input),
        ...(threadId ? { threadId } : {})
      })
      threadId = result?.thread?.id ?? threadId
      if (!threadId) throw new Error("Codex did not return a thread id.")
      if (input.name) await this.rename(input.name)
      return { threadId }
    },

    async readThread() {
      return await input.request("thread/read", {
        threadId: requireThreadId(),
        includeTurns: true
      })
    },

    async startTurn(content) {
      const result = await input.request("turn/start", {
        threadId: requireThreadId(),
        input: [{ type: "text", text: content, text_elements: [] }],
        approvalPolicy: "never",
        sandboxPolicy: turnSandboxPolicy(input),
        cwd: input.workspacePath
      })
      const turnId = result?.turn?.id
      if (!turnId) throw new Error("Codex did not return a turn id.")
      return { id: turnId, status: result.turn.status ?? "inProgress" }
    },

    async rename(name) {
      await input.request("thread/name/set", {
        threadId: requireThreadId(),
        name
      })
    },

    async archive() {
      await input.request("thread/archive", { threadId: requireThreadId() })
    },

    async delete() {
      await input.request("thread/delete", { threadId: requireThreadId() })
    },

    async interrupt(turnId) {
      await input.request("turn/interrupt", {
        threadId: requireThreadId(),
        turnId
      })
    },

    get threadId() {
      return threadId
    }
  }

  function requireThreadId() {
    if (!threadId) throw new Error("Codex thread has not started.")
    return threadId
  }
}

function threadPolicy(input) {
  return input.permissionMode === "full"
    ? {
        cwd: input.workspacePath,
        sandbox: "danger-full-access",
        approvalPolicy: "never",
        threadSource: "jormungand"
      }
    : {
        cwd: input.workspacePath,
        sandbox: "workspace-write",
        approvalPolicy: "never",
        threadSource: "jormungand"
      }
}

function turnSandboxPolicy(input) {
  return input.permissionMode === "full"
    ? { type: "dangerFullAccess" }
    : {
        type: "workspaceWrite",
        writableRoots: [input.workspacePath],
        networkAccess: false
      }
}
