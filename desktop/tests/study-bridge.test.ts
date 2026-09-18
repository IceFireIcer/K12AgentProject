/**
 * 学习档案的**主进程取数层**与**文件名清理**的断言。
 *
 * 这一组盯住四条「错了就静默出事」的红线：
 *
 * 1. ★★ **文件名只能变成文件名**：渲染进程递进来的 `..\\..\\config.json`、`a/b.md`、
 *    `x.exe` 都必须被清理成**单段、相对、以 `.md` 结尾**的名字 ——
 *    这是安全边界（它会落到学生磁盘上），所以用白名单重建而不是黑名单过滤；
 * 2. ★ **失败一律变成可读中文**（判别联合），绝不抛异常穿 IPC ——
 *    handler 里抛出去会变成渲染进程侧的 `Error invoking remote method` 堆栈文本；
 * 3. ★ **请求路径的构造**：`studentId` 必须 `encodeURIComponent`
 *    （它来自主进程，但仍不该让一个特殊字符改变 URL 结构）；
 * 4. ★ **导出内容是 LF + 结尾单个换行**（不制造 CRLF/LF 混排，本项目已踩过）。
 *
 * 这些全是纯函数（不加载 Pi、不碰文件系统），所以能直接在 `node --test` 里跑。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_EXPORT_NAME,
  MAX_FILE_NAME_CHARS,
  normalizeExportContent,
  sanitizeFileName
} from '../src/main/study/export-naming.ts'
import {
  STUDY_MAX_REPORT_DAYS,
  STUDY_REQUEST_TIMEOUT_MS,
  fetchStudyJson,
  readReportDays,
  readStudyGradeLevel,
  studyChaptersPath,
  studyGraphPath,
  studyMistakesPath,
  studyReportPath
} from '../src/main/study/client.ts'

// ── 文件名清理（安全边界）──────────────────────────────────────────────

test('文件名清理：路径分隔符被彻底去掉（渲染进程无法指定路径）', () => {
  const attacks = [
    '../../../config.json',
    '..\\..\\config.json',
    'C:\\Windows\\System32\\drivers\\etc\\hosts',
    '/etc/passwd',
    'a/b/c.md',
    'a\\/b\\c.md',
    './../../x'
  ]
  for (const attack of attacks) {
    const safe = sanitizeFileName(attack)
    assert.equal(safe.includes('/'), false, `残留路径分隔符：${attack} → ${safe}`)
    assert.equal(safe.includes('\\'), false, `残留路径分隔符：${attack} → ${safe}`)
    assert.equal(safe.includes('..'), false, `残留 ..：${attack} → ${safe}`)
    assert.ok(safe.endsWith('.md'), `必须以 .md 结尾：${attack} → ${safe}`)
    assert.ok(safe.length > 0)
  }
})

test('文件名清理：以点开头的名字被去点（隐藏文件 / 目录项）', () => {
  for (const raw of ['.env', '..', '.', '.gitignore']) {
    const safe = sanitizeFileName(raw)
    assert.equal(safe.startsWith('.'), false, `不该以点开头：${raw} → ${safe}`)
  }
})

test('文件名清理：可疑后缀被替换成 .md（不会导出成可执行文件）', () => {
  for (const raw of ['报告.exe', 'run.bat', 'x.js', 'payload.cmd', 'a.txt']) {
    const safe = sanitizeFileName(raw)
    assert.ok(safe.endsWith('.md'), `${raw} → ${safe} 应当以 .md 结尾`)
    assert.equal(/\.(exe|bat|cmd|js|txt)$/i.test(safe), false, `可疑后缀残留：${safe}`)
  }
  // 已经是 .md 的不重复补
  assert.equal(sanitizeFileName('学习报告.md'), '学习报告.md')
  assert.equal(sanitizeFileName('学习报告.markdown'), '学习报告.md')
})

test('文件名清理：中文与常规字符保留，非法字符换成 -', () => {
  assert.equal(sanitizeFileName('第4章 学习报告'), '第4章 学习报告.md')
  const safe = sanitizeFileName('a*b?c:d"e<f>g|h.md')
  assert.equal(safe, 'a-b-c-d-e-f-g-h.md', `非法字符应当换成 -：${safe}`)
})

test('文件名清理：空 / 非字符串 / 全是非法字符 → 默认名', () => {
  for (const raw of ['', '   ', '///', '***', null, undefined, 42, {}]) {
    assert.equal(sanitizeFileName(raw), `${DEFAULT_EXPORT_NAME}.md`, `输入 ${JSON.stringify(raw)}`)
  }
})

test('文件名清理：超长名字被按字符截断（不按字节）', () => {
  const long = '学'.repeat(200)
  const safe = sanitizeFileName(long)
  // 名字（去掉 .md）不超过上限
  assert.ok(
    Array.from(safe.replace(/\.md$/, '')).length <= MAX_FILE_NAME_CHARS,
    `长度没有截断：${Array.from(safe).length}`
  )
})

test('★ 文件名清理是幂等的：清理过的名字再清理一次不变', () => {
  for (const raw of ['../../../x.exe', '报告.md', '..\\a b*c.md', '']) {
    const once = sanitizeFileName(raw)
    assert.equal(sanitizeFileName(once), once, `不幂等：${raw} → ${once} → ${sanitizeFileName(once)}`)
  }
})

// ── 导出内容规范化 ─────────────────────────────────────────────────────

test('导出内容：CRLF 统一成 LF，结尾恰好一个换行', () => {
  assert.equal(normalizeExportContent('a\r\nb\r\n'), 'a\nb\n')
  assert.equal(normalizeExportContent('a\nb'), 'a\nb\n')
  assert.equal(normalizeExportContent('a\n\n\n'), 'a\n')
  // 裸 CR（老 Mac 换行）也要归一
  assert.equal(normalizeExportContent('a\rb'), 'a\nb\n')
})

test('导出内容：空内容也给一个结尾换行（不产出 0 字节文件）', () => {
  assert.equal(normalizeExportContent(''), '\n')
  assert.equal(normalizeExportContent(undefined), '\n')
})

// ── 路径构造 ───────────────────────────────────────────────────────────

test('报告路径：带天数且对 id 做 encodeURIComponent', () => {
  assert.equal(studyReportPath('student_001', 7), '/api/profile/student_001/report?days=7')
  // 特殊字符不该改变 URL 结构
  assert.equal(studyReportPath('a b', 7), '/api/profile/a%20b/report?days=7')
  assert.equal(studyReportPath('a/b', 7), '/api/profile/a%2Fb/report?days=7')
})

test('章节 / 地图路径：带学生时附 query，不带时只有路径', () => {
  assert.equal(studyChaptersPath('junior'), '/api/knowledge/chapters/junior')
  assert.equal(studyChaptersPath('junior', 'student_001'), '/api/knowledge/chapters/junior?student_id=student_001')
  assert.equal(studyGraphPath('junior'), '/api/graph/overview/junior')
  assert.equal(studyGraphPath('junior', 'student_001'), '/api/graph/overview/junior?student_id=student_001')
  assert.equal(studyMistakesPath('student_001'), '/api/quiz/mistakes/student_001')
})

// ── 入参校验 ───────────────────────────────────────────────────────────

test('学段白名单：只认四个冻结字面量，认不出返回 null（不猜测）', () => {
  for (const good of ['primary_low', 'primary_high', 'junior', 'senior']) {
    assert.equal(readStudyGradeLevel(good), good)
  }
  for (const bad of ['kindergarten', 'Junior', '', null, undefined, 3, {}]) {
    assert.equal(readStudyGradeLevel(bad), null, `不该接受 ${JSON.stringify(bad)}`)
  }
})

test('报告天数：默认 7、整数 1..上限、越界返回 null', () => {
  assert.equal(readReportDays(undefined), 7)
  assert.equal(readReportDays(null), 7)
  assert.equal(readReportDays(1), 1)
  assert.equal(readReportDays(STUDY_MAX_REPORT_DAYS), STUDY_MAX_REPORT_DAYS)
  for (const bad of [0, -1, STUDY_MAX_REPORT_DAYS + 1, 1.5, 'abc', {}]) {
    assert.equal(readReportDays(bad), null, `不该接受 ${JSON.stringify(bad)}`)
  }
})

// ── 失败一律变成可读中文（绝不抛穿 IPC）──────────────────────────────

test('★ 取数失败不抛异常：HTTP 非 2xx 变成带状态码的可读中文', async () => {
  const result = await fetchStudyJson('/api/x', {
    request: async () =>
      new Response(JSON.stringify({ detail: '该学生尚未建立学习记录' }), {
        status: 404,
        statusText: 'Not Found',
        headers: { 'content-type': 'application/json' }
      })
  })
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.equal(result.message, '读取失败（HTTP 404）：该学生尚未建立学习记录')
})

test('★ 取数失败不抛异常：拒答（连不上 / 超时）也变成可读中文', async () => {
  const result = await fetchStudyJson('/api/x', {
    request: async () => {
      throw new Error('fetch failed')
    }
  })
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.match(result.message, /读取失败/)

  const timeout = new Error('The operation was aborted due to timeout')
  timeout.name = 'TimeoutError'
  const timedOut = await fetchStudyJson('/api/x', {
    request: async () => {
      throw timeout
    }
  })
  assert.equal(timedOut.ok, false)
  assert.ok(!timedOut.ok)
  assert.match(timedOut.message, /超时/, '超时要单独说清楚（处置与其它失败不同）')
})

test('取数成功：原样带回 JSON（主进程不做任何解析/重算）', async () => {
  const payload = { studentId: 'student_001', totalActivities: 3, nested: { a: [1, 2] } }
  const result = await fetchStudyJson('/api/x', {
    request: async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
  })
  assert.equal(result.ok, true)
  assert.ok(result.ok)
  assert.deepEqual(result.data, payload)
})

test('取数：非 JSON 的失败响应也能给出可读消息（不因解析失败而崩）', async () => {
  const result = await fetchStudyJson('/api/x', {
    request: async () => new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })
  })
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.match(result.message, /HTTP 401/)
})

test('请求超时常量是个有限值（不能是 0 或 Infinity）', () => {
  assert.ok(Number.isFinite(STUDY_REQUEST_TIMEOUT_MS))
  assert.ok(STUDY_REQUEST_TIMEOUT_MS > 0 && STUDY_REQUEST_TIMEOUT_MS <= 60_000)
})
