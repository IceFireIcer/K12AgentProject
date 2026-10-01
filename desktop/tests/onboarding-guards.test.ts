/**
 * 票 25–30「对话式冷启动画像」跨层守卫（执行报告 §0.6.6 G-A…G-L + §0.6.7 14 条禁做清单）。
 *
 * ★ 为什么这份测试几乎全是**读源码文本**：本轮红线横跨 Python / 主进程 / 渲染层三层，
 *   而 node --test 跑在桌面端、连不上 sidecar 的 SQLite。跨语言的「两边白名单逐字一致」
 *   只有两种做法 —— 跨语言调用（脆弱、依赖本机 Python）或读源码文本（快、CI 能跑）。
 *   这里选后者；**行为级验证在各层自己的测试里**：
 *     · A server/tests/test_profile_tags.py / test_onboarding_routes.py（入库、出栈、TTL、闸）
 *     · B desktop/tests/onboarding-state.test.ts（状态机 / fire-and-forget）
 *     · C desktop/tests/persona-injection.test.ts（投影进 prompt）
 *     · D desktop/tests/renderer-onboarding.test.ts（占位符替换残留）
 *   本文件负责把「契约书 §2/§5/§6」逐条钉成**可在 CI 独立跑**的断言。
 *
 * ★ 断言纪律：一律写成**正向/结构性**断言（「这个键必须在白名单里」「prompt 端必须
 *   import 共享白名单」），不写「禁止某历史实现」式断言 —— 本项目从零实现。
 *   仅 §0.6.7 的 14 条禁做清单是**规格点名**的红线，那些「不得出现」是在定义边界本身，
 *   不是对某个历史实现的防守。
 *
 * ★ 跑法：cd desktop && node --test tests/onboarding-guards.test.ts
 *   若 A/B/C/D 尚未落盘，涉及它们的断言会红 —— 这是**预期**的：断言按契约先写好，
 *   等对应层落盘后应转绿。不要为了让测试变绿去改别人的写域。
 */

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  EMOTION_LABELS,
  EMOTION_VALUES,
  EMOTION_VALUE_SET,
  EPHEMERAL_TAGS,
  EPHEMERAL_TAG_SET,
  EPHEMERAL_TTL_MS,
  EPHEMERAL_TTL_TURNS,
  IDENTITY_LOCAL_FIELDS,
  IDENTITY_LOCAL_FORBIDDEN,
  INTENSITY_MAX,
  INTENSITY_MIN,
  JOIN_KEY,
  LEARNER_STYLE_VALUES,
  LEARNER_STYLE_VALUE_SET,
  LLM_VISIBLE_TAGS,
  LLM_VISIBLE_TAG_SET,
  ONBOARDING_DONE_STATE,
  ONBOARDING_QUESTIONS,
  ONBOARDING_QUESTION_IDS,
  ONBOARDING_INITIAL_STATE,
  ONBOARDING_STATES,
  ONBOARDING_STATE_SET,
  PARENT_CONSENT_DEFAULT,
  PERSONALITY_VALUES,
  PERSONALITY_VALUE_SET,
  STUDENT_FALLBACK_NAME,
  isLlmVisibleTag,
  remainingOnboarding
} from '../src/shared/profile-tags.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(desktopRoot, '..')
const sharedTagsFile = join(desktopRoot, 'src', 'shared', 'profile-tags.ts')
const mainAgentDir = join(desktopRoot, 'src', 'main', 'agent')
const promptsDir = join(mainAgentDir, 'prompts')
const extensionsDir = join(mainAgentDir, 'extensions')
const onboardingDir = join(mainAgentDir, 'onboarding')
const rendererDir = join(desktopRoot, 'src', 'renderer', 'src')
const channelsFile = join(desktopRoot, 'src', 'main', 'ipc', 'channels.ts')
const serverAppDir = join(repoRoot, 'server', 'app')
const serverRoutesDir = join(serverAppDir, 'routes')
const contractsFile = join(serverAppDir, 'contracts.py')
const migrationsFile = join(serverAppDir, 'store', 'migrations.py')

/* ------------------------------------------------------------------ *
 * 读源码的小工具
 * ------------------------------------------------------------------ */

function show(file: string): string {
  return relative(repoRoot, file).replace(/\\/g, '/')
}

function readSource(file: string): string {
  return readFileSync(file, 'utf8')
}

/**
 * 去掉注释与字符串字面量后的源码（用于「代码里有没有 X」这类断言）。
 *
 * ★ 为什么需要它：G-M 系列的几条断言是「代码里不许出现 displayName / 裸 fetch(」——
 *   而**注释本身会提到这些词**（比如「displayName 连入参都不许有」「不许出现裸 fetch(」）。
 *   直接在原文上断言会被自己的注释绊倒（实测踩到），所以先在「代码视图」上判。
 * ★ 手法：块注释 / 行注释剥掉，字符串与模板字符串一并剥掉（那些里的词是**数据**不是代码，
 *   比如错误文案里出现「fetch failed」不该算新开出口）。
 * ★ 保守起见：正则不追求完美（正则剥注释本就不可能完美），它只需要把这类断言
 *   从「被注释绊倒」变成「看代码」，对括号不嵌套的 TS 足够。
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, '``')
    .replace(/'(?:\\[\s\S]|[^\\'])*'/g, "''")
    .replace(/"(?:\\[\s\S]|[^\\"])*"/g, '""')
}

function requiredSource(file: string, why: string): string {
  assert.ok(existsSync(file), show(file) + ' 不存在：' + why)
  return readSource(file)
}

function walkDir(root: string, extensions: readonly string[]): string[] {
  const found: string[] = []
  if (!existsSync(root)) return found
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(full)
    }
  }
  walk(root)
  return found
}

function serverPyFiles(): string[] {
  return walkDir(serverAppDir, ['.py'])
}

function joined(files: readonly string[]): string {
  return files.map((file) => readSource(file)).join('\n')
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort()
}

/** 去掉注释：注释里解释「为什么不能出现某词」是好事，不该被判违规。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/gm, '$1')
}

function interfaceBody(source: string, name: string, file: string): string {
  const code = stripComments(source)
  const head = new RegExp('export\\s+interface\\s+' + name + '\\s*\\{').exec(code)
  assert.ok(head, show(file) + ' 里找不到 interface ' + name)
  const open = code.indexOf('{', head.index)
  let depth = 0
  let close = -1
  for (let index = open; index < code.length; index += 1) {
    const char = code[index]
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        close = index
        break
      }
    }
  }
  assert.ok(close > open, show(file) + ' 的 interface ' + name + ' 花括号不配平（提取不出主体）')
  const body = code.slice(open + 1, close)
  assert.ok(body.includes('\n'), show(file) + ' 的 interface ' + name + ' 被写成单行，字段提取器会整块漏掉')
  return body
}

function declaredFields(body: string): string[] {
  return body
    .split(/[\n;]/)
    .map((member) => member.trim())
    .filter((member) => member.length > 0)
    .map((member) => /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/.exec(member))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1])
}

/* ------------------------------------------------------------------ *
 * Python 源码抽取（跨语言一致性用读文本，不跨语言调用）
 * ------------------------------------------------------------------ */

/** 抽一个 Python 类的主体（到下一个顶层 class 之前）。 */
function pyClassBody(source: string, name: string): string {
  const head = new RegExp('(?:^|\\n)class\\s+' + name + '\\b[\\s\\S]*?:\\r?\\n').exec(source)
  assert.ok(head, 'contracts.py 里找不到 class ' + name + '（契约书 §2.1 点名要它）')
  const rest = source.slice(head.index + head[0].length)
  const next = /\nclass\s+/.exec(rest)
  return next ? rest.slice(0, next.index) : rest
}

/** 抽一个 Python 类的带注解字段名（只认声明行，注释行不参与）。 */
function pyClassFields(source: string, name: string): string[] {
  const body = pyClassBody(source, name)
  const fields: string[] = []
  for (const line of body.split('\n')) {
    const matched = /^[ \t]+([A-Za-z_]\w*)\s*:/.exec(line)
    if (matched) fields.push(matched[1])
  }
  return fields
}

/** 抽一个 Python 字符串集合常量（tuple / list / set / frozenset 都认）。 */
function pyStringCollection(source: string, name: string): string[] {
  const pattern = new RegExp(
    '(?:^|\\n)[ \\t]*' + name + '\\b\\s*(?::[^=\\n]*)?=\\s*(?:frozenset\\s*\\(\\s*)?[([{]([\\s\\S]*?)[)\\]}]'
  )
  const matched = pattern.exec(source)
  assert.ok(matched, '服务端找不到常量 ' + name)
  return [...matched[1].matchAll(/['"]([^'"]+)['"]/g)].map((entry) => entry[1])
}

/** 抽一个 Python 数值常量（允许 24 * 60 * 60 * 1000 这种四则运算）。 */
function pyNumber(source: string, name: string): number {
  const matched = new RegExp(
    '(?:^|\\n)[ \\t]*' + name + '\\b\\s*(?::[^=\\n]*)?=\\s*([0-9\\s*+\\-()]+)'
  ).exec(source)
  assert.ok(matched, '服务端找不到数值常量 ' + name)
  const expression = matched[1].trim()
  const value = Function('return (' + expression + ')')()
  assert.ok(typeof value === 'number' && Number.isFinite(value), name + ' 不是数值常量')
  return value
}

/** 在 server/app 下找**声明**某常量的文件。 */
function findDefiningPy(name: string): { file: string; source: string } | null {
  for (const file of serverPyFiles()) {
    const source = readSource(file)
    if (new RegExp('(?:^|\\n)[ \\t]*' + name + '\\b\\s*(?::[^=\\n]*)?=').test(source)) {
      return { file, source }
    }
  }
  return null
}

/** 抽 CREATE TABLE 的主体。 */
function ddlBody(source: string, table: string): string {
  const matched = new RegExp(
    'CREATE TABLE(?:\\s+IF NOT EXISTS)?\\s+' + table + '\\s*\\(([\\s\\S]*?)\\);'
  ).exec(source)
  assert.ok(matched, '迁移里找不到 CREATE TABLE ' + table)
  return matched[1]
}

/** 抽 DDL 主体里的列名（跳过 PRIMARY/UNIQUE 这类约束行）。 */
function ddlColumns(body: string): string[] {
  const keywords = new Set(['PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'CONSTRAINT', 'CREATE', 'INDEX'])
  const names: string[] = []
  for (const line of body.split('\n')) {
    const clean = line.replace(/--.*$/, '').trim()
    const matched = /^([A-Za-z_]\w*)\s+[A-Za-z]/.exec(clean)
    if (matched && !keywords.has(matched[1].toUpperCase())) names.push(matched[1])
  }
  return names
}

/** 抽路由装饰器上的路径字面量（装饰器常写成多行，用 [\s\S] 跨行不必要，只跨空白即可）。 */
function routePaths(source: string): string[] {
  return [...source.matchAll(/@router\.(?:get|post|put|delete|patch)\(\s*["']([^"']+)["']/g)].map(
    (entry) => entry[1]
  )
}

/** 「必须不含」式断言：用于 §0.6.7 点名的红线字面量。 */
function assertAbsent(source: string, needles: readonly string[], where: string, why: string): void {
  for (const needle of needles) {
    assert.ok(!source.includes(needle), where + ' 出现禁做字面量「' + needle + '」：' + why)
  }
}

/** prompt 侧文件：四份学段模板 + 共用规则 + profile/grade（+ 引导扩展）。 */
function promptFiles(includeOnboarding: boolean): string[] {
  const files = walkDir(promptsDir, ['.ts'])
  for (const name of ['profile.ts', 'grade.ts']) {
    const file = join(extensionsDir, name)
    if (existsSync(file)) files.push(file)
  }
  if (includeOnboarding) {
    const file = join(extensionsDir, 'onboarding.ts')
    if (existsSync(file)) files.push(file)
    // ★ 引导模式的整份 prompt 在 B 的 onboarding/ 目录里（buildOnboardingSystemPrompt）——
    //   {{student_name}} 占位纪律与情绪/依赖话术都写在那儿，扫 prompt 时必须带上。
    files.push(...walkDir(onboardingDir, ['.ts']))
  }
  return [...new Set(files)]
}

/** identity_local 的列名在源码里出现的正则。class 是 JS 关键字，要排除类声明。 */
function identityFieldPattern(field: string): RegExp {
  if (field === 'class') return /\bclass\b(?!\s+[A-Za-z_$])/
  return new RegExp('\\b' + field + '\\b')
}

/**
 * 在 server/app 里按「必须出现的成员」发现某个字符串集合常量的镜像。
 *
 * ★ 不绑常量名：A 侧把白名单叫 ALLOWED_TAG_KEYS，而 TS 叫 LLM_VISIBLE_TAGS ——
 *   绑名字会把「一次命名差异」误判成「少了守卫」。守卫要钉的是**取值一致**，
 *   所以先发现它，再逐字比对（命名差异记在报告里交给集成方定夺）。
 */
function findPyCollection(required: readonly string[]): { file: string; name: string; values: string[] } | null {
  for (const file of serverPyFiles()) {
    const source = readSource(file)
    for (const matched of source.matchAll(
      /(?:^|\n)[ \t]*([A-Z_][A-Z0-9_]*)\s*(?::[^=\n]*)?=\s*(?:frozenset\s*\(\s*)?[([{]([\s\S]*?)[)\]}]/g
    )) {
      const values = [...matched[2].matchAll(/['"]([^'"]+)['"]/g)].map((entry) => entry[1])
      if (required.every((member) => values.includes(member))) {
        return { file, name: matched[1], values }
      }
    }
  }
  return null
}

/* ------------------------------------------------------------------ *
 * 契约常量（执行报告 §0.5 MVP 15 标签 / §0.6.3 白名单）
 * ------------------------------------------------------------------ */

/** MVP 15 个标签里**模型可见**的那 13 个（另两个是闸，见下）。 */
const MVP_VISIBLE_TAGS = [
  'anon_student_id',
  'grade_band',
  'subject',
  'current_topic',
  'knowledge_point',
  'mastery',
  'error_type',
  'explain_style',
  'output_length',
  'emotion',
  'intensity',
  'tone',
  'safety_level'
] as const

/** parent_consent / memory_switch 是**闸**不是**信息**（§0.6.3）。 */
const GATE_TAGS = ['parent_consent', 'memory_switch'] as const

/** 永久不可外传的真实身份列（§0.6.2）。 */
const REAL_IDENTITY_FIELDS = ['real_name', 'real_grade', 'school', 'class'] as const

/* ================================================================== *
 * G-A：白名单是唯一出口
 * ================================================================== */

test('G-A 白名单自洽：无重复键，MVP 13 个可见标签全部在名单里，两个闸不在名单里', () => {
  assert.ok(LLM_VISIBLE_TAGS.length > 0, '白名单不能为空')
  assert.equal(LLM_VISIBLE_TAG_SET.size, LLM_VISIBLE_TAGS.length, '白名单有重复键（集合与列表对不上）')
  for (const tag of LLM_VISIBLE_TAGS) {
    assert.ok(isLlmVisibleTag(tag), '白名单里的 ' + tag + ' 必须自洽可见')
  }
  for (const tag of MVP_VISIBLE_TAGS) {
    assert.ok(isLlmVisibleTag(tag), 'MVP 可见标签 ' + tag + ' 必须在白名单里（§0.5）')
  }
  for (const gate of GATE_TAGS) {
    assert.ok(!isLlmVisibleTag(gate), gate + ' 是闸不是信息，不得进白名单（§0.6.3）')
  }
  assert.ok(isLlmVisibleTag(JOIN_KEY), 'join 钥匙必须是白名单成员（否则两表无法关联）')
})

test('G-A 服务端白名单镜像与 TS 逐字一致，且被真正引用（出栈再过一遍，不是只声明）', () => {
  const mirror = findPyCollection(['anon_student_id', 'grade_band', 'safety_level'])
  assert.ok(
    mirror,
    '服务端必须有 LLM_VISIBLE_TAGS 的 Python 镜像（含 anon_student_id / grade_band / safety_level）—— 待 A 落盘'
  )
  assert.deepEqual(
    sorted(mirror.values),
    sorted(LLM_VISIBLE_TAGS),
    '跨语言白名单必须逐字一致（服务端镜像 = ' + mirror.name + ' @ ' + show(mirror.file) + '）：' +
      'TS 加了键而 Python 没加 = 写入端与模型可见面出现缝'
  )
  const mentions = serverPyFiles().reduce((count, file) => {
    const matched = readSource(file).match(new RegExp('\\b' + mirror.name + '\\b', 'g'))
    return count + (matched ? matched.length : 0)
  }, 0)
  assert.ok(
    mentions > 1,
    '白名单常量 ' + mirror.name + ' 必须被写入端与出栈端同时引用（只声明不引用 = 出栈不过滤，G-A 的「出栈再过一遍」落空）'
  )
})

/* ================================================================== *
 * G-B：两表物理隔离、身份列与白名单零重叠
 * ================================================================== */

test('G-B 用 IDENTITY_LOCAL_FORBIDDEN 断言：身份列与白名单零重叠（除 join 钥匙）', () => {
  assert.deepEqual(
    // ★ Set 展开成数组再排序：sorted() 接的是 readonly string[]，
    //   而 IDENTITY_LOCAL_FORBIDDEN 是 ReadonlySet（用 Set 是为了 O(1) 判成员）。
    sorted([...IDENTITY_LOCAL_FORBIDDEN]),
    sorted(IDENTITY_LOCAL_FIELDS.filter((field) => field !== JOIN_KEY)),
    'IDENTITY_LOCAL_FORBIDDEN 必须恰好是「身份列去掉 join 钥匙」—— 两个方向都要能被发现'
  )
  const overlap = IDENTITY_LOCAL_FIELDS.filter((field) => isLlmVisibleTag(field))
  assert.deepEqual(overlap, [JOIN_KEY], '两张表只能有 join 钥匙这一处交集（§0.6.2 Lead 裁决口径）')
  for (const field of IDENTITY_LOCAL_FORBIDDEN) {
    assert.ok(!isLlmVisibleTag(field), 'identity_local.' + field + ' 是身份列，绝不允许进白名单')
  }
  for (const field of REAL_IDENTITY_FIELDS) {
    assert.ok(IDENTITY_LOCAL_FORBIDDEN.has(field), '真身份列 ' + field + ' 必须在身份禁列集合里')
  }
  const mirror = findPyCollection(REAL_IDENTITY_FIELDS)
  assert.ok(mirror, '服务端必须有 IDENTITY_LOCAL_FIELDS 的 Python 镜像（含真身份四列）—— 待 A 落盘')
  assert.deepEqual(
    sorted(mirror.values),
    sorted(IDENTITY_LOCAL_FIELDS),
    '身份列集合也必须跨语言逐字一致（服务端镜像 = ' + mirror.name + '）：两边列名漂了，G-B 就守到别的表上去了'
  )
})

test('G-B 存储层物理隔离：身份列只在 identity_local，profile_tags 只有白名单载体列', () => {
  const migrations = requiredSource(migrationsFile, 'A 需落迁移 v5（两张新表）')
  const identityColumns = ddlColumns(ddlBody(migrations, 'identity_local'))
  const tagColumns = ddlColumns(ddlBody(migrations, 'profile_tags'))
  for (const field of REAL_IDENTITY_FIELDS) {
    assert.ok(identityColumns.includes(field), 'identity_local 必须承载真身份列 ' + field)
    assert.ok(!tagColumns.includes(field), 'profile_tags 不得出现身份列 ' + field + '（两表物理隔离）')
  }
  for (const column of ['key', 'value']) {
    assert.ok(tagColumns.includes(column), 'profile_tags 必须有 ' + column + ' 列')
  }
})

/* ================================================================== *
 * G-C：prompt 拼装器只读 profile_tags
 * ================================================================== */

test('G-C prompt 拼装器只读 profile_tags：身份列在 prompt 源里零出现，且复用共享白名单', () => {
  const files = promptFiles(false)
  assert.ok(files.length > 0, '找不到 prompt 源文件：' + show(promptsDir))
  for (const file of files) {
    const code = stripComments(readSource(file))
    for (const field of IDENTITY_LOCAL_FORBIDDEN) {
      assert.ok(
        !identityFieldPattern(field).test(code),
        show(file) + ' 不得读取 identity_local.' + field + '（白名单没有它；prompt 拼装器只许读 profile_tags 投影）'
      )
    }
  }
  const importers = files.filter((file) => readSource(file).includes('profile-tags'))
  assert.ok(
    importers.length >= 1,
    'prompt 侧必须直接复用 @shared/profile-tags 的白名单常量（另写一份 key 列表 = 第二处真相）'
  )
})

/* ================================================================== *
 * G-D：{{student_name}} 占位机制（行为级残留测试在 D 的 renderer-onboarding）
 * ================================================================== */

test('G-D 姓名只在本地：prompt 用 {{student_name}} 占位，渲染层负责替换与残留兜底', () => {
  assert.ok(STUDENT_FALLBACK_NAME.length > 0, '必须有一个学生面回落称呼')
  const promptJoined = joined(promptFiles(true))
  assert.match(
    promptJoined,
    /\{\{\s*student_name\s*\}\}/,
    'prompt 必须写死 {{student_name}} 占位符 —— 真名不进 prompt 是 G-D 的实现前提'
  )
  const rendererFiles = walkDir(rendererDir, ['.ts', '.tsx', '.vue'])
  const rendererJoined = joined(rendererFiles)
  assert.ok(rendererJoined.includes('student_name'), '渲染层必须实现 {{student_name}} 就地替换（待 D 落盘）')
  assert.ok(
    rendererJoined.includes('STUDENT_FALLBACK_NAME'),
    '渲染层回落称呼必须复用共享常量 STUDENT_FALLBACK_NAME（不要在组件里另写一份）'
  )
  assert.match(
    rendererJoined,
    /\{\{/,
    '渲染层必须处理 {{…}} 残留（替换后仍出现未替换占位符 = 学生看见花括号）'
  )
})

/* ================================================================== *
 * G-E：短期情绪 TTL（真造时间）
 * ================================================================== */

interface EphemeralRow {
  key: string
  ts: number
  turnsSince: number
}

const HOUR_MS = 60 * 60 * 1000

/**
 * TTL 投影的**契约模型**：与 §0.6.5「3 轮会话或 24 小时，取先到」逐字对应。
 * A 的 SQLite 行为测试才是权威；这里锁的是**语义**（取先到 / 只约束情绪），
 * 让后端一次改动同时红在两处。
 */
function projectVisibleTags(rows: readonly EphemeralRow[]): EphemeralRow[] {
  const now = TTL_NOW
  return rows.filter((row) => {
    if (!EPHEMERAL_TAG_SET.has(row.key)) return true
    if (now - row.ts > EPHEMERAL_TTL_MS) return false
    if (row.turnsSince > EPHEMERAL_TTL_TURNS) return false
    return true
  })
}

const TTL_NOW = Date.UTC(2026, 8, 28, 12, 0, 0)

test('G-E TTL 真的过期：ts 拨到 25 小时前读不到；3 轮先到也读不到；TTL 不碰非情绪标签', () => {
  assert.deepEqual(sorted([...EPHEMERAL_TAGS]), ['emotion', 'intensity', 'trigger'], 'TTL 只覆盖这三个短期情绪标签')
  assert.ok(EPHEMERAL_TTL_MS > 0 && EPHEMERAL_TTL_TURNS > 0, 'TTL 必须是一个正数窗口')

  const fresh: EphemeralRow[] = [{ key: 'emotion', ts: TTL_NOW, turnsSince: 0 }]
  const stale: EphemeralRow[] = [{ key: 'emotion', ts: TTL_NOW - 25 * HOUR_MS, turnsSince: 0 }]
  const nearMiss: EphemeralRow[] = [{ key: 'emotion', ts: TTL_NOW - 23 * HOUR_MS, turnsSince: 0 }]
  const tooManyTurns: EphemeralRow[] = [{ key: 'emotion', ts: TTL_NOW - 1 * HOUR_MS, turnsSince: EPHEMERAL_TTL_TURNS + 1 }]
  const oldMastery: EphemeralRow[] = [{ key: 'mastery', ts: TTL_NOW - 240 * HOUR_MS, turnsSince: 99 }]

  assert.deepEqual(projectVisibleTags(fresh).map((row) => row.key), ['emotion'], '刚写入的情绪标签必须读得到')
  assert.deepEqual(projectVisibleTags(stale).map((row) => row.key), [], '超过 24 小时的情绪标签必须当作不存在')
  assert.deepEqual(projectVisibleTags(nearMiss).map((row) => row.key), ['emotion'], '23 小时（未过期）仍可见')
  assert.deepEqual(projectVisibleTags(tooManyTurns).map((row) => row.key), [], '超过 3 轮（取先到）必须当作不存在')
  assert.deepEqual(projectVisibleTags(oldMastery).map((row) => row.key), ['mastery'], 'TTL 只约束短期情绪，不是全表过期')
})

test('G-E TTL 跨语言一致：服务端同一组窗口常量，且「过期即不存在」写在存储层', () => {
  // ★ A 侧用秒（库里 ts 是 Unix 秒，不引第二种时间单位），TS 侧用毫秒 —— 名称与单位都不同，
  //   所以这里按**语义**比对（换算成毫秒），而不是比字符串。
  const msDef = findDefiningPy('EPHEMERAL_TTL_MS')
  const secondsDef = findDefiningPy('EPHEMERAL_TTL_SECONDS')
  assert.ok(msDef || secondsDef, '服务端必须声明 TTL 窗口常量（EPHEMERAL_TTL_MS 或 EPHEMERAL_TTL_SECONDS）—— 待 A 落盘')
  const pythonMs = msDef
    ? pyNumber(msDef.source, 'EPHEMERAL_TTL_MS')
    : pyNumber(secondsDef ? secondsDef.source : '', 'EPHEMERAL_TTL_SECONDS') * 1000
  assert.equal(pythonMs, EPHEMERAL_TTL_MS, 'TTL 窗口两边必须一致（服务端秒 × 1000 与 TS 毫秒比对）')
  const turnsDef = findDefiningPy('EPHEMERAL_TTL_TURNS')
  assert.ok(turnsDef, '服务端必须声明 EPHEMERAL_TTL_TURNS')
  assert.equal(pyNumber(turnsDef.source, 'EPHEMERAL_TTL_TURNS'), EPHEMERAL_TTL_TURNS, 'TTL 轮数两边必须一致')
  const tagsDef = findDefiningPy('EPHEMERAL_TAGS')
  assert.ok(tagsDef, '服务端必须声明 EPHEMERAL_TAGS（与 TS 同名同值）')
  assert.deepEqual(
    sorted(pyStringCollection(tagsDef.source, 'EPHEMERAL_TAGS')),
    sorted(EPHEMERAL_TAGS),
    '过期标签集合两边必须逐字一致'
  )
})

/* ================================================================== *
 * G-F / G-G：两道闸
 * ================================================================== */

test('G-F memory_switch 是闸不是信息：不在白名单，且服务端写入前必须读它', () => {
  assert.ok(!isLlmVisibleTag('memory_switch'), 'memory_switch 是闸，不得进白名单')
  assert.ok(IDENTITY_LOCAL_FORBIDDEN.has('memory_switch'), 'memory_switch 必须是身份表本地列')
  const serverJoined = joined(serverPyFiles())
  assert.ok(
    serverJoined.includes('memory_switch'),
    '服务端必须读 memory_switch 才能做到「关了就不写任何标签」—— 只在前端拦等于没关（待 A 落盘）'
  )
})

test('G-G parent_consent 默认同意（决策 B）且关掉即不外发画像；三道闸缺一不可', () => {
  assert.equal(PARENT_CONSENT_DEFAULT, true, '本轮裁决是 B：默认同意，家长可在设置页关')
  assert.ok(!isLlmVisibleTag('parent_consent'), 'parent_consent 是闸，不得进白名单')
  assert.ok(IDENTITY_LOCAL_FORBIDDEN.has('parent_consent'), 'parent_consent 必须是身份表本地列')
  const serverJoined = joined(serverPyFiles())
  assert.ok(
    serverJoined.includes('parent_consent'),
    '服务端必须读 parent_consent 才能做到「不同意不外发任何画像」（待 A 落盘）'
  )
  // 三道闸：① memory_switch=0 不写标签 ② parent_consent=0 不外发 ③ 真身份永不在白名单
  assert.ok(IDENTITY_LOCAL_FORBIDDEN.has('memory_switch'), '闸①：memory_switch 必须是闸')
  for (const field of REAL_IDENTITY_FIELDS) {
    assert.ok(IDENTITY_LOCAL_FORBIDDEN.has(field), '闸③：' + field + ' 必须永不可见（默认同意买的是不被拦，不是降边界）')
  }
})

/* ================================================================== *
 * 契约面（写入端点「无此参数」是 14 条禁做里数据类红线的落点）
 * ================================================================== */

test('契约面：五问写入端点恰好 question_id / answer_text / session_id 三个字段', () => {
  const contracts = requiredSource(contractsFile, 'A 落 onboarding 契约')
  assert.deepEqual(
    sorted(pyClassFields(contracts, 'OnboardingAnswerRequest')),
    ['answer_text', 'question_id', 'session_id'],
    '五问写入端点只能收这三样：任何画像维度参数都不该混进回答请求（多带字段直接 422）'
  )
  const tagsOut = pyClassFields(contracts, 'ProfileTagsOut')
  for (const field of ['tags', 'parent_consent', 'memory_switch']) {
    assert.ok(tagsOut.includes(field), 'ProfileTagsOut 缺字段 ' + field + '（契约书 §2.1）')
  }
  const tagOut = pyClassFields(contracts, 'ProfileTagOut')
  for (const field of ['key', 'value', 'confidence', 'source', 'ts', 'dimension', 'label']) {
    assert.ok(tagOut.includes(field), 'ProfileTagOut 缺字段 ' + field + '（label 由后端给，渲染层不写 kp slug）')
  }
})

/* ================================================================== *
 * G-H：14 条禁做清单，逐条一条断言
 * ================================================================== */

test('G-H-1 真实身份不进模型：四列身份 + 两道闸 + 流程状态都不可见', () => {
  for (const field of ['real_name', 'real_grade', 'school', 'class', 'parent_consent', 'memory_switch', 'onboarding_state']) {
    assert.ok(IDENTITY_LOCAL_FORBIDDEN.has(field), field + ' 必须在身份禁列集合里（G-B）')
    assert.ok(!isLlmVisibleTag(field), field + ' 不得出现在白名单（G-B + G-C）')
  }
})

function assertForbiddenTags(keys: readonly string[], label: string): void {
  for (const key of keys) {
    assert.ok(!isLlmVisibleTag(key), label + '：标签白名单不得含 ' + key)
  }
}

function assertForbiddenWriteParams(names: readonly string[], label: string): void {
  const contracts = requiredSource(contractsFile, 'A 落 onboarding 契约')
  const fields = [
    ...pyClassFields(contracts, 'OnboardingAnswerRequest'),
    ...pyClassFields(contracts, 'ProfileTagUpdateRequest')
  ]
  for (const name of names) {
    assert.ok(!fields.includes(name), label + '：写入端点不得有参数 ' + name)
  }
}

test('G-H-2 家庭收入：标签表无此 key，写入端点无此参数', () => {
  const words = ['income', 'family_income', 'household_income']
  assertForbiddenTags(words, '家庭收入')
  assertForbiddenWriteParams(words, '家庭收入')
})

test('G-H-3 父母职业：标签表无此 key，写入端点无此参数', () => {
  const words = ['parent_occupation', 'parents_occupation', 'parent_job']
  assertForbiddenTags(words, '父母职业')
  assertForbiddenWriteParams(words, '父母职业')
})

test('G-H-4 消费画像：标签表无此 key，写入端点无此参数', () => {
  const words = ['consumption', 'consumption_profile', 'spending', 'purchase_history']
  assertForbiddenTags(words, '消费画像')
  assertForbiddenWriteParams(words, '消费画像')
})

test('G-H-5 广告 ID：标签表无此 key', () => {
  assertForbiddenTags(['ad_id', 'advertising_id', 'idfa', 'gaid'], '广告 ID')
})

test('G-H-6 精确位置：标签表无此 key（学校/班级也在身份表本地，永不可见）', () => {
  assertForbiddenTags(['precise_location', 'gps', 'latitude', 'longitude', 'home_address'], '精确位置')
  for (const field of ['school', 'class']) {
    assert.ok(!isLlmVisibleTag(field), '精确到校/班的位置信息不得可见：' + field)
  }
})

test('G-H-7 跨站追踪：存储层无任何第三方标识字段', () => {
  const words = ['tracking_id', 'third_party_id', 'cookie_id', 'device_fingerprint', 'cross_site_id']
  assertForbiddenTags(words, '跨站追踪')
  const migrations = requiredSource(migrationsFile, 'A 需落迁移 v5')
  const columns: string[] = []
  for (const table of ['identity_local', 'profile_tags']) {
    columns.push(...ddlColumns(ddlBody(migrations, table)))
  }
  for (const word of words) {
    assert.ok(!columns.includes(word), '存储层不得有第三方标识列 ' + word)
  }
})

test('G-H-8 社交关系：标签表无此 key，写入端点无此参数', () => {
  const words = ['friends', 'friend_list', 'social_graph', 'contacts', 'classmates']
  assertForbiddenTags(words, '社交关系')
  assertForbiddenWriteParams(words, '社交关系')
})

test('G-H-9 公开排名：画像/引导端点只按单个 student_id 作用域，无跨学生聚合', () => {
  const files = walkDir(serverRoutesDir, ['.py'])
  assert.ok(files.length > 0, '找不到 server/app/routes')
  for (const file of files) {
    for (const path of routePaths(readSource(file))) {
      assert.ok(
        !/rank|leaderboard|leader_board|top_students|scoreboard/i.test(path),
        show(file) + ' 的 ' + path + ' 是跨学生排名类端点（禁做 #9）'
      )
      if (path.startsWith('/profile/') || path.startsWith('/onboarding/')) {
        assert.ok(
          path.includes('{student_id}'),
          show(file) + ' 的 ' + path + ' 必须按单个 student_id 作用域（画像端点不返回跨学生聚合）'
        )
      }
    }
  }
})

test('G-H-10 敏感属性推断：source 枚举封闭，inferred 只落在白名单的风格/情绪类', () => {
  const contracts = requiredSource(contractsFile, 'A 落 onboarding 契约')
  assert.match(
    contracts,
    /Literal\[\s*["']declared["']\s*,\s*["']observed["']\s*,\s*["']inferred["']\s*\]/,
    'source 必须是 declared | observed | inferred 的封闭枚举'
  )
  const inferredAllowed = [
    'emotion',
    'intensity',
    'trigger',
    'confidence',
    'explain_style',
    'output_length',
    'pace',
    'practice_type',
    'interest_topic',
    'tone',
    'encouragement_freq',
    'challenge_level',
    'error_type',
    'zpd_level'
  ]
  for (const key of inferredAllowed) {
    assert.ok(isLlmVisibleTag(key), 'inferred 允许的键必须都在白名单内：' + key)
    assert.ok(!IDENTITY_LOCAL_FORBIDDEN.has(key), 'inferred 绝不许碰身份列：' + key)
  }
  const serverJoined = joined(serverPyFiles())
  assert.ok(serverJoined.includes('inferred'), '服务端必须显式区分 inferred 来源（否则敏感属性推断没有落点）')
})

test('G-H-11 长期负面情绪档案：三个情绪标签必须带过期时间（G-E）', () => {
  assert.deepEqual(sorted([...EPHEMERAL_TAGS]), ['emotion', 'intensity', 'trigger'], '长期记住一个孩子的负面情绪是禁做 #11')
  assert.ok(EPHEMERAL_TTL_MS <= 24 * 60 * 60 * 1000, '情绪 TTL 不得超过 24 小时')
  assert.ok(EPHEMERAL_TTL_TURNS <= 3, '情绪 TTL 不得超过 3 轮会话（取先到）')
})

test('G-H-12 心理诊断：emotion 是有限枚举，不是临床词汇', () => {
  assert.deepEqual(
    sorted([...EMOTION_VALUES]),
    sorted(['happy', 'calm', 'confused', 'frustrated', 'angry']),
    '情绪取值域必须是这五个日常词'
  )
  assert.deepEqual(sorted([...EMOTION_VALUE_SET]), sorted([...EMOTION_VALUES]), '枚举与集合必须一致')
  assert.deepEqual(
    sorted(Object.keys(EMOTION_LABELS)),
    sorted([...EMOTION_VALUES]),
    '中文名必须逐一对应，不许有第二份映射'
  )
  const clinical = ['depression', 'depressed', 'anxiety', 'disorder', 'diagnosis', '抑郁', '焦虑症', '多动症', '自闭']
  const emotionText = [...EMOTION_VALUES, ...Object.values(EMOTION_LABELS)].join(' ')
  assertAbsent(emotionText, clinical, 'emotion 取值域', '禁做 #12：记录情绪不等于做心理诊断')
  assert.ok(INTENSITY_MIN === 0 && INTENSITY_MAX === 3, '强度是 0–3 小整数（不是 0–100 的分，避免分数文化）')
  const mirror = findPyCollection(['happy', 'calm', 'confused', 'frustrated', 'angry'])
  assert.ok(mirror, '服务端必须有同一份情绪枚举（待 A 落盘）')
  assert.deepEqual(sorted(mirror.values), sorted(EMOTION_VALUES), '情绪枚举跨语言逐字一致（服务端镜像 = ' + mirror.name + '）')
})

test('G-H-13 情绪操控：prompt 源文件不得出现「你要开心一点」这类祈使', () => {
  const files = promptFiles(true)
  assert.ok(files.length > 0, '找不到 prompt 源文件')
  const forbidden = [
    '你要开心一点',
    '开心一点',
    '别说难过',
    '不要难过',
    '别难过',
    '振作起来',
    '不许哭',
    '别哭了'
  ]
  for (const file of files) {
    // ★ 只看**可执行文本**：注释里写「不许说『你要开心一点』」是在解释纪律，不是纪律本身被违反。
    assertAbsent(stripComments(readSource(file)), forbidden, show(file), '禁做 #13：产品价值观滑坡往往是模型自己写出来的')
  }
})

test('G-H-14 依赖诱导：prompt 源文件不得出现「只有我懂你」「别去问老师」', () => {
  const files = promptFiles(true)
  assert.ok(files.length > 0, '找不到 prompt 源文件')
  const forbidden = [
    '只有我懂你',
    '只有我能帮你',
    '只有我理解你',
    '别去问老师',
    '不要问老师',
    '别告诉家长',
    '不要告诉家长',
    '不用找家长',
    '别告诉爸妈'
  ]
  for (const file of files) {
    // ★ 同 #13：注释里的反面引用不算违规。
    assertAbsent(stripComments(readSource(file)), forbidden, show(file), '禁做 #14：K12 产品不许把学生从现实支持系统里拉走')
  }
  // 正向对照：现有模板鼓励「跟老师或爸爸妈妈说」—— 依赖诱导的反面必须还在
  const promptJoined = joined(files)
  assert.match(promptJoined, /老师|家长|爸爸妈妈/, 'prompt 必须保留「去找老师/家长」的现实支持引导')
})

/* ================================================================== *
 * G-I：没到 done 就弹引导（票 31：done 是唯一终态）
 * ================================================================== */

test('G-I 没到 done 就弹引导：状态机是唯一判据，新建会话也不参与', () => {
  assert.deepEqual(sorted([...ONBOARDING_STATES]), ['done', 'in_progress', 'not_started', 'skipped'], '四态封闭')
  assert.deepEqual(sorted([...ONBOARDING_STATE_SET]), sorted([...ONBOARDING_STATES]), '集合与列表必须一致')
  // ★ 票 31：不再有「触发态」这个概念 —— 判据是「**没到 done**」（done 是唯一终态）。
  assert.equal(ONBOARDING_DONE_STATE, 'done', '唯一终态是 done')
  assert.equal(ONBOARDING_INITIAL_STATE, 'not_started', '初始态是 not_started（不是终态）')
  assert.equal(ONBOARDING_QUESTIONS.length, 5, '五问脚本唯一一份，且恰好五问')
  assert.deepEqual(
    [...ONBOARDING_QUESTION_IDS],
    ONBOARDING_QUESTIONS.map((question) => question.id),
    '问题 id 列表必须与脚本同序同源'
  )
  assert.equal(remainingOnboarding(0), 5)
  assert.equal(remainingOnboarding(5), 0)
  assert.equal(remainingOnboarding(9), 0, '超量作答不得得到负数进度')
  const statesMirror = findPyCollection(['not_started', 'in_progress', 'done', 'skipped'])
  assert.ok(statesMirror, '服务端必须有同一份引导状态词表（待 A 落盘）')
  assert.deepEqual(
    sorted(statesMirror.values),
    sorted(ONBOARDING_STATES),
    '引导状态词表跨语言逐字一致（服务端镜像 = ' + statesMirror.name + '）'
  )

  const files = walkDir(onboardingDir, ['.ts'])
  assert.ok(files.length > 0, show(onboardingDir) + ' 还不存在：B 需落引导模块（待 B 落盘）')
  const source = joined(files)
  assert.match(
    source,
    /ONBOARDING_DONE_STATE/,
    '弹不弹的判据必须复用共享常量 ONBOARDING_DONE_STATE，而不是自己写 done / not_started 字面量'
  )
  // ★ 票 31：跳过入口全链路删除 —— 引导模块里不许再有 skip 语义
  assert.ok(
    !/[Ss]kipOnboarding|recordSkip|onboardingSkip|onboarding:skip/.test(source),
    show(onboardingDir) + ' 里还有跳过语义：五问不允许跳过，未答完就续问直到 done'
  )
})

test('G-I q5 只收兴趣/动机：不再收集姓名/称呼（称呼归账号门），且不引心理侧写', () => {
  // 2026-10-01 换题：称呼已由账号门负责（建号 / 改名），五问里再问一次等于同一个门出现两遍；
  // q5 改为补「兴趣 / 动机」这一维（interest_topic）。
  const q5 = ONBOARDING_QUESTIONS.find((question) => question.id === 'q5')
  assert.ok(q5, 'q5 必须在五问脚本里')
  assert.deepEqual(q5.chips, [], 'q5 是自由作答（给选项等于替他把话说了）')
  assert.ok(
    q5.text.includes('喜欢') || q5.text.includes('兴趣'),
    'q5 必须落到兴趣 / 动机这一维：' + q5.text
  )
  // ★ 明确不收集姓名 / 称呼：那是账号门的职责
  assert.equal(
    ONBOARDING_QUESTIONS.some((question) => question.text.includes('称呼')),
    false,
    '五问都不再收集称呼（称呼走账号门）'
  )
  assert.equal(q5.text.includes('名字'), false, 'q5 不收集姓名')
  // 不引心理侧写：不出现性格 / 心理 / 情绪 / 家庭这类词
  for (const word of ['性格', '心理', '情绪', '家庭', '焦虑']) {
    assert.equal(q5.text.includes(word), false, 'q5 不得引向心理侧写：' + word)
  }
  // 五问互不重复：每个问句各问一个维度
  const texts = ONBOARDING_QUESTIONS.map((question) => question.text)
  assert.equal(new Set(texts).size, texts.length, '五个问句不得重复')
})

/* ================================================================== *
 * G-J：概括是 fire-and-forget
 * ================================================================== */

test('G-J 概括 fire-and-forget：经后台队列派发、超时包住、失败走降级', () => {
  const files = walkDir(onboardingDir, ['.ts'])
  assert.ok(files.length > 0, show(onboardingDir) + ' 还不存在：B 需落引导模块（待 B 落盘）')
  const source = joined(files)
  // ① 派发在后台队列里：公开方法 await 的是「收回答 + 落库」，概括只在队列里跑
  assert.match(
    source,
    /enqueue\(\s*\(\s*\)\s*=>\s*[\w.]*[Ss]ummar/,
    '概括必须经后台队列 enqueue 派发（fire-and-forget：永不 resolve 的桩也不许阻塞 UI）'
  )
  // ② 超时窗口：桩挂死时队列不能被无限占住
  assert.match(source, /ONBOARDING_SUMMARY_TIMEOUT_MS/, '概括必须有超时预算（建议 8s，§1.7）')
  assert.match(source, /Promise\.race\(/, '概括必须被超时包装（Promise.race + 定时器）')
  // ③ 失败降级可见（不静默），且注入面存在（概括是可替换的桩）
  assert.match(source, /degraded/, '概括失败必须走 degraded 并可见')
  assert.match(source, /[Ss]ummarizer/, '概括必须是可注入的实现（OnboardingSummarizer 接缝）')
})

/* ================================================================== *
 * G-K：作用域没有扩大
 * ================================================================== */

test('G-K learning_history.question 仍然每一行为空，五问回答只走 onboarding_qa', () => {
  const profile = requiredSource(join(serverRoutesDir, 'profile.py'), '现有学习记录写入路径')
  assert.match(
    profile,
    /\bquestion\s*=\s*""/,
    '学习记录写入必须继续显式写空串（onboarding 例外只覆盖五问自己的表）'
  )
  const migrations = requiredSource(migrationsFile, 'A 需落迁移 v5')
  assert.match(migrations, /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+onboarding_qa/, '五问回答必须落 onboarding_qa（待 A 落盘）')
  assert.ok(joined(serverPyFiles()).includes('onboarding_qa'), '服务端必须有真正写入 onboarding_qa 的路径')
  const onboardingFiles = walkDir(serverRoutesDir, ['.py']).filter((file) => file.includes('onboarding'))
  assert.ok(onboardingFiles.length > 0, show(serverRoutesDir) + ' 下还没有 onboarding 路由（待 A 落盘）')
  for (const file of onboardingFiles) {
    assert.ok(
      !/learning_history/.test(readSource(file)),
      show(file) + ' 不得写 learning_history（作用域没有扩大到普通学习记录）'
    )
  }
})

/* ================================================================== *
 * G-L：既有 G6c，不许红
 * ================================================================== */

test('G-L ChatSendRequest 字段集合仍然恰好 [text]（既有 G6c，不许红）', () => {
  const channels = requiredSource(channelsFile, 'ChatSendRequest 定义处')
  const fields = declaredFields(interfaceBody(channels, 'ChatSendRequest', channelsFile))
  assert.deepEqual(fields, ['text'], '学段/章节/学生 id/问题 id 都绝不混进对话请求（回答归属靠位置，走 onboarding:answer 独立通道）')
})

/* ------------------------------------------------------------------ *
 * 常驻：共享常量文件本身不能绕过守卫（防止有人改成 Set 字面量或空数组）
 * ------------------------------------------------------------------ */

test('常驻：共享白名单文件就是唯一真相（本文件不另立第二份 key 列表）', () => {
  const source = readSource(sharedTagsFile)
  assert.match(source, /export const LLM_VISIBLE_TAGS/, '白名单必须导出为具名常量')
  assert.match(source, /export const IDENTITY_LOCAL_FORBIDDEN/, '身份禁列必须导出为具名常量（G-B 的落点）')
  assert.match(source, /export const EPHEMERAL_TAGS/, '过期标签集合必须导出（G-E 的落点）')
  assert.match(source, /export const ONBOARDING_DONE_STATE/, '唯一终态必须导出（G-I 的落点）')
})

/* ------------------------------------------------------------------ *
 * G-M：持续画像迭代（Adaptive Profile Loop）的跨层红线（二期）
 *
 * ★ 与 G-A…G-L 同一条纪律：跨语言 / 跨进程的红线用**读源码文本**钉住，
 *   行为级验证在 desktop/tests/profile-refresh.test.ts（载荷与解析，纯函数）
 *   与 server/tests/test_profile_tags.py（分档写入的真实落库）。
 * ------------------------------------------------------------------ */

const profileRefreshDir = join(mainAgentDir, 'profile-refresh')
const payloadFile = join(profileRefreshDir, 'payload.ts')
const refreshFile = join(profileRefreshDir, 'refresh.ts')
const runtimeFile = join(mainAgentDir, 'runtime.ts')

test('G-M-0 持续迭代复用共享白名单：不另立第二份 key 列表', () => {
  const source = readSource(payloadFile)
  assert.match(
    source,
    /LLM_VISIBLE_TAGS/,
    '持续概括的可写 key 必须从 shared/profile-tags.ts 的白名单派生（算式可以重写，来源不能是第二份字面量列表）'
  )
  assert.doesNotMatch(
    source,
    /export const REFRESH_ALLOWED_KEYS[^=]*=\s*\[/,
    'REFRESH_ALLOWED_KEYS 不得写成字面量数组（那会成为白名单的第二份真相）'
  )
})

test('G-M-1 概括无权产出 declared：解析器显式拒它，prompt 三条纪律（禁心理/禁 PII/助手只是上下文）', () => {
  const source = readSource(payloadFile)
  // 解析侧：source 只认 observed / inferred（declared 落不进 out）
  assert.match(
    source,
    /source !== 'observed' && source !== 'inferred'/,
    '解析器必须把 source 收紧到 observed / inferred 两个取值（declared 是学生自述的专属来源）'
  )
  // prompt 侧：三条纪律必须在 system 文本里（G-M-7 与 §2.6）
  // ★ 2026-09-30 口径改写（红线最小移动）：原句含「性格」，现已按用户裁决放开
  //   「性格」一维（但带词表闸）—— 心理状态 / 家庭情况 / 智能水平三条仍禁。
  assert.match(
    source,
    /不要推断学生的心理状态、家庭情况或智能水平/,
    'prompt 必须保留「禁推断心理状态/家庭/智能水平」这三条（G-M-7 改写后口径）'
  )
  assert.match(source, /不要输出真名、学校、班级、手机号、身份证号/, 'prompt 必须保留「禁 PII」这条')
  assert.match(source, /助手的话不是学生的偏好/, 'prompt 必须明说「助手的话只是上下文」（§2.4 细节 3）')
})

test('G-M-7 红线最小移动（2026-09-30）：只放开了「性格」一维，且它是带闸的放开', () => {
  const payload = readSource(payloadFile)
  const onboarding = readSource(join(mainAgentDir, 'onboarding', 'summarize-llm.ts'))
  const shared = readSource(sharedTagsFile)

  // ① 三条禁令**原文仍在**（改写而不是删除 —— 这是「最小移动」的证据）
  assert.match(
    payload,
    /不要推断学生的心理状态、家庭情况或智能水平/,
    '持续概括 prompt 的三禁令原文必须仍在'
  )
  assert.match(
    onboarding,
    /不要推断学生的心理状态、家庭情况或智能水平/,
    '五问概括 prompt 的三禁令原文必须仍在'
  )
  // ①′ 旧口径（含「性格」的那一句）必须已不复存在 —— 否则「文本说禁、实现却放」自相矛盾
  assert.doesNotMatch(
    payload,
    /不要推断学生的性格/,
    '旧的「不要推断学生的性格」必须已改写（否则口径与实现不一致）'
  )

  // ② 放开是**带闸的**：两条解析路径都必须对 personality 做词表校验
  assert.match(
    payload,
    /key === 'personality' && !PERSONALITY_VALUE_SET\.has\(value\)/,
    '持续概括解析侧必须对 personality 做封闭词表闸'
  )
  assert.match(
    onboarding,
    /key === 'personality' && !PERSONALITY_VALUE_SET\.has\(value\)/,
    '五问解析侧也必须对 personality 做封闭词表闸'
  )

  // ③ 两个词表都要**真的拼进 prompt**（只 import 不拼 = 模型仍会写词表外的词）
  assert.match(payload, /PERSONALITY_VALUES\.join/, '持续概括 prompt 必须把性格词表拼给模型')
  assert.match(payload, /LEARNER_STYLE_VALUES\.join/, '持续概括 prompt 必须把学习类型词表拼给模型')
  assert.match(onboarding, /PERSONALITY_VALUES\.join/, '五问 prompt 必须把性格词表拼给模型')

  // ④ 词表本身不得含任何医学 / 心理学词汇 —— 这是红线移动那道闸的**实质**
  const clinicalWords = ['抑郁', '焦虑', '多动', '自闭', '障碍', '症', '倾向', '人格']
  for (const word of clinicalWords) {
    assert.ok(
      !PERSONALITY_VALUES.join('').includes(word),
      `性格词表不得含临床词汇「${word}」（它是本键唯一的取值域闸）`
    )
    assert.ok(
      !LEARNER_STYLE_VALUES.join('').includes(word),
      `学习类型词表不得含临床词汇「${word}」`
    )
  }

  // ⑤ 词表在 shared 真源里是封闭枚举（`as const`），渲染层 / 两处解析器都从它取
  assert.match(shared, /export const PERSONALITY_VALUES = \[/, '性格词表必须是具名常量')
  assert.match(shared, /export const LEARNER_STYLE_VALUES = \[/, '学习类型词表必须是具名常量')
  assert.ok(PERSONALITY_VALUE_SET.size === PERSONALITY_VALUES.length, '性格词表集合与列表必须一致')
  assert.ok(LEARNER_STYLE_VALUE_SET.size === LEARNER_STYLE_VALUES.length, '学习类型词表集合与列表必须一致')
})

test('G-M-4 助手文本也过脱敏：buildRefreshPayload 对 user 与 assistant 都调 sanitizeStudentText', () => {
  const source = readSource(payloadFile)
  assert.match(source, /import \{ sanitizeStudentText \}/, '必须复用 onboarding/sanitize.ts 的脱敏实现（不另写一份 PII 模式表）')
  // 两个字段都要过同一个函数（助手可能复述学生的话 —— 漏了就是侧漏）
  const studentCall = /sanitizeAndTruncate\(turn\.user\)/
  const assistantCall = /sanitizeAndTruncate\(turn\.assistant\)/
  assert.match(source, studentCall, '学生文本必须过脱敏 + 截断')
  assert.match(source, assistantCall, '★ 助手文本也必须过脱敏 + 截断（它可能复述了学生的话）')
})

test('G-M-5 载荷不含 displayName：构建函数的入参里根本没有它', () => {
  const source = readSource(payloadFile)
  const code = codeOnly(source)
  const inputInterface = /interface RefreshPayloadInput \{[\s\S]*?\n\}/.exec(code)
  assert.ok(inputInterface, '必须能定位 RefreshPayloadInput')
  assert.doesNotMatch(
    inputInterface![0],
    /displayName|realName/,
    '★ displayName 连入参都不许有（不传 = 结构上不可能出网，而不是靠调用方自觉）'
  )
  // 代码视图里也不许把真名类字段拼进载荷（注释里提到它正是为了说明「它不在这里」）
  assert.doesNotMatch(code, /displayName/, 'payload.ts 的代码里不该出现 displayName 这个名字')
})

test('G-M-6 轮次计数跨重启不归零：runtime 冷启动用服务端累计轮次校准', () => {
  const source = readSource(runtimeFile)
  assert.match(source, /calibrateTurn\(/, 'runtime 必须在冷启动用后端位标校准本地轮次（否则重启后计数归零）')
  assert.match(
    source,
    /cumulativeTurns/,
    '校准的输入必须是服务端的累计轮次（gradeExtension 已同步下来的那个量），不是本地每会话计数器'
  )
})

test('G-M-8 REFRESH_MAX_TAGS 是硬上限：解析器超出即停（不静默补位）', () => {
  const source = readSource(payloadFile)
  assert.match(source, /REFRESH_MAX_TAGS = \d+/, '上限必须是具名常量（可调，且测试可断言）')
  assert.match(
    source,
    /out\.length >= REFRESH_MAX_TAGS/,
    '解析循环必须在达到上限时 break（超出只取前 N 条）'
  )
  // 上限本身要合理：持续迭代是「小步修正」，比五问的 12 小得多
  const count = Number(/REFRESH_MAX_TAGS = (\d+)/.exec(source)?.[1] ?? '99')
  assert.ok(count <= 4, `REFRESH_MAX_TAGS 应是小步修正的量级（当前 ${count}，建议 4）`)
})

test('G-M-9 出网口收敛：持续概括不新开网络出口（复用 llmFetch / apiFetch 两个既有口）', () => {
  const source = readSource(refreshFile)
  const code = codeOnly(source)
  assert.doesNotMatch(
    code,
    /[^.\w]fetch\s*\(/,
    '★ refresh.ts 里不许出现裸 fetch(（主进程只有两个出网口：bridge/llm-completions 与 bridge/client）'
  )
  assert.match(code, /llmFetch/, '模型调用必须走既有出网口 llmFetch')
  assert.match(
    code,
    /defaultRequestJson/,
    'sidecar 调用必须走既有出口 defaultRequestJson（= bridge/client 的 apiFetch 包装）'
  )
})

test('G-M-10 runtime 的挂钩是 fire-and-forget，且只在成功路径上', () => {
  const source = readSource(runtimeFile)
  assert.match(
    source,
    /void observeProfileRefreshTurn\(/,
    '★ 挂钩必须用 void（fire-and-forget）—— 概括是一次 LLM 往返，绝不能拖慢本轮对话'
  )
  // 挂钩位置：在安全终审 await 之后（被撤回的轮次不该进画像证据）
  const hookIndex = source.indexOf('void observeProfileRefreshTurn(')
  const settledIndex = source.indexOf('await gate.settled()')
  assert.ok(settledIndex >= 0 && hookIndex > settledIndex, '挂钩必须在 gate.settled() 之后（撤回的那一轮不进画像证据）')
})

test('G-M-11 切学生 / 关会话必须清窗口（禁做 #9：绝不跨学生）', () => {
  const source = readSource(runtimeFile)
  assert.match(source, /clearTranscriptWindow\(/, 'runtime 必须在 dispose / 切学生时清掉环形窗口（B 同学不能继承 A 同学的对话）')
  assert.match(source, /resetTurnClock\(/, '轮次计数也必须一并清（否则会继承 A 同学的轮次而提前触发）')
})

