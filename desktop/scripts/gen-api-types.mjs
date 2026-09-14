/**
 * 契约 codegen：`shared/openapi.json` → `shared/api-types.ts`。
 *
 * （`项目执行文档.md` 6.1 的防漂移链路第二段）
 *
 *     server/app/models.py  ← 唯一手写处
 *       → server/scripts/export_openapi.py   （导出 openapi.json）
 *       → 本脚本                              （openapi-typescript 生成 api-types.ts）
 *       → npm run typecheck                   （漂移即报错）
 *
 * 用法：
 *   npm run gen:api           # 生成
 *   npm run check:api         # 只校验（生成结果与磁盘不一致则退出码 1）
 *
 * ⚠️ `api-types.ts` 是生成物，**不要手改**——改动会在下次生成时被覆盖。
 * 需要在类型上补东西（如 SSE 事件名联合类型）请改这里，或改后端契约。
 *
 * 实现说明：走 **编程式 API**（`import openapi-typescript`）而不是子进程调
 * `node_modules/.bin/openapi-typescript`——后者是 shell 包装脚本，用 `node` 执行会报
 * `Invalid or unexpected token`（Windows 上尤其明显）。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import openapiTS, { astToString } from 'openapi-typescript'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = dirname(HERE)
const REPO = dirname(DESKTOP)
const OPENAPI = join(DESKTOP, 'src', 'shared', 'openapi.json')
const OUT = join(DESKTOP, 'src', 'shared', 'api-types.ts')

const checkOnly = process.argv.includes('--check')

if (!existsSync(OPENAPI)) {
  console.error(`✗ 找不到 ${relative(REPO, OPENAPI)}`)
  console.error('  请先在 server/ 下运行：uv run python scripts/export_openapi.py')
  process.exit(2)
}

const schema = JSON.parse(readFileSync(OPENAPI, 'utf-8'))

// ---------------------------------------------------------------------------
// 从 schema 里抽出「契约里定的、但 openapi-typescript 不会生成」的信息
// ---------------------------------------------------------------------------

/** SSE 事件名联合类型：后端通过 `x-sse-events` 扩展声明（见 app/api/chat.py）。 */
function sseEventUnion() {
  const paths = schema.paths ?? {}
  for (const ops of Object.values(paths)) {
    for (const op of Object.values(ops)) {
      const names = op?.['x-sse-events']
      if (Array.isArray(names) && names.length > 0) {
        return names.map((n) => `'${n}'`).join(' | ')
      }
    }
  }
  // 后端没声明就是契约缺失——宁可失败，也不要生成一个假的空联合类型
  throw new Error('openapi.json 里没有 x-sse-events（后端契约未声明 SSE 事件名？）')
}

const header = `/**
 * ★ 本文件由 \`scripts/gen-api-types.mjs\` 从 \`shared/openapi.json\` 生成，**请勿手改**。
 *
 * 契约链路：server/app/models.py → export_openapi.py → openapi.json → 本文件 → npm run typecheck
 * 改契约的正确姿势：改 \`server/app/models.py\` → \`uv run python scripts/export_openapi.py\` → \`npm run gen:api\`
 */

`

// 直接把 schema 对象喂给 openapi-typescript（它也接受 URL / 文件路径）
const generated = astToString(await openapiTS(schema))

const sseTypes = `
// ---------------------------------------------------------------------------
// SSE 事件（契约 6.4）——事件名来自后端的 \`x-sse-events\`，不要在这里手抄
// ---------------------------------------------------------------------------

/** 6 种 SSE 事件名。 */
export type SseEventName = ${sseEventUnion()}

/** 事件名 → data 载荷类型的映射（前端解析器据此收窄类型）。 */
export interface SseEventPayloadMap {
  delta: components['schemas']['SseDeltaData']
  citation: components['schemas']['SseCitationData']
  payload: components['schemas']['SsePayloadData']
  blocked: components['schemas']['SseBlockedData']
  done: components['schemas']['SseDoneData']
  error: components['schemas']['SseErrorData']
}

/** 解析后的单个 SSE 事件（判别联合，\`event\` 一收窄就能拿到对应 data 类型）。 */
export type SseEvent = {
  [K in SseEventName]: { event: K; data: SseEventPayloadMap[K] }
}[SseEventName]

/** 便捷别名：SSE \`payload\` 事件里 \`kind\` 对应的三种 SubAgent 产物。 */
export type SubagentPayload =
  | components['schemas']['AnimationPayload']
  | components['schemas']['QuizPayload']
  | components['schemas']['CodeTemplate']
`

const output = header + generated + sseTypes

if (checkOnly) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf-8') : null
  if (current !== output) {
    console.error('✗ api-types.ts 与 openapi.json 不一致（契约漂移！）')
    console.error('  修复：npm run gen:api')
    process.exit(1)
  }
  console.log('✓ api-types.ts 与 openapi.json 一致')
  process.exit(0)
}

writeFileSync(OUT, output, 'utf-8')
const models = Object.keys(schema.components?.schemas ?? {}).length
console.log(`✓ 生成 ${relative(REPO, OUT)}（${models} 个模型）`)
