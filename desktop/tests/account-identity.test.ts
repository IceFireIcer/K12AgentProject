/**
 * 账号门 ↔ 称呼（`identity_local.real_name`）**唯一写入点**的守卫（task-44 ③④）。
 *
 * 事实（2026-10-01 用户裁决）：五问的 q5 从「称呼」换成「兴趣 / 动机」，所以 real_name
 * 改由**账号门**负责 —— 建号 / 改名时把昵称写进去。这里钉住三件事：
 *   ① 建号后 real_name = 门里填的昵称，且写的是**刚建出来的那位**（不是当前账号）；
 *   ② 改名同样跟着写；
 *   ③ 只改学段时**不碰**称呼。
 * 反向那半（五问全程不写身份）在 `onboarding-state.test.ts` 的用例里。
 *
 * 写法照 `data-plane-forward.test.ts`：替身 `electron` 的 ipcMain 注册表 +
 * 替身 `bridge/client.ts`（唯一 HTTP 出口，记录 path / method / body）。
 */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

/** `electron` 替身：只要一个 ipcMain.handle 注册表。 */
const ELECTRON_STUB =
  'data:text/javascript;base64,' +
  Buffer.from(`
const handlers = new Map()
export const ipcMain = {
  handle(channel, listener) { handlers.set(channel, listener) },
  removeHandler(channel) { handlers.delete(channel) }
}
export const testIpc = {
  invoke(channel, payload) {
    const listener = handlers.get(channel)
    if (!listener) throw new Error('这条通道没有注册处理器：' + channel)
    return listener({}, payload)
  }
}
`).toString('base64')

/** `bridge/client.ts` 替身：全项目唯一 HTTP 出口的观测点。 */
const BRIDGE_STUB =
  'data:text/javascript;base64,' +
  Buffer.from(`
const calls = []
const replies = []
export const DEFAULT_API_TIMEOUT_MS = 8000
export const testTransport = {
  calls,
  reset() { calls.length = 0; replies.length = 0 },
  reply(path, status, body) { replies.unshift({ path, status, body }) }
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
  return new Response(JSON.stringify({}), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}
export async function probeHealth() { return null }
export function configureSidecarEndpoint() {}
export function clearSidecarEndpoint() {}
`).toString('base64')

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return { url: ELECTRON_STUB, shortCircuit: true }
    // 主进程与引导服务两处动态 import 同一个出口（`../` 与 `../../`）—— 按后缀认。
    if (specifier.endsWith('bridge/client.ts')) return { url: BRIDGE_STUB, shortCircuit: true }
    return nextResolve(specifier, context)
  }
})

const { IPC } = await import('../src/main/ipc/channels.ts')
const { registerDataHandlers } = await import('../src/main/ipc/handlers-data.ts')
const bridge = await import(BRIDGE_STUB)
const { testIpc } = await import(ELECTRON_STUB)

interface WireCall {
  path: string
  init: { method?: string; body?: string }
}

const calls = bridge.testTransport.calls as WireCall[]

/** 装上全部数据面处理器，返回一个「像 ipcRenderer.invoke 那样」的入口。 */
function install(state: { studentId: string; gradeLevel: string | null }) {
  registerDataHandlers({
    resolveStudentId: () => state.studentId,
    currentGradeLevel: () => state.gradeLevel
  })
  return async (channel: string, payload?: unknown): Promise<unknown> =>
    await testIpc.invoke(channel, payload)
}

const ACCOUNT_ROW = {
  studentId: 'student_777',
  nickname: '小星',
  gradeLevel: 'senior',
  currentChapter: '',
  createdAt: 0,
  lastActiveAt: 0
}

test('建号：门里填的昵称写进**刚建出来那位**的 real_name（称呼唯一写入点）', async () => {
  bridge.testTransport.reset()
  bridge.testTransport.reply('/api/students', 200, ACCOUNT_ROW)
  // 当前账号故意是**另一位**：称呼必须写到新账号名下，绝不写到现在这位
  const invoke = install({ studentId: 'student_001', gradeLevel: 'junior' })
  const created = (await invoke(IPC.accountsCreate, {
    nickname: '小星',
    gradeLevel: 'senior'
  })) as { ok: boolean }
  assert.equal(created.ok, true, '建号要成功')
  const identity = calls.find((call) => call.path === '/api/profile/student_777/identity/flags')
  assert.ok(identity, '建号后必须写称呼（否则 {{student_name}} 永远回落「同学」）')
  assert.equal(identity.init.method, 'PUT')
  assert.deepEqual(JSON.parse(String(identity.init.body)), { realName: '小星' })
  assert.equal(
    calls.some((call) => call.path.includes('student_001')),
    false,
    '不能写到当前账号名下（身份必须是刚建出来的那位）'
  )
})

test('改名：昵称跟着写进 real_name；只改学段时**不碰**称呼', async () => {
  bridge.testTransport.reset()
  bridge.testTransport.reply('/api/students/student_777', 200, { ...ACCOUNT_ROW, nickname: '小新' })
  const invoke = install({ studentId: 'student_001', gradeLevel: 'junior' })
  const renamed = (await invoke(IPC.accountsRename, {
    studentId: 'student_777',
    nickname: '小新'
  })) as { ok: boolean }
  assert.equal(renamed.ok, true)
  const identity = calls.find((call) => call.path === '/api/profile/student_777/identity/flags')
  assert.ok(identity, '改名后 real_name 要跟着换（否则模型眼里的称呼还是旧的）')
  assert.deepEqual(JSON.parse(String(identity.init.body)), { realName: '小新' })

  bridge.testTransport.reset()
  bridge.testTransport.reply('/api/students/student_777', 200, ACCOUNT_ROW)
  await invoke(IPC.accountsRename, { studentId: 'student_777', gradeLevel: 'junior' })
  assert.equal(
    calls.some((call) => call.path.endsWith('/identity/flags')),
    false,
    '只改学段不该碰称呼'
  )
})

/* ------------------------------------------------------------------ *
 * 源码级守卫：② 「读写同一个人」+ ① 「Q1 不走手动 override」
 * ------------------------------------------------------------------ */

const DESKTOP_ROOT = new URL('..', import.meta.url)
const readSource = (relativePath: string): string =>
  readFileSync(new URL(relativePath, DESKTOP_ROOT), 'utf8')

/** 去掉注释：注释里写着纪律不算接线（本仓守卫的标准手法）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

test('★★ 写学段用的是**当前账号**：装配前比对身份、写前复核身份（读写同一个人）', () => {
  const handlers = stripComments(readSource('src/main/ipc/handlers.ts'))
  const ensureBody = handlers.slice(handlers.indexOf('export async function ensureChatRuntime('))
  const guardAt = ensureBody.indexOf('runtime.studentId !== wanted')
  const disposeAt = ensureBody.indexOf('await disposeChatRuntime()')
  const returnAt = ensureBody.indexOf('if (runtime) return runtime')
  assert.ok(guardAt > 0, '★ ensureChatRuntime 必须比对「已装配的那位 vs 当前账号」')
  assert.ok(disposeAt > guardAt, '★ 身份不一致必须先 dispose 旧会话（Pi 会话按学生隔离）')
  assert.ok(
    returnAt > disposeAt,
    '★ 顺序反了：先返回旧实例就等于继续用上一个学生（线上事故的形态）'
  )
  assert.match(
    handlers,
    /resolveStudentId: resolveActiveStudentId/,
    '★ 装配选项必须注入当前账号解析（写学段前复核用）'
  )

  const runtime = stripComments(readSource('src/main/agent/runtime.ts'))
  const setAt = runtime.indexOf('async setGradeLevel(')
  assert.ok(setAt > 0, '找不到 setGradeLevel')
  const setBody = runtime.slice(setAt, setAt + 1800)
  assert.match(setBody, /options\.resolveStudentId\?\.\(\)/, '★ 写库前必须**在调用时**解析当前账号')
  assert.match(setBody, /targetStudentId !== paths\.studentId/, '★ 身份不一致必须拒绝，不许写到别人名下')
  assert.match(
    setBody,
    /postGradeOverride\(targetStudentId, gradeLevel\)/,
    '★ 落库用的是复核过的 id，不是装配期捕获的 paths.studentId'
  )
})

test('★ Q1 的学段走学生资料更新（PATCH students），不再走 grade:override 的手动语义', () => {
  const handlers = stripComments(readSource('src/main/ipc/handlers.ts'))
  const applyAt = handlers.indexOf('applyGradeBand:')
  assert.ok(applyAt > 0, '找不到 applyGradeBand 接线')
  const applyBody = handlers.slice(applyAt, applyAt + 900)
  assert.match(
    applyBody,
    /updateStudentGradeForAccount\(resolveActiveStudentId\(\), level\)/,
    '★ Q1 必须写学生资料（账号菜单同一条路），身份在调用时解析'
  )
  assert.doesNotMatch(applyBody, /setGradeLevel/, '★ 不得再走 grade:set（那会写 source=explicit + 10 轮冷却）')
  assert.doesNotMatch(applyBody, /postGradeOverride/, '★ 更不得直连 override 端点')

  const data = stripComments(readSource('src/main/ipc/handlers-data.ts'))
  const helperAt = data.indexOf('export async function updateStudentGradeForAccount(')
  assert.ok(helperAt > 0, 'handlers-data.ts 必须导出 updateStudentGradeForAccount')
  const helperBody = data.slice(helperAt, helperAt + 700)
  assert.match(helperBody, /method: 'PATCH'/, '★ 走的是 PATCH /api/students/{id}（学生资料更新）')
})
