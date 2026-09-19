/**
 * 票 08 + 09 的守卫：**工具调用轨迹导出**与**学习记录回流**（执行文档 §9.4 第 4 条、§8.1）。
 *
 * 这一组断言守护两件容易「看起来做了、其实没有」的事：
 *
 *   G8-1  轨迹里的参数**只有摘要**：密钥、学生个人信息、对话原文一律不出现（轨迹要进报告与 PPT）
 *   G8-2  轨迹如实记录 `{turn, toolName, args摘要, ok, latencyMs, degraded}`，且被安全阀拦下的调用也留痕
 *   G8-3  导出物是**合法 Mermaid**（`flowchart TD`、节点 id 唯一、标签已转义、边两端都有定义）
 *   G8-4  导出真的落盘（`.mmd` 纯图 + `.md` 带明细表），且**默认路径就是 `docs/tool-trace.mmd`**
 *   G9-7  学习记录提取：四类活动（qa / animation / coding / quiz）都覆盖，**不写对话正文**
 *   G9-8  learning-log 的 HTTP 出口：经 `bridge/client.ts` 打到 `POST /api/profile/{id}/events`
 *         —— **真 HTTP 往返 + 真 token 头**（用本地假服务端，不需要 uvicorn / Pyodide）
 *   G8-5  六扩展注册表：缺哪几个扩展、缺哪几个 Tool 都要**点名**（不静默少能力），strict 模式直接抛
 *
 * 跑法：`npm test`。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { clearSidecarEndpoint, configureSidecarEndpoint } from '../src/main/bridge/client.ts'
import {
  AGENT_EXTENSION_SPECS,
  AGENT_TOOL_NAMES,
  auditToolCoverage,
  bindAgentSession,
  CORE_EXTENSION_FACTORIES,
  createAgentExtensionRegistry,
  describeRegistryReport,
  registerAgentExtensions,
  type AgentExtensionApi,
  type AgentToolDefinition
} from '../src/main/agent/extensions/index.ts'
import {
  createLearningLogExtension,
  extractCorrectness,
  extractKpId,
  extractLearningFromTool,
  postLearningEvent,
  type LearningEventPayload
} from '../src/main/agent/extensions/learning-log.ts'
import {
  createTraceExtension,
  degradedOf,
  demoRecorder,
  escapeMermaidLabel,
  exportToolTrace,
  nextTurnFor,
  resolveTracePath,
  summarizeArgs,
  ToolTraceRecorder,
  toolResultOk,
  TRACE_RELATIVE_PATH
} from '../src/main/agent/trace.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/* ------------------------------------------------------------------ *
 * G8-1 参数摘要（数据合规）
 * ------------------------------------------------------------------ */

test('G8-1 ★ 参数摘要不含密钥、不含学生个人信息、不含对话原文', () => {
  const summary = summarizeArgs({
    kp_id: 'prog-loop-jr',
    grade_level: 'junior',
    count: 2,
    query: '老师，我的名字是小明，请把这段代码改成计算平均分',
    api_key: 'sk-abcdef1234567890',
    student_name: '小明',
    student_id: 'student_001',
    token: 'deadbeef',
    code: 'print(1)\nprint(2)\nprint(3)',
    options: ['A', 'B', 'C']
  })

  // 白名单内的短标识与标量可以出现（轨迹要能看出「调了哪个知识点」）
  assert.match(summary, /kp_id=prog-loop-jr/)
  assert.match(summary, /grade_level=junior/)
  assert.match(summary, /count=2/)
  assert.match(summary, /options=«数组 3 项»/)
  assert.match(summary, /code=«文本 \d+ 字 \/ 3 行»/)
  assert.match(summary, /…共 10 项/, '超过 8 个键时只给前 8 个 + 总数（摘要要有界）')

  // ★ 三类禁止内容一个都不能出现
  for (const forbidden of ['sk-abcdef', 'deadbeef', '小明', 'student_001', '计算平均分', 'print(1)']) {
    assert.ok(!summary.includes(forbidden), `参数摘要里出现了不该出现的内容：${forbidden}\n实际：${summary}`)
  }

  // 单个敏感键/个人信息键：连键值都要隐去（逐个单测，避免被「前 8 个键」截断影响）
  assert.equal(summarizeArgs({ api_key: 'sk-abcdef1234567890' }), 'api_key=«已省略(敏感)»')
  assert.equal(summarizeArgs({ token: 'deadbeef' }), 'token=«已省略(敏感)»')
  assert.equal(summarizeArgs({ student_name: '小明' }), 'student_name=«已省略(个人信息)»')
  assert.equal(summarizeArgs({ student_id: 'student_001' }), 'student_id=«已省略(个人信息)»')
  assert.equal(summarizeArgs({ nickname: '小明的昵称' }), 'nickname=«已省略(个人信息)»')

  // 单行、有长度上限（要能直接嵌进 Mermaid 标签与 Markdown 表格）
  assert.ok(!summary.includes('\n'))
  assert.ok(summary.length <= 200, `摘要过长（${summary.length}）：${summary}`)

  // 中文/自然语言一律不进摘要
  assert.equal(summarizeArgs({ query: '什么是循环' }), 'query=«文本 5 字»')
  assert.equal(summarizeArgs({}), '(无参数)')
  assert.equal(summarizeArgs(null), '(无参数)')
})

test('G8-1b Mermaid 标签转义：引号/尖括号/竖线不会把图渲染坏', () => {
  assert.equal(escapeMermaidLabel('a"b<c>d|e'), 'a#quot;b#lt;c#gt;d#124;e')
  assert.equal(escapeMermaidLabel('x[y]{z}(w)'), 'x#91;y#93;#123;z#125;#40;w#41;')
  assert.equal(escapeMermaidLabel('多行\n标签'), '多行 标签')
})

/* ------------------------------------------------------------------ *
 * G8-2 轨迹记录
 * ------------------------------------------------------------------ */

test('G8-2a 轮次换算：一条学生消息内的多个 sub-turn 归同一轮，新消息的 turnIndex 归零则 +1', () => {
  // Pi 的真实 turnIndex 语义（`dist/core/agent-session.js:462-495`，已逐行核对）：
  //   - `agent_start`（= 每条学生消息）把 `_turnIndex` 重置为 0；
  //   - 该消息内每次 `turn_end` 让 `_turnIndex++`，所以同一条消息内是 0,1,2,…
  // 因此「回退/重复的下标」才是新的一轮 —— 这正是 `nextTurnFor` 的判据。
  let current = 0
  let lastIndex = -1
  const turns: number[] = []
  const indexes = [0, 1, 2, 3, 0, 1, 2, 3, 0] // 三条学生消息，各含 4/4/1 个 sub-turn
  for (const index of indexes) {
    const next = nextTurnFor(current, lastIndex, index)
    current = next.turn
    lastIndex = next.lastIndex
    turns.push(current)
  }
  assert.deepEqual(turns, [1, 1, 1, 1, 2, 2, 2, 2, 3], '每条新消息必须是一个新轮次')

  // 缺 turnIndex（Pi 未给）时，保守地当成新一轮，绝不把两轮合并成一轮
  assert.equal(nextTurnFor(3, 0, Number.NaN).turn, 4)
})

test('G8-2 轨迹记录：turn / toolName / 参数摘要 / ok / latencyMs / degraded 全部如实', () => {
  const recorder = new ToolTraceRecorder()
  const extension = createTraceExtension(recorder)
  const handlers = new Map<string, (event: unknown) => unknown>()
  extension({
    on: (event, handler) => handlers.set(event, handler)
  })
  // 只允许订阅 4 个只读事件（不碰 tool_execution_end 的返回值，也不自建总线）
  assert.deepEqual(
    [...handlers.keys()].sort(),
    ['tool_call', 'tool_execution_end', 'tool_execution_start', 'turn_start']
  )

  handlers.get('turn_start')?.({ turnIndex: 1 })
  handlers.get('tool_call')?.({ toolCallId: 'c1', toolName: 'rag_search', input: { query: '循环是什么', grade_level: 'junior' } })
  handlers.get('tool_execution_start')?.({ toolCallId: 'c1', toolName: 'rag_search', args: { query: '循环是什么', grade_level: 'junior' } })
  const first = recorder.noteToolEnd({ toolCallId: 'c1', toolName: 'rag_search', isError: false, result: { degraded: 'fts' } })

  assert.ok(first)
  assert.equal(first.turn, 1)
  assert.equal(first.toolName, 'rag_search')
  assert.equal(first.ok, true)
  assert.equal(first.degraded, 'fts')
  assert.ok(Number.isInteger(first.latencyMs) && first.latencyMs >= 0)
  assert.match(first.argsSummary, /grade_level=junior/)
  assert.ok(!first.argsSummary.includes('循环是什么'), '参数摘要不得含学生原文')

  // 第 2 轮 + 一次「自兜异常」（`details.error === true`，与 `runtime.ts` 的 safeToolExecute 同形态）
  // + 一次被安全阀拦下。
  //
  // ⚠️ 这里必须是 `turnIndex: 0`，不是 `2` —— 按 Pi 0.85.1 的真实语义
  //（`dist/core/agent-session.js:470`）：**每条学生消息的 `agent_start` 都会把 `_turnIndex` 重置为 0**，
  // 它只在「同一条消息内的多次 LLM 往返」之间自增。所以「第 2 条学生消息」的真机形态就是 0。
  // 用 `2` 会让测试通过一条现实中不存在的序列（既有版本就是这样，掩盖了轮次恒为 1 的缺陷）。
  handlers.get('turn_start')?.({ turnIndex: 0 })
  handlers.get('tool_call')?.({ toolCallId: 'c2', toolName: 'get_student_profile', input: { student_id: 'student_001' } })
  handlers.get('tool_execution_start')?.({ toolCallId: 'c2', toolName: 'get_student_profile', args: {} })
  const second = recorder.noteToolEnd({
    toolCallId: 'c2',
    toolName: 'get_student_profile',
    isError: false,
    result: {
      content: [{ type: 'text', text: '⚠️ 本地数据服务不可用' }],
      details: { error: true, errorMessage: '本地数据服务不可用（sidecar 尚未就绪）', degraded: true }
    }
  })
  assert.equal(second?.ok, false, 'details.error=true 必须被记成失败（Pi 的 isError 只看有没有抛）')
  assert.match(second?.errorMessage ?? '', /sidecar 尚未就绪/)

  const blocked = recorder.noteBlockedCall('c3', 'generate_animation', '内容安全：命中敏感词')
  assert.equal(blocked.blocked, true)
  assert.equal(blocked.ok, false)
  assert.match(blocked.blockReason ?? '', /敏感词/)

  const records = recorder.records()
  assert.equal(records.length, 3)
  assert.deepEqual(records.map((record) => record.turn), [1, 2, 2])
  assert.deepEqual(records.map((record) => record.seq), [1, 2, 3])
  // 快照是副本：外部改不动内部状态
  records[0].toolName = 'tampered'
  assert.equal(recorder.records()[0].toolName, 'rag_search')

  // 工具函数
  assert.equal(degradedOf({ details: { degraded: 'vector' } }), 'vector')
  assert.equal(degradedOf({ details: { degraded: 'unknown' } }), undefined)
  assert.equal(toolResultOk({ details: { error: true, errorMessage: 'x' } }), false, 'safeToolExecute 的形态')
  assert.equal(toolResultOk({ details: { ok: false } }), false, '口语化写法也认')
  assert.equal(toolResultOk({ details: { ok: true } }), true)
  assert.equal(toolResultOk(undefined), true)

  /* ★★ 回归：`evaluate_code` 的**领域**字段不得被读成工具失败
   *
   * 这条链的真实代价：学生在编程卡片里写错一行代码（`evaluate_code` 本身完全正常）→
   * `details.ok === false` 被上面的第 3 条读成「工具失败」→ 轨迹图（报告「设计合理性 25%」
   * 的**核心证据**）在**最常见的教学路径**上画出一个假 `fail` 节点、标签写 `error`。
   * 修法是把「工具级」与「领域级」两个问题分开：载荷给出 `toolOk`（显式）与 `codeOk`（领域），
   * 本函数**以显式声明为准**，不再从 `ok` 猜。
   */
  const failedStudentCode = { details: { codeOk: false, toolOk: true, ok: false, feedback: '缩进不对' } }
  assert.equal(
    toolResultOk(failedStudentCode),
    true,
    '★ 学生代码没跑通 ≠ 工具失败：有 toolOk 时必须以它为准（否则轨迹图失真）'
  )
  assert.equal(
    toolResultOk({ details: { codeOk: true, toolOk: false, ok: true } }),
    false,
    '反向对照：显式声明 toolOk=false 时，即便 `ok` 是 true 也要记成失败'
  )
  // 没有 toolOk 的老写法照旧（不能因为新增了一条判据就把既有的两种标记丢掉）
  assert.equal(toolResultOk({ details: { ok: false, errorMessage: 'x' } }), false)
  assert.equal(toolResultOk({ details: { codeOk: false, ok: false } }), false, '未声明 toolOk 时仍按老判据')

  // 新增：一个 Tool 自兜异常时，`get_student_profile` 的失败要能在轨迹里看见
  const fresh = new ToolTraceRecorder()
  fresh.noteTurn(1)
  fresh.noteToolStart({ toolCallId: 'x1', toolName: 'get_student_profile', args: {} })
  fresh.noteToolEnd({
    toolCallId: 'x1',
    toolName: 'get_student_profile',
    isError: false,
    result: { content: [{ type: 'text', text: 'x' }], details: { error: true, errorMessage: 'sidecar 尚未就绪' } }
  })
  const rendered = fresh.toMermaid()
  assert.match(rendered, /get_student_profile/)
  assert.match(rendered, /error/, '自兜异常在图上要显示 error')
})

test('★ G8-2b 悬空条目会过期：上一轮的 `tool_call`（被拦下 / 本轮中止）不留在内存里', () => {
  const recorder = new ToolTraceRecorder()
  recorder.noteTurn(0)
  // 第 1 轮：两次 `tool_call` 之后都没有 `tool_execution_end`
  // （被安全阀拦下、或本轮被中止 —— 两种情形都不会再有执行事件）
  recorder.noteToolCall({ toolCallId: 'k1', toolName: 'generate_animation', input: { kp_id: 'a' } })
  recorder.noteToolCall({ toolCallId: 'k2', toolName: 'rag_search', input: { query: 'x' } })
  assert.deepEqual(
    recorder.pendingSize(),
    { calls: 2, blocks: 2 },
    '前置条件：这两条确实悬空了（否则这条测试什么都没在测）'
  )

  // 第 2 轮（Pi 把 turnIndex 重置回 0）→ 上一轮的悬空条目确定配不上对了
  recorder.noteTurn(0)
  assert.deepEqual(
    recorder.pendingSize(),
    { calls: 0, blocks: 0 },
    '★ 轮次推进必须清掉上一轮的悬空条目（否则长会话里无界增长）'
  )
  assert.equal(recorder.size, 0, '清的是**待配对**表，不是已落的记录')

  // ★ 反向对照：**同一轮之内**的正常配对不能被清掉（清早了会丢轮号、参数摘要与计时）
  recorder.noteToolCall({ toolCallId: 'k3', toolName: 'rag_search', input: { query: 'y' } })
  recorder.noteToolStart({ toolCallId: 'k3', toolName: 'rag_search', args: { query: 'y' } })
  const record = recorder.noteToolEnd({ toolCallId: 'k3', toolName: 'rag_search', isError: false, result: {} })
  assert.equal(record?.toolName, 'rag_search')
  assert.equal(record?.argsSummary.includes('«文本 1 字»'), true, '配对成功时参数摘要仍在（清理没伤到正常路径）')
  assert.deepEqual(recorder.pendingSize(), { calls: 0, blocks: 0 })
})

test('★ G8-2c 单轮之内悬空条目也有上限（模型在一轮里反复调用时不会无界增长）', () => {
  const recorder = new ToolTraceRecorder()
  recorder.noteTurn(0)
  for (let index = 0; index < 500; index += 1) {
    recorder.noteToolCall({ toolCallId: `x${index}`, toolName: 'rag_search', input: { query: 'q' } })
  }
  const size = recorder.pendingSize()
  assert.ok(size.calls <= 64, `悬空 pending 必须有上限，实际 ${size.calls}`)
  assert.ok(size.blocks <= 64, `悬空 blocks 必须有上限，实际 ${size.blocks}`)
  // 丢的是最旧的：最近几条仍能正常配对（这条证明「上限」没有把功能一起砍掉）
  const latest = recorder.noteToolEnd({ toolCallId: 'x499', toolName: 'rag_search', isError: false, result: {} })
  assert.equal(latest?.toolName, 'rag_search')
})

/* ------------------------------------------------------------------ *
 * G8-3 / G8-4 导出物是合法 Mermaid，并且真的落盘
 * ------------------------------------------------------------------ */

/** 极简 Mermaid 结构校验：图表类型、节点 id 唯一、边两端有定义、标签引号成对。 */
function assertValidMermaid(source: string, options: { requireEdges?: boolean } = {}): void {
  const requireEdges = options.requireEdges ?? true
  const lines = source.split('\n').filter((line) => line.trim().length > 0)
  assert.equal(lines[0].trim(), 'flowchart TD', '必须是 flowchart 图（渲染器才认得）')

  /** 节点形态：`ID["标签"]` 或 `ID(["标签"])`；`:::` 的 class 简写已先剥掉。 */
  const NODE_SHAPE = /^([A-Za-z][A-Za-z0-9_]*)(?:\(\[|\[)"(.*)"(?:\]\)|\])$/

  const definitions = new Set<string>()
  let edges = 0

  const checkLabel = (label: string, text: string): void => {
    assert.ok(!label.includes('"'), `标签里还有裸引号（Mermaid 会渲染坏）：${text}`)
    // `<br/>` 是 Mermaid 合法的换行标记；其余裸尖括号/方括号/竖线一律不允许
    const withoutBreaks = label.replace(/<br\/>/g, '')
    assert.ok(!/[<>|[\]]/.test(withoutBreaks), `标签里还有裸尖括号/方括号/竖线：${text}`)
  }
  const defineNode = (id: string, label: string, text: string): void => {
    assert.ok(!definitions.has(id), `节点 id 重复定义：${id}（${text}）`)
    checkLabel(label, text)
    definitions.add(id)
  }

  for (const line of lines.slice(1)) {
    const text = line.trim()
    if (text.startsWith('%%') || text.startsWith('classDef')) continue
    // 去掉 `:::class` 简写（节点与边都可能带）
    const cleaned = text.replace(/:::+[a-z]+$/, '').trim()

    const edge = /^([A-Za-z][A-Za-z0-9_]*) --> (.+)$/.exec(cleaned)
    if (edge) {
      edges += 1
      assert.ok(definitions.has(edge[1]), `边的起点未定义：${edge[1]}（${text}）`)
      const target = NODE_SHAPE.exec(edge[2])
      assert.ok(target, `边的终点形态不认识：${text}`)
      defineNode((target as RegExpExecArray)[1], (target as RegExpExecArray)[2], text)
      continue
    }
    const node = NODE_SHAPE.exec(cleaned)
    assert.ok(node, `无法识别的 Mermaid 行：${text}`)
    defineNode(node[1], node[2], text)
  }
  assert.ok(definitions.size > 0, '图里没有任何节点')
  if (requireEdges) assert.ok(edges > 0, '图里没有任何边（轨迹图必须体现路由顺序）')
}

test('G8-3 ★ 轨迹图是合法 Mermaid，且能看出「轮次 → Tool → 回复」的路由', () => {
  const recorder = demoRecorder()
  const mermaid = recorder.toMermaid()

  assertValidMermaid(mermaid)
  assert.match(mermaid, /第 1 轮 · 学生提问/)
  assert.match(mermaid, /rag_search/)
  assert.match(mermaid, /generate_quiz/)
  assert.match(mermaid, /degraded:fts/, '降级档位要出现在图上')
  assert.match(mermaid, /error/, '失败调用要标成 error')
  // 个人信息键以占位符出现（括号在标签里被转义成 Mermaid 实体）
  assert.match(mermaid, /已省略#40;个人信息#41;/)
  // ★ 演示数据里塞了学生姓名与提问原文：两者都必须被隐去
  assert.ok(!mermaid.includes('小明'), '学生姓名绝不能出现在轨迹里')
  assert.ok(!mermaid.includes('什么是循环'), '学生原文绝不能出现在轨迹里')
})

test('G8-3b 空轨迹也是合法 Mermaid（无调用时给出可读提示，而不是空文件）', () => {
  const mermaid = new ToolTraceRecorder().toMermaid()
  assertValidMermaid(mermaid, { requireEdges: false })
  assert.match(mermaid, /尚无工具调用/)
})

test('G8-4 ★ 导出：.mmd 是纯 Mermaid，.md 带明细表；默认路径就是 docs/tool-trace.mmd', () => {
  assert.equal(TRACE_RELATIVE_PATH.replace(/\\/g, '/'), 'docs/tool-trace.mmd')
  assert.equal(
    resolveTracePath({ repoRoot: join('E:', 'repo') }).replace(/\\/g, '/'),
    'E:/repo/docs/tool-trace.mmd'
  )
  assert.equal(
    resolveTracePath({ outPath: join('C:', 'tmp', 'x.mmd') }).replace(/\\/g, '/'),
    'C:/tmp/x.mmd'
  )

  const dir = mkdtempSync(join(tmpdir(), 'k12-trace-'))
  try {
    const outPath = join(dir, 'tool-trace.mmd')
    const written = exportToolTrace(demoRecorder(), { outPath })

    assert.equal(written.records, 3)
    assert.equal(written.mmdPath, outPath)
    const mmd = readFileSync(written.mmdPath, 'utf8')
    assertValidMermaid(mmd)
    assert.ok(!mmd.includes('```'), '.mmd 必须是纯 Mermaid（不能带 Markdown 代码围栏）')

    assert.ok(written.markdownPath, '默认应同时写一份 Markdown 明细')
    const markdown = readFileSync(written.markdownPath as string, 'utf8')
    assert.match(markdown, /# 工具调用轨迹/)
    assert.match(markdown, /```mermaid/)
    assert.match(markdown, /\| # \| 轮次 \| Tool \| 参数摘要 \| 结果 \| 耗时 \| 降级 \| 备注 \|/)
    // 表里每一行调用都要有 ok 与耗时（票 08 的验收口径）
    assert.match(markdown, /\| 1 \| 1 \| rag_search \|.*\| ok \| \d+ms \| fts \|/)
    assert.match(markdown, /\| 3 \| 2 \| get_student_profile \|.*\| error \| \d+ms \|/)
    // 明细表不能把学生姓名带进来
    assert.ok(!markdown.includes('小明'))

    // markdownPath: null 时只写 .mmd（打包态没有 docs/ 时的用法）
    const onlyMmd = exportToolTrace(demoRecorder(), { outPath: join(dir, 'only.mmd'), markdownPath: null })
    assert.equal(onlyMmd.markdownPath, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * G9-7 学习记录提取（四类活动；不写对话正文）
 * ------------------------------------------------------------------ */

test('G9-7 学习记录提取：qa / animation / coding / quiz 全覆盖，无关 Tool 不写库', () => {
  assert.deepEqual(extractLearningFromTool('rag_search', { query: '循环' }, { degraded: 'vector' }), {
    activity: 'qa',
    detail: '对话答疑（检索教材片段）'
  })
  assert.deepEqual(extractLearningFromTool('generate_animation', { kp_id: 'prog-loop-jr', concept: '循环' }, {}), {
    activity: 'animation',
    detail: '观看动画讲解',
    kpId: 'prog-loop-jr'
  })
  assert.deepEqual(extractLearningFromTool('evaluate_code', { kp_id: 'prog-loop-jr', code: 'print(1)' }, { details: { ok: true } }), {
    activity: 'coding',
    detail: '代码运行与评估',
    kpId: 'prog-loop-jr'
  })
  assert.deepEqual(
    extractLearningFromTool('submit_quiz', { qid: 'q1' }, { details: { kpId: 'prog-loop-jr', correct: false } }),
    { activity: 'quiz', detail: '提交作答', kpId: 'prog-loop-jr', isCorrect: false }
  )

  // 与学习数据无关的 Tool → `null`（不猜、不写库）
  for (const toolName of ['get_student_profile', 'smoke_echo', 'some_future_tool']) {
    assert.equal(extractLearningFromTool(toolName, {}, {}), null, `${toolName} 不该产生学习记录`)
  }

  // ★ 提取结果里**不存在**任何承载对话正文的字段
  const extracted = extractLearningFromTool('generate_quiz', { kp_id: 'prog-loop-jr', stem: '以下哪个是循环' }, {})
  assert.deepEqual(Object.keys(extracted ?? {}).sort(), ['activity', 'detail', 'kpId'])
  assert.ok(!JSON.stringify(extracted).includes('以下哪个是循环'))

  // kp_id 形状校验：中文/路径/超长一律丢弃（避免把正文写进 kp_id 列）
  assert.equal(extractKpId({ kp_id: 'prog-loop-jr' }, {}), 'prog-loop-jr')
  assert.equal(extractKpId({ kp_id: '循环' }, {}), undefined)
  assert.equal(extractKpId({ kp_id: '../../etc/passwd' }, {}), undefined)
  assert.equal(extractKpId({}, { details: { kpId: 'machine-learning-sr' } }), 'machine-learning-sr')

  // 对错只认显式字段：`ok` 在不同扩展里含义不同，拿它当对错会污染掌握度
  assert.equal(extractCorrectness({ details: { correct: true } }), true)
  assert.equal(extractCorrectness({ details: { passed: false } }), false)
  assert.equal(extractCorrectness({ details: { ok: false, error: '工具失败' } }), undefined)
  assert.equal(extractCorrectness({ details: { ok: true } }), undefined)
})

/* ------------------------------------------------------------------ *
 * G9-8 learning-log 的回写路径
 * ------------------------------------------------------------------ */

test('G9-8 learning-log：绑定学生后按事件写库（tool_execution_end + agent_end），失败不抛', async () => {
  const posted: Array<{ studentId: string; payload: LearningEventPayload }> = []
  const extension = createLearningLogExtension({
    poster: async (studentId, payload) => {
      posted.push({ studentId, payload })
    },
    sessionProvider: () => ({ studentId: 'student_001', sessionId: 'sess-42', gradeLevel: 'junior' })
  })

  const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>()
  extension({
    on: (event, handler) => handlers.set(event, handler),
    registerTool: () => undefined
  })

  // ★ 事件口径：只有这两个（没有 `session_end` —— Pi 无此事件）
  assert.deepEqual([...handlers.keys()].sort(), ['agent_end', 'tool_execution_end'])

  handlers.get('tool_execution_end')?.({
    toolCallId: 'c1',
    toolName: 'generate_animation',
    args: { kp_id: 'prog-loop-jr' },
    isError: false,
    result: { details: { ok: true } }
  })
  handlers.get('tool_execution_end')?.({
    toolCallId: 'c2',
    toolName: 'get_student_profile', // 无关 Tool：不该写库
    args: {},
    isError: false,
    result: {}
  })
  handlers.get('agent_end')?.({ messages: [] }, { sessionManager: { getSessionId: () => 'sess-42' } })

  await extension.flush()

  assert.equal(posted.length, 2)
  assert.deepEqual(
    posted.map((item) => item.payload.activity),
    ['animation', 'qa']
  )
  for (const item of posted) {
    assert.equal(item.studentId, 'student_001')
    assert.equal(item.payload.sessionId, 'sess-42')
    assert.equal(item.payload.gradeLevel, 'junior')
    // ★ 载荷里不得出现对话正文
    assert.deepEqual(
      Object.keys(item.payload).sort(),
      Object.keys(item.payload)
        .filter((key) => ['activity', 'detail', 'kpId', 'sessionId', 'gradeLevel', 'isCorrect'].includes(key))
        .sort()
    )
  }
  assert.deepEqual(extension.stats(), { written: 2, failed: 0, queued: 0, dropped: 0, lastError: undefined })

  // sidecar 不可用：**不抛**，进队列等重试，并留下可读原因
  const failing = createLearningLogExtension({
    poster: async () => {
      throw new Error('sidecar 尚未就绪（无端口与 token），无法发起 /api 请求。')
    },
    sessionProvider: () => ({ studentId: 'student_002', sessionId: 'sess-43', gradeLevel: 'senior' }),
    backoffMs: 60_000,
    log: () => undefined
  })
  const failingHandlers = new Map<string, (event: unknown) => unknown>()
  failing({ on: (event, handler) => failingHandlers.set(event, handler), registerTool: () => undefined })
  assert.doesNotThrow(() =>
    failingHandlers.get('agent_end')?.({ messages: [] })
  )
  assert.equal(await failing.flush(), false)
  const stats = failing.stats()
  assert.equal(stats.written, 0)
  assert.equal(stats.failed, 1)
  assert.equal(stats.queued, 1, '失败记录必须留在队列里等重试，不能静默丢')
  assert.match(stats.lastError ?? '', /sidecar/)

  // 未绑定学生 → 记一条警告并丢弃（不猜一个默认学生去写库）
  const warnings: string[] = []
  const unbound = createLearningLogExtension({
    poster: async () => undefined,
    sessionProvider: () => null,
    log: (line) => warnings.push(line)
  })
  const unboundHandlers = new Map<string, (event: unknown) => unknown>()
  unbound({ on: (event, handler) => unboundHandlers.set(event, handler), registerTool: () => undefined })
  bindAgentSession(null)
  unboundHandlers.get('tool_execution_end')?.({ toolName: 'generate_animation', args: { kp_id: 'prog-loop-jr' }, result: {} })
  assert.equal(unbound.stats().written, 0)
  assert.ok(warnings.some((line) => line.includes('未绑定当前学生')))
})

test('G9-8b ★ 回写路径的 HTTP 形状：`POST /api/profile/{id}/events` + camelCase 载荷', () => {
  // ⚠️ 本用例只守**载荷契约**（字段名、类型、「不得出现对话正文字段」）。
  //    真 HTTP 往返（真的发请求 / 真的带 X-Auth-Token）见下面 G9-8c ——
  //    那条以前被一条**已失效**的技术理由压着没写：注释号称 `bridge/client.ts`
  //    有一处缺 `.ts` 的导入会让 `node --test` 直接 `ERR_MODULE_NOT_FOUND`，
  //    实测**已不成立**（`client.ts:18` 现在是 `from '../sidecar/protocol.ts'`，带扩展名；
  //    全仓已无缺扩展名的相对导入），所以那条集成测试补得回来。
  const payloads: LearningEventPayload[] = [
    {
      activity: 'quiz',
      kpId: 'prog-loop-jr',
      sessionId: 'sess-42',
      isCorrect: true,
      detail: '提交作答',
      gradeLevel: 'junior'
    },
    { activity: 'qa', sessionId: 'sess-42', detail: '对话轮次结束', gradeLevel: 'junior' }
  ]

  const expectedKeys = ['activity', 'detail', 'gradeLevel', 'isCorrect', 'kpId', 'sessionId']
  for (const payload of payloads) {
    const serialized = JSON.stringify(payload)
    const parsed = JSON.parse(serialized) as Record<string, unknown>
    for (const key of Object.keys(parsed)) {
      assert.ok(
        expectedKeys.includes(key),
        `载荷里出现契约外字段：${key}（contracts.py 的 extra="forbid" 会直接 422）`
      )
    }
    assert.ok(!/\b(question|text|prompt|answer|code)\b/.test(serialized), '载荷里不得出现对话正文相关字段')
  }
})

test('★ G9-8c 真 HTTP 往返：learning-log 经 bridge/client.ts 发出带 X-Auth-Token 的 POST，并真读懂回执', async () => {
  // 这一条把 G9-8 从「载荷形状」升级成**端到端**：起一个本地假服务端（不需要 uvicorn），
  // 走**真的** `bridge/client.ts`（真的 token 注入、真的 URL 拼接、真的 JSON 响应解析）。
  const received: Array<{ method: string; url: string; token: string | null; body: string; contentType: string | null }> = []
  /** HTTP 头的值可能是数组（同名头多次出现）——这里只关心单值形态，非字符串一律记成 null。 */
  const headerValue = (value: string | string[] | undefined): string | null =>
    typeof value === 'string' ? value : null
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      received.push({
        method: request.method ?? '',
        url: request.url ?? '',
        token: headerValue(request.headers['x-auth-token']),
        body,
        contentType: headerValue(request.headers['content-type'])
      })
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ ok: true, id: 7 }))
    })
  })

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  assert.ok(address && typeof address === 'object', '假服务端必须拿到端口')
  const port = (address as { port: number }).port

  try {
    // ★ 走生产路径配置端点：token 只在这一处进内存（`apiFetch` 注入 `X-Auth-Token`）
    configureSidecarEndpoint(port, 'test-token-abc123')

    // ★ 送的是契约里**有**的字段（`extra="forbid"` 会直接 422）
    const payload: LearningEventPayload = {
      activity: 'coding',
      kpId: 'prog-loop-jr',
      sessionId: 'sess-99',
      isCorrect: false,
      detail: '运行学生代码',
      gradeLevel: 'junior'
    }
    await postLearningEvent('student_001', payload)

    assert.equal(received.length, 1, '必须真的发出一条 HTTP 请求')
    assert.equal(received[0].method, 'POST')
    assert.equal(
      received[0].url,
      '/api/profile/student_001/events',
      'URL 必须是 `/api/profile/{id}/events`（且带着 token 头 —— 这条以前只有「报告里那句话」）'
    )
    assert.equal(received[0].token, 'test-token-abc123', '★ token 必须由 bridge/client.ts 注入（调用方拿不到它）')
    assert.equal(received[0].contentType, 'application/json')
    assert.deepEqual(JSON.parse(received[0].body), payload, '发出的正文必须是那个载荷本身（不多字段）')
    // ★ 学生 id 走**路径段**（encodeURIComponent），不是请求体字段
    assert.ok(!received[0].body.includes('student_001'), '学生 id 不该重复出现在请求体里（它在路径上）')

    // 失败路径：非 2xx 必须抛**可读**错误（学习记录写入失败不能静默）
    const failing = createServer((_request, response) => {
      response.writeHead(422, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ detail: 'extra fields not permitted' }))
    })
    await new Promise<void>((done) => failing.listen(0, '127.0.0.1', done))
    const failingAddress = failing.address() as { port: number }
    try {
      configureSidecarEndpoint(failingAddress.port, 'test-token-abc123')
      await assert.rejects(
        () => postLearningEvent('student_001', payload),
        (error: unknown) => {
          assert.ok(error instanceof Error)
          assert.match(error.message, /学习记录写入失败：HTTP 422/)
          assert.match(error.message, /extra fields not permitted/, '要把服务端的可读原因带出来（截断但不丢）')
          return true
        }
      )
    } finally {
      await new Promise<void>((done) => failing.close(() => done()))
    }
  } finally {
    clearSidecarEndpoint()
    await new Promise<void>((done) => server.close(() => done()))
  }
})

/* ------------------------------------------------------------------ *
 * G8-5 六扩展注册表
 * ------------------------------------------------------------------ */

test('G8-5 扩展清单：六个扩展、十个冻结 Tool、事件落点与票 08 逐条一致', () => {
  assert.deepEqual(
    AGENT_EXTENSION_SPECS.map((spec) => spec.name),
    ['animation', 'coding', 'quiz', 'profile', 'grade', 'learning-log']
  )
  // ★ 10 = 票 08 的 9 个 + 票 20 的 remember_preference（画像扩展的「写」那一端）
  assert.equal(AGENT_TOOL_NAMES.length, 10)
  assert.deepEqual(auditToolCoverage(), { ok: true, violations: [] })

  const learningLog = AGENT_EXTENSION_SPECS.find((spec) => spec.name === 'learning-log')
  assert.deepEqual(learningLog?.events, ['tool_execution_end', 'agent_end'])
  assert.ok(
    !AGENT_EXTENSION_SPECS.some((spec) => spec.events.some((event) => event === 'session_end')),
    '`session_end` 在 Pi 里不存在（全包 grep 0 命中），任何扩展都不该订阅它'
  )
  // 每一条 `file` 都要能对上一个真实文件（本文件自带的两个必须存在；其余四个由别的票落地）
  assert.ok(Object.keys(CORE_EXTENSION_FACTORIES).sort().join(',') === 'learning-log,profile')
})

test('G8-5b 注册器：核心扩展已注册；未落地的四个被点名；strict 模式直接抛', () => {
  const tools: AgentToolDefinition[] = []
  const events: string[] = []
  const pi: AgentExtensionApi = {
    on: (event) => events.push(event),
    registerTool: (tool) => tools.push(tool)
  }

  const logs: string[] = []
  const report = registerAgentExtensions(pi, { log: (line) => logs.push(line) })

  assert.deepEqual(report.registered.sort(), ['learning-log', 'profile'])
  assert.deepEqual(
    report.missing.map((entry) => entry.name).sort(),
    ['animation', 'coding', 'grade', 'quiz']
  )
  // 缺的 Tool = 未落地扩展负责的那 7 个 payload 类 Tool
  assert.deepEqual(report.missingTools.slice().sort(), [
    'evaluate_code',
    'generate_animation',
    'generate_quiz',
    'generate_variants',
    'get_code_template',
    'get_coding_hint',
    'submit_quiz'
  ])
  assert.equal(report.ok, false, '缺扩展时报告必须是不 ok（否则等于静默少能力）')
  assert.ok(logs.some((line) => line.includes('animation')), '缺哪个扩展要**点名**')
  assert.match(describeRegistryReport(report), /待落地 4 个/)

  // 本文件自带的两个扩展真的注册了东西：profile 两个 Tool（读画像 + 记偏好）、
  // learning-log 两个事件。**顺序与 `profile.ts` 里 `registerTool` 的调用顺序一致**
  // （`get_student_profile` 在前、`remember_preference` 在后）。
  assert.deepEqual(tools.map((tool) => tool.name), ['get_student_profile', 'remember_preference'])
  assert.deepEqual(events.sort(), ['agent_end', 'tool_execution_end'])

  // 注入假的四个扩展后报告转绿
  const complete = createAgentExtensionRegistry({
    factories: {
      animation: () => undefined,
      coding: () => undefined,
      quiz: () => undefined,
      grade: () => undefined
    }
  })
  assert.deepEqual(complete.report().missing, [])

  // strict：生产构建缺一个就抛（防止「半套能力」被当成完成品）
  assert.throws(() => registerAgentExtensions(pi, { strict: true, log: () => undefined }), /扩展未就位/)

  // 某个扩展注册时抛异常：其余能力必须继续（Pi 与 UI 同进程）
  const boom = registerAgentExtensions(pi, {
    factories: { coding: () => { throw new Error('coding 扩展挂起就炸') } },
    log: () => undefined
  })
  assert.equal(boom.failed.length, 1)
  assert.match(boom.failed[0].error ?? '', /coding 扩展挂起就炸/)
  assert.deepEqual(boom.failed[0].name, 'coding')
})

test('G8-5c 本文件自带的扩展都通过了「参数用 TypeBox 声明」这条（有 properties/type）', () => {
  const tools: AgentToolDefinition[] = []
  registerAgentExtensions(
    { on: () => undefined, registerTool: (tool) => tools.push(tool) },
    { log: () => undefined }
  )
  const profile = tools.find((tool) => tool.name === 'get_student_profile')
  assert.ok(profile)
  const schema = profile.parameters as { type?: string; properties?: Record<string, unknown> }
  assert.equal(schema.type, 'object')
  assert.ok(schema.properties?.max_mastery, '参数 schema 里应当声明 max_mastery（Prompt 预算控制）')
})

/* ------------------------------------------------------------------ *
 * 结构守卫：轨迹模块不得引 Pi 静态依赖（否则 1478 个模块 + esbuild 全被拖进主进程）
 * ------------------------------------------------------------------ */

test('G8-6 trace.ts / extensions 不静态 import Pi 包（只允许动态 import）', () => {
  for (const file of [
    join(desktopRoot, 'src', 'main', 'agent', 'trace.ts'),
    join(desktopRoot, 'src', 'main', 'agent', 'extensions', 'index.ts'),
    join(desktopRoot, 'src', 'main', 'agent', 'extensions', 'profile.ts'),
    join(desktopRoot, 'src', 'main', 'agent', 'extensions', 'learning-log.ts')
  ]) {
    // 注释里解释「为什么不静态 import Pi」是好事，所以先剥注释再断言
    const source = stripComments(readFileSync(file, 'utf8'))
    assert.ok(
      !/from\s+['"]@earendil-works\/pi-coding-agent['"]/.test(source),
      `${file} 静态 import 了 Pi 包（会把 CLI main.js 与 esbuild 拖进主进程，风险 #15）`
    )
    assert.ok(!/\bfetch\s*\(/.test(source), `${file} 直接用了 fetch（必须走 bridge/client.ts）`)
  }
})

/** 去掉注释，只留可执行代码。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/gm, '$1')
}
