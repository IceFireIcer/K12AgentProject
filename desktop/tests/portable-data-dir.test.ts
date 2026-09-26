/**
 * P0-1 守卫：便携形态的**数据目录决策**（`src/main/portable.ts` 的纯函数）。
 *
 * 这一组盯住一次**真机实测到的数据丢失事故**：单文件便携版关掉再开，
 * 配置 / 学段 / 进度 / 会话全没了 —— 根因是启动器把应用解压到 `%TEMP%` 再运行，
 * 而旧实现把 `userData` 指到「exe 同级 `data/`」，那个 exe 就在临时目录里，
 * 启动器每次重新解压 = 每次清空。
 *
 * 判据（每一条都对应一个真实形态，不是构造出来的）：
 *   G-P0-1a 单文件便携（exe 在 `%TEMP%\<unpackDirName>`、拿不到 `PORTABLE_EXECUTABLE_DIR`）
 *           → **不改道**（否则就是事故本身）
 *   G-P0-1b 单文件便携、但启动器**给了**真实目录 → 改道到那个真实目录
 *   G-P0-1c zip 绿色形态（exe 落在用户解压的真实目录）→ 改道到 `<exeDir>/data`
 *   G-P0-1d 非便携 / 开发态 → 不改道
 *   G-P0-1e 显式 `K12_DATA_DIR` → 最高优先，与形态无关
 *   G-P0-1f Windows 路径大小写不敏感（临时目录识别不能假阴性）
 *
 * 跑法：`cd desktop && node --test tests/portable-data-dir.test.ts`（也在 `npm test` 里）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  decidePortableDataDir,
  PORTABLE_UNPACK_DIR_NAME,
  type PortableDataDirInput
} from '../src/main/portable.ts'

const TEMP = 'C:\\Users\\someone\\AppData\\Local\\Temp'
const DESKTOP_ROOT = join(fileURLToPath(import.meta.url), '..', '..')

/** 一个「单文件便携」输入：exe 在临时解压目录里、marker 在、启动器未给真实目录。 */
function singleFilePortable(overrides: Partial<PortableDataDirInput> = {}): PortableDataDirInput {
  return {
    isPackaged: true,
    exeDir: `${TEMP}\\${PORTABLE_UNPACK_DIR_NAME}`,
    tempDir: TEMP,
    portableExecutableDir: null,
    markerExists: true,
    forced: false,
    ...overrides
  }
}

test('G-P0-1a 单文件便携（exe 在 %TEMP%）绝不改道到临时目录', () => {
  const decision = decidePortableDataDir(singleFilePortable())
  assert.equal(decision.redirect, false, '往临时解压目录写数据就是数据丢失事故本身')
  assert.equal(decision.dataDir, null)
  assert.equal(decision.reason, 'temp-unpack-dir')
})

test('G-P0-1a2 marker 不在也不强制时，判定为「不是便携形态」', () => {
  const decision = decidePortableDataDir(singleFilePortable({ markerExists: false }))
  assert.equal(decision.redirect, false)
  assert.equal(decision.reason, 'not-portable')
})

test('G-P0-1a3 启动器未继承到 PORTABLE_EXECUTABLE_DIR 时，靠 exeDir 兜底识别临时目录', () => {
  // ★ 这正是实测遇到的形态：环境变量为 undefined，只能靠 exe 的落点判断。
  const decision = decidePortableDataDir(singleFilePortable({ portableExecutableDir: null }))
  assert.equal(decision.reason, 'temp-unpack-dir')
})

test('G-P0-1b 单文件便携但启动器给了真实目录 → 改道到真实目录', () => {
  const decision = decidePortableDataDir(
    singleFilePortable({ portableExecutableDir: 'D:\\K12Agent' })
  )
  assert.equal(decision.redirect, true)
  assert.equal(decision.dataDir, 'D:\\K12Agent\\data')
  assert.equal(decision.reason, 'persistent-real-dir')
})

test('G-P0-1c zip 绿色形态（真实解压目录）→ 数据跟着 exe 走', () => {
  const decision = decidePortableDataDir(
    singleFilePortable({ exeDir: 'E:\\Portable\\K12Agent', portableExecutableDir: null })
  )
  assert.equal(decision.redirect, true)
  assert.equal(decision.dataDir, 'E:\\Portable\\K12Agent\\data')
})

test('G-P0-1c2 强制开关（K12_PORTABLE=1）下，真实目录同样生效', () => {
  const decision = decidePortableDataDir(
    singleFilePortable({ exeDir: 'E:\\Portable\\K12Agent', markerExists: false, forced: true })
  )
  assert.equal(decision.redirect, true)
  assert.equal(decision.reason, 'persistent-real-dir')
})

test('G-P0-1d 非打包态（开发）不改道，否则污染源码目录', () => {
  const decision = decidePortableDataDir(
    singleFilePortable({ isPackaged: false, exeDir: 'E:\\repo\\desktop' })
  )
  assert.equal(decision.redirect, false)
  assert.equal(decision.reason, 'not-packaged')
})

test('G-P0-1d2 打包但非便携（nsis 安装版）不改道', () => {
  const decision = decidePortableDataDir(
    singleFilePortable({
      exeDir: 'C:\\Program Files\\K12Agent',
      markerExists: false,
      forced: false
    })
  )
  assert.equal(decision.redirect, false)
  assert.equal(decision.reason, 'not-portable')
})

test('G-P0-1e 显式 K12_DATA_DIR 优先级最高（与形态无关）', () => {
  const decision = decidePortableDataDir(
    singleFilePortable({ isPackaged: true, explicitDataDir: 'F:\\k12data' })
  )
  assert.equal(decision.redirect, true)
  assert.equal(decision.dataDir, 'F:\\k12data\\data')
  assert.equal(decision.reason, 'explicit-data-dir')
})

test('G-P0-1e2 非绝对的 K12_DATA_DIR 不采纳（退回形态判定，不当成路径用）', () => {
  const decision = decidePortableDataDir(
    singleFilePortable({ exeDir: 'E:\\Portable\\K12Agent', explicitDataDir: 'relative\\path' })
  )
  assert.equal(decision.reason, 'persistent-real-dir', '相对路径不采纳，应回到形态判定')
})

test('G-P0-1f Windows 大小写不敏感：%temp% 的不同写法都识别成临时目录', () => {
  const decision = decidePortableDataDir(
    singleFilePortable({
      exeDir: 'c:\\users\\SOMEONE\\appdata\\local\\temp\\k12-agent-desktop-portable',
      tempDir: 'C:\\Users\\someone\\AppData\\Local\\Temp'
    })
  )
  assert.equal(decision.reason, 'temp-unpack-dir', '大小写不同不能识别失败，否则数据又丢')
})

test('G-P0-1f2 目录名兜底：TEMP 被改到别处也认得出那个解压目录名', () => {
  const decision = decidePortableDataDir(
    singleFilePortable({
      exeDir: 'X:\\weird-temp-root\\k12-agent-desktop-portable',
      tempDir: 'C:\\Windows\\Temp'
    })
  )
  assert.equal(decision.reason, 'temp-unpack-dir')
})

test('G-P0-1g 同前缀但不同目录不算「在里面」（C:\\temp 与 C:\\temp2）', () => {
  const decision = decidePortableDataDir(
    singleFilePortable({ exeDir: 'C:\\temp2\\K12Agent', tempDir: 'C:\\temp' })
  )
  assert.equal(
    decision.reason,
    'persistent-real-dir',
    'C:\\temp2 不在 C:\\temp 之内，不能误判成临时目录而放弃改道'
  )
})

/* ------------------------------------------------------------------ *
 * 源码级守卫：真机事故的那段代码不许被写回来
 * ------------------------------------------------------------------ */

test('G-P0-1h index.ts 必须经 decidePortableDataDir 决策，不得直接 join(exeDir,"data")', () => {
  const source = readFileSync(join(DESKTOP_ROOT, 'src', 'main', 'index.ts'), 'utf8')
  // 去注释：注释里会引用旧写法，只有真正的代码才该被拦。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.ok(
    code.includes('decidePortableDataDir('),
    '便携数据目录必须走可单测的判定函数（否则又只能靠真机才发现丢数据）'
  )
  assert.ok(
    !/join\(\s*exeDir\s*,\s*['"]data['"]\s*\)/.test(code),
    "不得再出现 join(exeDir, 'data') —— 单文件形态下 exeDir 是临时解压目录，会把学生数据写进 %TEMP%"
  )
})

test('G-P0-1i unpackDirName 常量与 electron-builder.yml 一字不差', () => {
  const yml = readFileSync(join(DESKTOP_ROOT, 'electron-builder.yml'), 'utf8')
  const match = /unpackDirName:\s*(\S+)/.exec(yml)
  assert.ok(match, 'electron-builder.yml 必须有 portable.unpackDirName')
  assert.equal(
    match[1],
    PORTABLE_UNPACK_DIR_NAME,
    '两处名字不一致会让「临时目录识别」失效（按名字兜底那条分支就永远不命中）'
  )
})
