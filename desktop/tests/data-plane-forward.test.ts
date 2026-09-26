/**
 * 数据面**转发链路**的断言：`ipc/handlers-data.ts` → `wire/data.ts` → HTTP 出口。
 *
 * ★ 为什么单独一份：这两个模块此前**零测试覆盖**（全仓 tests 里没有一处 import 过它们），
 *   这正是下面两处 P0 能一直躺着的原因：
 *
 *   · `quiz:grade` / `code:run-hint` 转发时**没把学生 id 塞进 body** —— 而服务端
 *     `QuizGradeRequest.student_id` / `CodeRunRequest.student_id` 都是**必填**，
 *     `CamelModel` 又是 `extra="forbid"`：结果是闯关页每次提交都 422（掌握度 /
 *     学习历史 / 进度三处全都不写），编程页「报错感知 + 分级求助」整条链路点了没反应。
 *   · `readDetail` 只认 `detail` 是**字符串**的形态 —— 而 422 的 `detail` 是个**数组**，
 *     于是一句本该可读的校验失败在界面上退化成英文 `Unprocessable Entity`。
 *
 * ★ 这一份盯住五条「错了就静默出事」的纪律，每一条都配**反向对照**（见各用例注释）：
 *   1. **学生身份由主进程决定**：转发出去的 body 里是主进程解析出的 id，递进来的同名值不算数；
 *   2. **题库学段由主进程注入**：渲染进程递来的 `gradeLevel` 说了不算；
 *   3. **长任务用长超时**：知识库导入 / 重建必须是 180s —— 用 8s 兜底会把一次**成功**的
 *      重建报成「响应超时」，而库其实已经写好了（最难查的假失败）；
 *   4. **URL 形状**：查询参数用**服务端声明过的那个名字**（契约里是 `grade_level`）；
 *   5. **失败必须是一句中文人话**：422 的数组 detail 要拆成「字段：说明」，不是 JSON dump。
 *
 * ★ 手法：两个替身 + **真的把请求发出去**（只是出口是替身）。
 *   `electron` 用 data: URL 模块替掉（只为主进程那一个 `ipcMain.handle` 注册表），
 *   `bridge/client.ts`（唯一的 HTTP 出口）也替掉并记录每次调用的 path 与 body ——
 *   于是测的是**从 IPC handler 一路到 body 的真实代码**，不是另写一份镜像逻辑。
 *
 * 跑法：`node --test tests/data-plane-forward.test.ts`（或 `npm test`）。
 *
 * ⚠️ `node --test` 直跑 `.ts` 用的是 Node 的类型擦除 —— **禁用 TS parameter property**，
 *   见 AGENTS §8.1。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { QuizGradeRequest } from '../src/main/ipc/channels.ts'

/* ------------------------------------------------------------------ *
 * 两个替身
 * ------------------------------------------------------------------ */

/** `electron` 的替身：只提供本文件要用的那一个 `ipcMain.handle` 注册表。 */
const ELECTRON_STUB =
  'data:text/javascript;base64,' +
  Buffer.from(`
const handlers = new Map()
export const ipcMain = {
  handle(channel, listener) { handlers.set(channel, listener) },
  removeHandler(channel) { handlers.delete(channel) }
}
export const testIpc = {
  registered() { return [...handlers.keys()] },
  invoke(channel, payload) {
    const listener = handlers.get(channel)
    if (!listener) throw new Error('这条通道没有注册处理器：' + channel)
    // 本文件所有 handler 都不看 event：学生身份来自主进程注入的闭包，不从 sender 取
    return listener({}, payload)
  }
}
`).toString('base64')

/**
 * `bridge/client.ts` 的替身 —— **HTTP 出口的观测点**。
 *
 * ★ 只替这一处就能观测到全部真实路径：它是唯一的出口（架构守卫 G5），
 *   所以 `wire/data.ts` / `study/client.ts` 拼出来的 path、method、body、超时
 *   都会原样落到 {@link testTransport.calls} 里。
 * ★ 默认回一个**认得出**的 JSON（不是 `{}`）：用例要能分辨「解析成功」与「拿到空对象」。
 */
const BRIDGE_STUB =
  'data:text/javascript;base64,' +
  Buffer.from(`
const calls = []
/**
 * 按路径定制的回执表（P3-4 的用例要用它模拟「还没有这个学生 → 404」）。
 *
 * ★ 匹配口径是「**同一条路径**，可带查询串」而不是「任意前缀」：
 *   前缀匹配会让 profile 的规则把 profile/.../recommendation 也吞掉
 *   （实测踩到：那条子路径本该 200，却被判成 404，于是链路的第三步根本没发生）。
 * ⚠️ 本段在 template literal 里，注释里**不能出现反引号**（会提前闭合字符串）。
 */
const replies = []
const defaultReply = async () =>
  new Response(JSON.stringify({ qid: 'probe', correct: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
export const DEFAULT_API_TIMEOUT_MS = 8000
export const testTransport = {
  calls,
  reset() { calls.length = 0 },
  /** 注册一条「同路径」回执（带查询串也算命中；后注册的优先）。 */
  reply(path, status, body) { replies.unshift({ path, status, body }) },
  clearReplies() { replies.length = 0 }
}
export async function apiFetch(path, init = {}) {
  calls.push({ path, init })
  for (const rule of replies) {
    if (path === rule.path || path.startsWith(rule.path + '?')) {
      return new Response(JSON.stringify(rule.body), {
        status: rule.status,
        headers: { 'content-type': 'application/json' }
      })
    }
  }
  return await defaultReply()
}
export async function probeHealth() { return null }
export function configureSidecarEndpoint() {}
export function clearSidecarEndpoint() {}
`).toString('base64')

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return { url: ELECTRON_STUB, shortCircuit: true }
    if (specifier === '../bridge/client.ts') return { url: BRIDGE_STUB, shortCircuit: true }
    return nextResolve(specifier, context)
  }
})

/* 被测模块必须**动态 import**：静态 import 会被提到 registerHooks 之前。 */
const { IPC, KNOWLEDGE_LONG_TASK_TIMEOUT_MS } = await import('../src/main/ipc/channels.ts')
const data = await import('../src/main/wire/data.ts')
const { registerDataHandlers } = await import('../src/main/ipc/handlers-data.ts')
const study = await import('../src/main/study/client.ts')
const bridge = await import(BRIDGE_STUB)
/** 替身 `electron` 里的注册表入口（`ipcMain.handle` 装好的那些处理器）。 */
const { testIpc } = await import(ELECTRON_STUB)

/** 还没判出学段时的冷启动默认值（与 `handlers-data.ts` 里那个兜底字面量同值）。 */
const COLD_START_GRADE = 'primary_high'

/** 出口替身的调用记录（`init.body` 是已经序列化的字符串）。 */
interface WireCall {
  path: string
  init: { method?: string; body?: string; headers?: Record<string, string> }
}

const calls = bridge.testTransport.calls as WireCall[]

/**
 * 替身里的 `ipcMain` 注册表与出口记录**只在这一个文件里**，
 * 所以「装上处理器 → 调一次 → 看出口收到了什么」只能串行跑：
 * `node --test` 默认就是串行执行同一个文件里的用例，这里不再额外加锁。
 */
interface IpcStub {
  invoke(channel: string, payload?: unknown): Promise<unknown>
}

const ipc = testIpc as IpcStub

/** 源码里的可执行文本（去注释）。用于「某个字面量还在不在」这类静态断言。 */
function executableSource(file: string): string {
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  return stripComments(readFileSync(join(desktopRoot, file), 'utf8')).replace(/\s+/g, ' ')
}

/** 去掉注释，只留可执行代码（连注释掉的调用一起当成「没写」）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/gm, '$1')
}

/** 装上全部数据面处理器并返回一个「像 `ipcRenderer.invoke` 那样」的入口。 */
function install(state: { studentId: string; gradeLevel: string | null }) {
  registerDataHandlers({
    resolveStudentId: () => state.studentId,
    currentGradeLevel: () => state.gradeLevel
  })
  return async (channel: string, payload?: unknown): Promise<unknown> =>
    await ipc.invoke(channel, payload)
}

function lastBody(): Record<string, unknown> {
  const call = calls[calls.length - 1]
  assert.ok(call, '这一步应当真的发出了一次请求')
  return JSON.parse(String(call.init.body)) as Record<string, unknown>
}

/**
 * 记录 `AbortSignal.timeout(ms)` 每次被要走的毫秒数。
 *
 * ★ 超时预算是**看不见的**（`AbortSignal` 不带毫秒数），而它是「知识库重建」那条
 *   假失败的唯一起因 —— 所以在这里把它记下来，而不是等它真在 8s 上翻车。
 */
async function withTimeoutRecorder(run: () => Promise<unknown>): Promise<number[]> {
  const original = AbortSignal.timeout
  const seen: number[] = []
  AbortSignal.timeout = ((ms: number) => {
    seen.push(ms)
    return original.call(AbortSignal, ms)
  }) as typeof AbortSignal.timeout
  try {
    await run()
    return seen
  } finally {
    AbortSignal.timeout = original
  }
}

/** 一次真实的 FastAPI 422 回执（`detail` 是**数组**；形状取自本机实测，不是编的）。 */
function validationError422(): Response {
  return new Response(
    JSON.stringify({
      detail: [
        {
          type: 'missing',
          loc: ['body', 'studentId'],
          msg: 'Field required',
          input: { qid: 'ai-definition-pl-q1', answer: 'A' }
        }
      ]
    }),
    { status: 422, statusText: 'Unprocessable Entity', headers: { 'content-type': 'application/json' } }
  )
}

/* ================================================================== *
 * 1. 学生身份由主进程决定
 * ================================================================== */

test('身份-1 quizGrade：body 里是主进程解析出的 id（渲染进程递进来的同名值被忽略）', async () => {
  bridge.testTransport.reset()
  const invoke = install({ studentId: 'student_main', gradeLevel: 'junior' })

  const result = await invoke(IPC.quizGrade, {
    qid: 'ai-definition-pl-q1',
    answer: 'A',
    // ★ 反向对照：渲染进程**确实**能递进来一个同名的值（IPC 载荷是 unknown），
    //   它必须被丢弃 —— 否则「读别人的学习记录」就只是改一个字符串的事。
    studentId: 'attacker'
  })

  assert.deepEqual(result, { ok: true, data: { qid: 'probe', correct: true } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, '/api/quiz/grade')
  assert.equal(calls[0].init.method, 'POST')
  const body = lastBody()
  assert.equal(body.studentId, 'student_main', '服务端的 student_id 是必填：漏了就是整页判分 422')
  assert.equal(body.qid, 'ai-definition-pl-q1')
  assert.equal(body.answer, 'A')
  assert.ok(!JSON.stringify(body).includes('attacker'), '渲染进程递进来的 id 绝不能出现在 body 里')
})

test('身份-2 quizGrade：会话 id 仍照旧透传（注入 id 不该顶掉别的字段）', async () => {
  bridge.testTransport.reset()
  const invoke = install({ studentId: 'student_main', gradeLevel: null })

  await invoke(IPC.quizGrade, { qid: 'q1', answer: 'A', sessionId: 'sess_9' })

  assert.deepEqual(lastBody(), { qid: 'q1', answer: 'A', sessionId: 'sess_9', studentId: 'student_main' })
})

test('身份-3 codeRunHint：body 里是主进程解析出的 id（渲染进程递进来的同名值被忽略）', async () => {
  bridge.testTransport.reset()
  const invoke = install({ studentId: 'student_main', gradeLevel: 'junior' })

  const result = await invoke(IPC.codeRunHint, {
    kpId: 'prog-loop-jr',
    code: 'print(totle)',
    stdout: '',
    stderr: "NameError: name 'totle' is not defined",
    attempt: 2,
    studentId: 'attacker'
  })

  assert.deepEqual(result, { ok: true, data: { qid: 'probe', correct: true } })
  assert.equal(calls[0].path, '/api/code/run-hint')
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(lastBody(), {
    kpId: 'prog-loop-jr',
    code: 'print(totle)',
    language: 'python',
    stdout: '',
    stderr: "NameError: name 'totle' is not defined",
    attempt: 2,
    studentId: 'student_main'
  })
})

test('身份-4 取数层自己的门：就算有一个同名值被原样递进来，被覆盖掉的也是它', async () => {
  bridge.testTransport.reset()
  // 反向对照的**第二道**（纵深防御）：handler 已经重新组装过对象，所以正常路径上
  // 走不到这里；但 `{...request, studentId}` 里那个**顺序**正是「主进程的 id 永远赢」
  // 这件事的实现 —— 换成 `{studentId, ...request}` 就会被payload 反向覆盖。
  const smuggled = { qid: 'q1', answer: 'A', studentId: 'attacker' } as unknown as QuizGradeRequest
  await data.dataRequests.quizGrade(smuggled, 'student_main')
  assert.equal(lastBody().studentId, 'student_main')

  await data.dataRequests.codeRunHint(
    { kpId: 'prog-loop-jr', code: 'x', language: 'python', stdout: '', stderr: '', attempt: 1 },
    'student_main'
  )
  assert.equal(lastBody().studentId, 'student_main')
})

test('身份-5 身份只有一个取数口：需要 id 的通道都走主进程的解析结果', async () => {
  bridge.testTransport.reset()
  const invoke = install({ studentId: 'student_alpha', gradeLevel: 'junior' })

  await invoke(IPC.profileRead)
  await invoke(IPC.quizProgress)
  await invoke(IPC.gradeSignals)
  await invoke(IPC.gradeHistory)

  // 反向对照：换一个学生，路径整体跟着换（说明它们读的都是同一个取数口，不是某处写死的）
  assert.deepEqual(
    calls.map((call) => call.path),
    [
      '/api/profile/student_alpha',
      '/api/quiz/progress/student_alpha',
      '/api/grade/signals/student_alpha',
      '/api/grade/history/student_alpha'
    ]
  )
})

test('身份-6 两条塞 body 的通道确实注册上了（注册表里有它们，才谈得上注入）', () => {
  install({ studentId: 'student_main', gradeLevel: 'junior' })
  const registered = (testIpc as { registered(): string[] }).registered()
  for (const channel of [IPC.studentGet, IPC.quizGrade, IPC.codeRunHint, IPC.animationHost]) {
    assert.ok(registered.includes(channel), `这条通道没有注册处理器：${channel}`)
  }
})

/**
 * ★★ P3-4：「没有就建一个」必须是**幂等**的，不能靠服务端分配新号。
 *
 * 真机事故：启动后 `students/` 里同秒冒出 `student_001` 与 `student_002`。
 * 根因是这条通道原来走「列一遍全部学生 → 没有就 `POST /api/students`」——
 * 而那个端点的 id 由**服务端扫描目录**分配，于是启动时两个并发的自动建号
 * （本通道 + 学段/推荐那条冷启动路径）会各建一个：第二个扫描时 001 已占 ⇒ 建出 002。
 * 学生的数据从此分裂在两个目录里。
 *
 * 修法是按**已知 id** 走幂等的建行路径（`/recommendation` 的冷启动分支
 * `upsert_student(student_id)`），两个并发调用做的是同一件幂等的事。
 */
test('身份-7 ★ studentGet 不靠 POST /api/students 分配新号，而是按已知 id 幂等建行（P3-4）', async () => {
  bridge.testTransport.reset()
  bridge.testTransport.clearReplies()
  // 第一次读画像：服务端说「还没有这一位」（真实形态：404 + detail）
  bridge.testTransport.reply(
    '/api/profile/student_main',
    404,
    { detail: '还没有 student_main 的画像：该学生尚未建立学习记录' }
  )
  install({ studentId: 'student_main', gradeLevel: 'junior' })

  const result = (await ipc.invoke(IPC.studentGet)) as {
    ok: boolean
    message?: string
    data?: { studentId?: string }
  }
  const paths = calls.map((call) => call.path)

  assert.equal(
    paths.includes('/api/students'),
    false,
    '不得再调 POST/GET /api/students —— 那条路的 id 是服务端扫描目录分配的，' +
      '两个并发调用会各建一个（student_001 与 student_002 同秒出现，就是 P3-4）'
  )
  assert.deepEqual(
    paths,
    ['/api/profile/student_main', '/api/profile/student_main/recommendation', '/api/profile/student_main'],
    '顺序应当是「读 → 幂等建（recommendation 的冷启动分支）→ 再读」'
  )
  assert.equal(
    calls[1].init.method,
    'GET',
    '第二步是 GET /recommendation（它的冷启动分支会按这个 id 建行）—— 不是 POST /api/students'
  )
  assert.equal(result.ok, false, '回执仍受替身控制（这里第二次读还是 404，如实返回失败）')
})

test('身份-7b ★ 非 404 的失败不得触发建号（权限 / 服务不可用不许乱建）', async () => {
  bridge.testTransport.reset()
  bridge.testTransport.clearReplies()
  bridge.testTransport.reply('/api/profile/student_main', 503, { detail: '本地数据库异常' })
  install({ studentId: 'student_main', gradeLevel: 'junior' })

  await ipc.invoke(IPC.studentGet)

  assert.deepEqual(
    calls.map((call) => call.path),
    ['/api/profile/student_main'],
    '503 时只读一次就如实失败 —— 只有「还没有」（404）才该触发建号'
  )
})

/* ================================================================== *
 * 2. 题库学段由主进程注入
 * ================================================================== */

test('学段-1 quizBank：学段取自 options.currentGradeLevel（渲染进程递来的被忽略）', async () => {
  bridge.testTransport.reset()
  const invoke = install({ studentId: 'student_main', gradeLevel: 'junior' })

  await invoke(IPC.quizBank, { kpId: 'prog-loop-jr', count: 2, gradeLevel: 'senior' })

  assert.equal(
    calls[0].path,
    '/api/quiz/bank/prog-loop-jr?grade_level=junior&count=2',
    '学段被前端指定 = 「只取不高于学生学段的内容」这条隔离被绕开'
  )
})

test('学段-2 quizBank：还没判出学段时按冷启动默认值取题（不把 null 拼进 URL）', async () => {
  // 先把「冷启动默认值」这个字面量钉在源码里：它是**业务值**（不是随手写的兜底），
  // 改了它就等于改了新学生的第一组题难度 —— 不该悄悄改掉。
  assert.ok(
    executableSource('src/main/ipc/handlers-data.ts').includes(`?? '${COLD_START_GRADE}'`),
    `handlers-data.ts 的冷启动学段不再是 ${COLD_START_GRADE}（改了就要同步改本用例）`
  )

  bridge.testTransport.reset()
  const invoke = install({ studentId: 'student_main', gradeLevel: null })

  await invoke(IPC.quizBank, { kpId: 'prog-loop-jr' })

  assert.equal(calls[0].path, `/api/quiz/bank/prog-loop-jr?grade_level=${COLD_START_GRADE}&count=3`)
})

/* ================================================================== *
 * 3. 长任务用长超时
 * ================================================================== */

test('超时-1 知识库导入 / 重建用 180s 长超时（用 8s 兜底会把成功的重建报成超时）', async () => {
  assert.equal(KNOWLEDGE_LONG_TASK_TIMEOUT_MS, 180_000)
  assert.ok(
    KNOWLEDGE_LONG_TASK_TIMEOUT_MS > data.DATA_REQUEST_TIMEOUT_MS,
    '长超时必须真的更长，否则这行等于没写'
  )
  bridge.testTransport.reset()
  const invoke = install({ studentId: 'student_main', gradeLevel: 'junior' })

  const imported = await withTimeoutRecorder(async () => {
    await invoke(IPC.knowledgeImport, { fileName: 'ch09.md', markdown: '# 第9章 测试' })
  })
  assert.deepEqual(imported, [KNOWLEDGE_LONG_TASK_TIMEOUT_MS])

  const rebuilt = await withTimeoutRecorder(async () => {
    await invoke(IPC.knowledgeRebuild)
  })
  assert.deepEqual(rebuilt, [KNOWLEDGE_LONG_TASK_TIMEOUT_MS])
})

test('超时-2 普通读写仍用 8s 兜底（长超时只给重活，别把整个数据面都拖长）', async () => {
  bridge.testTransport.reset()
  const invoke = install({ studentId: 'student_main', gradeLevel: 'junior' })

  const budget = await withTimeoutRecorder(async () => {
    await invoke(IPC.knowledgeStats)
    await invoke(IPC.quizProgress)
  })

  assert.deepEqual(budget, [data.DATA_REQUEST_TIMEOUT_MS, data.DATA_REQUEST_TIMEOUT_MS])
})

/* ================================================================== *
 * 4. URL 形状（查询参数用服务端声明过的那个名字）
 * ================================================================== */

test('URL-1 路径工厂：查询参数名与**服务端声明的**参数名逐字一致', () => {
  // snake_case 的那几个（OpenAPI 里声明的主名就是 snake_case）
  assert.equal(data.quizBankPath('prog-loop-jr', 'junior', 3), '/api/quiz/bank/prog-loop-jr?grade_level=junior&count=3')
  assert.equal(data.codeTemplatePath('prog-loop-jr', 'junior'), '/api/code/templates/prog-loop-jr?grade_level=junior')
  assert.equal(data.codeTemplatePath('prog-loop-jr'), '/api/code/templates/prog-loop-jr')
  assert.equal(data.knowledgePointsPath({ gradeLevel: 'junior' }), '/api/knowledge/points?grade_level=junior')

  // ★ 反向对照（同样是「按服务端签名」而不是「全项目统一 snake_case」）：
  //   这两个端点声明的名字**就是 camelCase**，写成 snake_case 会被 FastAPI 静默忽略。
  assert.equal(data.quizProgressPath('student_001', ['a', 'b']), '/api/quiz/progress/student_001?kpIds=a%2Cb')
  assert.equal(
    data.animationTemplatesPath({ kpId: 'prog-loop-jr', gradeLevel: 'junior' }),
    '/api/animation/templates?kpId=prog-loop-jr&gradeLevel=junior'
  )
  // 动画渲染的 body 也是 camelCase（`resources.py` 读的是 body 里的 kpId / gradeLevel）
  assert.equal(data.ANIMATION_RENDER_PATH, '/api/animation/render')
})

test('URL-2 路径工厂：id 一律 encodeURIComponent（一个特殊字符不该改变 URL 结构）', () => {
  assert.equal(data.profilePath('a/b'), '/api/profile/a%2Fb')
  assert.equal(data.profilePath('a b'), '/api/profile/a%20b')
  assert.equal(data.quizBankPath('kp/../x', 'junior', 1), '/api/quiz/bank/kp%2F..%2Fx?grade_level=junior&count=1')
  assert.equal(data.animationHostPath('s/1', 'kp 2'), '/api/animation/host/s%2F1/kp%202')
  assert.equal(data.codeHintPath('prog-loop-jr', 2), '/api/code/hint/prog-loop-jr?level=2')
})

/* ================================================================== *
 * 5. 失败必须是一句中文人话
 * ================================================================== */

test('readDetail-1 422 的数组 detail 拆成「字段：说明」，不是英文状态文本', async () => {
  for (const [label, run] of [
    ['数据面', () => data.requestJson('/api/quiz/grade', { method: 'POST', body: {}, request: async () => validationError422() })],
    ['档案', () => study.requestStudyJson('/api/x', { method: 'PUT', body: {}, request: async () => validationError422() })]
  ] as const) {
    const result = await run()
    assert.equal(result.ok, false)
    assert.ok(!result.ok)
    assert.ok(
      !result.message.includes('Unprocessable Entity'),
      `${label}：422 退化成英文状态文本了 —— ${result.message}`
    )
    assert.ok(!result.message.includes('[{'), `${label}：把 JSON 原样 dump 给学生了 —— ${result.message}`)
    assert.match(result.message, /studentId/, `${label}：要说清是哪个字段没过校验`)
    assert.match(result.message, /^操作失败（HTTP 422）：|^保存失败（HTTP 422）：/, label)
  }
})

test('readDetail-2 字符串 detail 原样返回（既有口径不变）', async () => {
  const response = () =>
    new Response(JSON.stringify({ detail: '知识点不在本学段的教材清单里' }), {
      status: 409,
      statusText: 'Conflict',
      headers: { 'content-type': 'application/json' }
    })

  const wire = await data.requestJson('/api/x', { request: async () => response() })
  assert.equal(wire.ok, false)
  assert.ok(!wire.ok)
  assert.equal(wire.message, '读取失败（HTTP 409）：知识点不在本学段的教材清单里')

  const archive = await study.requestStudyJson('/api/x', { request: async () => response() })
  assert.equal(archive.ok, false)
  assert.ok(!archive.ok)
  assert.equal(archive.message, '读取失败（HTTP 409）：知识点不在本学段的教材清单里')
})

test('readDetail-3 非 JSON 响应有兜底（不因解析失败而崩，也不回一个空串）', async () => {
  const textOnly = () => new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })

  const wire = await data.requestJson('/api/x', { request: async () => textOnly() })
  assert.equal(wire.ok, false)
  assert.ok(!wire.ok)
  assert.match(wire.message, /HTTP 401/)

  const archive = await study.requestStudyJson('/api/x', { request: async () => textOnly() })
  assert.equal(archive.ok, false)
  assert.ok(!archive.ok)
  assert.match(archive.message, /HTTP 401/)
})

test('readDetail-3b `message` 字段也是认的（与 handlers.ts 的兜底链一致：detail → message → 状态文本）', async () => {
  const result = await data.requestJson('/api/x', {
    request: async () =>
      new Response(JSON.stringify({ message: '没有权限读这个学生的记录' }), {
        status: 403,
        statusText: 'Forbidden',
        headers: { 'content-type': 'application/json' }
      })
  })
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.equal(result.message, '读取失败（HTTP 403）：没有权限读这个学生的记录')
})

test('readDetail-4 细节里的换行被单行化、超长被截断（失败消息要能进状态栏）', async () => {
  const long = '字段不对。\n'.repeat(80)
  const result = await data.requestJson('/api/x', {
    request: async () =>
      new Response(JSON.stringify({ detail: long }), {
        status: 422,
        headers: { 'content-type': 'application/json' }
      })
  })
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  const detail = result.message.replace(/^.*）：/, '')
  assert.ok(!detail.includes('\n'), '失败消息不能是多行（状态栏放不下）')
  assert.ok(detail.length <= 201, `截断上限是 200 字 + 省略号，实际 ${detail.length}`)
  assert.ok(detail.endsWith('…'))
})

test('readDetail-5 ★ 两处实现必须逐字一致（同类回执不该有两种说法）', () => {
  // 源码级断言（与 `student-context.test.ts` 的「6 个拼装点不许各写一份」同一手法）：
  // 「两处保持同步」靠人记得必然漂移，所以在这里钉住。
  // 拿**去注释后的可执行文本**比对：注释掉一处、在另一处改代码都能被抓出来。
  const readDetailBody = (file: string): string => {
    const source = executableSource(file)
    const start = source.indexOf('async function readDetail')
    const end = source.indexOf('function describeError')
    assert.ok(start > 0 && end > start, `${file} 里找不到 readDetail / describeError`)
    return source.slice(start, end)
  }

  assert.equal(
    readDetailBody('src/main/wire/data.ts'),
    readDetailBody('src/main/study/client.ts'),
    '两个读细节的实现已经漂移：改一处就要改另一处'
  )
})
