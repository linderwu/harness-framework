import assert from "node:assert/strict"
import { resolve } from "node:path"
import test from "node:test"
import ts from "typescript"

const guardedWrites = new Set([
  "insertConversation",
  "updateConversation",
  "createConversationDispatch",
  "claimNextConversationDispatch",
  "cancelQueuedConversationDispatches",
  "completeExecutionJob",
  "failExecutionJob",
  "submitConversationTurn",
  "claimNextConversationTurn",
  "settleConversationTurn",
  "cancelPendingConversationTurns",
  "stopConversationTurn",
  "moveConversation",
  "createConversation",
  "updateConversationProfile",
  "renameConversation",
  "setConversationState",
  "deleteConversation",
  "mergeConversationEntries"
])

interface DirectRepositoryWrite {
  file: string
  containingFunction: string
  method: string
}

const legacyBoundWriterAllowlist: readonly DirectRepositoryWrite[] = [
  { file: "lib/conversation-dispatcher.ts", containingFunction: "ConversationDispatcher.runLegacyDrain", method: "claimNextConversationDispatch" },
  { file: "lib/conversation-dispatcher.ts", containingFunction: "ConversationDispatcher.runLegacyJob", method: "completeExecutionJob" },
  { file: "lib/conversation-dispatcher.ts", containingFunction: "ConversationDispatcher.runLegacyJob", method: "failExecutionJob" },
  { file: "lib/conversation-dispatcher.ts", containingFunction: "ConversationDispatcher.runLegacyJob", method: "updateConversation" },
  { file: "lib/conversation-dispatcher.ts", containingFunction: "ConversationQueueService.cancelPending", method: "cancelQueuedConversationDispatches" },
  { file: "lib/conversation-dispatcher.ts", containingFunction: "ConversationQueueService.cancelPending", method: "updateConversation" },
  { file: "lib/conversation-dispatcher.ts", containingFunction: "ConversationQueueService.enqueue", method: "createConversationDispatch" },
  { file: "lib/conversation-dispatcher.ts", containingFunction: "ConversationQueueService.enqueue", method: "insertConversation" },
  { file: "lib/conversation.ts", containingFunction: "ConversationService.dispatchBoundQueuedEntry", method: "updateConversation" },
  { file: "lib/conversation.ts", containingFunction: "ConversationService.postMessage", method: "insertConversation" },
  { file: "lib/conversation.ts", containingFunction: "ConversationService.postMessage", method: "updateConversation" },
  { file: "lib/hive-services.ts", containingFunction: "dispatchWorker", method: "insertConversation" }
]

function sourcePath(fileName: string) {
  return fileName.replaceAll("\\", "/")
}

function containingFunction(node: ts.Node): string {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isMethodDeclaration(current) || ts.isMethodSignature(current)) {
      const owner = current.parent && ts.isClassDeclaration(current.parent) && current.parent.name
        ? `${current.parent.name.text}.`
        : ""
      return `${owner}${current.name.getText()}`
    }
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text
    if (ts.isFunctionExpression(current) && current.name) return current.name.text
    if (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) return "<anonymous>"
  }
  return "<module>"
}

function tupleKey(match: DirectRepositoryWrite) {
  return `${match.file}\u0000${match.containingFunction}\u0000${match.method}`
}

function sortTuples(matches: readonly DirectRepositoryWrite[]) {
  return [...matches].sort((left, right) =>
    left.file.localeCompare(right.file) ||
    left.containingFunction.localeCompare(right.containingFunction) ||
    left.method.localeCompare(right.method)
  )
}

function uniqueSortedTuples(matches: readonly DirectRepositoryWrite[]) {
  return sortTuples([...new Map(matches.map((match) => [tupleKey(match), match])).values()])
}

function isGenericExecutionJobRunnerCall(
  sourceFile: ts.SourceFile,
  receiverType: ts.Type
) {
  const alias = receiverType.aliasSymbol
  const aliasFile = alias?.declarations?.[0]?.getSourceFile().fileName
  return (
    sourcePath(sourceFile.fileName).endsWith("/lib/execution-job-runner.ts") &&
    alias?.getName() === "ExecutionJobRunnerRepository" &&
    aliasFile !== undefined &&
    sourcePath(aliasFile).endsWith("/lib/execution-job-runner.ts")
  )
}

function createProjectProgram(virtualSources = new Map<string, string>()) {
  const configPath = resolve("tsconfig.json")
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) {
    throw new Error(ts.formatDiagnostic(config.error, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n"
    }))
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd(), undefined, configPath)
  assert.equal(parsed.errors.length, 0, ts.formatDiagnostics(parsed.errors, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => "\n"
  }))
  if (virtualSources.size === 0) {
    return ts.createProgram(parsed.fileNames, parsed.options)
  }
  const host = ts.createCompilerHost(parsed.options)
  const readFile = host.readFile.bind(host)
  const fileExists = host.fileExists.bind(host)
  const getSourceFile = host.getSourceFile.bind(host)
  host.readFile = (fileName) => virtualSources.get(sourcePath(fileName)) ?? readFile(fileName)
  host.fileExists = (fileName) => virtualSources.has(sourcePath(fileName)) || fileExists(fileName)
  host.getSourceFile = (fileName, languageVersion) => {
    const source = virtualSources.get(sourcePath(fileName))
    return source === undefined
      ? getSourceFile(fileName, languageVersion)
      : ts.createSourceFile(fileName, source, languageVersion)
  }
  return ts.createProgram([...parsed.fileNames, ...virtualSources.keys()], parsed.options, host)
}

function collectDirectRepositoryWrites(program = createProjectProgram()): DirectRepositoryWrite[] {
  const checker = program.getTypeChecker()
  const root = sourcePath(process.cwd())
  const matches: DirectRepositoryWrite[] = []

  for (const sourceFile of program.getSourceFiles()) {
    const file = sourcePath(sourceFile.fileName)
    if (!file.startsWith(`${root}/`) || !/\.(ts|tsx)$/.test(file)) continue
    if (file.endsWith("/lib/hive-memory/repository.ts") || file.includes("/lib/conversation-lifecycle/")) continue

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text
        if (guardedWrites.has(method)) {
          const symbol = checker.getSymbolAtLocation(node.expression.name)
          const declarationFile = symbol?.declarations?.[0]?.getSourceFile().fileName
          const receiverType = checker.getTypeAtLocation(node.expression.expression)
          if (
            declarationFile &&
            sourcePath(declarationFile).endsWith("/lib/hive-memory/repository.ts") &&
            !isGenericExecutionJobRunnerCall(sourceFile, receiverType)
          ) {
            matches.push({
              file: file.slice(root.length + 1),
              containingFunction: containingFunction(node),
              method
            })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }

  return uniqueSortedTuples(matches)
}

test("only explicit bound workflows may call guarded Hive repository writers", () => {
  assert.equal(legacyBoundWriterAllowlist.length, 12)
  assert.equal(new Set(legacyBoundWriterAllowlist.map(tupleKey)).size, 12)
  assert.deepEqual(collectDirectRepositoryWrites(), sortTuples(legacyBoundWriterAllowlist))
})

test("ownership gate catches a mapped Hive repository writer", () => {
  const fileName = sourcePath(resolve("lib/__ownership-mutation.ts"))
  const matches = collectDirectRepositoryWrites(createProjectProgram(new Map([[fileName, `
    import type { HiveMemoryRepository } from "./hive-memory/repository"
    declare const repository: Pick<HiveMemoryRepository, "updateConversation">
    async function directMappedWriter() {
      await repository.updateConversation({ id: "entry" })
    }
  `]])))

  assert.ok(matches.some((match) =>
    match.file === "lib/__ownership-mutation.ts" &&
    match.containingFunction === "directMappedWriter" &&
    match.method === "updateConversation"
  ))
})
