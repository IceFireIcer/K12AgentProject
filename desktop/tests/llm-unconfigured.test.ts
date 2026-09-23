/**
 * 「还没配置模型」的显示（2026-09-22）。
 *
 * ---------------------------------------------------------------------------
 * 这一组守的是什么
 * ---------------------------------------------------------------------------
 * 缺陷形态：顶栏与输入条上的模型 chip **直接显示服务端默认值**（`deepseek-v4-flash`），
 * 而那个默认值在「一个 Key 都没填」的首次安装上也照样存在 ——
 * 于是学生/老师看到的第一眼是「已经配好了一个模型」，而实际上他打出去的每一句话
 * 都只会失败（主进程走「缺 Key」早退，提示还是技术口吻的）。
 *
 * ★ 修法只改**显示**，底层默认值一个字节都不动：Pi 建会话必须有供应商与端点，
 *   填了 Key 就该立刻能用（见 `pi-bootstrap.ts` 的 `DEFAULT_*` 说明与 D-069）。
 * ★ 判据的唯一实现在 `labels.ts` 的 `llmReadyState`（顶栏 chip / 输入条 chip /
 *   选择弹层 / 对话页空态提示 四处共用）—— 四处各判一次，迟早有一处还显示模型名。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

/**
 * 解析钩子：`@shared/*` 别名 + 「相对且没写扩展名」的 Vite 风格导入。
 *
 * ★ 为什么必须有：本文件要**行为面**地跑一遍 `stores/settings.ts`（读一份假设置回执，
 *   看 chip 上显示什么），而它值导入 `api/settings.ts` → `@shared/provider-catalog`
 *   —— `@shared/*` 是 vite/tsconfig 的别名，Node 不认（与 `settings-to-pi.test.ts`
 *   同一套做法，别在这里另发明一种）。
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

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = join(HERE, '..')
const read = (rel: string): string => readFileSync(join(DESKTOP, rel), 'utf8')

/**
 * 取「以某个标签为根的那个元素」的整段源码（含全部子节点）。
 *
 * ★ 为什么需要它：下面要断「入口卡**在空态里**」，而空态是一个四层嵌套的
 *   `<div data-testid="chat-empty">`。用「往后找第一个 `</div>`」会切在内层，
 *   用固定字符数切片又会被下一次改动的排版绊倒（多写两行注释就假红、少写就假绿）。
 *   所以按 `<div` / `</div>` 配对计数，一路走到它的闭合处。
 * ⚠️ 只在**模板**区用：`<div` 若出现在属性值或注释里会算错（本项目当前没有这种写法，
 *   下面那条 `doesNotMatch(/<ChatMessage/)` 是防「切多了」的自检）。
 */
function divBlockAt(source: string, markerIndex: number): string {
  const open = source.lastIndexOf('<div', markerIndex)
  if (open < 0) return ''
  const tags = /<div(?=[\s/>])|<\/div>/g
  tags.lastIndex = open
  let depth = 0
  let match: RegExpExecArray | null
  while ((match = tags.exec(source)) !== null) {
    if (match[0] === '</div>') {
      depth -= 1
      if (depth === 0) return source.slice(open, tags.lastIndex)
    } else {
      depth += 1
    }
  }
  return ''
}

const MODEL_STORE = 'src/renderer/src/stores/model.ts'
const TOPBAR = 'src/renderer/src/components/AppTopbar.vue'
const COMPOSER = 'src/renderer/src/components/MessageComposer.vue'
const PICKER = 'src/renderer/src/components/ModelPicker.vue'
const CHAT_VIEW = 'src/renderer/src/views/Chat.vue'

/** 一份最小的设置快照（只需要 `llm` 那几个字段，其余照契约给默认值）。 */
function snapshot(llm: { hasKey: boolean; modelId: string; apiKey?: string }): unknown {
  return {
    llm: {
      providerId: 'deepseek',
      providerName: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      modelId: llm.modelId,
      apiKey: llm.apiKey ?? (llm.hasKey ? '…abcd' : ''),
      hasKey: llm.hasKey
    },
    embedding: {
      mode: 'local_fastembed',
      baseUrl: null,
      modelId: null,
      apiKey: '',
      hasKey: false
    }
  }
}

function installSettingsBridge(data: unknown): void {
  const ok = { ok: true, data }
  const api = {
    readSettings: () => Promise.resolve(ok),
    saveSettings: () => Promise.resolve(ok),
    probeSettings: () => Promise.resolve({ ok: false, message: '未接线' }),
    readProviderCatalog: () => Promise.resolve({ ok: true, data: [] }),
    fetchProviderModels: () => Promise.resolve({ ok: true, data: { candidates: [], issues: [] } })
  }
  ;(globalThis as { window?: unknown }).window = { api }
}

/* ------------------------------------------------------------------ *
 * 1. ★★ 三态判据（纯函数）
 * ------------------------------------------------------------------ */

test('★★ 判据：没读到设置 = 读取中｜没 Key = 未配置｜有 Key + 有模型 = 已配置', async () => {
  const { llmReadyState, llmDisplayLabel, LLM_UNCONFIGURED_LABEL, LLM_LOADING_LABEL } = await import(
    '../src/renderer/src/labels.ts'
  )

  assert.equal(llmReadyState(null), 'loading', '快照还没到 → 读取中（**不许**当未配置：那是一次假报警）')
  assert.equal(
    llmReadyState({ hasKey: false, modelId: 'deepseek-v4-flash' }),
    'unconfigured',
    '★★ 没填 Key 就是「未配置」——**哪怕 modelId 里躺着一个服务端默认模型名**（这正是缺陷的根因）'
  )
  assert.equal(
    llmReadyState({ hasKey: true, modelId: 'deepseek-v4-flash' }),
    'ready',
    '填了 Key 且模型名非空 → 已配置'
  )
  assert.equal(
    llmReadyState({ hasKey: true, modelId: '   ' }),
    'unconfigured',
    '★ 有 Key 但模型名是空白 → 仍然算未配置（chip 上不能是空白）'
  )

  assert.equal(llmDisplayLabel(null), LLM_LOADING_LABEL)
  assert.equal(
    llmDisplayLabel({ hasKey: false, modelId: 'deepseek-v4-flash' }),
    LLM_UNCONFIGURED_LABEL,
    '★★ 未配置时 chip 上必须是「未配置」，不许出现模型名'
  )
  assert.equal(llmDisplayLabel({ hasKey: true, modelId: ' deepseek-v4-pro ' }), 'deepseek-v4-pro', '已配置 → 模型名（去掉首尾空白）')
})

test('★ 学生看到的说明里不许出现技术词（API Key / BaseURL / Model ID）', async () => {
  const { llmChipTitle } = await import('../src/renderer/src/labels.ts')
  const student = llmChipTitle({ hasKey: false, modelId: 'deepseek-v4-flash' }, false)
  for (const term of ['API Key', 'BaseURL', 'Model ID', 'api.deepseek']) {
    assert.ok(
      !student.includes(term),
      `★ 学生视角的说明里出现了「${term}」：${student}\n` +
        '  —— 双视角纪律（D-063）：学生那一半给的是「找谁」（老师或家长），不是「填什么」'
    )
  }
  assert.match(student, /老师或家长/, '★ 学生视角要说清「找谁」')

  const teacher = llmChipTitle({ hasKey: false, modelId: 'deepseek-v4-flash' }, true)
  assert.match(teacher, /API Key/, '教师视角要说清「填什么」（他有权限、也需要知道）')

  // 已配置时两半都要给出「当前模型」（学生那半不许说「点击更换」——弹层对他是只读的）
  const studentReady = llmChipTitle({ hasKey: true, modelId: 'deepseek-v4-flash' }, false)
  assert.match(studentReady, /deepseek-v4-flash/)
  assert.ok(!studentReady.includes('点击更换'), '★ 学生视角不许承诺「点击更换」（弹层只读）')
})

/* ------------------------------------------------------------------ *
 * 2. ★★ 四个显示点都走同一个判据（源码级）
 * ------------------------------------------------------------------ */

test('★★ 两个 chip 都调 `llmChipTitle`（不许各自拼一份）', () => {
  for (const file of [TOPBAR, COMPOSER]) {
    const source = read(file)
    assert.match(source, /llmChipTitle\(/, `${file} 必须用 labels.ts 的 llmChipTitle（唯一实现）`)
  }
  const topbar = read(TOPBAR)
  assert.doesNotMatch(
    topbar,
    /当前模型：\$\{model\.current/,
    '★ 顶栏不许自己拼「当前模型：…」——它会绕过三态判据（未配置时照样显示模型名）'
  )
  const composer = read(COMPOSER)
  assert.doesNotMatch(composer, /当前模型：\$\{model\.label/, '★ 输入条同上')
})

test('★★ `stores/model.ts`：未配置时 `current` 必须为 `null`、`label` 必须走三态', () => {
  const source = read(MODEL_STORE)
  assert.match(
    source,
    /if \(!llm \|\| llmReadyState\(llm\) !== 'ready'\) return null/,
    '★★ `current`（= 「当前在用的模型」）在未配置时必须为 null —— 否则弹层会给一个候选打上「正在用」'
  )
  assert.match(
    source,
    /const label = computed\(\(\) => llmDisplayLabel\(settings\.snapshot\?\.llm\)\)/,
    '★ chip 标签必须走 llmDisplayLabel（三态），不许再写 `?? \'未配置模型\'` 那种只在快照缺失时兜底的写法'
  )
  assert.doesNotMatch(
    source,
    /未配置模型/,
    "★ 旧文案「未配置模型」只在**快照缺失**时出现（那时显示的是模型名而不是它）—— 换成三态之后不该再有它"
  )
})

test('★★ 选择弹层：未配置时给一条明确的配置引导（并撤掉「正在使用的模型」这个说法）', () => {
  const source = read(PICKER)
  assert.match(source, /const needsSetup = computed\(\(\) => model\.readyState === 'unconfigured'\)/, '弹层要读同一个判据')
  assert.match(source, /data-testid="model-unconfigured"/, '★ 未配置要有一块明确的引导')
  assert.match(source, /data-testid="model-setup-cta"/, '★ 引导里要有一个能点的「打开设置」')
  // ★ 「正在使用的模型」这个标题在没有模型在用的时候是假话
  assert.match(
    source,
    /needsSetup \? '还没配置模型' : viewMode\.isTeacher \? '选择模型' : '正在使用的模型'/,
    '★ 未配置时标题不许还说「正在使用的模型」（那时没有任何模型在用）'
  )
})

test('★★ 对话页空态：进门就说清「还答不了」+ 现在能用的功能 + 去设置', () => {
  const source = read(CHAT_VIEW)
  assert.match(source, /data-testid="chat-llm-unconfigured"/, '★ 空态里要有这条提示')
  assert.match(source, /data-testid="chat-llm-setup"/, '★ 要有去设置的入口')
  const at = source.indexOf('data-testid="chat-llm-unconfigured"')
  const block = source.slice(at, at + 1600)
  assert.match(block, /viewMode\.isTeacher/, '★ 两半各说各的话（老师看「填什么」、学生看「找谁」）')
  // 「还答不了」：学生打出去之前唯一一次说清楚的机会（等他打完整句话再报错就晚了）
  assert.match(block, /答不了/, '★ 学生那半要直说「现在问不了问题」')
  // 「去设置」：给的是**去哪配**（学生那半说「找老师或家长」，不是「填什么」）
  assert.match(block, /设置/, '★ 要指出去哪配置（学生视角下这是唯一能做的动作）')

  // ══════════════════════════════════════════════════════════════════════
  // ★★ 「现在还能干什么」由**空态里的入口卡**兑现，不由黄条复述
  //     （2026-09-22 设计评审报告 C3；这条守卫的意图没变，变的是它的兑现者）
  // ══════════════════════════════════════════════════════════════════════
  // 旧写法：黄条末句再写一遍「下面的动画 / 编程 / 闯关不依赖模型，现在就能用」。
  // 事实：**正下方就是那几张入口卡**，同一件事在同一屏说两遍（报告 0.1-2：
  // 同一事实全局只出现一处）。所以那句话被删了 —— 但**不是**这条守卫可以少守一件事：
  // 学生进门仍然要同时知道 ① 现在问不了问题；② 现在还能干什么；③ 去哪配。
  // 只是②的兑现者从「黄条里的一句话」换成了「真的渲染出来的入口卡」，
  // 所以下面断的是「入口卡在空态里、且三个本地页面真的挂在上面」。
  // ⚠️ 别把那句文案加回黄条：它一加回来，②就又有了两个来源（这正是这段注释要拦的事）。
  const emptyAt = source.indexOf('data-testid="chat-empty"')
  assert.ok(emptyAt > 0, '对话页必须有空态容器（data-testid="chat-empty"）')
  const empty = divBlockAt(source, emptyAt)
  assert.ok(empty.length > 0, '空态容器的闭合标签必须能配对（改了嵌套结构就同步 `divBlockAt` 的取块方式）')
  assert.doesNotMatch(empty, /<ChatMessage/, '取块必须停在空态里 —— 把消息列表（`v-else` 那一支）也算进来会让下面几条假绿')
  assert.match(empty, /data-testid="chat-llm-unconfigured"/, '★ 黄条本身也必须在空态里（飘到外面的话，没配模型的学生要打完一句话才看到它）')
  assert.match(empty, /class="chat__entries"/, '★ 空态里必须有入口卡容器（「现在还能干什么」的兑现者）')
  assert.match(empty, /v-for="e in entries"/, '★ 入口卡必须真的按 `entries` 渲染 —— 只留一个空容器等于什么都没说')
  // 三个本地功能（动画 / 编程 / 闯关）真的挂在 entries 上：它们才是「不依赖模型也能用」的实体
  for (const page of ['animation', 'coding', 'quiz']) {
    assert.match(
      source,
      new RegExp(`to: '${page}'`),
      `★ entries 里必须有去 ${page} 的入口 —— 黄条不再复述那三样，学生能不能知道「现在还能干什么」全靠这几张卡`
    )
  }
})

/* ------------------------------------------------------------------ *
 * 3. ★★ 行为面：真的把设置读进来，看 chip 上显示什么
 * ------------------------------------------------------------------ */

test('★★ 没填 Key → chip 显示「未配置」（不是 deepseek-v4-flash）', async () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  try {
    installSettingsBridge(snapshot({ hasKey: false, modelId: 'deepseek-v4-flash' }))
    const { useSettingsStore } = await import('../src/renderer/src/stores/settings.ts')
    const { useModelStore } = await import('../src/renderer/src/stores/model.ts')
    setActivePinia(createPinia())
    const settings = useSettingsStore()
    const model = useModelStore()

    await settings.load()
    assert.equal(model.readyState, 'unconfigured')
    assert.equal(model.current, null, '★ 未配置时没有「当前模型」')
    assert.equal(model.label, '未配置', '★★ chip 上必须是「未配置」—— 显示模型名会让用户以为已经配好了')
    assert.equal(model.shortLabel, '未配置')
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = originalWindow
  }
})

test('★ 填了 Key → chip 显示模型名（后端的默认值照旧可用，不需要用户重选）', async () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  try {
    installSettingsBridge(snapshot({ hasKey: true, modelId: 'deepseek-v4-flash' }))
    const { useSettingsStore } = await import('../src/renderer/src/stores/settings.ts')
    const { useModelStore } = await import('../src/renderer/src/stores/model.ts')
    setActivePinia(createPinia())
    const settings = useSettingsStore()
    const model = useModelStore()

    await settings.load()
    assert.equal(model.readyState, 'ready')
    assert.equal(model.label, 'deepseek-v4-flash')
    assert.equal(model.current?.modelId, 'deepseek-v4-flash')
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = originalWindow
  }
})
