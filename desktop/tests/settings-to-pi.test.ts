/**
 * 设置 → Pi 这条链路的**接线与纯函数**测试。
 *
 * 覆盖三块（都是本次改造新增的、且一旦被人改回去就会静默失效的东西）：
 *
 *   A. `buildModelsJsonConfig` —— 把设置翻译成 Pi 的 `models.json`。三条分支各有断言，
 *      其中「内置 provider + 内置模型**不写 models[]**」是**读源码 + 实测**得出的硬约束：
 *      写了会把内置模型的 `reasoning` / `compat.thinkingFormat` 静默抹掉。
 *
 *   B. `resolveCredentials` —— providerId 可配 + Key 优先级（设置页 > CLI > auth.json > env > models.json）。
 *
 *   C. `runtime-config.ts` —— 主进程专用的配置载体：回执形状校验、失败回落、
 *      **明文 Key 绝不落盘 / 绝不进日志**。
 *
 * 跑法：`npm test`。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  buildModelsJsonConfig,
  resolveCredentials,
  writeModelsJson,
  type CatalogProvider
} from '../src/main/agent/pi-bootstrap.ts'
import { resolvePiPaths } from '../src/main/agent/pi-paths.ts'
import { parseRuntimeLlmConfig } from '../src/main/settings/runtime-config.ts'

/**
 * `@shared/*` 与无扩展名相对导入的解析钩子。
 *
 * 前者是 vite/tsconfig 的别名（`@shared/* → src/shared/*`），Node 不认 —— 而渲染进程的
 * `api/settings.ts` 现在会**值导入** `@shared/provider-catalog`（不只是类型），
 * 所以测试里必须把它解析出来。后者是渲染进程源码用 Vite 风格的无后缀导入（`'../labels'`）。
 * 与 `renderer-quiz.test.ts` 里的钩子同一套做法。
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@shared/')) {
      const base = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'shared')
      const candidate = join(base, specifier.slice('@shared/'.length))
      for (const suffix of ['.ts', '/index.ts']) {
        if (existsSync(candidate + suffix)) {
          return { url: new URL(`file://${(candidate + suffix).replace(/\\/g, '/')}`).href, shortCircuit: true }
        }
      }
    }
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && context.parentURL) {
        for (const suffix of ['.ts', '/index.ts']) {
          const candidate = new URL(specifier + suffix, context.parentURL)
          if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
        }
      }
      throw error
    }
  }
})

// ★ 必须在钩子之后**动态**导入（静态 import 会被提升到钩子注册之前）
const {
  buildPresetOptions,
  findPresetById,
  MANUAL_PRESET_ID,
  mergeModelCandidates,
  selectedPresetId
} = await import('../src/renderer/src/api/settings.ts')
const { mergeModelCandidates: sharedMerge } = await import('../src/shared/provider-catalog.ts')
type ProviderCatalogEntry = import('../src/shared/provider-catalog.ts').ProviderCatalogEntry

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...segments: string[]): string => readFileSync(join(desktopRoot, ...segments), 'utf8')

/**
 * 去掉注释，只留**可执行代码**（接线守卫一律在 strip 之后的文本上匹配）。
 *
 * 为什么必须去（`architecture-guards.test.ts` 的同一条口径，那里踩过一次）：
 * 接线守卫的本质是「这行调用真的在生产路径上」。如果拿**原文**做 `includes`，
 * 那么「注释掉调用再写一行 `// TODO: 恢复 applySavedLlmConfig()`」也能满足守卫 ——
 * 守卫当场变成一句装饰。注释里解释约定是好事，不该被判违规，但也不该**代替**代码。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/gm, '$1')
}

/**
 * 取「从 `startIndex` 到下一个顶层声明之前」的那一段（在 **strip 之后**的文本上取）。
 *
 * 为什么不用 `slice(at, at + 1200)` 的定长窗口：代码一挪（多几行、改个参数），
 * 窗口就落到别的函数上 —— 断言要么「碰巧通过」要么「莫名失败」，窗口本身成了噪声源。
 */
function snippetUntilNextDeclaration(source: string, startIndex: number): string {
  const rest = source.slice(startIndex)
  const match = /\n(?:export\s|async\s+function\s|function\s|const\s|let\s|var\s)/.exec(rest.slice(1))
  return match ? rest.slice(0, match.index + 1) : rest
}

/** 接线守卫的读法：读源码并去注释（杜绝「写注释即满足守卫」）。 */
function readCode(...segments: string[]): string {
  return stripComments(read(...segments))
}

/** 测试用的假目录：一个内置 provider（deepseek，带 reasoning/compat）+ 一个无端点的。 */
const CATALOG: CatalogProvider[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    models: [
      {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        reasoning: true,
        thinkingLevelMap: { low: 'low', high: 'high' },
        input: ['text'],
        cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        compat: { thinkingFormat: 'deepseek', maxTokensField: 'max_tokens' }
      },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', reasoning: true }
    ]
  },
  { id: 'endpointless', name: '没有端点的供应商', models: [{ id: 'm-1', name: 'm-1' }] }
]

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'k12-wiring-'))
  return dir
}

/* ================================================================== *
 * A. buildModelsJsonConfig
 * ================================================================== */

test('A1 内置 provider + 内置模型：只改 provider 级 baseUrl，不写 models[]（保住内置 compat）', () => {
  const config = buildModelsJsonConfig(
    { providerId: 'deepseek', providerName: 'DeepSeek', baseUrl: 'https://proxy.example.com/v1', modelId: 'deepseek-v4-flash' },
    CATALOG
  )
  const entry = config.providers.deepseek

  assert.equal(entry.baseUrl, 'https://proxy.example.com/v1', '端点要被设置覆盖')
  assert.equal(entry.api, 'openai-completions')
  assert.ok(
    !('models' in entry),
    '★ 内置模型不得写进 models[]：provider-composer 会整条替换，把内置的 reasoning/compat 抹掉'
  )
})

test('A2 内置 provider + 非内置模型：追加 models[] 并从兄弟模型抄字段', () => {
  // 老配置里的 deepseek-chat 就是这种形态（它不在 Pi 目录里）
  const config = buildModelsJsonConfig(
    { providerId: 'deepseek', providerName: 'DeepSeek', baseUrl: 'https://api.deepseek.com', modelId: 'deepseek-chat' },
    CATALOG
  )
  const models = config.providers.deepseek.models as Array<Record<string, unknown>>

  assert.ok(Array.isArray(models), '非内置模型必须显式声明，否则 getModel 必然 miss')
  assert.equal(models.length, 1)
  assert.equal(models[0].id, 'deepseek-chat')
  assert.equal(models[0].baseUrl, 'https://api.deepseek.com')
  // ★ 抄字段：不抄的话新模型只有默认值（reasoning:false、无 deepseek 思考格式），
  //   同一 provider 下两个模型的行为会莫名其妙地不一致
  assert.equal(models[0].reasoning, true, 'reasoning 要从兄弟模型抄过来')
  assert.deepEqual(models[0].compat, { thinkingFormat: 'deepseek', maxTokensField: 'max_tokens' })
  assert.equal(models[0].contextWindow, 1_000_000)
})

test('A3 非内置 provider（校内网关）：必须写 models[]，否则 Pi 里一个模型都没有', () => {
  const config = buildModelsJsonConfig(
    { providerId: 'custom', providerName: '校内网关', baseUrl: 'https://gw.school.example.com/v1', modelId: 'gpt-4o-mini' },
    CATALOG
  )
  const entry = config.providers.custom
  const models = entry.models as Array<Record<string, unknown>>

  assert.equal(entry.baseUrl, 'https://gw.school.example.com/v1')
  assert.equal(entry.name, '校内网关')
  assert.equal(models.length, 1)
  assert.equal(models[0].id, 'gpt-4o-mini')
  // 没有内置定义时 API 形态是我们替它选的（OpenAI 兼容是唯一合理的默认）
  assert.equal(models[0].api, 'openai-completions')
})

test('A4 端点取值顺序：设置 > 该 provider 内置端点 > 全局默认', () => {
  const fromSettings = buildModelsJsonConfig(
    { providerId: 'deepseek', providerName: '', baseUrl: 'https://mine.example.com', modelId: 'deepseek-v4-flash' },
    CATALOG
  )
  assert.equal(fromSettings.providers.deepseek.baseUrl, 'https://mine.example.com')

  const fromCatalog = buildModelsJsonConfig(
    { providerId: 'deepseek', providerName: '', baseUrl: '', modelId: 'deepseek-v4-flash' },
    CATALOG
  )
  assert.equal(fromCatalog.providers.deepseek.baseUrl, 'https://api.deepseek.com', '空端点要用目录里的')

  const fromDefault = buildModelsJsonConfig(
    { providerId: 'unknown-provider', providerName: '', baseUrl: '', modelId: 'x' },
    CATALOG
  )
  assert.equal(fromDefault.providers['unknown-provider'].baseUrl, 'https://api.deepseek.com', '兜底用内置默认端点')
})

test('A5 providerName 为空时用目录里的显示名（写进 models.json 供排查）', () => {
  const config = buildModelsJsonConfig(
    { providerId: 'deepseek', providerName: '   ', baseUrl: '', modelId: 'deepseek-v4-flash' },
    CATALOG
  )
  assert.equal(config.providers.deepseek.name, 'DeepSeek')
})

test('A6 ★ 绝不写任何 API Key 进 models.json（Key 只走内存 setRuntimeApiKey）', () => {
  for (const modelId of ['deepseek-v4-flash', 'deepseek-chat']) {
    const config = buildModelsJsonConfig(
      { providerId: 'deepseek', providerName: 'DeepSeek', baseUrl: 'https://api.deepseek.com', modelId },
      CATALOG
    )
    const serialized = JSON.stringify(config).toLowerCase()
    assert.ok(!serialized.includes('apikey'), `models.json 里不得出现 apiKey 字段（${modelId}）`)
    assert.ok(!serialized.includes('sk-'), 'models.json 里不得出现任何看起来像 Key 的值')
  }
})

/* ================================================================== *
 * B. resolveCredentials
 * ================================================================== */

test('B1 providerId 可配（不再硬编码 deepseek）', () => {
  const dir = tempDir()
  try {
    const paths = resolvePiPaths(dir)
    assert.equal(resolveCredentials(paths, {}).providerId, 'deepseek', '不传时用内置默认')
    assert.equal(resolveCredentials(paths, { providerId: 'zai' }).providerId, 'zai')
    assert.equal(resolveCredentials(paths, { providerId: '  openai  ' }).providerId, 'openai', '要去空白')
    assert.equal(resolveCredentials(paths, { providerId: '' }).providerId, 'deepseek', '空串视为未指定')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('B2 Key 优先级：设置页 > CLI --api-key > auth.json > 环境变量 > models.json', () => {
  const dir = tempDir()
  try {
    const paths = resolvePiPaths(dir)
    mkdirSync(paths.agentDir, { recursive: true })
    writeFileSync(paths.authPath, JSON.stringify({ deepseek: { key: 'sk-from-auth' } }), 'utf8')
    writeFileSync(paths.modelsPath, JSON.stringify({ providers: { deepseek: { baseUrl: 'https://x', apiKey: 'sk-from-models' } } }), 'utf8')

    // 设置页的 Key 最优先（它是用户在界面上填的那把）
    assert.equal(
      resolveCredentials(paths, { apiKey: 'sk-from-settings', apiKeySource: 'settings' }).apiKey,
      'sk-from-settings'
    )
    assert.equal(
      resolveCredentials(paths, { apiKey: 'sk-from-settings', apiKeySource: 'settings' }).source,
      'settings'
    )
    // CLI 参数次之
    assert.equal(resolveCredentials(paths, { apiKey: 'sk-from-cli', apiKeySource: 'flag' }).source, 'flag')
    // 都没给 → auth.json
    const fromAuth = resolveCredentials(paths, {})
    assert.equal(fromAuth.apiKey, 'sk-from-auth')
    assert.equal(fromAuth.source, 'auth.json')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('B3 models.json 里的 $VAR 占位符不算 Key（那是环境变量引用，不是凭据）', () => {
  // ★ 这条断言**不能**依赖运行环境有没有设 `DEEPSEEK_API_KEY`：
  //   原来的写法是 `if (process.env.DEEPSEEK_API_KEY) { 断言 env } else { 断言不是 Key }`，
  //   于是「演示机为跑真模型 export 了该变量」时，**核心的那条断言根本不执行**而测试依然绿。
  //   现在：本用例内**显式清掉**它（try/finally 恢复），让「$VAR 占位符不算 Key」这条永远跑到；
  //   「环境变量优先级」单独写成下面 B3b 的显式用例（自己设、自己恢复）。
  const saved = process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_API_KEY
  const dir = tempDir()
  try {
    const paths = resolvePiPaths(dir)
    mkdirSync(paths.agentDir, { recursive: true })
    writeFileSync(
      paths.modelsPath,
      JSON.stringify({ providers: { deepseek: { baseUrl: 'https://x', apiKey: '$DEEPSEEK_API_KEY' } } }),
      'utf8'
    )
    const result = resolveCredentials(paths, { providerId: 'deepseek' })
    assert.equal(result.apiKey, undefined, '$ 开头的占位符绝不能被当成真的 Key')
    assert.notEqual(result.source, 'models.json', '占位符也不该让 source 记成「从 models.json 取到了 Key」')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    if (saved === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = saved
  }
})

test('B3b 环境变量优先级：auth.json 之后、models.json 之前的兜底（显式设/显式恢复）', () => {
  const saved = process.env.DEEPSEEK_API_KEY
  process.env.DEEPSEEK_API_KEY = 'sk-from-env-order-test'
  const dir = tempDir()
  try {
    const paths = resolvePiPaths(dir)
    // 不写 auth.json（让它一路走到 env 这一档）
    const result = resolveCredentials(paths, { providerId: 'deepseek' })
    assert.equal(result.source, 'env', '没有任何显式来源时应当用环境变量')
    assert.equal(result.apiKey, 'sk-from-env-order-test')

    // 设置页 / CLI 给的值必须**压过**环境变量（优先级链的第 1、2 档）
    assert.equal(
      resolveCredentials(paths, { providerId: 'deepseek', apiKey: 'sk-from-settings', apiKeySource: 'settings' }).apiKey,
      'sk-from-settings'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
    if (saved === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = saved
  }
})

test('B4 writeModelsJson 幂等可重写（语义与旧的 ensureModelsJson 相反）', () => {
  const dir = tempDir()
  try {
    const paths = resolvePiPaths(dir)
    writeModelsJson(paths, { providerId: 'deepseek', providerName: 'DeepSeek', baseUrl: 'https://a', modelId: 'deepseek-v4-flash' }, CATALOG)
    const first = readFileSync(paths.modelsPath, 'utf8')

    // 再写一次（换了配置）必须**覆盖**，不能像旧实现那样「存在就一个字节都不动」
    writeModelsJson(paths, { providerId: 'zai', providerName: 'Z.AI', baseUrl: 'https://b', modelId: 'glm-5.2' }, CATALOG)
    const second = readFileSync(paths.modelsPath, 'utf8')

    assert.notEqual(first, second, '★ 设置改了必须能写进去（否则设置页改了什么都进不去 Pi）')
    assert.ok(second.includes('zai'))
    assert.ok(!second.includes('deepseek'), '旧 provider 不该残留在文件里')
    assert.ok(!existsSync(`${paths.modelsPath}.tmp`), '原子写不该留下临时文件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ================================================================== *
 * C. runtime-config（主进程专用的配置载体）
 * ================================================================== */

test('C1 回执形状校验：缺关键字段一律返回 null（让调用方回落默认值）', () => {
  assert.equal(parseRuntimeLlmConfig(null), null)
  assert.equal(parseRuntimeLlmConfig('nope'), null)
  assert.equal(parseRuntimeLlmConfig({}), null)
  assert.equal(parseRuntimeLlmConfig({ providerId: 'deepseek' }), null, '缺 modelId')
  assert.equal(parseRuntimeLlmConfig({ modelId: 'x' }), null, '缺 providerId')
  assert.equal(parseRuntimeLlmConfig({ providerId: '  ', modelId: 'x' }), null, '全是空白也算缺')
})

test('C2 合法回执：原样带出明文 Key 与 hasKey（主进程要拿它去发请求）', () => {
  const parsed = parseRuntimeLlmConfig({
    providerId: 'zai',
    providerName: 'Z.AI',
    baseUrl: 'https://api.z.ai/api/v4',
    modelId: 'glm-5.2',
    apiKey: 'sk-plaintext-for-main-process',
    hasKey: true
  })
  assert.deepEqual(parsed, {
    providerId: 'zai',
    providerName: 'Z.AI',
    baseUrl: 'https://api.z.ai/api/v4',
    modelId: 'glm-5.2',
    apiKey: 'sk-plaintext-for-main-process',
    hasKey: true
  })
})

test('C3 未配置 Key：apiKey 空串 + hasKey 由 apiKey 推导（后端没给 hasKey 时）', () => {
  const parsed = parseRuntimeLlmConfig({ providerId: 'deepseek', modelId: 'deepseek-v4-flash' })
  assert.equal(parsed?.apiKey, '')
  assert.equal(parsed?.hasKey, false)
  assert.equal(parsed?.providerName, '', '缺 providerName 时给空串（它不是必需字段）')
  assert.equal(parsed?.baseUrl, '')
})

test('C4 ★ 接线守卫：建会话前先拉配置，且失败要能自愈（启动竞态）', () => {
  // ★ 在**去注释**的源码上匹配：否则「注释掉调用 + 写一行 TODO」就能满足守卫
  const handlers = readCode('src', 'main', 'ipc', 'handlers.ts')

  // ① 装配前必须读一次设置（这就是「启动先读配置」）
  const ensureAt = handlers.indexOf('export async function ensureChatRuntime')
  assert.ok(ensureAt > 0, 'handlers.ts 必须有 ensureChatRuntime')
  const ensureSnippet = snippetUntilNextDeclaration(handlers, ensureAt)
  assert.ok(
    ensureSnippet.includes('refreshRuntimeLlmConfig()'),
    '★ 装配前必须先读设置：否则「设置改完重启」用的还是内置默认值（实测踩到过）'
  )
  assert.ok(
    ensureSnippet.includes('createChatRuntime('),
    '读完配置要把它交给会话工厂'
  )

  // ② ★ 启动竞态的自愈：渲染进程挂载就读学段 → 早于 sidecar 就绪就把会话建出来了，
  //    那种会话必须能在「拿到设置之后」补上，否则本次运行里设置永远不生效。
  assert.ok(
    handlers.includes('ensureRuntimeConfigApplied'),
    '★ 必须有「补配置」这条路径（启动竞态：学段徽章会早于 sidecar 建会话）'
  )
  const runTurnAt = handlers.indexOf('async function runChatTurn')
  assert.ok(runTurnAt > 0, 'handlers.ts 必须有 runChatTurn')
  const runTurnSnippet = snippetUntilNextDeclaration(handlers, runTurnAt)
  assert.ok(
    runTurnSnippet.includes('await ensureRuntimeConfigApplied()'),
    '每轮对话开始前要试着补一次配置（幂等、便宜）'
  )

  // ③ 保存成功后要热应用（「保存即生效」）
  const saveAt = handlers.indexOf('IPC.settingsSave')
  assert.ok(saveAt > 0, 'handlers.ts 必须有 settingsSave 处理器')
  const saveSnippet = snippetUntilNextDeclaration(handlers, saveAt)
  assert.ok(
    saveSnippet.includes('applySavedLlmConfig()'),
    '★ 保存成功后必须热应用，否则用户改完设置要重启才生效'
  )
  // ★ 但热应用失败**不能**把「保存成功」变成失败回执（配置已经落盘了）
  assert.ok(
    saveSnippet.includes('return { ok: true, data }'),
    '保存成功就回成功 —— 热切换是尽力而为，不该反过来否定已经落盘的保存'
  )
})

test('C5 ★ 接线守卫：热切换失败要销毁会话让下一条消息按新配置重建', () => {
  const handlers = readCode('src', 'main', 'ipc', 'handlers.ts')
  const at = handlers.indexOf('async function applySavedLlmConfig')
  assert.ok(at > 0, 'handlers.ts 必须有 applySavedLlmConfig')
  const snippet = snippetUntilNextDeclaration(handlers, at)

  assert.ok(snippet.includes('applyLlmConfig('), '要走 runtime 的热切换')
  assert.ok(
    snippet.includes('disposeChatRuntime()'),
    '★ 热切换失败必须销毁会话：下一条消息会按新配置重建（否则失败就彻底不生效了）'
  )
  // 这条路径在保存成功的回执后面，绝不能抛出去（strip 之后不再需要逐行跳过 `*` 行）
  assert.ok(
    !/\bthrow\b/.test(snippet),
    'applySavedLlmConfig 不得抛异常（它在「保存成功」的回执路径上）'
  )
})

/* ================================================================== *
 * D. 设置页的预设 / 候选逻辑
 * ================================================================== */

const ENTRY: ProviderCatalogEntry[] = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', models: [{ id: 'm1', name: 'm1' }, { id: 'm2', name: 'm2' }] },
  { id: 'empty', name: '没有模型的供应商', baseUrl: 'https://x', models: [] },
  { id: 'noendpoint', name: '没有端点的', baseUrl: null, models: [{ id: 'n1', name: 'n1' }] }
]

test('D1 预设选项：过滤掉没有任何模型的 provider（选它只会得到找不到模型的配置）', () => {
  const options = buildPresetOptions(ENTRY)
  assert.deepEqual(options.map((option) => option.id).sort(), ['deepseek', 'noendpoint'])
  assert.ok(!options.some((option) => option.id === 'empty'))
  assert.deepEqual(options.find((option) => option.id === 'deepseek')?.models, ['m1', 'm2'])
})

test('D2 预设选项：有端点的排前面（选完就能用）', () => {
  const options = buildPresetOptions(ENTRY)
  assert.equal(options[0].id, 'deepseek', '有内置端点的要排在最前面')
  assert.equal(options.find((option) => option.id === 'noendpoint')?.baseUrl, '', 'null 端点归一成空串')
})

test('D3 下拉取值：认得的 providerId 停在它上面，认不得的停在「手动填写」', () => {
  const options = buildPresetOptions(ENTRY)
  assert.equal(selectedPresetId(options, 'deepseek'), 'deepseek')
  assert.equal(selectedPresetId(options, 'custom'), MANUAL_PRESET_ID, '★ 手填的 id 不该被显示成某个内置供应商')
  assert.equal(selectedPresetId(options, ''), MANUAL_PRESET_ID)
  assert.equal(findPresetById(options, 'deepseek')?.label, 'DeepSeek')
})

test('D4 ★ 候选合并：只有一处实现，主进程与渲染进程共用', () => {
  /**
   * 曾经是两份实现（主进程一份、渲染进程一份），**被这条测试逼出了分叉**：
   * 两边逻辑等价但写法不同（`!trimmed` vs `trimmed === ''`），
   * 于是改成「实现放 `@shared/provider-catalog`，两边都 import 它」。
   *
   * 这条测试现在守两件事：
   *   ① 行为规格（下面这张表就是规则本身）；
   *   ② **实现只有一处** —— 两个消费点都必须 import，不得各写一份。
   */
  const cases: Array<{ preset: string[]; endpoint: string[]; expect: string[] }> = [
    { preset: ['b', 'a', 'dup'], endpoint: ['dup', 'c', '  ', 'c'], expect: ['b', 'a', 'dup', 'c'] },
    { preset: [], endpoint: [], expect: [] },
    { preset: ['only'], endpoint: [], expect: ['only'] },
    { preset: [], endpoint: ['x'], expect: ['x'] },
    { preset: ['  pad  '], endpoint: [], expect: ['pad'] },
    { preset: ['a'], endpoint: ['a'], expect: ['a'] }
  ]
  for (const item of cases) {
    assert.deepEqual(
      mergeModelCandidates(item.preset, item.endpoint),
      item.expect,
      `预设在前、去重、保持原顺序、丢掉空白项（用例：${JSON.stringify(item)}）`
    )
  }

  // ② 唯一实现点：不得在任何消费方再写一份 `function mergeModelCandidates`
  const consumers = [
    read('src', 'main', 'ipc', 'handlers.ts'),
    read('src', 'renderer', 'src', 'api', 'settings.ts')
  ]
  for (const source of consumers) {
    assert.ok(
      !/function\s+mergeModelCandidates/.test(source),
      '★ 候选合并只能有一处实现（shared/provider-catalog）：再写一份就会与它悄悄分叉'
    )
    assert.ok(
      source.includes('@shared/provider-catalog'),
      '消费方必须 import 共享实现（主进程与渲染进程共用同一份规则）'
    )
  }

  // 正向断言：共享模块里确实有实现，且两条 import 路径拿到的是**同一个函数**
  const sharedSource = read('src', 'shared', 'provider-catalog.ts')
  assert.ok(
    /export function mergeModelCandidates/.test(sharedSource),
    'shared/provider-catalog.ts 必须有 mergeModelCandidates 的实现'
  )
  assert.equal(mergeModelCandidates, sharedMerge, '渲染进程 re-export 的必须是同一个函数（不是包装过的副本）')
})
