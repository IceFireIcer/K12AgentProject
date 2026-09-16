/**
 * sidecar 启动命令解析的单测（票 01）。
 *
 * 跑法：`npm test`（内部即 `node --test`，扫 tests 目录下的 .test.ts）。
 * ★ 直接 import `.ts` 源文件，靠 Node 内置的类型擦除，不引入任何测试框架或构建步骤。
 *   Node 会打印一条 MODULE_TYPELESS_PACKAGE_JSON 警告：这是**预期**的，不影响结果。
 *   本仓库**有意不设** `"type": "module"` —— 主进程/preload 保持 CJS 产物，
 *   这样 `out/preload/index.js` 的路径才是稳定的（票 03 接 Pi 时若确实需要 ESM，再整体裁决）。
 * ★ 本文件（以及被测文件）不得使用 TS parameter property（`constructor(private readonly x)`），
 *   Node 的类型擦除模式会直接报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  DEV_PORT,
  PACKAGED_SERVER_EXE,
  healthUrl,
  resolveSidecarCommand,
  type SidecarPaths
} from '../src/main/sidecar/protocol.ts'

const paths: SidecarPaths = {
  serverDir: 'E:\\repo\\server',
  resourcesPath: 'E:\\app\\resources',
  dataDir: 'C:\\Users\\tester\\AppData\\Roaming\\K12AI教学助手'
}

/** 统一成正斜杠，避免测试被平台分隔符影响。 */
function slash(value: string): string {
  return value.replace(/\\/g, '/')
}

test('dev 模式：用 uv run 起 server 目录下的 app.main', () => {
  const command = resolveSidecarCommand('dev', paths)

  assert.equal(command.command, 'uv', 'dev 态必须走 uv（本机裸 python 不可用）')
  assert.ok(
    command.args.join(' ').includes('-m app.main'),
    `dev 参数里必须有 "-m app.main"，实际为：${command.args.join(' ')}`
  )
  assert.ok(
    command.args.includes('--port') && command.args.includes(String(DEV_PORT)),
    `dev 参数里必须有 "--port ${DEV_PORT}"，实际为：${command.args.join(' ')}`
  )
  assert.ok(
    command.args.includes('--data-dir') && command.args.includes(paths.dataDir),
    `dev 参数里必须把 --data-dir 传给 userData，实际为：${command.args.join(' ')}`
  )
  assert.ok(
    command.args.includes('--host') && command.args.includes('127.0.0.1'),
    `sidecar 只允许绑定回环地址，实际为：${command.args.join(' ')}`
  )
  assert.equal(command.cwd, paths.serverDir, 'dev 的 cwd 必须指向仓库的 server/')
  assert.ok(
    slash(command.cwd).endsWith('/server'),
    `dev 的 cwd 必须以 server 结尾，实际为：${command.cwd}`
  )
})

test('packaged 模式：直接跑冻结产物 k12-agent-server.exe', () => {
  const command = resolveSidecarCommand('packaged', paths)

  const expectedExe = join(paths.resourcesPath, 'server', PACKAGED_SERVER_EXE)
  assert.equal(
    command.command,
    expectedExe,
    `packaged 必须指向 <resourcesPath>/server/${PACKAGED_SERVER_EXE}，实际为：${command.command}`
  )
  assert.ok(
    slash(command.command).endsWith(`/server/${PACKAGED_SERVER_EXE}`),
    `packaged 命令必须以 ${PACKAGED_SERVER_EXE} 结尾，实际为：${command.command}`
  )
  assert.equal(
    command.cwd,
    join(paths.resourcesPath, 'server'),
    'packaged 的 cwd 必须是 sidecar 产物所在目录'
  )
  assert.ok(
    command.args.includes('--port') && command.args.includes(String(DEV_PORT)),
    `packaged 参数里必须有 "--port ${DEV_PORT}"（票 02 改为 --port 0），实际为：${command.args.join(' ')}`
  )
  assert.ok(
    command.args.includes('--data-dir') && command.args.includes(paths.dataDir),
    `packaged 参数里必须有 --data-dir <userData>，实际为：${command.args.join(' ')}`
  )
  assert.ok(
    !command.args.includes('uv') && command.command !== 'uv',
    `packaged 态不得依赖 uv（终端用户没有 Python 环境），实际为：${command.command} ${command.args.join(' ')}`
  )
})

test('两种模式的端口都来自 DEV_PORT 常量，不散落硬编码', () => {
  assert.equal(DEV_PORT, 8756, '开发用固定端口按执行文档 §7.5 为 8756')
  assert.ok(resolveSidecarCommand('dev', paths).args.includes(String(DEV_PORT)))
  assert.ok(resolveSidecarCommand('packaged', paths).args.includes(String(DEV_PORT)))
})

test('healthUrl 只拼回环地址', () => {
  assert.equal(healthUrl(8756), 'http://127.0.0.1:8756/health')
  assert.equal(healthUrl(51234), 'http://127.0.0.1:51234/health')
})
