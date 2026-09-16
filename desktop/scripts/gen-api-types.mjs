#!/usr/bin/env node
/**
 * 从 `src/shared/openapi.json` 生成 `src/shared/api-types.ts`（**生成物，不手改**）。
 *
 * 防漂移链的第二段（执行文档 §6.1）：
 *
 *     server/app/contracts.py（唯一手写处）
 *       → server/scripts/export_openapi.py → src/shared/openapi.json
 *       → ★ 本脚本（openapi-typescript）→ src/shared/api-types.ts
 *       → npm run typecheck 报错 = 契约漂移
 *
 * 用法：
 *
 *     cd desktop
 *     npm run gen:api      # 生成 / 覆盖
 *     npm run check:api    # 字节比对，不一致退 1（架构守卫与 CI 用）
 *
 * 设计要点
 * --------
 * - **不手写任何接口**：TS 侧的类型全部由 pydantic 推导。手写一份就等于放弃这条链。
 * - **可复现**：openapi.json 已是规范序（导出脚本排过序），同一份输入必然生成同一份输出；
 *   `--check` 因此可以做字节比对。
 * - 生成物里额外断言 **6 事件词表**：它由 `contracts.py` 的 `IPC_EVENT_NAMES` 经
 *   OpenAPI 的 `IpcEventName` 传导过来，本脚本再加一道「6 个、不多不少、顺序一致」的校验，
 *   防止有人改词表改了后端却忘了前端（反之亦然）。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import openapiTS, { astToString } from 'openapi-typescript'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const inputPath = join(desktopRoot, 'src', 'shared', 'openapi.json')
const outputPath = join(desktopRoot, 'src', 'shared', 'api-types.ts')

/**
 * ★ 6 事件词表的冻结值（**不是第二来源，是守卫副本**）。
 *
 * 唯一权威是 `server/app/contracts.py` 的 `IPC_EVENT_NAMES`（它经 OpenAPI 传到这里）；
 * 前端对应 `src/shared/ipc-events.ts`。改词表必须三处同时改，
 * 所以这里对着 OpenAPI 里的实际值做等值断言 —— 不同步就当场失败，而不是生成一份漂移的类型。
 */
const FROZEN_EVENT_NAMES = ['delta', 'citation', 'payload', 'blocked', 'done', 'error']

const HEADER = `/**
 * ⚠️ 生成物，**不要手改**（generated, do not edit）。
 *
 * 来源：\`server/app/contracts.py\`（唯一手写契约处）
 *   → \`server/scripts/export_openapi.py\` → \`src/shared/openapi.json\`
 *   → \`desktop/scripts/gen-api-types.mjs\` → 本文件。
 *
 * 重新生成：\`cd desktop && npm run gen:api\`；校验是否漂移：\`npm run check:api\`。
 * 手改本文件会在下一次 \`--check\` 时被判定为漂移（并让 typecheck 失去意义）。
 *
 * ★ 6 事件词表（冻结，见 \`contracts.py\` 的 \`IPC_EVENT_NAMES\` 与 \`shared/ipc-events.ts\`）：
 *   ${FROZEN_EVENT_NAMES.join(' | ')}
 *
 * ⚠️ 本文件**不含**带标准答案的内部模型 \`QuizQuestion\`（§6.3 答案泄漏防护）：对外的题目
 * 一律是 \`QuizQuestionOut\`。本文件里唯一带 \`answer\` 的是 \`QuizGradeRequest\` —— 那是
 * **学生提交的作答**（请求方向），不是标准答案；导出脚本会断言它不被任何 response 引用。
 */
`

/** 读取 OpenAPI 文档；失败时给出可操作的提示。 */
function readOpenApiSchema() {
  if (!existsSync(inputPath)) {
    fail(
      `找不到 ${show(inputPath)}。\n` +
        `  请先在 server 侧生成：cd server && uv run python scripts/export_openapi.py`
    )
  }
  try {
    return JSON.parse(readFileSync(inputPath, 'utf8'))
  } catch (error) {
    fail(`解析 ${show(inputPath)} 失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

function show(file) {
  return relative(desktopRoot, file).replace(/\\/g, '/')
}

/**
 * 失败即退出。退出码与 `server/scripts/export_openapi.py` 对齐：
 * **1 = 检出漂移**（CI/守卫据此判定契约不一致），2 = 脚本自身出错（读不到文件等）。
 */
function fail(message, exitCode = 2) {
  console.error(`[gen-api-types] ✗ ${message}`)
  process.exit(exitCode)
}

/**
 * 校验 OpenAPI 里的 `IpcEventName` 枚举 == 冻结的 6 个事件名。
 * 它同时保证「TS 里的 `IpcEventName` 联合类型确实由词表推导而来」。
 */
function assertFrozenEventVocabulary(schema) {
  const enumValues = schema?.components?.schemas?.IpcEventName?.enum
  if (!Array.isArray(enumValues)) {
    fail(
      'OpenAPI 里没有 components.schemas.IpcEventName 枚举。\n' +
        '  它是 contracts.py 的 IPC_EVENT_NAMES 经 CONTRACT_ENUMS 导出的；请检查导出脚本是否漏了它。'
    )
  }
  if (JSON.stringify(enumValues) !== JSON.stringify(FROZEN_EVENT_NAMES)) {
    fail(
      `6 事件词表漂移：\n` +
        `  OpenAPI（后端）：${enumValues.join(', ')}\n` +
        `  冻结词表（前端）：${FROZEN_EVENT_NAMES.join(', ')}\n` +
        `  改词表需同步 contracts.py + shared/ipc-events.ts + 两侧守卫测试。`
    )
  }
  return enumValues
}

/** 生成完整的文件内容（纯函数，`--check` 与写入共用同一份结果）。 */
async function renderApiTypes(schema) {
  const ast = await openapiTS(schema)
  const generated = astToString(ast)
  return `${HEADER}\n${generated}`
}

async function main() {
  const checkOnly = process.argv.includes('--check')

  const schema = readOpenApiSchema()
  const eventNames = assertFrozenEventVocabulary(schema)
  const contents = await renderApiTypes(schema)

  if (checkOnly) {
    let existing
    try {
      existing = readFileSync(outputPath, 'utf8')
    } catch {
      fail(
        `生成物不存在：${show(outputPath)}\n` +
          `  请先跑：cd desktop && npm run gen:api`
      )
    }
    if (existing === contents) {
      console.log(
        `[gen-api-types] ✓ 前端类型无漂移：${show(outputPath)} 与 openapi.json 一致` +
          `（${eventNames.length} 个事件名已校验）`
      )
      return
    }
    fail(
      `前端类型已漂移：${show(outputPath)} 与 openapi.json 不一致。\n` +
        `  修复：cd desktop && npm run gen:api\n` +
        `  （若 api-types.ts 是手改的，请回滚手改 —— 它必须由生成链产出）`,
      1
    )
  }

  writeFileSync(outputPath, contents, 'utf8')
  console.log(
    `[gen-api-types] ✓ 已写出 ${show(outputPath)}（${contents.length} 字符 / ` +
      `${Object.keys(schema.paths ?? {}).length} 条路径 / ` +
      `${Object.keys(schema.components?.schemas ?? {}).length} 个 schema）`
  )
}

main().catch((error) => {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error))
})
