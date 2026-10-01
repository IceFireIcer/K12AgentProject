/**
 * 身份一致性（W1/W6）的不变量守卫：**写学段用的是「当前账号」，不是装配那一刻捕获的那个学生**。
 *
 * 真机事故：建号 / 切号后运行时尚停在旧学生，学段写进了上一个学生的库（界面以为初中、
 * 学生实际 senior，关卡树与取题学段对不上 → 练习页必然 404）。两处修法：
 *   · W6：手动写路径在**调用时**经 resolveStudentId 解析当前账号，不一致就拒绝写入；
 *         Q1 的学段走「学生资料更新」那条路（冷启动初始值，不写 explicit / 不进冷却）；
 *   · W1：建号与切号走同一条「整页重载」路；新建表单不再问学段（由五问 q1 定）。
 * 这些是跨进程装配时序的源码级不变量，按仓内守卫先例读文件断言。
 *
 * 跑法：node --test tests/identity-grade.test.ts
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath: string): string =>
  readFileSync(join(DESKTOP_ROOT, ...relativePath.split('/')), 'utf8').replace(/\r\n/g, '\n')

/**
 * 剥掉注释（手写状态机）：
 *   · 「这个文件里没有 X」这类**说明**不该被当成实现（本仓注释刻意引用旧写法）；
 *   · 同时避开「函数返回值里的 { 被当成函数体」这类花括号陷阱 —— 断言都打在紧接着签名
 *     的一段窗口上，不靠配对花括号定位。
 */
function stripComments(source: string): string {
  let out = ''
  let i = 0
  while (i < source.length) {
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2)
      i = end < 0 ? source.length : end + 2
      continue
    }
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4)
      i = end < 0 ? source.length : end + 3
      continue
    }
    if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i)
      i = end < 0 ? source.length : end
      continue
    }
    out += source[i]
    i += 1
  }
  return out
}

/** 紧接着某个签名之后的一段窗口（签名找不到就响亮失败，不静默扫全文）。 */
function windowAfter(source: string, signature: string, size: number): string {
  const at = source.indexOf(signature)
  assert.ok(at > 0, '找不到签名：' + signature)
  return source.slice(at, at + size)
}

/* ================================================================== *
 * W6：写路径调用时解析当前账号
 * ================================================================== */

test('★ 手写学段的身份在**调用时**解析：绝不沿用装配那一刻捕获的 id', () => {
  const runtime = read('src/main/agent/runtime.ts')
  assert.match(
    runtime,
    /resolveStudentId\?: \(\) => string/,
    'ChatRuntimeOptions 必须有「当前账号解析口」（生产 = handlers.ts 的 resolveActiveStudentId）'
  )

  const setGrade = windowAfter(runtime, 'async setGradeLevel(', 2200)
  assert.match(
    setGrade,
    /options\.resolveStudentId\?\.\(\)/,
    '写路径必须在**调用时**解析当前账号（装配时的 studentId 会过期）'
  )
  assert.match(setGrade, /postGradeOverride\(targetStudentId,/, '必须把调用时解析出来的 targetStudentId 交给写库')
  assert.doesNotMatch(
    setGrade,
    /postGradeOverride\(paths\.studentId/,
    '绝不能把装配时捕获的 paths.studentId 写进库 —— 那正是线上事故的成因'
  )
  assert.match(
    setGrade,
    /当前账号已经切换/,
    '解析出的账号与装配时不一致时，要拒绝写入并回一句可读中文（宁可报错，也不写别人名下）'
  )
})

test('★ Q1 的学段走「学生资料更新」那条路（冷启动初始值），不走手动 grade:set 语义', () => {
  const handlers = read('src/main/ipc/handlers.ts')
  const band = windowAfter(handlers, 'applyGradeBand: async (level)', 900)
  assert.match(
    band,
    /updateStudentGradeForAccount\(resolveActiveStudentId\(\), level\)/,
    'Q1 写学段时也要在**调用时**解析当前账号，落点是资料更新（不是手动覆盖）'
  )
  assert.doesNotMatch(
    band,
    /\.setGradeLevel\(/,
    'Q1 不得走手动 grade:set 语义 —— 那会写 source=explicit 并进 10 轮冷却（与冷启动初始值冲突）'
  )
  assert.match(band, /instance\.refreshGradeLevel\(\)/, '写完把服务端那份读回来（显示以服务端为准）')

  assert.match(
    handlers,
    /IPC\.gradeSet,[\s\S]{0,2000}?\.setGradeLevel\(level\)/,
    '学生手动设定仍走 setGradeLevel（唯一的人工写入口）'
  )

  const onboarding = read('src/main/ipc/handlers-data.ts')
  assert.match(onboarding, /applyGradeBand\?:/, '引导处理器要收 applyGradeBand 注入点')
  assert.match(
    onboarding,
    /applyGradeBand: options\.applyGradeBand/,
    '注入点必须透传给服务（不注入 = 学段不立即生效，但引导照常走完）'
  )

  const extract = read('src/main/agent/onboarding/extract.ts')
  assert.match(extract, /学段只有一个写入口/, 'q1 抽取侧不得另写 grade_band（注释即口径：两处写会漂）')
})

/* ================================================================== *
 * W1：建号 / 切号 / 表单
 * ================================================================== */

test('★ 建号与切号走同一条路：整页重载（运行时不会停在旧学生）', () => {
  const accounts = stripComments(read('src/renderer/src/stores/accounts.ts'))
  const create = windowAfter(accounts, 'async function createAccount(', 1800)
  assert.match(create, /return await switchAndReload\(target\)/, '建号后必须走切号那条路（整页重载）')
  assert.doesNotMatch(create, /\benter\(/, '建号绝不能走 enter：那条路有不重载的快捷键（注释说明不算实现）')

  const switchFn = windowAfter(accounts, 'async function switchAndReload(', 800)
  assert.match(switchFn, /reloadNow\(\)/, '切号 / 建号都要真正触发整页重载')

  const rename = windowAfter(accounts, 'async function renameAccount(', 1400)
  assert.match(rename, /if \(patch\.gradeLevel !== undefined\) reloadNow\(\)/, '改学段同样整页重载')
})

test('★ 新建表单不问学段（用既有中性默认值）；已有账号的学段照常展示', () => {
  const gate = stripComments(read('src/renderer/src/views/AccountGate.vue'))
  assert.doesNotMatch(gate, /account-gate-grade/, '新建表单不再有学段选择按钮')
  assert.doesNotMatch(gate, /draftGrade/, '不再有 draftGrade 状态（学段由五问 q1 定）')
  assert.match(
    gate,
    /accounts\.createAccount\(draftName\.value, DEFAULT_ACCOUNT_GRADE\)/,
    '建号时用既有的中性默认学段常量（不新造魔法值）'
  )
  assert.match(gate, /gradeLabelOf\(item\.gradeLevel\)/, '已有账号卡片上的学段展示要保留')

  const accounts = stripComments(read('src/renderer/src/stores/accounts.ts'))
  assert.match(
    accounts,
    /export const DEFAULT_ACCOUNT_GRADE: GradeLevel = 'junior'/,
    '默认学段取既有的中性冷启动档（服务端冷启动默认也是它）'
  )
})

test('★ 顶栏学段以服务端为准：显示值只来自服务端推送，冷启动默认值不上屏', () => {
  const chat = stripComments(read('src/renderer/src/stores/chat.ts'))
  const apply = windowAfter(chat, 'function applyGradeState(', 2600)
  assert.match(apply, /currentGrade\.value = next\.gradeLevel/, '显示值来自服务端推送的 gradeLevel')
  assert.match(
    apply,
    /const accepted: GradeOrigin\[\] = \['rules', 'llm', 'inferred', 'explicit'\]/,
    '只放行服务端能给的四种来源'
  )
  assert.doesNotMatch(apply, /'default'/, '冷启动默认值不得上屏（用默认值冒充判定结果是骗演示）')
  assert.match(chat, /void refreshGrade\(\)/, '进入 / 重载时要重新拉一次（换人后不沿用上一份显示）')
})
test('★ 镜像常量：渲染层 DEFAULT_ACCOUNT_GRADE 必须与主进程 DEFAULT_GRADE_LEVEL 同值', () => {
  // 渲染进程不能 import 主进程模块（会把主进程代码拖进包），所以这个默认值是**人工镜像**。
  // 这类镜像迟早会漂：改了其中一个、忘了另一个，建号落的中性学段就会与冷启动默认档不一致。
  const accounts = stripComments(read('src/renderer/src/stores/accounts.ts'))
  const grade = stripComments(read('src/main/agent/prompts/grade.ts'))
  const mirrorValue = /export const DEFAULT_ACCOUNT_GRADE: GradeLevel = '([a-z_]+)'/.exec(accounts)
  const authority = /export const DEFAULT_GRADE_LEVEL: GradeLevel = '([a-z_]+)'/.exec(grade)
  assert.ok(mirrorValue, 'stores/accounts.ts 里找不到 DEFAULT_ACCOUNT_GRADE 的字面量')
  assert.ok(authority, 'main/agent/prompts/grade.ts 里找不到 DEFAULT_GRADE_LEVEL 的字面量')
  assert.equal(
    mirrorValue[1],
    authority[1],
    '镜像常量漂了：渲染层的 DEFAULT_ACCOUNT_GRADE=' + String(mirrorValue[1]) +
      ' 与主进程的 DEFAULT_GRADE_LEVEL=' + String(authority[1]) +
      ' 必须同值 —— 改了其中一个别忘了另一个（渲染进程不能 import 主进程模块，只能人工同值）'
  )
})

