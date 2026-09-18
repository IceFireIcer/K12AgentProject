/**
 * 票：**教材章节选择（软偏好）** —— 主进程取数层（`src/main/study/chapter.ts`）与
 * `study/client.ts` 的 GET/PUT 推广的断言。
 *
 * 这一组盯住四条「错了就静默出事」的红线：
 *
 *   1. ★ **URL 形状**：`/api/profile/{id}/chapter`（id 必须 `encodeURIComponent`，
 *      它来自主进程，但仍不该让一个特殊字符改变 URL 结构）；
 *   2. ★ **失败绝不抛异常**（判别联合 + 可读中文）——
 *      handler 里抛出去会变成渲染进程侧的 `Error invoking remote method` 堆栈文本；
 *   3. ★ **方法 / body / Content-Type**：`fetchChapterState` 是 GET、`saveChapterState` 是
 *      `PUT` + `{chapterTitle}`；**GET 不带 body**（某些代理会因此拒绝一个带 `body: undefined`
 *      的 GET）；
 *   4. ★ **`readChapterTitle` 的边界**：非 string → `null`、空白 → `''`（= 清除）、
 *      超长 → `null`；它是 IPC 边界的白名单（渲染进程递来的值一律不当真）。
 *
 * ⚠️ `node --test` 直跑 `.ts` 用的是 Node 的类型擦除 —— **禁用 TS parameter property**，
 *   见 AGENTS §8.1。
 *
 * 跑法：`npm test`。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CHAPTER_TITLE_MAX_CHARS,
  chapterPath,
  fetchChapterState,
  readChapterTitle,
  saveChapterState
} from '../src/main/study/chapter.ts'
import { fetchStudyJson, requestStudyJson, STUDY_REQUEST_TIMEOUT_MS } from '../src/main/study/client.ts'
import { IPC, PUSH_CHANNELS } from '../src/main/ipc/channels.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 记下测试注入出口收到的每一次调用（**不改动任何真实网络**）。 */
function recordingRequest(reply: () => Promise<Response> | Response): {
  calls: Array<{ path: string; timeoutMs: number; init?: { method: string; headers?: Record<string, string>; body?: string } }>
  request: (path: string, timeoutMs: number, init?: { method: string; headers?: Record<string, string>; body?: string }) => Promise<Response>
} {
  const calls: Array<{ path: string; timeoutMs: number; init?: { method: string; headers?: Record<string, string>; body?: string } }> = []
  return {
    calls,
    request: async (path, timeoutMs, init) => {
      calls.push({ path, timeoutMs, init })
      return await reply()
    }
  }
}

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { 'content-type': 'application/json' }
  })

// ── URL 形状 ───────────────────────────────────────────────────────────

test('章节端点：/api/profile/{id}/chapter，且对 id 做 encodeURIComponent', () => {
  assert.equal(chapterPath('student_001'), '/api/profile/student_001/chapter')
  // 特殊字符不该改变 URL 结构
  assert.equal(chapterPath('a b'), '/api/profile/a%20b/chapter')
  assert.equal(chapterPath('a/b'), '/api/profile/a%2Fb/chapter')
})

// ── 方法 / body / 头 ───────────────────────────────────────────────────

test('读章节：走 GET、不带请求体（GET 带 body 会被一些代理直接拒掉）', async () => {
  const recorder = recordingRequest(() =>
    jsonResponse({ gradeLevel: 'junior', chapterTitle: '第4章 用 Python 处理数据' })
  )
  const result = await fetchChapterState('student_001', { request: recorder.request })

  assert.equal(result.ok, true)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].path, '/api/profile/student_001/chapter')
  assert.equal(recorder.calls[0].timeoutMs, STUDY_REQUEST_TIMEOUT_MS)
  assert.equal(recorder.calls[0].init?.method, 'GET')
  assert.equal(recorder.calls[0].init?.body, undefined, 'GET 不该带请求体')
  assert.equal(recorder.calls[0].init?.headers, undefined, 'GET 不该带 Content-Type')
})

test('写章节：走 PUT + JSON body（带 Content-Type），空串也能原样发出（= 清除）', async () => {
  const recorder = recordingRequest(() => jsonResponse({ gradeLevel: 'junior', chapterTitle: '' }))
  const result = await saveChapterState('student_001', '', { request: recorder.request })

  assert.equal(result.ok, true)
  assert.equal(recorder.calls[0].path, '/api/profile/student_001/chapter')
  assert.equal(recorder.calls[0].init?.method, 'PUT')
  assert.equal(recorder.calls[0].init?.headers?.['Content-Type'], 'application/json')
  assert.equal(recorder.calls[0].init?.body, JSON.stringify({ chapterTitle: '' }), '空串 = 清除，必须原样发出去')
})

// ── 失败绝不抛异常（判别联合 + 可读中文）────────────────────────────────

test('★ 读章节失败不抛异常：HTTP 非 2xx 变成带状态码的可读中文', async () => {
  const result = await fetchChapterState('student_001', {
    request: async () => jsonResponse({ detail: '本地数据服务没有这个学生' }, 404)
  })
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.equal(result.message, '读取失败（HTTP 404）：本地数据服务没有这个学生')
})

test('★ 写章节失败不抛异常：消息用「保存失败」而不是「读取失败」', async () => {
  const result = await saveChapterState('student_001', '第9章 不存在的章', {
    request: async () => jsonResponse({ detail: '章节不在当前学段的教材清单里' }, 422)
  })
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.match(result.message, /^保存失败（HTTP 422）：/)
  assert.match(result.message, /章节不在当前学段的教材清单里/)
})

test('★ 连不上 / 超时也变成可读中文（绝不抛穿 IPC）', async () => {
  const refused = await fetchChapterState('student_001', {
    request: async () => {
      throw new Error('fetch failed')
    }
  })
  assert.equal(refused.ok, false)
  assert.ok(!refused.ok)
  assert.match(refused.message, /读取失败/)

  const timeout = new Error('The operation was aborted due to timeout')
  timeout.name = 'TimeoutError'
  const timedOut = await saveChapterState('student_001', '第1章', {
    request: async () => {
      throw timeout
    }
  })
  assert.equal(timedOut.ok, false)
  assert.ok(!timedOut.ok)
  assert.match(timedOut.message, /超时/, '超时要单独说清楚（处置与其它失败不同）')
})

test('非 JSON 的失败响应也能给出可读消息（不因解析失败而崩）', async () => {
  const result = await fetchChapterState('student_001', {
    request: async () => new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })
  })
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.match(result.message, /HTTP 401/)
})

// ── readChapterTitle：IPC 边界的白名单 ────────────────────────────────

test('readChapterTitle：只认字符串（非 string 一律 null，不猜测、不兜底成空串）', () => {
  for (const bad of [null, undefined, 42, {}, [], true, Symbol('x')]) {
    assert.equal(readChapterTitle(bad), null, `不该接受 ${String(bad)}`)
  }
  assert.equal(readChapterTitle('第4章 用 Python 处理数据'), '第4章 用 Python 处理数据')
})

test('readChapterTitle：trim 掉首尾空白；**全空白 → 空串**（= 清除，不是 null）', () => {
  assert.equal(readChapterTitle('  第1章 走进人工智能  '), '第1章 走进人工智能')
  // ★ 空串与 null 是**两件事**：空串是学生的意图（取消选择），null 是非法入参。
  assert.equal(readChapterTitle(''), '')
  assert.equal(readChapterTitle('   '), '')
  assert.equal(readChapterTitle('\t\n '), '')
})

test('readChapterTitle：超过上限按**码点**判 null（与服务端 len() 同口径）', () => {
  assert.equal(readChapterTitle('学'.repeat(CHAPTER_TITLE_MAX_CHARS)), '学'.repeat(CHAPTER_TITLE_MAX_CHARS))
  assert.equal(readChapterTitle('学'.repeat(CHAPTER_TITLE_MAX_CHARS + 1)), null)
  // 中文一个字 = 一个码点（UTF-16 也是 1）：超出即拒
  assert.equal(readChapterTitle('第'.repeat(CHAPTER_TITLE_MAX_CHARS) + '章'), null)
  assert.equal(readChapterTitle('😀'.repeat(CHAPTER_TITLE_MAX_CHARS)), '😀'.repeat(CHAPTER_TITLE_MAX_CHARS))
  assert.equal(readChapterTitle('😀'.repeat(CHAPTER_TITLE_MAX_CHARS + 1)), null, '代理对要按一个码点算')
})

test('readChapterTitle 是幂等的：清理过的标题再清理一次不变', () => {
  for (const raw of ['  第2章  ', '', '第3章', '学'.repeat(CHAPTER_TITLE_MAX_CHARS)]) {
    const once = readChapterTitle(raw)
    assert.notEqual(once, null)
    assert.equal(readChapterTitle(once), once, `不幂等：${JSON.stringify(raw)} → ${once}`)
  }
})

// ── GET 薄包装的兼容性（既有调用点与测试不许被打断）──────────────────

test('fetchStudyJson 仍是 GET 的薄包装（既有四条学习档案通道走的就是它）', async () => {
  const recorder = recordingRequest(() => jsonResponse({ ok: true }))
  const result = await fetchStudyJson('/api/x', { request: recorder.request })

  assert.equal(result.ok, true)
  assert.equal(recorder.calls[0].init?.method, 'GET')
  assert.equal(recorder.calls[0].init?.body, undefined)
})

test('requestStudyJson 默认就是 GET（省略 method 时不猜成别的动词）', async () => {
  const recorder = recordingRequest(() => jsonResponse({ ok: true }))
  await requestStudyJson('/api/y', { request: recorder.request })
  assert.equal(recorder.calls[0].init?.method, 'GET')
})

// ── IPC 边界（源码级：handlers.ts / preload 都 import electron，node --test 加载不了）

const handlersSource = readFileSync(join(desktopRoot, 'src', 'main', 'ipc', 'handlers.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|\s)\/\/.*$/gm, '$1')

/**
 * 取一条 `ipcMain.handle(<标记>, …)` 的**完整调用**（靠大括号配对，不用缩进猜）。
 *
 * ★ 为什么不用 `[\s\S]*?\n  \}\)` 这种正则：本仓库的处理器收尾写法不统一
 *   （有的写 `\n  })`、有的写 `\n    }\n  )`），那个正则会在前者上**越过**本条处理器
 *   一路匹配到文件里下一条 `\n  })` —— 断言于是在一个过长的片段里做，形同虚设
 *   （写这个测试时正好踩到过一次）。
 */
function handlerBody(source: string, marker: string): string {
  const markerAt = source.indexOf(marker)
  assert.ok(markerAt >= 0, `handlers.ts 里找不到 ${marker}`)
  // 起点回到本次调用开头的 `ipcMain.handle(`（标记在参数位上，往回找就有）
  const start = source.lastIndexOf('ipcMain.handle(', markerAt)
  assert.ok(start >= 0, `${marker} 前面找不到 ipcMain.handle(`)
  const open = source.indexOf('{', markerAt)
  assert.ok(open >= 0, `${marker} 后面找不到回调的起始大括号`)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        const body = source.slice(start, index + 1)
        // 负向对照：配对失手时片段会一路吃到后面的处理器，当场说清楚
        assert.ok(
          !body.includes('registerStudyHandlers') && !body.includes('registerSessionHandlers'),
          `${marker} 的提取越界了（吃到了别的处理器）—— 本测试的定位依据需要更新`
        )
        return body
      }
    }
  }
  throw new Error(`${marker} 的大括号没有配对（源码被截断了？）`)
}

test('★ chapter:get / chapter:set 的学生身份只由主进程决定（不接受渲染进程递身份）', () => {
  const getHandler = handlerBody(handlersSource, 'IPC.chapterGet,')
  const setHandler = handlerBody(handlersSource, 'IPC.chapterSet,')

  assert.match(getHandler, /ipcMain\.handle\(IPC\.chapterGet,/, '定位到的不是 chapter:get 的处理器')
  assert.match(setHandler, /ipcMain\.handle\(\s*IPC\.chapterSet,/, '定位到的不是 chapter:set 的处理器')

  for (const [name, body] of [
    ['chapterGet', getHandler],
    ['chapterSet', setHandler]
  ] as const) {
    assert.match(body, /resolveActiveStudentId\(\)/, `${name} 必须用主进程的 resolveActiveStudentId() 决定身份`)
    assert.ok(
      !/studentId\s*:/.test(body),
      `${name} 不得从渲染进程的载荷里读 studentId（那等于允许改别人的章节）`
    )
  }
})

test('★ chapter:set 用 readChapterTitle 做入参白名单（认不出回 ok:false，不抛异常）', () => {
  const setHandler = handlerBody(handlersSource, 'IPC.chapterSet,')
  assert.match(setHandler, /readChapterTitle\(/, 'chapter:set 必须用 readChapterTitle 白名单校验入参')
  assert.match(setHandler, /ok: false/, '入参不合法要回可读回执，而不是抛异常穿 IPC')
})

test('★ chapter:set 成功后立刻推 chapter:changed（学生点完就能看到指示器变了）', () => {
  const setHandler = handlerBody(handlersSource, 'IPC.chapterSet,')
  assert.match(setHandler, /pushChapterState\(state\)/, '写成功后必须立刻推送（否则指示器要等下一次读才更新）')
})

test('★ 章节三条通道的推送 / invoke 分类正确（与 grade 那一对完全对称）', () => {
  assert.equal(IPC.chapterGet, 'chapter:get')
  assert.equal(IPC.chapterSet, 'chapter:set')
  assert.equal(IPC.chapterChanged, 'chapter:changed')

  assert.ok(PUSH_CHANNELS.includes(IPC.chapterChanged), 'chapter:changed 是主→渲染推送，必须登记进 PUSH_CHANNELS')
  assert.ok(!PUSH_CHANNELS.includes(IPC.chapterGet), 'chapter:get 是 invoke（有回执），不是推送通道')
  assert.ok(!PUSH_CHANNELS.includes(IPC.chapterSet), 'chapter:set 是 invoke（有回执），不是推送通道')
})

/** preload 也 import electron（`node --test` 加载不了），所以这一条同样读源码。 */
const preloadSource = readFileSync(join(desktopRoot, 'src', 'preload', 'index.ts'), 'utf8')

test('★ preload：章节推送在边界处过 isChapterState 白名单（半截对象不进界面）', () => {
  assert.match(
    preloadSource,
    /ipcRenderer\.on\(IPC\.chapterChanged/,
    'preload 必须订阅 chapter:changed（否则指示器只能靠手动刷新）'
  )
  assert.match(
    preloadSource,
    /function isChapterState\(/,
    'preload 必须有 isChapterState（照 isGradeState）—— 认不出就整条丢掉'
  )
  const body = /function isChapterState\([\s\S]*?\n\}/.exec(preloadSource)?.[0] ?? ''
  assert.match(body, /GRADE_LEVELS as readonly string\[\]\)\.includes\(record\.gradeLevel\)/, 'isChapterState 必须校验四学段白名单')
  assert.match(body, /typeof record\.chapterTitle === 'string'/, 'isChapterState 必须要求 chapterTitle 是字符串（空串合法）')

  // 订阅返回取消函数（照 onGradeChanged）：没有它，组件卸载后会留下野监听
  const subscribeBody = /onChapterChanged:[\s\S]*?\n  \},/.exec(preloadSource)?.[0] ?? ''
  assert.match(subscribeBody, /removeListener\(IPC\.chapterChanged/, 'subscribe 必须返回取消订阅函数（否则重复挂载会叠加监听）')
})
