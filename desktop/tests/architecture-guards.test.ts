/**
 * 架构守卫测试（可执行的"规矩"，比写在文档里靠谱）。
 *
 * 这些约束一旦被破坏，往往要到很后面才炸（甚至只在打包后炸），所以用测试钉死：
 * 1. **禁用 `EventSource`** —— 只支持 GET、带不了 header → token 传不过去（S02 DoD 硬性项）。
 * 2. **生成物不得手改** —— `api-types.ts` 必须带着生成头，且与 `openapi.json` 一致。
 * 3. **Electron 侧不引入原生 DB / Node-only 依赖** —— 刻意的风险隔离（AGENTS §4）。
 * 4. **渲染层不得直接 import Node 模块**。
 * 5. **SDK / fetch 必须带 `X-Auth-Token`** —— 后端每个 `/api/*` 都要鉴权。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = dirname(HERE)
const REPO = dirname(DESKTOP)
const SRC = join(DESKTOP, 'src')

/** 递归收集源码文件（跳过生成物与依赖）。 */
function walk(dir: string, exts: string[]): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'out' || entry === 'dist') continue
      out.push(...walk(full, exts))
    } else if (exts.some((e) => entry.endsWith(e))) {
      out.push(full)
    }
  }
  return out
}

/**
 * 只去掉**注释**，保留字符串与模板字面量。
 *
 * ⚠️ 早期版本顺手把字符串也抹掉了，结果"检测裸 fetch `${base}/api/...`"的
 * 正则永远匹配不到（模板串已被抹成 `` ），守卫形同虚设——守卫本身也要能被
 * 变异测试证明有效（见下面的"测试自身也有效"用例）。
 */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const CODE_FILES = walk(SRC, ['.ts', '.vue', '.mts', '.js'])

describe('架构守卫 · 禁止 EventSource', () => {
  it('src/ 下没有任何 EventSource 用法（含实例化与类型引用）', () => {
    const offenders: string[] = []
    for (const file of CODE_FILES) {
      const code = stripComments(readFileSync(file, 'utf-8'))
      if (/\bnew\s+EventSource\b|\bEventSource\s*\(/.test(code)) {
        offenders.push(relative(REPO, file))
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `EventSource 只支持 GET 且无法携带 X-Auth-Token，必须用 fetch + ReadableStream：${offenders}`
    )
  })

  it('★ 测试自身也有效：能检出故意植入的 EventSource（防止正则失效导致假绿）', () => {
    const planted = 'const es = new EventSource(`/api/chat/stream?token=${t}`)'
    assert.ok(/\bnew\s+EventSource\b/.test(stripComments(planted)), '守卫正则失效了')
  })

  it('SSE 消费者确实用的是 fetch + ReadableStream', () => {
    const client = readFileSync(join(SRC, 'renderer', 'src', 'api', 'client.ts'), 'utf-8')
    assert.match(client, /fetch\(/, '必须用 fetch')
    assert.match(client, /getReader\(\)/, '必须用 ReadableStream reader')
    assert.ok(
      /new TextDecoder\('utf-8'\)/.test(client),
      '必须显式 utf-8 解码器'
    )
    assert.ok(
      /decode\([^)]*\{\s*stream:\s*true\s*\}/.test(client),
      '★ TextDecoder 必须带 { stream: true }，否则中文跨 chunk 会乱码'
    )
  })
})

describe('架构守卫 · 请求必须带鉴权头', () => {
  it('client.ts 统一注入 X-Auth-Token（且只有一处拼 header）', () => {
    const client = readFileSync(join(SRC, 'renderer', 'src', 'api', 'client.ts'), 'utf-8')
    assert.match(client, /'X-Auth-Token'/, '必须注入 X-Auth-Token')
    assert.match(client, /function authHeaders/, 'header 组装必须收敛到一个函数')
  })

  it('渲染层没有绕开 client.ts 直接裸 fetch 后端 /api', () => {
    const offenders: string[] = []
    for (const file of CODE_FILES) {
      const rel = relative(REPO, file)
      // client.ts 是唯一允许直接 fetch 后端的地方；Dashboard 里的 /api/ping 探针
      // 也走 fetch，所以只禁"别处新写的 /api 调用"。
      if (rel.endsWith(join('api', 'client.ts'))) continue
      const code = stripComments(readFileSync(file, 'utf-8'))
      if (/fetch\(\s*[`'"]\$\{?[^`'"]*\/api\//.test(code)) {
        offenders.push(rel)
      }
    }
    assert.deepEqual(offenders, [], `这些文件绕开了统一客户端直连 /api/*：${offenders}`)
  })
})

describe('架构守卫 · 契约生成物', () => {
  const OUT = join(SRC, 'shared', 'api-types.ts')

  it('api-types.ts 存在且带生成标记', () => {
    assert.ok(existsSync(OUT), 'api-types.ts 未生成：npm run gen:api')
    const head = readFileSync(OUT, 'utf-8').slice(0, 400)
    assert.match(head, /请勿手改|请勿手动修改/, '必须带"生成物勿手改"标记')
  })

  it('★ api-types.ts 与 openapi.json 一致（契约漂移检测）', () => {
    execFileSync(process.execPath, ['scripts/gen-api-types.mjs', '--check'], {
      cwd: DESKTOP,
      stdio: 'pipe'
    })
  })

  it('SSE 事件联合类型来自后端契约（6 种，不多不少）', () => {
    const text = readFileSync(OUT, 'utf-8')
    const match = text.match(/export type SseEventName = ([^\n]+)/)
    assert.ok(match, '未找到 SseEventName')
    const names = match[1].split('|').map((s) => s.trim().replace(/'/g, ''))
    assert.deepEqual(
      [...names].sort(),
      ['blocked', 'citation', 'delta', 'done', 'error', 'payload'],
      'SSE 事件名与契约不符'
    )
  })

  it('openapi.json 涵盖了全部契约模型（含非路由可达的 Payload）', () => {
    const schema = JSON.parse(readFileSync(join(SRC, 'shared', 'openapi.json'), 'utf-8'))
    const names = Object.keys(schema.components?.schemas ?? {})
    for (const required of [
      'QuizPayload',
      'AnimationPayload',
      'CodeTemplate',
      'CodeEvaluation',
      'Citation',
      'StudentProfile',
      'DepNode',
      'SseDeltaData',
      'GradeLevel'
    ]) {
      assert.ok(names.includes(required), `契约模型 ${required} 未出现在 openapi.json 中`)
    }
  })
})

describe('架构守卫 · sidecar 生命周期不变量', () => {
  const SIDECAR = join(SRC, 'main', 'sidecar.ts')
  const source = readFileSync(SIDECAR, 'utf-8')

  /**
   * 切出某个**方法声明**的方法体（含嵌套大括号）。
   *
   * ⚠️ 必须锚定在行首的声明形态上：早期版本用 `source.indexOf('stop(')`，
   * 结果命中文档注释里那句"不要写成 `await stop(); start()`"，
   * 于是断言检查的是注释而不是代码（假绿/假红都发生过）。
   */
  function methodBody(name: string): string {
    const decl = new RegExp(`^\\s*(?:private\\s+|public\\s+)?(?:async\\s+)?${name}\\s*\\(`, 'm')
    const match = decl.exec(source)
    assert.ok(match, `未找到方法声明 ${name}()`)
    const open = source.indexOf('{', match.index)
    let depth = 0
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth++
      else if (source[i] === '}') {
        depth--
        if (depth === 0) return source.slice(open, i + 1)
      }
    }
    throw new Error(`方法 ${name} 括号不闭合`)
  }

  it('★ start() 必须清除 shuttingDown（否则手动重启后崩溃将不再自愈）', () => {
    assert.ok(
      /this\.shuttingDown\s*=\s*false/.test(methodBody('start')),
      'start() 未重置 shuttingDown —— 手动重启一次后，后端崩溃将永久不再自动重启'
    )
  })

  it('★ restart() 不得通过 stop() 实现（stop 会置 shuttingDown=true）', () => {
    const body = methodBody('restart')
    assert.ok(
      !/this\.stop\(/.test(body),
      'restart() 里调用了 this.stop()：会把 shuttingDown 置 true，导致后续崩溃不再自动重启。' +
        '应调用 teardown() 再 start()。'
    )
  })

  it('stop() 置 shutdown 标志（应用退出语义）', () => {
    assert.ok(/this\.shuttingDown\s*=\s*true/.test(methodBody('stop')))
  })

  it('IPC 的 sidecar:restart 走 SidecarManager.restart()，不自己拼 stop+start', () => {
    const main = readFileSync(join(SRC, 'main', 'index.ts'), 'utf-8')
    const handler = main.slice(main.indexOf("'sidecar:restart'"))
    const chunk = handler.slice(0, handler.indexOf('})'))
    assert.ok(/sidecar\.restart\(\)/.test(chunk), 'IPC 应调用 sidecar.restart()')
    assert.ok(!/sidecar\.stop\(\)/.test(chunk), 'IPC 里不要自己拼 stop()+start()')
  })

  it('退出路径仍然保留（before-quit 会杀进程树）', () => {
    const main = readFileSync(join(SRC, 'main', 'index.ts'), 'utf-8')
    assert.match(main, /before-quit/, '必须有退出清理')
    assert.match(main, /sidecar\.stop\(\)/, '退出时必须 stop()')
  })
})

describe('架构守卫 · Electron 侧风险隔离', () => {
  const MAIN = join(SRC, 'main')

  it('main 进程不引入任何原生数据库模块（AGENTS §4 刻意约束）', () => {
    const banned = [/better-sqlite3/, /sqlite3/, /\bnode-sqlite\b/, /@libsql/, /duckdb/]
    const offenders: string[] = []
    for (const file of walk(MAIN, ['.ts'])) {
      const code = stripComments(readFileSync(file, 'utf-8'))
      for (const pattern of banned) {
        if (pattern.test(code)) offenders.push(`${relative(REPO, file)} → ${pattern}`)
      }
    }
    assert.deepEqual(offenders, [], 'Electron 侧不得引入原生 DB 模块（数据一律经 Python sidecar）')
  })

  it('package.json 依赖列表里没有原生 DB 模块', () => {
    const pkg = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf-8'))
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    for (const name of Object.keys(deps)) {
      assert.ok(
        !/sqlite|duckdb|better-sqlite3|leveldown|rocksdb/i.test(name),
        `依赖 ${name} 属于原生存储模块，违反风险隔离约束`
      )
    }
  })

  it('渲染层不 import Node 内置模块（保持纯浏览器语义）', () => {
    const rendererFiles = walk(join(SRC, 'renderer'), ['.ts', '.vue'])
    const nodeModules = ['node:fs', 'node:path', 'node:child_process', 'node:crypto', 'fs', 'child_process']
    const offenders: string[] = []
    for (const file of rendererFiles) {
      const code = readFileSync(file, 'utf-8')
      for (const mod of nodeModules) {
        if (new RegExp(`from\\s+['"]${mod}['"]`).test(code)) {
          offenders.push(`${relative(REPO, file)} → ${mod}`)
        }
      }
    }
    assert.deepEqual(offenders, [], `渲染层不得依赖 Node 模块（能力必须经 preload 白名单）：${offenders}`)
  })

  it('页面里没有硬编码的 512 维魔法数字（维度必须来自配置常量）', () => {
    // 允许出现在注释/文档里；这里只查代码里的字面量 512
    const offenders: string[] = []
    for (const file of walk(SRC, ['.ts', '.vue'])) {
      const code = stripComments(readFileSync(file, 'utf-8'))
      if (/\b512\b/.test(code)) offenders.push(relative(REPO, file))
    }
    assert.deepEqual(offenders, [], `嵌入维度 512 不得硬编码在前端：${offenders}`)
  })
})
