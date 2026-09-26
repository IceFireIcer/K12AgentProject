/**
 * 演示模式（轮次诊断信封 + 演示驾驶舱 + 只读机制浮窗 + 三档视角）的守卫与单测。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一组测试守的是什么
 * ══════════════════════════════════════════════════════════════════════════
 * 演示模式最容易出的不是「跑不起来」，而是**演示时说了一句不成立的话**：
 *   · 「每轮都推一次信封」→ 其实早退路径（输入拦截 / 无 Key）没推；
 *   · 「落盘只留结构」→ 其实把学生正文也写进 JSONL 了；
 *   · 「四级链逐级可见」→ 其实老后端没给 `attempts`，界面却自己编了三档；
 *   · 「这条旁路坏了不影响对话」→ 其实 bridge 缺失时把整块数据面判成不可用；
 *   · 「演示页只在最高档可达」→ 其实教师档侧栏里就摆着它。
 * 所以下面每条都落在**可机械复核的判据**上（行为、字段集合、import 关系、通道归属）。
 *
 * ★ 与 `student-view-discipline.test.ts` 的分工：那个管「学生看得到什么」，
 *   这个管「证据是真是假、旁路是不是真的旁路」。两者互补，不要合并。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

/**
 * 解析钩子：让 Node 也能加载主进程模块里的两种写法。
 *
 * ★ 为什么需要：主进程源码用 `@shared/*` 别名（走 electron-vite 解析）与**不带后缀**的相对
 *   import（走 tsc/vite 解析），而 Node 的 ESM 加载器两条都不认 —— 那些模块平时靠
 *   `tsc` / 打包器加载，本文件是**第一个直接 import 它们的测试**。
 * ⚠️ 只影响本测试进程；不要在别的测试里复制一份（要共用就抽成 helper）。
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = join(HERE, '..')
const RENDERER = join(DESKTOP, 'src', 'renderer', 'src')

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@shared/')) {
      const file = join(DESKTOP, 'src', 'shared', `${specifier.slice('@shared/'.length)}.ts`)
      return nextResolve(pathToFileURL(file).href, context)
    }
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context)
      }
      throw error
    }
  }
})

const read = (rel: string): string => readFileSync(join(DESKTOP, rel), 'utf8')

/** 递归列出渲染进程下的 `.vue` / `.ts`。 */
function rendererFiles(dir: string = RENDERER): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...rendererFiles(full))
    else if (/\.(vue|ts)$/.test(entry)) out.push(full)
  }
  return out
}

const rel = (file: string): string => file.slice(RENDERER.length + 1).replaceAll('\\', '/')

/** 临时目录（诊断存储的落盘测试用）。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'k12-diag-'))
  test.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/* ================================================================== *
 * ① 信封采集：每一条记录都必须来自真实发生的机制
 * ================================================================== */

test('★★ 轮次信封：输入拦截 / 学段冷却 / 撤回 / 推理过滤 都被如实记进对应字段', async () => {
  const { TurnDiagnosticsRecorder, filterReasoning } = await import('../src/main/agent/diagnostics.ts')

  const recorder = new TurnDiagnosticsRecorder({
    turn: 3,
    requestId: 'req-3',
    text: '循环是怎么工作的？',
    gradeLevel: 'junior',
    at: Date.now() - 50
  })

  // ① 入口安全：放行 → 阶段记 pass，且**不**产生拦截记录
  recorder.noteInputSafety({ allowed: true })

  // ② 学段观察：在冷却期内 → 必须留下一条拦截记录（演示模式的高潮就是「我拦下了什么」）
  recorder.noteGrade({
    turn: 3,
    appliedGrade: 'junior',
    pendingGrade: null,
    layer2: 'not_due',
    cumulativeTurns: 3,
    decidedBy: 'rules',
    lastReason: '连续两轮用词偏初中',
    cooldownRemainingTurns: 2
  })

  // ③ Prompt 拼装：三段结构（模板 / 画像 / 权威段）
  recorder.notePrompt({
    prompt: ['# 你的角色', '你是智团团。', '', '## 该学生当前情况（系统自动汇总，不要逐条念给学生）', '掌握度 0.5', '', '## 学段（系统自动推断，以此段为准）', '本轮按初中作答。'].join('\n'),
    gradeTemplate: 'junior',
    hostPathClean: true,
    overrides: [
      { stage: 'override', applied: true, note: '建会话时替换' },
      { stage: 'per-turn', applied: true, note: '每轮重拼' },
      { stage: 'authority', applied: true, note: '恒追加' }
    ]
  })

  // ④ 画像块：与上一轮同一份 → sameAsPrev 为真（前缀可复用）
  recorder.noteStudentContext('## 该学生当前情况\n掌握度 0.5', '')
  const firstHash = recorder.current().studentContext.byteHash
  const again = new TurnDiagnosticsRecorder({ turn: 4, requestId: 'req-4', text: '再讲一遍', gradeLevel: 'junior' })
  again.noteStudentContext('## 该学生当前情况\n掌握度 0.5', firstHash)
  assert.equal(again.current().studentContext.sameAsPrev, true, '同一份画像块必须被判成逐字节相同')
  assert.equal(again.current().studentContext.byteHash, firstHash, '同一份画像块的指纹必须一致')
  const changed = new TurnDiagnosticsRecorder({ turn: 5, requestId: 'req-5', text: 'x', gradeLevel: 'junior' })
  changed.noteStudentContext('## 该学生当前情况\n掌握度 0.7', firstHash)
  assert.equal(changed.current().studentContext.sameAsPrev, false, '画像块变了就不能说「逐字节相同」')

  // ⑤ 工具调用（窗口由 runtime 按轮次筛好，这里直接给这一轮的）
  recorder.noteTools([
    { turn: 3, toolName: 'rag_search', ok: true, latencyMs: 142 },
    { turn: 3, toolName: 'get_code_template', ok: false, latencyMs: 890, degraded: 'fts' }
  ])

  // ⑥ 检索四级链（Python 的逐级记录）
  recorder.noteRetrieval({
    query: '循环',
    degraded: 'fts',
    gradeFilter: "grade_level IN ('junior','primary_high','primary_low')",
    hitCount: 2,
    compatCount: 1,
    levels: [
      { level: 'vector', tried: true, ok: false, hits: 0, note: 'sqlite-vec KNN 无命中' },
      { level: 'cloud', tried: false, ok: false, hits: 0, note: '未配置云端嵌入' },
      { level: 'fts', tried: true, ok: true, hits: 2, note: 'FTS5 trigram' },
      { level: 'outline', tried: false, ok: false, hits: 0, note: '未走到这一档' }
    ]
  })

  // ⑦ 生成侧终审：撤回 1 次 → 终审阶段记 blocked，并留下拦截记录
  recorder.noteSafetyFinal({ finalizations: 1, retractions: 1, bufferedChars: 320, streamed: true })

  // ⑧ 模型推理：含本机路径 → **整段替换**（不是打码）
  recorder.noteThinkingDelta('先看 E:\\data\\kb.sqlite 里的内容')
  const turn = recorder.finish({ ok: false, status: 'blocked' })

  assert.equal(turn.turn, 3)
  assert.equal(turn.input.text, '循环是怎么工作的？', '学生输入要原样进信封（它只进内存，不落盘）')
  assert.deepEqual(
    turn.interceptions.map((item) => item.source),
    ['学段 · 冷却窗口', '内容安全 · 生成侧终审'],
    '两条拦截都必须留下记录（演示模式最强的证据就是「我拦下了什么」）'
  )
  const stages = Object.fromEntries(turn.safetyFinal.stages.map((stage) => [stage.stage, stage.verdict]))
  assert.deepEqual(stages, { input: 'pass', stream: 'pass', final: 'blocked' }, '三阶段的结论要逐段如实')
  assert.equal(turn.reasoning.available, false, '含本机路径的推理必须整段丢弃')
  assert.equal(turn.reasoning.filtered, '', '丢弃就是丢弃（不做局部遮盖）')
  assert.match(turn.reasoning.note, /整段丢弃/, '要写清为什么没有内容')
  assert.equal(turn.tools.length, 2)
  assert.equal(turn.retrieval?.levels.length, 4, '四档都要在（没走到的那档写「未走到」）')
  assert.equal(turn.prompt.segments.some((segment) => segment.id === 'student-context'), true)
  assert.equal(turn.prompt.segments.some((segment) => segment.id === 'grade-authority'), true)
  assert.equal(turn.done.status, 'blocked')
  assert.ok(turn.done.totalMs >= 0)

  // 推理过滤：干净内容照常放行；含凭证形状的一律整段丢弃
  assert.equal(filterReasoning('先把问题拆成两步').available, true)
  assert.equal(filterReasoning('key 是 sk-abcdefgh12345678').available, false)
})

test('★★ 推理过滤：本机路径 / 凭证形状一律整段丢弃，干净内容只做路径兜底替换', async () => {
  const { filterReasoning } = await import('../src/main/agent/diagnostics.ts')

  assert.deepEqual(filterReasoning(''), { available: false, filtered: '', note: '本轮没有拿到模型推理增量。' })
  const risky = filterReasoning('API_KEY = abc')
  assert.equal(risky.available, false)
  assert.equal(risky.filtered, '')
  const clean = filterReasoning('先解释循环，再举一个生活例子')
  assert.equal(clean.available, true)
  assert.match(clean.note, /默认折叠/)
})

/* ================================================================== *
 * ② 落盘纪律：正文一律不落，结构与结论照留
 * ================================================================== */

test('★★ 落盘前剥离：正文 / 画像块 / Prompt 原文 / 检索词 / 推理 全部置空，计数与结论保留', async () => {
  const { stripForPersistence, TurnDiagnosticsRecorder, byteHash } = await import(
    '../src/main/agent/diagnostics.ts'
  )

  const recorder = new TurnDiagnosticsRecorder({
    turn: 1,
    requestId: 'req-1',
    text: '这是一句学生的原话',
    gradeLevel: 'junior'
  })
  recorder.notePrompt({
    prompt: '模板正文 + 画像 + 权威段',
    gradeTemplate: 'junior',
    hostPathClean: true,
    overrides: [{ stage: 'authority', applied: true, note: '恒追加' }]
  })
  recorder.noteStudentContext('画像块里有掌握度与知识点', '')
  recorder.noteRetrieval({
    query: '学生问题里的关键词',
    degraded: 'vector',
    gradeFilter: "grade_level IN ('junior')",
    hitCount: 1,
    compatCount: 0,
    levels: [{ level: 'vector', tried: true, ok: true, hits: 1, note: 'KNN' }]
  })
  const live = recorder.finish({ ok: true, status: 'ok' })

  const saved = stripForPersistence(live)
  assert.equal(saved.input.text, '', '学生原话不许落盘')
  assert.equal(saved.studentContext.text, '', '画像块不许落盘（它含个人信息）')
  assert.equal(saved.retrieval?.query, '', '检索词不许落盘（它常常照抄了学生的问法）')
  assert.deepEqual(
    saved.prompt.segments.map((segment) => segment.text),
    live.prompt.segments.map(() => ''),
    'Prompt 原文不许落盘'
  )
  // 结构与结论必须留着，否则「重启后回放」就没有意义了
  assert.equal(saved.prompt.chars, live.prompt.chars)
  assert.equal(saved.prompt.totalTokens, live.prompt.totalTokens)
  assert.equal(saved.studentContext.byteHash, live.studentContext.byteHash)
  assert.equal(saved.retrieval?.gradeFilter, live.retrieval?.gradeFilter)
  assert.equal(saved.retrieval?.levels.length, 1)
  assert.equal(saved.done.status, 'ok')
  // ★ 剥离必须是**拷贝**：内存里那份（界面正在用）不能被改掉
  assert.equal(live.input.text, '这是一句学生的原话', 'stripForPersistence 不许就地改内存里那份')
  assert.equal(live.studentContext.text, '画像块里有掌握度与知识点')
  assert.equal(byteHash('同一份文本'), byteHash('同一份文本'), '指纹必须是稳定函数')
})

/* ================================================================== *
 * ③ 环形缓冲 + JSONL 暖机 + 清空（跨重启回放的地基）
 * ================================================================== */

test('★★ 存储：环形上限淘汰最旧、暖机接着上次的号、清空幂等、坏行跳过', async () => {
  const { DiagnosticsStore } = await import('../src/main/agent/diagnostics.ts')
  const dir = tempDir()
  const filePath = join(dir, 'turn-diagnostics.jsonl')

  const store = new DiagnosticsStore({ filePath, limit: 3 })
  for (let index = 1; index <= 5; index += 1) {
    const recorder = new (await import('../src/main/agent/diagnostics.ts')).TurnDiagnosticsRecorder({
      turn: store.beginTurn(),
      requestId: `req-${index}`,
      text: `第 ${index} 句`,
      gradeLevel: 'junior'
    })
    store.append(recorder.finish({ ok: true, status: 'ok' }))
  }
  const snapshot = store.snapshot()
  assert.equal(snapshot.turns.length, 3, '环形上限生效（最近 3 轮）')
  assert.deepEqual(
    snapshot.turns.map((turn) => turn.turn),
    [3, 4, 5],
    '淘汰的必须是最旧的，且顺序仍按轮次升序'
  )

  // 重启：新实例从落盘记录暖机，轮次号继续
  const revived = new DiagnosticsStore({ filePath, limit: 3 })
  const restored = revived.warmup()
  assert.equal(restored, 3, '暖机要读回落盘的记录')
  assert.equal(revived.snapshot().persisted, true, '暖机来的快照要标出来（界面上写「这是上次的记录」）')
  assert.equal(revived.beginTurn(), 6, '轮次号必须接着上次的最大值往下发（不许回到 1）')
  assert.equal(revived.snapshot().turns[0].input.text, '', '暖机读回的记录里没有正文（落盘时已剥离）')

  // 坏行跳过：半行 JSON 不该让整次启动失败
  writeFileSync(filePath, `${JSON.stringify({ turn: 1, requestId: 'x', done: {} })}\n{ 半行\n`, 'utf8')
  const tolerant = new DiagnosticsStore({ filePath, limit: 3 })
  assert.equal(tolerant.warmup(), 1, '坏行跳过、好行照读')

  // 清空：内存 + 磁盘都清，且幂等
  const cleared = store.clear()
  assert.equal(cleared.turns.length, 0)
  assert.equal(existsSync(filePath), false, '清空要把落盘文件删掉')
  assert.equal(store.clear().turns.length, 0, '清空必须幂等')
})

/* ================================================================== *
 * ④ 逐级记录读取：老后端不许被编造
 * ================================================================== */

test('★★ 四级链读取：认得出就逐级透传，认不出只标最终档位（绝不编造中间档）', async () => {
  const { readRetrievalFromDetails } = await import('../src/main/agent/diagnostics.ts')

  assert.equal(readRetrievalFromDetails(null), null, '没有工具产出 = 这一轮没查教材')
  assert.equal(readRetrievalFromDetails({ ok: false }), null, '失败的检索不产生检索轨迹')

  const full = readRetrievalFromDetails({
    ok: true,
    query: '循环',
    degraded: 'fts',
    gradeFilter: "grade_level IN ('junior')",
    hitCount: 2,
    compatCount: 1,
    attempts: [
      { level: 'vector', ok: false, detail: '无命中', hits: 0 },
      { level: 'fts', ok: true, detail: 'FTS5 trigram', hits: 2 }
    ]
  })
  assert.equal(full?.levels.length, 4, '四档都要出现（界面上一眼看得出「试了哪几级」）')
  assert.equal(full?.levels.find((level) => level.level === 'cloud')?.tried, false, '没试过的那档写未走到')
  assert.equal(full?.levels.find((level) => level.level === 'vector')?.note, '无命中')
  assert.equal(full?.gradeFilter, "grade_level IN ('junior')")

  // 老 sidecar：没有 attempts → 只标记最终档位，中间档一律「未走到」
  const legacy = readRetrievalFromDetails({ ok: true, degraded: 'outline', hitCount: 0 })
  assert.equal(legacy?.levels.filter((level) => level.tried).length, 1, '只允许一档被判为 tried')
  assert.equal(legacy?.levels.find((level) => level.level === 'outline')?.tried, true)
  assert.match(
    legacy?.levels.find((level) => level.level === 'outline')?.note ?? '',
    /旧版后端/,
    '退化形态必须**说明**自己是退化形态，而不是假装逐级都已知'
  )
})

/* ================================================================== *
 * ⑤ 旁路纪律：演示数据不能拖垮主链路
 * ================================================================== */

test('★★ 诊断是**可选旁路**：不并进数据面必需方法，推送通道独立登记', async () => {
  const dataApi = read('src/renderer/src/api/data.ts')
  const bridge = read('src/renderer/src/api/diagnostics.ts')
  const preload = read('src/preload/index.ts')
  const channels = read('src/main/ipc/channels.ts')

  // ① `REQUIRED_METHODS` 是「整块数据面就绪」的判据：少一个就整块不可用。
  //    演示是旁路，绝不能进来 —— 否则老产物 / 测试替身会让编程页、闯关页一起假红。
  const requiredBlock = dataApi.slice(
    dataApi.indexOf('export const REQUIRED_METHODS'),
    dataApi.indexOf('] as const satisfies readonly (keyof DataBridge)[]')
  )
  assert.ok(requiredBlock.length > 0, 'REQUIRED_METHODS 的形状变了，同步这条判据')
  for (const method of ['readDiagnostics', 'clearDiagnostics']) {
    assert.ok(!requiredBlock.includes(method), `${method} 不许进数据面的必需方法（它只是演示旁路）`)
  }

  // ② 旁路自己有独立的探测入口（缺方法时只让演示页显示一句学生话）
  assert.match(bridge, /export function resolveDiagnosticsBridge/, '诊断桥要有自己的探测函数')
  //    方法名（渲染进程）↔ 通道键名（channels.ts）↔ 线上通道名，三者逐一核对
  const THREE = [
    { method: 'readDiagnostics', key: 'diagnosticsRead', wire: 'diagnostics:read' },
    { method: 'clearDiagnostics', key: 'diagnosticsClear', wire: 'diagnostics:clear' },
    { method: 'onDiagnosticsChanged', key: 'diagnosticsChanged', wire: 'diagnostics:changed' }
  ] as const
  for (const { method, key, wire } of THREE) {
    assert.ok(bridge.includes(`'${method}'`), `诊断桥必须探测 ${method}`)
    assert.ok(preload.includes(`${method}:`), `preload 白名单必须暴露 ${method}`)
    assert.ok(channels.includes(`${key}:`), `channels.ts 必须有 ${key} 的通道键名`)
    assert.ok(channels.includes(`'${wire}'`), `channels.ts 必须有 ${wire} 这条通道`)
  }

  // ③ 推送通道登记（守卫 G7 要求推送必须来自 `PUSH_CHANNELS`）；两条 invoke **不许**进去
  const pushBlock = channels.slice(
    channels.indexOf('export const PUSH_CHANNELS'),
    channels.indexOf('/**', channels.indexOf('export const PUSH_CHANNELS'))
  )
  assert.match(pushBlock, /IPC\.diagnosticsChanged/, '每轮推送必须登记为推送通道')
  assert.ok(!pushBlock.includes('IPC.diagnosticsRead'), '读取是 invoke（有回执），不许登记成推送')
  assert.ok(!pushBlock.includes('IPC.diagnosticsClear'), '清空是 invoke（有回执），不许登记成推送')
})

/* ================================================================== *
 * ⑥ 演示页的豁免必须名副其实（技术口原文案只喂给最高档）
 * ================================================================== */

test('★★ 演示证据模块（components/diag/evidence.ts）只被演示面 import，且演示页要求最高档', async () => {
  const { PAGES, visibleInSidebar, requiredViewFor } = await import('../src/renderer/src/stores/ui.ts')

  // ① 页面归属：演示页要求最高档；学生与教师**都**进不去侧栏
  assert.equal(PAGES.demo.nav, 'debug', '演示页必须是 debug 档专属')
  assert.equal(requiredViewFor('demo'), 'debug')
  assert.equal(visibleInSidebar(PAGES.demo, 'student'), false)
  assert.equal(visibleInSidebar(PAGES.demo, 'teacher'), false)
  assert.equal(visibleInSidebar(PAGES.demo, 'debug'), true)

  // ② import 关系（这就是那条例外的凭据）：
  //    技术口原文案只许被演示页消费 —— 一旦有学生可见的组件 import 它，这条立刻红。
  const ALLOWED = new Set(['views/Demo.vue'])
  const consumers: string[] = []
  for (const file of rendererFiles()) {
    const name = rel(file)
    if (name === 'components/diag/evidence.ts') continue
    const source = readFileSync(file, 'utf8')
    if (/from\s+'[^']*diag\/evidence'/.test(source)) consumers.push(name)
  }
  assert.deepEqual(
    consumers.sort(),
    [...ALLOWED].sort(),
    '演示证据模块的消费者变了 —— 它整份都是技术原文，只许喂给「演示 / 调试档」才可达的那一页'
  )

  // ③ 演示页必须真的用上那些分块（只定义不渲染 = 做了却看不到）
  const demo = read('src/renderer/src/views/Demo.vue')
  for (const token of ['DIAG_BLOCKS', 'GUARD_CATALOG', 'GRADE_MATRIX_ROWS', 'HIDDEN_MECHANISM_CARDS']) {
    assert.ok(demo.includes(token), `演示页要渲染 ${token}`)
  }
  // ④ 驾驶舱最要紧的两个动作必须在（导出演示包 / 一键清空）
  assert.match(demo, /exportPackage/, '演示包导出必须在')
  assert.match(demo, /diagnostics\.clear\(\)/, '一键清空必须在')
})

test('★★ 浮窗是只读的：不出现任何写运行时状态的控件', () => {
  const panel = read('src/renderer/src/components/DiagnosticsPanel.vue')
  // 只允许这四个动作按钮（拖拽手柄不是按钮）；出现输入类控件即违反「只读」纪律
  assert.ok(!/<input|<select|<textarea/.test(panel), '只读浮窗里不许有输入控件')
  assert.ok(!/MessageComposer/.test(panel), '只读浮窗里不许挂输入条（那是追问窗的事）')
  assert.match(panel, /diag-open-demo/, '必须有「在演示页打开」的出口')
  // ★ 「默认关闭」是安全底线（防止演示手滑、投屏意外）：store 的初始值必须是 false
  const panelStore = read('src/renderer/src/stores/diagnosticsPanel.ts')
  assert.match(panelStore, /const open = ref\(false\)/, '浮窗默认必须是关闭的')
})

/* ================================================================== *
 * ⑦ 契约与守卫静态卡：编号表必须与守卫文件同步
 * ================================================================== */

test('★★ 静态卡的守卫编号与 architecture-guards.test.ts 完全一致（免得写在屏幕上骗人）', async () => {
  const { GUARD_CATALOG } = await import('../src/renderer/src/components/diag/evidence.ts')
  const guards = read('tests/architecture-guards.test.ts')
  const ids = new Set(GUARD_CATALOG.map((row) => row.id))
  const missing = [...ids].filter((id) => !new RegExp(`test\\('${id}:`).test(guards))
  assert.deepEqual(missing, [], `静态卡上写了守卫文件里不存在的编号：${missing.join(' / ')}`)
  assert.ok(GUARD_CATALOG.length >= 15, '守卫编号表不许被削薄（它是「工程成熟度」的证据）')
})

/* ================================================================== *
 * ⑧ 三档视角：档位表与派生标志必须等价
 * ================================================================== */

test('★★ 档位高低表与 viewMode 的派生标志等价（不许出现「侧栏可见、页面说不可见」）', async () => {
  const { VIEW_MODE_ORDER, viewModeAllows } = await import('../src/renderer/src/stores/ui.ts')

  assert.deepEqual([...VIEW_MODE_ORDER], ['student', 'teacher', 'debug'])
  // 逐档断言（与 `viewMode.ts` 里那两个字面量比较**同一份**语义：teacher 档含 debug）
  for (const mode of VIEW_MODE_ORDER) {
    assert.equal(viewModeAllows(mode, null), true, 'null = 所有档位都能看')
    assert.equal(viewModeAllows(mode, 'student'), true)
    assert.equal(viewModeAllows(mode, 'teacher'), mode !== 'student', `teacher 档对 ${mode} 的可见性`)
    assert.equal(viewModeAllows(mode, 'debug'), mode === 'debug', `debug 档对 ${mode} 的可见性`)
  }
  // 派生标志的写法（字面量比较）由源码 + 上面这张表共同钉住
  const store = read('src/renderer/src/stores/viewMode.ts')
  assert.match(
    store,
    /const isTeacher = computed\(\(\) => mode\.value === 'teacher' \|\| mode\.value === 'debug'\)/,
    'isTeacher 必须把 debug 也算进去（演示档 ⊃ 教师档）'
  )
  assert.match(store, /const isDebug = computed\(\(\) => mode\.value === 'debug'\)/, 'isDebug 只认最高档')
})
