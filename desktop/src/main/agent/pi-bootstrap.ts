/**
 * Pi Agent 运行时底座（票 03 = 关卡 B₁）。
 *
 * 职责：
 *   1. **动态**导入 Pi（不静态 import —— 应用启动不该为 1478 个模块付 ~1.7s；
 *      而且 Pi 加载失败时应用仍要能起来报错，而不是白屏）。
 *   2. 三处目录隔离：`ModelRuntime({ authPath, modelsPath })` + `ResourceLoader({ agentDir })`
 *      + `SessionManager.create(cwd, sessionDir)` 全部钉在 `<userData>/pi-agent/`。
 *   3. 强制 `systemPromptOverride`（Pi issue #6308：默认 prompt 泄漏宿主安装路径）。
 *   4. 提供 `runPiSmoke()`：**同一段代码**既给 `scripts/pi-smoke.mjs`（开发态）用，
 *      也给打包产物的 `K12_PI_SMOKE=1` 模式用 —— 避免「开发能过、打包不过」时两套代码互相甩锅。
 *
 * ★ 入口名以实际包导出为准（不存在 `createAgent` / `PiAgent` / `registerExtension`）：
 *   实测 0.85.1 的 `exports` 为
 *     "."                 → dist/index.js          （SDK 入口，本文件用它）
 *     "./rpc-entry"       → dist/bundle/rpc-entry.js（Plan B 的 RPC 入口）
 *     "./client"          → src/client/index.ts    （**源码路径，发布包里不存在**）
 *     "./experimental/plugin" → src/experimental/plugin.ts（同上）
 *   **没有 `./sdk` 子路径**。
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BASELINE_SYSTEM_PROMPT } from './prompts/baseline.ts'
import {
  ensureEsbuildBinaryPath,
  locateEsbuild,
  toUnpackedPath,
  type EsbuildLocation
} from './native-deps.ts'
import { ensurePiDirs, resolvePiPaths, type PiPaths } from './pi-paths.ts'

/** Pi 的包名（唯一合法入口）。 */
export const PI_PACKAGE = '@earendil-works/pi-coding-agent'

/** 默认供应商 / 模型（需求要求 BaseURL 与 ModelID 均可自填，这里只是默认值）。 *
 * ⚠️ 这三项**必须与 `server/app/contracts.py` 的同名默认值一字不差**：
 * 服务端默认值经 `GET /api/settings/runtime` 喂进来，这里只是「拿不到服务端配置时」的兜底。
 * `deepseek-v4-flash` 是 Pi 内置 deepseek 目录里真实存在的模型 —— 老默认值 `deepseek-chat`
 * **不在**目录里，会让首轮对话直接抛「Pi 里找不到模型」（实测踩到，见 pitfalls.md）。 */
export const DEFAULT_PROVIDER_ID = 'deepseek'
export const DEFAULT_MODEL_ID = 'deepseek-v4-flash'
/** ★ Pi 内置 DeepSeek provider 的 baseUrl **没有 `/v1`**（前端提示文案仍会告诉你另一种写法）。 */
export const DEFAULT_BASE_URL = 'https://api.deepseek.com'

/** 环境变量名（Key 解析链的第三档）。 */
const ENV_KEY_NAMES = ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY']

/**
 * ★ 离线探针：没有任何 Key 时，也把一轮对话「踢」到 system prompt 的终态。
 *
 * 为什么要这么绕：Pi 在 `session.prompt()` **最开始**就做凭证检查，
 * 没 Key 会直接抛 `No API key found for deepseek.` —— 连 `before_agent_start` 都不会触发。
 * 于是「system prompt 到底会不会把宿主路径发出去」在无 Key 环境下就**无法判定**。
 *
 * 做法：给 runtime 塞一个**假 Key**（满足 checkAuth），同时把这一轮用的 model 的 `baseUrl`
 * 在内存里换成 `http://127.0.0.1:9/v1`（保留端口 9 = discard，必然连接被拒）。
 * 这样：`before_agent_start` 正常触发 → system prompt 走到终态 → 请求在**本地**连接失败。
 * **不接触任何真实供应商、不写盘、不伪造任何响应。**
 *
 * ★ 导出给 `runtime.ts` 用（`PROBE_API_KEY` / `PROBE_BASE_URL` 是**同一份**常量）：
 *   两处各写一遍字面量会漂移（改了一边、另一边还是旧值，探针就不指向同一个不可达地址了）。
 */
export const PROBE_API_KEY = 'offline-probe-no-real-key'
export const PROBE_BASE_URL = 'http://127.0.0.1:9/v1'

export interface PiCredentials {
  providerId: string
  modelId: string
  baseUrl: string
  /** 解析到的 Key；`undefined` 表示「没有 Key」——**这不是加载失败**，要分开报。 */
  apiKey?: string
  /** Key 从哪来，用于排查（设置页 / `--api-key` / `auth.json` / 环境变量 / `models.json` / 离线探针 / 无）。 */
  source: 'settings' | 'flag' | 'auth.json' | 'env' | 'models.json' | 'offline-probe' | 'none'
  /** 本轮用的是离线探针（假 Key + 不可达 baseUrl），**没有真实请求发出**。 */
  offlineProbe?: boolean
}

export interface PiSessionHandle {
  paths: PiPaths
  credentials: PiCredentials
  /**
   * ★ 当前会话的 system prompt（一轮跑过之后 = `before_agent_start` 的返回值）。
   * ⚠️ **跑过一轮之前它是 Pi 自己拼的那份**（带 `Current working directory: <绝对路径>`），
   *    所以泄漏断言必须在**跑过一轮之后**再做，否则会误报（实测踩到过）。
   */
  systemPrompt: string
  /**
   * ★ 泄漏证据：**未加第二道 override 时** Pi 会发出的 system prompt。
   * 实测 0.85.1 即便设了 `systemPromptOverride`，`buildSystemPrompt()` 仍会无条件追加
   * `Current working directory: <绝对路径>`（含盘符与用户名）—— 这就是 Pi issue #6308 的真实形态。
   * 只在真的跑过一轮之后才有值（`before_agent_start` 触发时捕获）。
   */
  baseSystemPromptSeen?: string
  /**
   * ★★ 最强证据：**真正发到网络上的**那份 system prompt（从 `before_provider_request`
   * 的 payload 里原样取出来）。`undefined` = 一轮都没发出去（例如无 Key 时的离线探针）。
   * 落盘文件名：`<logDir>/system-prompt-wire.txt`。
   */
  wireSystemPrompt?: string
  /** 发出过的 provider 请求数（离线探针那一轮必然失败，所以是 0 或 1）。 */
  providerRequestCount: number
  /** 供应商侧是否具备凭证。`false` = 只能跑到「准备发请求」为止。 */
  authReady: boolean
  /** 关掉会话：内部会 dispose（JSONL flush）。 */
  dispose(): Promise<void>
  /** 发一句话，拿到首个文本增量（需要 Key）。 */
  firstDelta(text: string, timeoutMs?: number): Promise<{ delta: string; ms: number }>
  /** 只把一轮「踢出去」（不等增量）：用于在无 Key 时也把 system prompt 走到终态。 */
  fireTurn(text: string): Promise<{ error?: string }>
}

/**
 * 从 `before_provider_request` 的 payload 里取出**即将发给模型**的 system prompt。
 *
 * 三种形态都兜住（我们无法保证 Pi 一定走 openai-completions 的 chat 形态）：
 *   - OpenAI Chat Completions：`messages[0].role === "system"`
 *   - Responses API：顶层 `instructions`
 *   - 某些适配层：顶层 `system`
 */
export function extractWireSystemPrompt(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const record = payload as Record<string, unknown>
  if (typeof record.system === 'string') return record.system
  if (typeof record.instructions === 'string') return record.instructions
  const messages = record.messages
  if (!Array.isArray(messages)) return undefined
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue
    const message = raw as { role?: unknown; content?: unknown }
    if (message.role !== 'system') continue
    if (typeof message.content === 'string') return message.content
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((part) => (part && typeof part === 'object' ? (part as { text?: unknown }).text : undefined))
        .filter((value): value is string => typeof value === 'string')
        .join('\n')
      if (text) return text
    }
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 * ★ Pi 内置供应商目录：预设端点 / 模型清单的唯一来源
 * ------------------------------------------------------------------ */

/** 目录里的一个模型（只取我们要用的字段；值原样来自 Pi 的内置目录）。 */
export interface CatalogModel {
  id: string
  name?: string
  baseUrl?: string
  reasoning?: boolean
  thinkingLevelMap?: unknown
  input?: unknown
  cost?: unknown
  contextWindow?: number
  maxTokens?: number
  compat?: unknown
}

/** 目录里的一个供应商（`models` 顺序即 Pi 的目录顺序）。 */
export interface CatalogProvider {
  id: string
  name: string
  baseUrl?: string
  models: CatalogModel[]
}

/** 进程级缓存（按 userDataDir 分键：目录是静态数据，但目录隔离要求我们不共用一个临时根）。 */
const catalogCache = new Map<string, Promise<CatalogProvider[]>>()

/**
 * ★★ Pi 内置供应商目录（**离线**，本机实测 40 个 provider）。
 *
 * 做法：建一个 catalog-only 的 `ModelRuntime`：
 *   - `modelsPath: null` —— **不读本应用的 `models.json`**（我们要的就是纯净的内置目录）；
 *   - `allowModelNetwork: false` + `refreshOnCreate: false` —— **不联网**，离线演示也能用；
 *   - `authPath` 显式指向**本应用自己的目录**下的一个 scratch 路径 ——
 *     `ModelRuntime.create` 会创建它（实测：会落一个空的 `auth.json`），
 *     所以**绝不能省略**：省略即退回 `~/.pi/agent/auth.json`，那就碰了用户的全局 Pi 配置
 *     （AGENTS §5.12 的硬约束，`pi-paths.ts` 的隔离断言也守着这条）。
 *
 * 用途（两处，见 `buildModelsJsonConfig` 与设置页的预设下拉）：
 *   1. 判断「这个 provider 是不是内置的」、「这个 modelId 在不在内置目录里」；
 *   2. 作为设置页「供应商预设」的下拉数据源（端点地址现成可用，不用手输）。
 *
 * 失败**不缓存**（下次可重试）；成功则进程内复用（目录不会变）。
 */
export function builtinCatalog(userDataDir: string): Promise<CatalogProvider[]> {
  const existing = catalogCache.get(userDataDir)
  if (existing) return existing

  const pending = (async (): Promise<CatalogProvider[]> => {
    const pi = await loadPi()
    const paths = resolvePiPaths(userDataDir)
    // ⚠️ 专门的 scratch 子目录：不与应用会话的 auth.json / models.json 混在一起。
    const scratch = join(paths.logDir, 'provider-catalog')
    mkdirSync(scratch, { recursive: true })

    // `ModelRuntime` 的返回类型在 `PiModuleLike` 里是刻意松的（只声明我们用到的方法），
    // 这里就地给出目录读取所需的最小结构面，避免为一个只读用途把整个 `pi-ai` 类型图拖进来。
    const runtime = (await pi.ModelRuntime.create({
      authPath: join(scratch, 'auth.json'),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false
    })) as unknown as {
      getProviders(): Array<{ id: string; name?: string; baseUrl?: string }>
      getModels(providerId?: string): CatalogModel[]
    }

    return runtime.getProviders().map((provider) => ({
      id: String(provider.id),
      name: String(provider.name ?? provider.id),
      baseUrl: typeof provider.baseUrl === 'string' ? provider.baseUrl : undefined,
      models: runtime.getModels(provider.id).map((model) => ({
        id: String(model.id),
        name: String(model.name ?? model.id),
        baseUrl: typeof model.baseUrl === 'string' ? model.baseUrl : undefined,
        reasoning: typeof model.reasoning === 'boolean' ? model.reasoning : undefined,
        thinkingLevelMap: model.thinkingLevelMap,
        input: model.input,
        cost: model.cost,
        contextWindow: typeof model.contextWindow === 'number' ? model.contextWindow : undefined,
        maxTokens: typeof model.maxTokens === 'number' ? model.maxTokens : undefined,
        compat: model.compat
      }))
    }))
  })()

  catalogCache.set(userDataDir, pending)
  pending.catch(() => {
    // 失败别把坏结果留在缓存里（否则一次网络抖动就永久失效）
    if (catalogCache.get(userDataDir) === pending) catalogCache.delete(userDataDir)
  })
  return pending
}

/**
 * ★ 单测/诊断用的目录缓存清理 —— **已删除**。
 *
 * 删它的理由（不是「没人用」，是它本身有害）：`builtinCatalog()` 的缓存键是 `userDataDir`，
 * 而清掉缓存只影响「下一次重新读目录」，对任何一条真实链路都没有作用；
 * 保留它反而鼓励「测试里清一下缓存掩盖状态残留」这种写法。
 * 真需要重读目录时重开一个 `userDataDir`（测试本来就是这么做的）。
 */

/* ------------------------------------------------------------------ *
 * models.json：由**设置**派生（不再是「幂等不覆盖」的文件）
 * ------------------------------------------------------------------ */

/** 一份「要喂给 Pi」的 LLM 配置（字段名与 `LlmRuntimeConfig` 契约对齐）。 */
export interface LlmConfigForPi {
  providerId: string
  providerName: string
  baseUrl: string
  modelId: string
}

/**
 * ★★ 把设置里的 LLM 配置**翻译成 Pi 的 `models.json`**（纯函数，可单测）。
 *
 * 为什么必须走 `models.json`：BaseURL / ModelID 自填是需求硬性要求，
 * 而 Pi 只认 `providers.<id>` + `models[].id` 这一套。
 *
 * ★★ 三条**读源码 + 实测**得出的规则（改动前务必看懂，踩过的坑见 pitfalls.md）：
 *
 *   1. **provider 是内置的、且 modelId 也在内置目录里** → **只写 provider 级 `baseUrl`**，
 *      **不写 `models[]`**。
 *      理由：`provider-composer.js` 的 `applyModelsJson()` 在 `config.models` 里遇到
 *      **已存在的 id** 时会**整个替换**那条模型（`modelFromJson()` 只 merge
 *      provider 级与 definition 自身的 compat，**不含被替换模型自己的 compat**）。
 *      实测：给 deepseek 写一条 `{id:'deepseek-v4-flash'}` 会把内置的
 *      `reasoning:true` / `compat.thinkingFormat:"deepseek"` **静默抹掉** ——
 *      模型看起来还在，推理与思考格式却没了。只改 provider 级 baseUrl 则原样保留（已实测）。
 *
 *   2. **provider 是内置的、但 modelId 不在内置目录里**（例如老配置里的 `deepseek-chat`）
 *      → 追加 `models[]` 声明它，并**从同 provider 的兄弟模型抄字段**
 *      （reasoning / thinkingLevelMap / input / cost / contextWindow / maxTokens / compat）。
 *      不抄的话，新模型只有默认值（`reasoning:false`、contextWindow 128k、无 deepseek 思考格式），
 *      同一 provider 下两个模型的行为会莫名其妙地不一致。实测：抄完 compat 正确，
 *      且**不会**连累已有的内置条目。
 *
 *   3. **provider 不是内置的**（校内网关 / 自建服务，需求要求支持）
 *      → 必须写 `models[]`：Pi 对没有任何内置定义的 provider 要求至少给出
 *      `baseUrl`/`headers`/`compat`/`modelOverrides`/`models` 之一，否则整个 provider
 *      组装失败（`must specify "baseUrl", …`）。没有 `models[]` 时 `getModels()` 为空，
 *      `getModel()` 必然返回 undefined → 第一轮对话直接抛「Pi 里找不到模型」。
 *
 * ★ **绝不写任何 API Key**：Key 一律经 `setRuntimeApiKey()` 只进内存（合规要求）。
 *   这里也不写 `apiKey: '$ENV'` 之类的占位 —— 内置 provider 自带自己的环境变量认证，
 *   自定义 provider 的环境变量名我们无从得知，写了反而是误导。
 */
export function buildModelsJsonConfig(
  config: LlmConfigForPi,
  catalog: readonly CatalogProvider[]
): { providers: Record<string, Record<string, unknown>> } {
  const providerId = config.providerId.trim() || DEFAULT_PROVIDER_ID
  const builtin = catalog.find((provider) => provider.id === providerId)

  const providerName = config.providerName.trim() || builtin?.name || providerId
  const modelId = config.modelId.trim()
  // 端点取值顺序：设置里填的 > 该 provider 的内置端点 > 全局默认。
  const baseUrl = config.baseUrl.trim() || builtin?.baseUrl || DEFAULT_BASE_URL

  const entry: Record<string, unknown> = {
    name: providerName,
    baseUrl,
    api: 'openai-completions'
  }

  const isBuiltinModel = builtin?.models.some((model) => model.id === modelId) ?? false
  if (modelId && !isBuiltinModel) {
    // 规则 2 / 3：非内置 id 必须显式声明（内置 provider 则从兄弟模型抄字段）
    const sibling = builtin?.models[0]
    const definition: Record<string, unknown> = { id: modelId, name: modelId, api: 'openai-completions', baseUrl }
    if (sibling) {
      // 只抄「有值」的字段，别把 undefined 也写成 JSON 的 null（Pi 的 schema 不收 null）
      if (sibling.reasoning !== undefined) definition.reasoning = sibling.reasoning
      if (sibling.thinkingLevelMap !== undefined) definition.thinkingLevelMap = sibling.thinkingLevelMap
      if (sibling.input !== undefined) definition.input = sibling.input
      if (sibling.cost !== undefined) definition.cost = sibling.cost
      if (sibling.contextWindow !== undefined) definition.contextWindow = sibling.contextWindow
      if (sibling.maxTokens !== undefined) definition.maxTokens = sibling.maxTokens
      if (sibling.compat !== undefined) definition.compat = sibling.compat
    }
    entry.models = [definition]
  }

  return { providers: { [providerId]: entry } }
}

/**
 * 把设置派生的配置**写进** `models.json`（原子写：临时文件 + rename）。
 *
 * ★★ 语义与历史上的 `ensureModelsJson` **相反**，这是有意的：
 *   旧版本「文件存在就一个字节都不动」，本意是「不覆盖用户手改的配置」；
 *   但那让**设置页改了什么都进不去 Pi**（`models.json` 成了首次运行后永不更新的死值）。
 *   现在 `models.json` 是**由设置派生的产物**（settings 是唯一权威），每次建会话 /
 *   保存设置都重写。要手改配置请改设置页 —— 那也是 `config.json` 的唯一写入口。
 *
 * 返回写入的文本（诊断与断言用）。
 */
export function writeModelsJson(
  paths: PiPaths,
  config: LlmConfigForPi,
  catalog: readonly CatalogProvider[]
): string {
  const text = `${JSON.stringify(buildModelsJsonConfig(config, catalog), null, 2)}\n`
  mkdirSync(paths.agentDir, { recursive: true })
  // 原子写：半截 JSON 会让 ModelRuntime 整个加载失败（而它只是配置文件，不该拦住应用启动）
  const temp = `${paths.modelsPath}.tmp`
  writeFileSync(temp, text, 'utf8')
  renameSync(temp, paths.modelsPath)
  return text
}

/* ------------------------------------------------------------------ *
 * Key 解析链：设置页 > --api-key → auth.json → 环境变量 → models.json
 * ------------------------------------------------------------------ */

/**
 * 本应用默认 ModelID / BaseURL 的**统一解析点**（环境变量兜底只写在这里，避免两处各写一遍）。
 * `K12_MODEL_ID` / `K12_BASE_URL` 是给冒烟与排查用的低优先级覆盖。
 */
export function resolveDefaultModelId(explicit?: string): string {
  return explicit ?? process.env.K12_MODEL_ID ?? DEFAULT_MODEL_ID
}

export function resolveDefaultBaseUrl(explicit?: string): string {
  return explicit ?? process.env.K12_BASE_URL ?? DEFAULT_BASE_URL
}

interface PersistedProviderConfig {
  baseUrl?: string
  apiKey?: string
  models?: Array<{ id?: string }>
}

/** 读本应用自己的 `models.json` 里某个 provider 的配置（解析失败一律当「没有」，绝不伪装成加载失败）。 */
function readModelsJson(paths: PiPaths, providerId: string): PersistedProviderConfig | undefined {
  if (!existsSync(paths.modelsPath)) return undefined
  try {
    const config = JSON.parse(readFileSync(paths.modelsPath, 'utf8')) as {
      providers?: Record<string, PersistedProviderConfig>
    }
    return config.providers?.[providerId]
  } catch {
    return undefined
  }
}

/**
 * 解析本次会话要用的 provider / model / baseUrl / key。
 *
 * 优先级（**冻结**：设置页、冒烟脚本与 `runtime.ts` 都依赖这几条）：
 *   - providerId：**显式入参 > 内置默认**。它决定用哪一份 provider 定义（认证 / 目录 / 协议）。
 *   - BaseURL / ModelID：**显式入参 > `models.json` > 环境变量 > 内置默认**。
 *     ⚠️ 显式入参必须能压过 `models.json` —— 否则「运行期改 BaseURL」根本不生效
 *     （票 03 的冒烟正是靠这条把请求指向本地桩；改前实测踩到过：请求被 models.json
 *     里的 `https://api.deepseek.com` 顶掉，于是拿着桩用的假 Key 打了真实供应商）。
 *   - API Key：**设置页（经由 `apiKeySource:'settings'` 显式标注）** → CLI `--api-key`
 *     → `auth.json` → 环境变量 → `models.json`（执行文档 §9.4 第 3 条）。
 *     后四档是「设置页还没配 Key」时的兜底；真正拍板的是 Pi 自己的 `checkAuth()`。
 */
export function resolveCredentials(
  paths: PiPaths,
  options: {
    apiKey?: string
    providerId?: string
    modelId?: string
    baseUrl?: string
    /** `apiKey` 从哪来：设置页或 CLI 参数。只影响诊断与 `source` 标签。 */
    apiKeySource?: 'settings' | 'flag'
  } = {}
): PiCredentials {
  const providerId = options.providerId?.trim() || DEFAULT_PROVIDER_ID
  const persisted = readModelsJson(paths, providerId)
  const modelId = options.modelId ?? persisted?.models?.[0]?.id ?? resolveDefaultModelId()
  const baseUrl = options.baseUrl ?? persisted?.baseUrl ?? resolveDefaultBaseUrl()
  let apiKey: string | undefined
  let source: PiCredentials['source'] = 'none'

  if (options.apiKey) {
    apiKey = options.apiKey
    source = options.apiKeySource ?? 'flag'
  }

  // ── Key 解析链（设置页之后的四档兜底）──
  if (!apiKey && existsSync(paths.authPath)) {
    try {
      const auth = JSON.parse(readFileSync(paths.authPath, 'utf8')) as Record<string, unknown>
      const entry = auth[providerId] as { key?: string; apiKey?: string } | string | undefined
      const value = typeof entry === 'string' ? entry : (entry?.key ?? entry?.apiKey)
      if (value) {
        apiKey = value
        source = 'auth.json'
      }
    } catch {
      // auth.json 坏了不影响判定「有没有 Key」，继续往下走
    }
  }

  if (!apiKey) {
    for (const name of ENV_KEY_NAMES) {
      if (process.env[name]) {
        apiKey = process.env[name]
        source = 'env'
        break
      }
    }
  }

  if (!apiKey && persisted?.apiKey && !persisted.apiKey.startsWith('$')) {
    apiKey = persisted.apiKey
    source = 'models.json'
  }

  return { providerId, modelId, baseUrl, apiKey, source }
}

/* ------------------------------------------------------------------ *
 * 泄漏断言：system prompt 绝不能带本机路径
 * ------------------------------------------------------------------ */

/**
 * ★ 风险 #19 / Pi issue #6308：默认 system prompt 会把宿主安装路径（含用户名）发给模型。
 * 这里把判定写成一个纯函数，**应用启动、冒烟脚本、单测三处共用同一套规则**。
 */
export function findHostPathLeaks(prompt: string, extraPatterns: string[] = []): string[] {
  const leaks: string[] = []
  const rules: Array<[string, RegExp]> = [
    // ★ 必须加 `(?<![A-Za-z0-9_])`：否则 `https://…` 里的 `s:/`、`file:///` 里的 `e:/`
    //   会被误判成盘符路径（本项目的 prompt 里必然出现 https URL，这条不修就是天天误报）。
    ['Windows 盘符路径', /(?<![A-Za-z0-9_])[A-Za-z]:[\\/]/],
    ['UNC 路径', /\\\\[A-Za-z0-9._-]+\\/],
    ['file:// URL', /file:\/\//i],
    ['POSIX 家目录', /\/(?:home|Users)\/[A-Za-z0-9._-]+/]
  ]
  for (const [label, pattern] of rules) {
    const hit = prompt.match(pattern)
    if (hit) leaks.push(`${label}: ${hit[0]}`)
  }
  const userName = process.env.USERNAME ?? process.env.USER
  if (userName && userName.length >= 3 && prompt.includes(userName)) {
    leaks.push(`当前用户名: ${userName}`)
  }
  for (const extra of extraPatterns) {
    if (extra && prompt.includes(extra)) leaks.push(`显式传入的敏感串: ${extra}`)
  }
  return leaks
}

/**
 * ★★ 抹掉 Pi **无条件追加**在 system prompt 末尾的 cwd 环境块。
 *
 * 为什么必须有它（实测 0.85.1 读源码 + 真机验证，见 `dist/core/system-prompt.js`）：
 *   `buildSystemPrompt()` 在 `customPrompt` 分支的**最后一行**执行
 *
 *       prompt += `\nCurrent working directory: ${promptCwd}\n`
 *
 *   —— **`systemPromptOverride` 只管住默认 prompt，管不住这一行**。于是即便我们两道都覆盖了，
 *   会话状态里的 prompt 仍然是「四学段模板 + Current working directory: C:/Users/<用户名>/…」，
 *   而 `before_provider_request` 取出来的**就是要发给云端模型的那几个字节**：
 *   宿主安装路径与 Windows 用户名真的会出网（Pi issue #6308 的真实形态）。
 *   连带后果：`runTurn()` 结尾的 `findHostPathLeaks` 断言**必然非空** → 每一轮都被记成
 *   `provider-error`，那条断言从此永远红着，等于失效。
 *
 * 语义：**只剥尾巴**。它不解析、不改写 prompt 正文，只在末尾形如
 *   `\nCurrent working directory: <非换行内容>`（可能带一个结尾换行）时把它去掉；
 * 认不出就**原样返回**（绝不猜测、绝不误删正文里的其它内容）。
 *
 * 调用点：`runtime.ts` 的 `before_agent_start` —— 在把 prompt 交给学段出口
 * （`gradeExtension.systemPromptFor`）**之前**先过这里，所以扩展侧收到的已经是干净的字符串
 * （扩展自己那条 `bare.includes(target) ? bare : …` 分支不会再把 cwd 留下来）。
 *
 * @param prompt `before_agent_start` 事件里的 `systemPrompt`（= Pi 拼完的基座 prompt）
 * @returns 去掉 cwd 尾块后的 prompt（没有该尾块时逐字返回原值）
 */
export function stripPiCwdBlock(prompt: string): string {
  if (typeof prompt !== 'string' || prompt.length === 0) return prompt
  let out = prompt
  // 循环是防御性的：append 段/技能段理论上不会重复追加，但真重复时不该留一半。
  // 上限 4 次足够（一次拼装最多追加一次），避免任何病态输入上的死循环。
  for (let i = 0; i < 4; i += 1) {
    const next = out.replace(/\nCurrent working directory:[^\n]*\n?$/i, '')
    if (next === out) break
    out = next
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 会话装配
 * ------------------------------------------------------------------ */

/** Pi 命名空间里我们真正用到的那几个符号（避免为了类型把整个包静态 import 进来）。 */
interface PiModule {
  createAgentSession: (options: Record<string, unknown>) => Promise<{ session: PiAgentSession }>
  DefaultResourceLoader: new (options: Record<string, unknown>) => PiResourceLoader
  ModelRuntime: { create: (options: Record<string, unknown>) => Promise<PiModelRuntime> }
  SessionManager: { create: (cwd: string, sessionDir?: string) => unknown }
  defineTool: (tool: Record<string, unknown>) => unknown
}

interface PiResourceLoader {
  reload(options?: Record<string, unknown>): Promise<void>
  getSystemPrompt(): string | undefined
}

/**
 * `pi.on(...)` 的 handler 形状（只需要 `event` 这一个参数；返回值按事件不同而不同）。
 * 用 `unknown` 收事件对象，在各自的 handler 里再窄化 —— 避免为一个冒烟会话把 Pi 的
 * 全部事件类型（34 个原生事件）都抄一遍。
 */
interface PiExtensionAPI {
  on(event: string, handler: (event: unknown) => Promise<unknown> | unknown): void
}

interface PiBeforeAgentStartEvent {
  prompt?: string
  /** 本轮**基座** system prompt（loader 产出 + Pi 追加的环境块），可整段替换。 */
  systemPrompt?: string
}

interface PiBeforeProviderRequestEvent {
  payload?: unknown
}

/** 与 `@earendil-works/pi-ai` 的 `AuthCheck` 对齐：有凭证才返回非 undefined。 */
interface PiAuthCheck {
  source?: string
  type: 'api_key' | 'oauth'
}

interface PiModelRuntime {
  getModel(providerId: string, modelId: string): unknown
  getModels(providerId?: string): unknown[]
  /** 目录用（`builtinCatalog`）：列出全部 provider。 */
  getProviders(): Array<{ id: string; name?: string; baseUrl?: string }>
  checkAuth(providerId: string): Promise<PiAuthCheck | undefined>
  setRuntimeApiKey(providerId: string, apiKey: string): Promise<void>
}

interface PiAgentSession {
  systemPrompt: string
  subscribe(listener: (event: PiEvent) => void): () => void
  prompt(text: string): Promise<void>
  dispose(): void
}

/**
 * 与 `@earendil-works/pi-ai` 的 `AssistantMessageEvent` 对齐（只取我们用到的那几个变体）。
 * 实测（0.85.1）该联合有 12 个变体；这里要的是：
 *   - `text_delta`  → 首个流式增量
 *   - `error`       → 供应商侧失败（`error.errorMessage` 就是供应商原话，例如 401 文案）
 *   - `done`        → 正常结束（`reason: stop | length | toolUse | deferred`）
 */
interface PiAssistantMessageEvent {
  type?: string
  delta?: string
  reason?: string
  error?: { errorMessage?: string; stopReason?: string }
}

interface PiEvent {
  type?: string
  assistantMessageEvent?: PiAssistantMessageEvent
}

/**
 * 加载 Pi。**动态 import**：主进程启动不被 Pi 拖慢；
 * 且 CJS/ESM 冲突一旦复发，这里是唯一炸点，错误信息可控。
 *
 * ★ 顺带记下**实际解析到的文件路径** —— 这是「打包产物里加载的是产物内的 Pi，
 *   而不是开发目录的 node_modules」这条断言的直接证据（见 `runPiSmoke` 打印的 `piEntryPath`）。
 */
export async function loadPi(): Promise<PiModule> {
  lastPiEntryPath = fileURLToPath(import.meta.resolve(PI_PACKAGE))
  return (await import(PI_PACKAGE)) as unknown as PiModule
}

/** 最近一次 `loadPi()` 解析到的真实入口路径（证据用）。 */
let lastPiEntryPath: string | undefined
export function piEntryPath(): string | undefined {
  return lastPiEntryPath
}

export interface CreatePiSessionOptions {
  /** ★ 必须显式传入（Electron 里是 `app.getPath('userData')`）；禁止回退 `~/.pi`。 */
  userDataDir: string
  /** Key 解析链第一档（设置页 / CLI `--api-key`）。 */
  apiKey?: string
  /** `apiKey` 的来源标签（设置页 vs CLI 参数），只影响 `credentials.source` 诊断。 */
  apiKeySource?: 'settings' | 'flag'
  /** ★ Pi 的 provider id（设置里的那一项）；不传则用内置默认。 */
  providerId?: string
  modelId?: string
  baseUrl?: string
  /** 供应商显示名（只写进 `models.json` 的 `name`，用于 Pi 侧排查；填什么都行）。 */
  providerName?: string
  /** 会话工作目录（决定 Pi 的项目级资源发现范围）。 */
  cwd?: string
  /**
   * 没有 Key 时是否用「离线探针」把一轮踢到 system prompt 终态（见 `PROBE_API_KEY` 注释）。
   * **不会发出任何真实请求**；仅用于关卡 B₁ 在无 Key 环境下判定风险 #19。
   */
  offlineProbe?: boolean
}

/**
 * 建一个真正可用的 Pi 会话。
 *
 * 目录隔离三处（缺一不可，票 03 的核心断言）：
 *   - `ModelRuntime.create({ authPath, modelsPath })`
 *   - `DefaultResourceLoader({ agentDir })`
 *   - `SessionManager.create(cwd, sessionDir)`
 */
export async function createPiSession(options: CreatePiSessionOptions): Promise<PiSessionHandle> {
  const paths = resolvePiPaths(options.userDataDir)
  ensurePiDirs(paths)

  // ★ `models.json` 由**设置**派生（见 `writeModelsJson` 的语义说明）。
  //   拿不到内置目录时退化成「只写 provider 级 baseUrl」，不影响可用性。
  const catalog = await builtinCatalog(options.userDataDir).catch(() => [])
  writeModelsJson(
    paths,
    {
      providerId: options.providerId?.trim() || DEFAULT_PROVIDER_ID,
      providerName: options.providerName?.trim() || '',
      baseUrl: resolveDefaultBaseUrl(options.baseUrl),
      modelId: resolveDefaultModelId(options.modelId)
    },
    catalog
  )

  const credentials = resolveCredentials(paths, {
    apiKey: options.apiKey,
    apiKeySource: options.apiKeySource,
    providerId: options.providerId,
    modelId: options.modelId,
    baseUrl: options.baseUrl
  })

  const pi = await loadPi()

  // ① 凭证 / 模型目录隔离
  const modelRuntime = await pi.ModelRuntime.create({
    authPath: paths.authPath,
    modelsPath: paths.modelsPath,
    // 不联网刷新目录：离线演示与「无 Key 冒烟」都必须确定性地跑起来
    allowModelNetwork: false,
    refreshOnCreate: false
  })

  // ② 资源目录隔离 + ★ 两道 systemPrompt 覆盖（整段替换，杜绝宿主路径泄漏）
  //
  //   ★★ 实测结论（0.85.1，票 03）：**只设 `systemPromptOverride` 不够**。
  //   `dist/core/system-prompt.js` 的 `buildSystemPrompt()` 在 `customPrompt` 分支末尾
  //   无条件执行 `prompt += "\nCurrent working directory: " + cwd.replace(/\\/g,"/")`，
  //   把 <userData> 的绝对路径（含盘符 + Windows 用户名）拼在后面。
  //   所以第二道必须落在 `before_agent_start` —— 它的返回值直接写进
  //   `agent.state.systemPrompt`（`dist/core/agent-session.js` 里
  //   `this.agent.state.systemPrompt = result.systemPrompt`），是**最后一道**改写点。
  //   这也正是票 06 注入学段语气要用的同一个钩子。
  //
  //   ⚠️ 顺序陷阱（实测踩到）：**跑过一轮之前** `session.systemPrompt` 还是基座那份
  //   （含 cwd）。所以泄漏断言必须在「一轮已经跑过」之后做 —— 否则无 Key 时判通过、
  //   有 Key 时反而误报失败（票 03 的第一次带 Key 冒烟就是这么翻的车）。
  const seen = { base: undefined as string | undefined, wire: undefined as string | undefined, requests: 0 }
  const promptGuard = (pi: PiExtensionAPI): void => {
    pi.on('before_agent_start', (event: unknown) => {
      const base = (event as PiBeforeAgentStartEvent).systemPrompt
      if (typeof base === 'string') seen.base = base
      return { systemPrompt: BASELINE_SYSTEM_PROMPT }
    })
    // ★ 最强的第三条证据链：从**真正要发出去的 payload** 里原样取出 system prompt。
    //   前两道挡的是「Pi 拼出来的 prompt」，这一道挡的是「网络上跑的字节」。
    pi.on('before_provider_request', (event: unknown) => {
      seen.requests += 1
      const wire = extractWireSystemPrompt((event as PiBeforeProviderRequestEvent).payload)
      if (wire !== undefined) seen.wire = wire
      // 不返回值：只观察，不改写 payload（脱敏演示留给票 06 的 provider 边界）
    })
  }

  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: options.cwd ?? paths.root,
    agentDir: paths.agentDir,
    // 第一道：替换 Pi 的默认 prompt（那段会列出 readme/docs/examples 的**绝对路径**）
    systemPromptOverride: () => BASELINE_SYSTEM_PROMPT,
    // 第二道：抹掉 buildSystemPrompt() 追加的 cwd 环境块（见上方注释）
    extensionFactories: [promptGuard],
    // 票 03 要的是**最小可判定**会话：把项目/全局资源发现全部关掉，
    // 让 system prompt 只可能来自上面的两道覆盖（= 断言才有意义）。
    // 票 06/08 会按需逐项打开（Extension 走 `extensionFactories`，不受 `noExtensions` 影响）。
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true
  })
  await resourceLoader.reload()

  // ③ 会话落盘隔离（一人一份的入口；票 09 会下沉到 students/<id>/）
  const sessionManager = pi.SessionManager.create(options.cwd ?? paths.root, paths.sessionDir)

  const model = modelRuntime.getModel(credentials.providerId, credentials.modelId) ?? modelRuntime.getModels(credentials.providerId)[0]
  if (!model) {
    throw new Error(
      `Pi 里找不到模型 ${credentials.providerId}/${credentials.modelId}（models.json 与内置目录都没命中）`
    )
  }

  // 离线探针：假 Key 满足 checkAuth，baseUrl 换成必然连接被拒的本地地址（只在内存里改，不写盘）
  const useProbe = options.offlineProbe === true && !credentials.apiKey
  const runtimeKey = credentials.apiKey ?? (useProbe ? PROBE_API_KEY : undefined)
  if (runtimeKey) {
    // 走 Runtime 覆盖而不是写 auth.json：**不把 Key 落盘**（合规要求）
    await modelRuntime.setRuntimeApiKey(credentials.providerId, runtimeKey)
  }
  const effectiveModel = useProbe ? { ...(model as object), baseUrl: PROBE_BASE_URL } : model
  const effectiveCredentials: PiCredentials = useProbe
    ? { ...credentials, source: 'offline-probe', offlineProbe: true, apiKey: undefined }
    : credentials

  // 用一个无副作用的 Tool 走通 `defineTool`（票 08 的 6 个 Extension 同款注册路径）
  const echoTool = pi.defineTool({
    name: 'smoke_echo',
    label: '冒烟回显',
    description: '冒烟用：原样回显一段文本，不做任何副作用。',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    execute: async (_id: string, params: { text: string }) => ({ content: [{ type: 'text', text: params.text }], details: {} })
  })

  const { session } = await pi.createAgentSession({
    cwd: options.cwd ?? paths.root,
    agentDir: paths.agentDir,
    modelRuntime,
    resourceLoader,
    sessionManager,
    model: effectiveModel,
    // 冒烟会话不给模型任何系统能力：内置 read/bash/edit/write 全关
    noTools: 'builtin',
    customTools: [echoTool]
  })

  const auth = await modelRuntime.checkAuth(credentials.providerId)
  const authReady = auth !== undefined

  return {
    paths,
    credentials: effectiveCredentials,
    get systemPrompt() {
      return session.systemPrompt
    },
    get baseSystemPromptSeen() {
      return seen.base
    },
    get wireSystemPrompt() {
      return seen.wire
    },
    get providerRequestCount() {
      return seen.requests
    },
    authReady,
    async dispose() {
      session.dispose()
    },
    async fireTurn(text) {
      // 只把一轮踢出去、不关心结果：让 before_agent_start 跑一遍，
      // 从而在**没有 Key** 的情况下也能把 system prompt 走到终态（关卡 B₁ 的关键技巧）。
      try {
        await session.prompt(text)
        return {}
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    async firstDelta(text, timeoutMs = 60_000) {
      const started = Date.now()
      return await new Promise<{ delta: string; ms: number }>((resolve, reject) => {
        let unsubscribe: (() => void) | undefined
        const timer = setTimeout(() => {
          unsubscribe?.()
          reject(new Error(`等待首个增量超时（${timeoutMs}ms）：期间既没收到增量也没收到错误事件`))
        }, timeoutMs)
        const settle = (fn: () => void): void => {
          clearTimeout(timer)
          unsubscribe?.()
          fn()
        }
        unsubscribe = session.subscribe((event) => {
          if (event.type !== 'message_update') return
          const update = event.assistantMessageEvent
          // ★ 供应商侧失败要**立刻**报出来（`error.errorMessage` 就是供应商原话）。
          //   不加这一条，401/网络错误会退化成一个 60 秒的超时——
          //   实测踩到过：拿本地桩的假 Key 打真实供应商，报错却显示成「等待首个增量超时」，
          //   把「认证失败」误读成「流式没通」。（票 06 的 `error` 事件映射可直接复用这段。）
          if (update?.type === 'error') {
            const message = update.error?.errorMessage ?? update.reason ?? '(供应商未给出错误信息)'
            settle(() => reject(new Error(`供应商返回错误：${message}`)))
            return
          }
          if (update?.type === 'text_delta' && update.delta) {
            const delta = update.delta
            settle(() => resolve({ delta, ms: Date.now() - started }))
          }
        })
        session.prompt(text).catch((error: unknown) => {
          settle(() => reject(error instanceof Error ? error : new Error(String(error))))
        })
      })
    }
  }
}

/* ------------------------------------------------------------------ *
 * 冒烟：把「走到哪一步」逐条打印出来
 * ------------------------------------------------------------------ */

export interface SmokeStep {
  step: string
  ok: boolean
  detail?: string
}

export interface SmokeResult {
  ok: boolean
  /** `true` = 卡在「缺 Key」，**不是** Pi 加载/打包失败。两者必须分开报。 */
  blockedByMissingKey: boolean
  steps: SmokeStep[]
  /** 落盘的 system prompt 路径（证据）。 */
  promptDumpPath?: string
  exitCode: number
}

export interface RunPiSmokeOptions extends CreatePiSessionOptions {
  /** 冒烟里要发的那句话。 */
  phrase?: string
  /** 允许把 Key 缺失当作「预期结果」而不是失败（票 03 环境无 Key）。 */
  expectKey?: boolean
  /** 是否在打包产物内运行（由调用方传入，避免猜测 `process.defaultApp` 的语义差异）。 */
  packaged?: boolean
  log?: (line: string) => void
}

/**
 * 关卡 B₁ 的判定主体。**开发态与打包产物跑的是同一个函数**。
 *
 * 打印顺序（票 03 要求）：
 *   (a) Pi 导入成功  (b) runtime 建好  (c) session 建好  (d) system prompt 检查结果
 *   (e) 首个流式增量 + 到达时间 **或** 「blocked: 缺 Key，卡在第 N 步」
 */
export async function runPiSmoke(options: RunPiSmokeOptions): Promise<SmokeResult> {
  const log = options.log ?? ((line: string) => console.log(line))
  const steps: SmokeStep[] = []
  const record = (step: string, ok: boolean, detail?: string): void => {
    steps.push({ step, ok, detail })
    log(`${ok ? '[ OK ]' : '[FAIL]'} ${step}${detail ? ` —— ${detail}` : ''}`)
  }
  const phrase = options.phrase ?? '你好，请用一句话自我介绍。'

  log('================ Pi Agent 冒烟（关卡 B₁）================')
  log(
    `运行时      : ${
      process.versions.electron ? `Electron ${process.versions.electron}` : 'Node'
    } / node ${process.versions.node}`
  )
  log(`打包态      : ${isPackagedRuntime(options.packaged) ? '是（打包产物内）' : '否（开发态）'}`)
  log(`进程可执行  : ${process.execPath}`)
  log(`工作目录    : ${process.cwd()}`)

  let handle: PiSessionHandle | undefined
  try {
    // (a) 导入
    const pi = await loadPi()
    const exportCount = Object.keys(pi as object).length
    const hasSdk = ['createAgentSession', 'ModelRuntime', 'DefaultResourceLoader'].every(
      (name) => typeof (pi as unknown as Record<string, unknown>)[name] === 'function'
    )
    record(`(a) 导入 ${PI_PACKAGE} 成功`, hasSdk, `导出符号 ${exportCount} 个，SDK 入口齐备=${hasSdk}`)
    if (!hasSdk) return finish(false, false, 10)
    // ★ 证据：打包产物里这一行必须落在 `<...>/resources/app.asar/node_modules/...`，
    //   否则说明跑的还是开发目录的 node_modules，冒烟不算数。
    log(`      Pi 实际解析自：${piEntryPath()}`)

    // (a2) 原生依赖诊断：证明**解包后的实体二进制**在当前运行时里真的可解析/可执行。
    // 风险 #15 的判定点 —— 只躺在 app.asar 里的文件是跑不起来的。
    const native = probeNativeDeps(piEntryPath())
    for (const item of native) {
      log(`      [原生] ${item.ok ? 'OK  ' : 'FAIL'} ${item.name}：${item.detail}`)
    }

    // (b)(c) runtime + session
    handle = await createPiSession({ offlineProbe: true, ...options })
    record('(b) ModelRuntime.create 成功', true, `models.json=${handle.paths.modelsPath}`)
    record(
      '(c) createAgentSession 成功',
      true,
      `provider=${handle.credentials.providerId} model=${handle.credentials.modelId} key来源=${handle.credentials.source}`
    )
    // 目录隔离的机器可读证据（给「没有碰 ~/.pi」这条断言做交叉验证）
    log(`      Pi 目录：agentDir=${handle.paths.agentDir}`)
    log(`               sessionDir=${handle.paths.sessionDir}`)
    log(`               authPath=${handle.paths.authPath}`)

    const hasKey = Boolean(handle.credentials.apiKey)

    // 先把这一轮踢出去（有 Key = 真实请求；无 Key = 离线探针），**再**判定 system prompt。
    // ★ 顺序不能反：跑过一轮之前 `session.systemPrompt` 还是基座那份（含 cwd），
    //   先判定会把「本来没发出去的基座 prompt」误报成泄漏（票 03 实测踩到）。
    let turnError: string | undefined
    let deltaLine: string | undefined
    if (!hasKey) {
      log(`      无 Key → 启用离线探针（假 Key + 不可达 ${PROBE_BASE_URL}），只为把一轮踢到 system prompt 终态`)
      turnError = (await handle.fireTurn(phrase)).error
    } else if (!handle.authReady) {
      record('(e) 供应商凭证检查', false, 'checkAuth 未通过（Key 存在但 provider 未就绪）')
      return finish(false, false, 11)
    } else {
      try {
        const { delta, ms } = await handle.firstDelta(phrase)
        deltaLine = `${ms}ms 后到达：${JSON.stringify(delta)}`
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        record('(e) 收到首个流式增量', false, `${message} —— 网络/额度/Key 问题，与 Pi 可加载性无关`)
        return finish(false, false, 12)
      }
    }

    // (d) system prompt：三层证据 —— 基座（未覆盖时会长什么样）/ 会话终态 / **真正发出的字节**
    const effectivePrompt = handle.systemPrompt ?? ''
    const baseSeen = handle.baseSystemPromptSeen
    if (baseSeen) {
      const baseLeaks = findHostPathLeaks(baseSeen)
      if (baseLeaks.length > 0) {
        log(`      ★ 风险 #19 证据（未加第二道 override 时的基座 prompt）：${baseLeaks.join(' / ')}`)
      }
    }
    const leaks = findHostPathLeaks(effectivePrompt, [options.userDataDir, process.execPath])
    const dumpPath = join(handle.paths.logDir, 'system-prompt.txt')
    writeFileSync(dumpPath, effectivePrompt, 'utf8')
    record(
      '(d) system prompt 无宿主路径泄漏',
      leaks.length === 0,
      leaks.length ? `泄漏：${leaks.join(' / ')}` : `${effectivePrompt.length} 字符，已落盘 ${dumpPath}`
    )

    // (d2) 真正发到网络上的那份（`before_provider_request` 的 payload）。离线探针那一轮
    //      发不出去（baseUrl 不可达），所以只有 `providerRequestCount > 0` 时才判定。
    if (handle.wireSystemPrompt !== undefined) {
      const wireLeaks = findHostPathLeaks(handle.wireSystemPrompt, [options.userDataDir, process.execPath])
      const wireDump = join(handle.paths.logDir, 'system-prompt-wire.txt')
      writeFileSync(wireDump, handle.wireSystemPrompt, 'utf8')
      record(
        '(d2) 实际发出的 system prompt 无宿主路径泄漏',
        wireLeaks.length === 0,
        wireLeaks.length ? `泄漏：${wireLeaks.join(' / ')}` : `${handle.wireSystemPrompt.length} 字符，已落盘 ${wireDump}`
      )
      if (wireLeaks.length > 0) return finish(false, false, 13)
    } else {
      log(`      （本机无 Key：provider 请求没发出去，故无法断言「网络上跑的字节」；已断言会话终态那份）`)
    }
    if (turnError) log(`      （探针那一轮的报错属预期：${turnError.split('\n')[0]}）`)

    // (e) 流式 —— 没有 Key 时**在这一步之前**停住并说清楚
    if (!hasKey) {
      log('')
      log('【blocked】缺少 API Key —— 已经走到「准备发请求」这一步，之后的网络调用无法执行。')
      log('           ★ 这不等于 Pi 加载失败：导入 / runtime / session / system prompt 四项全部已通过。')
      log('           补齐任一来源后即可跑到首个增量：')
      log('             node scripts/pi-smoke.mjs --api-key sk-xxx')
      log('          或  set DEEPSEEK_API_KEY=sk-xxx   （auth.json / models.json 亦可）')
      return finish(true, true, 0)
    }

    record('(e) 收到首个流式增量', true, deltaLine ?? '(未捕获)')
    return finish(true, false, 0)
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    record('Pi 运行时装配', false, message)
    if (error instanceof Error && error.stack) log(error.stack)
    return finish(false, false, 1)
  } finally {
    if (handle) {
      try {
        await handle.dispose()
      } catch {
        // dispose 失败不该盖掉真正的结论
      }
    }
  }

  function finish(ok: boolean, blockedByMissingKey: boolean, exitCode: number): SmokeResult {
    log('')
    log(`结论        : ${ok ? (blockedByMissingKey ? '通过（到 Key 为止）' : '通过') : '失败'}`)
    log(`退出码      : ${exitCode}`)
    log('========================================================')
    return { ok, blockedByMissingKey, steps, exitCode }
  }
}

/** 打包态判定：不依赖 electron 模块（纯 Node 脚本里也要能跑）。 */
function isPackagedRuntime(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit
  return Boolean(process.env.K12_PI_SMOKE_PACKAGED)
}

interface NativeProbe {
  name: string
  ok: boolean
  detail: string
}

/**
 * 原生依赖实测（风险 #15 的判定点）。**只做诊断，不改变判定结果**：
 * 即便这里全绿，关卡 B₁ 也要靠「打包产物里真的跑一遍」才算过（见 `runPiSmoke`）。
 *
 * 为什么不能只 `require.resolve("esbuild")`：那只证明**模块**找得到，证明不了**二进制**能跑。
 * 所以这里做三件事：
 *   1. 从 **Pi 的入口**向上解析（复现 Node 真实解析顺序），并且**二进制与 JS 包必须同源**
 *      —— 本仓库有三份 esbuild（顶层 0.25.12 / `vite/node_modules` 0.28.2 /
 *      `pi-coding-agent/node_modules` 0.28.1），拿错副本会「版本对不上但看起来都在」；
 *   2. `app.asar` → `app.asar.unpacked` 的实体化纠正（Electron 的 `require.resolve` 会返回
 *      asar 虚拟路径，而 OS 需要实体文件）；
 *   3. 真的 `spawn --version` + 真的 `buildSync()` 打包一次 —— **这是唯一能区分
 *      「文件存在」与「文件可执行」的判据**（`fs.existsSync` 在 asar 虚拟层里会骗你）。
 */
function probeNativeDeps(piEntry?: string): NativeProbe[] {
  const probes: NativeProbe[] = []
  const origin = piEntry ?? fileURLToPath(import.meta.url)

  // ① esbuild 解析位置：解析起点必须是 Pi 的入口，否则命中的是构建期副本
  let location: EsbuildLocation | undefined
  try {
    location = locateEsbuild(origin)
    probes.push({
      name: 'esbuild 解析位置（自 Pi 入口向上）',
      ok: Boolean(location.packageJson && location.binary),
      detail: location.packageJson
        ? `esbuild@${location.version} ← ${location.packageJson}`
        : `自 ${origin} 向上找不到 node_modules/esbuild/package.json`
    })

    if (location.binary) {
      const real = location.binaryInsideAsar ? undefined : statSync(location.binary).size
      probes.push({
        name: 'esbuild 二进制是实体文件（不在 app.asar 内）',
        ok: !location.binaryInsideAsar,
        detail: location.binaryInsideAsar
          ? `★ 仍在 app.asar 内（未解包），spawn 必然 ENOENT：${location.binary}`
          : `${location.binary}（${real}B）`
      })
      if (!location.binaryInsideAsar) {
        const out = spawnSync(location.binary, ['--version'], { encoding: 'utf8', timeout: 20_000 })
        const version = (out.stdout ?? '').trim()
        probes.push({
          name: 'esbuild 可执行（spawn --version）',
          ok: out.status === 0 && version.length > 0,
          detail: `退出码=${out.status} 输出=${version || out.error?.message || '(空)'}`
        })
      }
    }
  } catch (error) {
    probes.push({
      name: 'esbuild 解析位置（自 Pi 入口向上）',
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    })
  }

  // ② clipboard 的 .node：只做「实体文件存在」判定（加载它要副作用，不值得为此引入拷贝）
  //    ⚠️ 它被 npm 提升到 **Pi 自己那层** node_modules 里，从本文件所在目录 resolve 不到，
  //    所以从 Pi 的入口路径逐级向上找 `<node_modules>/@mariozechner/`。
  //    实测（`scripts/pi-import-graph.mjs`）：这才是**包根导入真正会加载**的原生文件。
  try {
    const found = piEntry ? findClipboardNativeNear(piEntry) : undefined
    probes.push({
      name: 'clipboard 原生 .node（实体文件）',
      ok: Boolean(found),
      detail: found ?? '在 Pi 的各层 node_modules 里没找到当前平台的 clipboard-* 原生文件'
    })
  } catch (error) {
    probes.push({
      name: 'clipboard 原生 .node（实体文件）',
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    })
  }

  // ③ ★★ 最决定性的一步：**真的用 Pi 那一份 esbuild 打包一次**。
  //    这是 issue #9286 的原始故障形态 —— esbuild 的 JS 层用
  //    `require.resolve('@esbuild/<platform>/esbuild.exe')` 拿到路径后交给
  //    `child_process.spawn()`；而 Electron 的 `require.resolve` 对 asar 内文件返回的是
  //    **asar 虚拟路径**，`spawn` 不认识它 → ENOENT（即使文件已被 asarUnpack 解包）。
  //    修复见 `native-deps.ts` 的 `ensureEsbuildBinaryPath()`（设 ESBUILD_BINARY_PATH，
  //    esbuild 的 `generateBinPath()` 会优先用它）。
  try {
    // 必须**先**设环境变量再 require：esbuild 在模块求值时就把 env 读进局部变量
    const forced = ensureEsbuildBinaryPath(origin)
    const requireFrom = location?.packageJson ? pathToFileURL(location.packageJson).href : pathToFileURL(origin).href
    const esbuild = createRequire(requireFrom)('esbuild') as {
      version: string
      buildSync: (options: Record<string, unknown>) => { outputFiles?: Array<{ text: string }> }
    }
    const out = esbuild.buildSync({
      stdin: { contents: 'export const smoke = 42', loader: 'js', resolveDir: process.cwd() },
      bundle: true,
      write: false,
      format: 'esm'
    })
    const text = out.outputFiles?.[0]?.text ?? ''
    probes.push({
      name: 'esbuild 真实打包（buildSync）',
      ok: text.includes('42'),
      detail: `esbuild@${esbuild.version} 打包成功，产物 ${text.trim().length} 字节；ESBUILD_BINARY_PATH=${forced ?? '(未设)'}`
    })
  } catch (error) {
    probes.push({
      name: 'esbuild 真实打包（buildSync）',
      ok: false,
      detail: `★ 打包失败（issue #9286 的形态）：${error instanceof Error ? error.message : String(error)}`
    })
  }

  return probes
}

/** 从给定入口逐级向上，在每一层 node_modules 下找 `@mariozechner/clipboard-<platform>`。 */
function findClipboardNativeNear(entryPath: string): string | undefined {
  let dir = dirname(entryPath)
  for (let i = 0; i < 8; i += 1) {
    const scopeDir = toUnpackedPath(join(dir, 'node_modules', '@mariozechner'))
    if (existsSync(scopeDir)) {
      const hit = findClipboardNative(scopeDir)
      if (hit) return hit
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** 在 `@mariozechner/` 下找当前平台的 clipboard 原生 `.node`（asar 路径自动纠正到 unpacked）。 */
function findClipboardNative(scopeDir: string): string | undefined {
  const platformPart = `${process.platform}-${process.arch}`
  try {
    for (const entry of readdirSync(scopeDir)) {
      if (!entry.startsWith('clipboard-') || !entry.includes(platformPart)) continue
      const nativeDir = toUnpackedPath(join(scopeDir, entry))
      if (!existsSync(nativeDir)) continue
      const hit = readdirSync(nativeDir).find((file) => file.endsWith('.node'))
      if (hit) return join(nativeDir, hit)
    }
  } catch {
    // 目录不存在就算了，返回 undefined 由调用方记 FAIL
  }
  return undefined
}

/** 供 `scripts/pi-smoke.mjs` 兜底用：把 Electron 的 userData 规则在纯 Node 下复现。 */
export function fallbackUserDataDir(appName = 'k12-agent-desktop'): string {
  if (process.env.K12_USER_DATA_DIR) return process.env.K12_USER_DATA_DIR
  const home = process.env.APPDATA ?? process.env.XDG_CONFIG_HOME ?? process.env.HOME ?? process.cwd()
  return join(home, appName)
}
