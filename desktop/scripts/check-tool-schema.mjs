/**
 * ★ Tool 参数一致性断言（执行文档 §6.3「防静默漂移」、AGENTS §4 契约纪律）。
 *
 *   `check-tool-schema.mjs` —— TypeBox（模型能填什么）⇄ pydantic（契约说什么是合法的）
 *
 * 为什么需要这一条链：Pi Tool 的参数用 **TypeBox `TSchema`** 声明，而契约的唯一来源是
 * **pydantic**（`server/app/contracts.py` → `openapi.json` → `api-types.ts`）。
 * 两边各自演化就会**静默漂移**：pydantic 改了字段名/类型，Tool 还在按老形状收参数，
 * 模型填进来的东西要么被后端拒（学生看到 error），要么被悄悄忽略（更糟）。
 *
 * 做法：**真的 import 主进程里那 4 个导出的 schema 常量**（不复制、不解析文本），
 *       逐字段与 `openapi.json` 的同名契约模型对比。
 *
 * ---------------------------------------------------------------------------
 * 对比规则（不是「大致一样就行」，是逐字段的硬比对）
 * ---------------------------------------------------------------------------
 *   共享字段（两边都有）：
 *     - 类型（含枚举取值集合）必须**完全一致**；
 *     - 必填性必须一致；
 *     - 两边都声明的边界（min/max/minLength/maxLength/minItems/maxItems/default）必须一致；
 *       **只有 Tool 侧声明的边界**属于「允许清单」条目（见下），逐条登记、逐条给理由。
 *   只有一边有的字段：必须逐条出现在 {@link ALLOWED_DIFFS} 里，并写明理由。
 *   任何**没有登记**的差异 = 漂移 → 退出码 1。
 *
 * ★★ 「允许清单」不是「把检查放松」：清单是**逐字段**的（字段名 + 差异种类 + 理由），
 *    没有登记的差异一律报错；清单里**已经失效**的条目也会报错（防止清单腐烂成一句空话）。
 *    这是执行文档 §6.3 要求的「TypeBox 与 pydantic 一致性断言」，不是「跳过」。
 *
 * 用法：node scripts/check-tool-schema.mjs     （`npm run check:tool-schema`）
 * 退出码：0 = 一致；1 = 有漂移（含清单失效）；2 = 脚本自身出错（读不到文件 / import 失败）。
 *
 * 只用 Node 内置能力（Node >= 22 的类型擦除 + `module.registerHooks`），不引入依赖。
 */

import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
/**
 * 契约生成物的位置。
 *
 * `K12_OPENAPI_PATH` 只用于**验证本脚本不是空转**：拿一份改坏的 openapi 副本跑一遍，
 * 看它是否真的报漂移（见报告里的负向验证）；日常跑法不需要这个变量。
 */
const OPENAPI_PATH = process.env.K12_OPENAPI_PATH
  ? resolve(process.env.K12_OPENAPI_PATH)
  : resolve(ROOT, 'src/shared/openapi.json')

/* ------------------------------------------------------------------ *
 * 0. 退出码约定（与 verify-ui.mjs 一致：0 通过 / 1 断言失败 / 2 脚本出错）
 * ------------------------------------------------------------------ */

function scriptError(message) {
  console.error(`[ERROR] ${message}`)
  process.exit(2)
}

/* ------------------------------------------------------------------ *
 * 1. 允许清单：**逐字段**登记的有意差异（每条都必须有理由）
 * ------------------------------------------------------------------ */

/**
 * 差异种类：
 *   `tool-only`        字段只在 Tool 参数里（模型能填，契约请求体里没有）
 *   `contract-only`    字段只在契约里（Tool 不暴露给模型）
 *   `required-tool`    Tool 侧必填、契约侧可选
 *   `required-contract`契约侧必填、Tool 侧可选
 *   `bounds-tool`      只有 Tool 侧声明了边界（更严的输入约束）
 *   `bounds-contract`  只有契约侧声明了边界
 */
const ALLOWED_DIFFS = [
  {
    tool: 'rag_search',
    field: 'gradeLevel',
    kind: 'required-contract',
    reason:
      '学段由系统判定，模型不能决定：契约里 RagSearchRequest.gradeLevel 必填（过滤写在 SQL 层），' +
      '而 Tool 参数里是可选的「复述」字段 —— 主进程注入的会话学段才是真值（extensions/rag-search.ts 头部第 2 条）。'
  },
  {
    tool: 'rag_search',
    field: 'kpId',
    kind: 'tool-only',
    reason: '知识点 id 是模型的检索提示（可选），不是 HTTP 请求体的字段：后端只用 query + gradeLevel。'
  },
  {
    tool: 'rag_search',
    field: 'allowCompat',
    kind: 'contract-only',
    reason: '向上兼容开关由 Python 默认值决定（契约默认 true），不让模型左右跨学段取用策略（§8.4）。'
  },
  {
    tool: 'rag_search',
    field: 'includeExpansion',
    kind: 'contract-only',
    reason: '依赖图扩展同上：由 Python 默认值决定（默认 true），模型填了也没用，索性不暴露。'
  },
  {
    tool: 'rag_search',
    field: 'query',
    kind: 'bounds-tool',
    reason: 'Tool 侧给模型加了 200 字上限（防止整句照抄当检索词）；契约层不限长。'
  },
  {
    tool: 'generate_quiz',
    field: 'gradeLevel',
    kind: 'tool-only',
    reason:
      '★ 学段由系统判定，模型不能设：契约的 QuizPayload 里**根本没有** gradeLevel（出题时学段由会话决定），' +
      'Tool 参数里那个可选字段只是让模型能「复述」当前学段（extensions/quiz.ts 的 resolveGradeLevel 以会话为准）。'
  },
  {
    tool: 'generate_quiz',
    field: 'count',
    kind: 'tool-only',
    reason: '出几道题是给模型的旋钮（1–10），契约的 QuizPayload 里没有它 —— 载荷只带出题结果。'
  },
  {
    tool: 'generate_quiz',
    field: 'kpId',
    kind: 'bounds-tool',
    reason: 'Tool 侧限长 64（知识点 id 的实际长度），契约层不限长。'
  },
  {
    tool: 'generate_quiz',
    field: 'source',
    kind: 'contract-only',
    reason: '题库 / 生成由 Python 与 Extension 判定后填（`source` 是产出字段），不是模型的入参。'
  },
  {
    tool: 'generate_quiz',
    field: 'questions',
    kind: 'contract-only',
    reason: '题目由题库或模型生成后填进载荷；模型不能直接把题目塞进参数（否则可绕过答案防线的投影）。'
  },
  {
    tool: 'generate_variants',
    field: 'gradeLevel',
    kind: 'tool-only',
    reason: '同 generate_quiz：学段真值来自会话，契约载荷里没有这个字段，Tool 参数只作复述。'
  },
  {
    tool: 'generate_variants',
    field: 'count',
    kind: 'tool-only',
    reason: '同 generate_quiz：数量是模型的旋钮，不是载荷字段。'
  },
  {
    tool: 'generate_variants',
    field: 'kpId',
    kind: 'bounds-tool',
    reason: '同 generate_quiz：Tool 侧限长 64。'
  },
  {
    tool: 'generate_variants',
    field: 'source',
    kind: 'contract-only',
    reason: '同 generate_quiz：`source` 是产出字段。'
  },
  {
    tool: 'generate_variants',
    field: 'questions',
    kind: 'contract-only',
    reason: '同 generate_quiz：题目是产出，不是入参。'
  },
  {
    tool: 'submit_quiz',
    field: 'studentId',
    kind: 'contract-only',
    reason:
      '★ 安全边界：学生 id 由主进程注入（`currentAgentSession()`），**绝不允许模型填** —— ' +
      '一旦成为模型参数，就能构造出「批改并写进别人档案」的调用。'
  },
  {
    tool: 'submit_quiz',
    field: 'sessionId',
    kind: 'contract-only',
    reason: '同上：会话 id 由主进程注入，模型不该也不能指定写进哪个会话。'
  },
  {
    tool: 'submit_quiz',
    field: 'qid',
    kind: 'bounds-tool',
    reason: 'Tool 侧限长 64 且非空（题目编号的实际形状），契约层不限长。'
  },
  {
    tool: 'submit_quiz',
    field: 'answer',
    kind: 'bounds-tool',
    reason:
      'Tool 侧规定多空作答每个分支的合理上限（非空字符串 + 最多 8 个空的数组），' +
      '契约层的 answer 只区分 string / string[]（不限长，因为判分只按 qid 查库）。'
  }
]

/* ------------------------------------------------------------------ *
 * 2. 工具清单：导出名 → 契约模型（**一个都不能少**）
 * ------------------------------------------------------------------ */

const TOOLS = [
  {
    tool: 'rag_search',
    exportName: 'RagSearchParams',
    module: 'src/main/agent/extensions/rag-search.ts',
    /** 契约侧对照物：Tool 实际发出去的那个请求体。 */
    contract: 'RagSearchRequest',
    contractNote: 'POST /api/rag/search 的请求体（Tool 真正发出的形状）'
  },
  {
    tool: 'generate_quiz',
    exportName: 'GenerateQuizParams',
    module: 'src/main/agent/extensions/quiz.ts',
    /** 契约侧对照物：Tool 产出并下发给前端的载荷（`kpId` 是两边共用的那个字段）。 */
    contract: 'QuizPayload',
    contractNote: '出题载荷（Tool 的产出形态）'
  },
  {
    tool: 'submit_quiz',
    exportName: 'SubmitQuizParams',
    module: 'src/main/agent/extensions/quiz.ts',
    contract: 'QuizGradeRequest',
    contractNote: 'POST /api/quiz/grade 的请求体（Tool 真正发出的形状）'
  },
  {
    tool: 'generate_variants',
    exportName: 'GenerateVariantsParams',
    module: 'src/main/agent/extensions/quiz.ts',
    contract: 'QuizPayload',
    contractNote: '出题载荷（变式题与出题同一形态）'
  }
]

/** 必须出现在工具清单里的 Tool 名（新增 Tool 时要同步加进来，缺一个就是漂移）。 */
const EXPECTED_TOOLS = ['rag_search', 'generate_quiz', 'submit_quiz', 'generate_variants']

/** 逐个字段比对的边界键（`description` / `title` 是散文，不参与比对）。 */
const BOUND_KEYS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'default']

/* ------------------------------------------------------------------ *
 * 3. 真 import 那 4 个 schema（借 Node 的类型擦除 + 一个补扩展名/别名的 hook）
 * ------------------------------------------------------------------ */

registerHooks({
  resolve(specifier, context, nextResolve) {
    // `@shared/*` 是 tsconfig / vite 的别名，Node 不认 —— 在这里映射回真实路径
    if (specifier.startsWith('@shared/')) {
      const target = resolve(ROOT, 'src/shared', specifier.slice('@shared/'.length))
      for (const candidate of [`${target}.ts`, target]) {
        if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true }
      }
    }
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      // 主进程源码按 Vite 的口味写相对导入（可能不带扩展名），这里补 `.ts`
      if (specifier.startsWith('.') && context.parentURL) {
        for (const suffix of ['.ts', '/index.ts']) {
          const candidate = new URL(specifier + suffix, context.parentURL)
          if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
        }
      }
      throw error
    }
  }
})

/** loadSchema(module, exportName)：import 真实模块并取那个导出的常量。 */
async function loadSchema(modulePath, exportName) {
  const absolute = resolve(ROOT, modulePath)
  if (!existsSync(absolute)) scriptError(`找不到模块：${modulePath}（期望在 ${absolute}）`)
  let loaded
  try {
    loaded = await import(pathToFileURL(absolute).href)
  } catch (error) {
    scriptError(`import ${modulePath} 失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const schema = loaded[exportName]
  if (typeof schema !== 'object' || schema === null) {
    scriptError(`${modulePath} 没有导出可用的 ${exportName}（Tool 参数的 TypeBox schema 必须导出，才能被本脚本断言）`)
  }
  return schema
}

/* ------------------------------------------------------------------ *
 * 4. JSON Schema（TypeBox 与 OpenAPI 都是它的方言）→ 可比的形状
 * ------------------------------------------------------------------ */

/** 类型描述：数组 → `array<inner>`，联合 → `(a|b)`，枚举 → `enum(…)`。 */
function typeOf(schema) {
  if (typeof schema !== 'object' || schema === null) return '?'
  const union = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : null
  if (union) {
    const members = [...new Set(union.map(typeOf))].sort()
    return members.length === 1 ? members[0] : `(${members.join('|')})`
  }
  if (schema.type === 'array') return `array<${typeOf(schema.items)}>`
  if (schema.type === 'integer') return 'integer'
  if (schema.type === 'number') return 'number'
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.split('/').pop()
    return `ref<${name}>`
  }
  if (typeof schema.const === 'string') return 'string'
  if (typeof schema.const === 'number') return 'number'
  if (typeof schema.const === 'boolean') return 'boolean'
  if (typeof schema.type === 'string') return schema.type
  return '?'
}

/**
 * 枚举取值集合（认不出返回 `null`）。
 *
 * 覆盖两种写法：`{enum:[…]}`（pydantic/OpenAPI）与 `{anyOf:[{const:…},…]}`（TypeBox 的 Union(Literal)）。
 * **取值集合必须完全一致** —— 这就是「四学段字面量不能各写一份」的机器断言。
 */
function enumValues(schema) {
  if (typeof schema !== 'object' || schema === null) return null
  if (Array.isArray(schema.enum)) return [...schema.enum].map(String).sort()
  const union = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : null
  if (union && union.every((member) => typeof member === 'object' && member !== null && 'const' in member)) {
    return union.map((member) => String(member.const)).sort()
  }
  return null
}

/** 边界值（只取两边都可能有意义的键）。 */
function boundsOf(schema) {
  const bounds = {}
  for (const key of BOUND_KEYS) {
    if (typeof schema === 'object' && schema !== null && schema[key] !== undefined) bounds[key] = schema[key]
  }
  return bounds
}

const MAX_CHARS = 200
function clip(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > MAX_CHARS ? `${flat.slice(0, MAX_CHARS)}…` : flat
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 联合类型的成员（不是联合就返回 `null`）。 */
function unionMembers(schema) {
  if (typeof schema !== 'object' || schema === null) return null
  if (Array.isArray(schema.anyOf)) return schema.anyOf
  if (Array.isArray(schema.oneOf)) return schema.oneOf
  return null
}

/**
 * 递归比对联合类型**各分支**的边界。
 *
 * 为什么单独做这一层：`answer` 在两边都是 `string | string[]`，字段一级没有边界键，
 * 只看第一层的话「Tool 给数组分支加了 minItems/maxItems」不会被发现。
 * 分支按类型名排序后一一配对（类型本身已在 compareTool 里断言过一致）。
 */
function compareUnionMemberBounds(entry, field, toolSchema, contractSchema, path, depth) {
  if (depth > 2) return
  const toolMembers = unionMembers(toolSchema)
  const contractMembers = unionMembers(contractSchema)
  if (!toolMembers || !contractMembers) return
  if (toolMembers.length !== contractMembers.length) {
    failures.push(`${entry.tool}.${field}：联合类型的分支数量不一致（Tool=${toolMembers.length}，契约=${contractMembers.length}）`)
    console.log(`      ✗ [漂移] ${path}：联合类型的分支数量不一致（Tool=${toolMembers.length}，契约=${contractMembers.length}）`)
    return
  }

  const byType = (a, b) => typeOf(a).localeCompare(typeOf(b))
  const sortedTool = [...toolMembers].sort(byType)
  const sortedContract = [...contractMembers].sort(byType)

  for (let index = 0; index < sortedTool.length; index += 1) {
    const memberPath = `${path}<${typeOf(sortedTool[index])}>`
    const toolBounds = boundsOf(sortedTool[index])
    const contractBounds = boundsOf(sortedContract[index])
    for (const key of [...new Set([...Object.keys(toolBounds), ...Object.keys(contractBounds)])].sort()) {
      const inTool = key in toolBounds
      const inContract = key in contractBounds
      const toolValue = toolBounds[key]
      const contractValue = contractBounds[key]
      if (inTool && inContract) {
        if (!sameJson(toolValue, contractValue)) {
          failures.push(`${entry.tool}.${memberPath}.${key}：边界值不一致（Tool=${toolValue}，契约=${contractValue}）`)
          console.log(`      ✗ [漂移] ${memberPath}.${key}：边界值不一致（Tool=${toolValue}，契约=${contractValue}）`)
        }
        continue
      }
      const kind = inTool ? 'bounds-tool' : 'bounds-contract'
      diff(
        entry.tool,
        field,
        kind,
        `${key} 只有${inTool ? 'Tool' : '契约'}侧声明（${inTool ? toolValue : contractValue}，位于 ${memberPath}）`
      )
    }
    compareUnionMemberBounds(entry, field, sortedTool[index], sortedContract[index], memberPath, depth + 1)
  }
}

/* ------------------------------------------------------------------ *
 * 5. 比对
 * ------------------------------------------------------------------ */

const failures = []
const warnings = []
/** 已被用到的允许清单条目（用来发现「清单腐烂」）。 */
const usedAllowances = new Set()

function allowanceFor(tool, field, kind) {
  const index = ALLOWED_DIFFS.findIndex(
    (entry) => entry.tool === tool && entry.field === field && entry.kind === kind
  )
  if (index === -1) return null
  usedAllowances.add(index)
  return ALLOWED_DIFFS[index]
}

/**
 * 报一个差异：允许清单里登记过就放过（并计数），没登记就是漂移。
 *
 * `detail` 是一句人能读懂的话（报告里直接打印，不要求读者去翻源码）。
 */
function diff(tool, field, kind, detail) {
  const allowed = allowanceFor(tool, field, kind)
  if (allowed) {
    console.log(`      · [已登记] ${field}（${kind}）：${detail}`)
    return
  }
  const line = `${tool}.${field}（${kind}）：${detail}`
  failures.push(line)
  console.log(`      ✗ [漂移] ${line}`)
}

function compareTool(entry, toolSchema, contractSchema) {
  console.log(`\n── ${entry.tool} / ${entry.exportName} ⇄ ${entry.contract}（${entry.contractNote}）`)

  if (toolSchema.type !== 'object' || typeof toolSchema.properties !== 'object' || toolSchema.properties === null) {
    failures.push(`${entry.tool}.${entry.exportName} 不是 TypeBox Object（Tool 参数必须是对象）`)
    console.log('      ✗ [漂移] Tool 参数 schema 不是对象类型')
    return
  }

  const toolProps = toolSchema.properties
  const toolRequired = new Set(Array.isArray(toolSchema.required) ? toolSchema.required : [])
  const contractProps = typeof contractSchema.properties === 'object' && contractSchema.properties !== null ? contractSchema.properties : {}
  const contractRequired = new Set(Array.isArray(contractSchema.required) ? contractSchema.required : [])

  // ① 共享字段：类型 / 枚举 / 必填性 / 边界
  const shared = Object.keys(toolProps).filter((name) => name in contractProps)
  if (shared.length === 0) {
    failures.push(`${entry.tool}：与 ${entry.contract} 没有一个同名字段（大概率是契约改名了）`)
    console.log(`      ✗ [漂移] 与契约模型 ${entry.contract} 没有同名字段`)
  }

  for (const field of shared) {
    const toolField = toolProps[field]
    const contractField = contractProps[field]

    const toolEnum = enumValues(toolField)
    const contractEnum = enumValues(contractField)
    const toolType = typeOf(toolField)
    const contractType = typeOf(contractField)

    if (toolEnum !== null || contractEnum !== null) {
      if (toolEnum === null || contractEnum === null) {
        diff(entry.tool, field, 'enum', `一边是枚举、另一边是自由取值（Tool=${toolEnum ? toolEnum.join('/') : toolType}，契约=${contractEnum ? contractEnum.join('/') : contractType}）`)
      } else if (!sameJson(toolEnum, contractEnum)) {
        diff(entry.tool, field, 'enum', `枚举取值不一致（Tool=${toolEnum.join('/')}，契约=${contractEnum.join('/')}）`)
      } else {
        console.log(`      ✓ ${field}：枚举一致（${toolEnum.join('/')}）`)
      }
    } else if (toolType !== contractType) {
      // `integer` 与 `number` 是不同方言：TypeBox 的 Type.Integer 对应契约的 integer
      failures.push(`${entry.tool}.${field}：类型不一致（Tool=${toolType}，契约=${contractType}）`)
      console.log(`      ✗ [漂移] ${field}：类型不一致（Tool=${toolType}，契约=${contractType}）`)
    } else {
      console.log(`      ✓ ${field}：类型一致（${toolType}）`)
    }

    const toolMust = toolRequired.has(field)
    const contractMust = contractRequired.has(field)
    if (toolMust !== contractMust) {
      const kind = toolMust ? 'required-tool' : 'required-contract'
      diff(entry.tool, field, kind, `必填性不一致（Tool ${toolMust ? '必填' : '可选'} / 契约 ${contractMust ? '必填' : '可选'}）`)
    }

    const toolBounds = boundsOf(toolField)
    const contractBounds = boundsOf(contractField)
    const boundKeys = [...new Set([...Object.keys(toolBounds), ...Object.keys(contractBounds)])].sort()
    for (const key of boundKeys) {
      const inTool = key in toolBounds
      const inContract = key in contractBounds
      if (inTool && inContract) {
        if (!sameJson(toolBounds[key], contractBounds[key])) {
          failures.push(`${entry.tool}.${field}.${key}：边界值不一致（Tool=${toolBounds[key]}，契约=${contractBounds[key]}）`)
          console.log(`      ✗ [漂移] ${field}.${key}：边界值不一致（Tool=${toolBounds[key]}，契约=${contractBounds[key]}）`)
        }
        continue
      }
      const kind = inTool ? 'bounds-tool' : 'bounds-contract'
      diff(entry.tool, field, kind, `${key} 只有${inTool ? 'Tool' : '契约'}侧声明（${inTool ? toolBounds[key] : contractBounds[key]}）`)
    }

    // 联合类型（`answer: string | string[]`）的**每个分支**也要比边界：
    // 只比字段一级的话，「Tool 给数组分支加了 maxItems」这种差异会看不见。
    compareUnionMemberBounds(entry, field, toolField, contractField, field, 0)
  }

  // ② 只有一边有的字段：逐条登记
  for (const field of Object.keys(toolProps)) {
    if (field in contractProps) continue
    diff(entry.tool, field, 'tool-only', `Tool 参数里有、契约模型 ${entry.contract} 里没有`)
  }
  for (const field of Object.keys(contractProps)) {
    if (field in toolProps) continue
    const requiredText = contractRequired.has(field) ? '必填' : '可选'
    diff(entry.tool, field, 'contract-only', `契约模型 ${entry.contract} 里有（${requiredText}）、Tool 参数里没有`)
  }
}

/* ------------------------------------------------------------------ *
 * 6. 主流程
 * ------------------------------------------------------------------ */

if (!existsSync(OPENAPI_PATH)) {
  scriptError(`读不到契约生成物：${OPENAPI_PATH}\n先跑 \`npm run gen:api\`（或确认 server 侧的 OpenAPI 导出成功）。`)
}

let spec
try {
  spec = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8'))
} catch (error) {
  scriptError(`openapi.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
}

const schemas = spec?.components?.schemas
if (typeof schemas !== 'object' || schemas === null) {
  scriptError('openapi.json 里没有 components.schemas（契约没生成全）')
}

console.log('Tool 参数（TypeBox）⇄ 契约（pydantic → OpenAPI）一致性断言')
console.log(`契约来源：${OPENAPI_PATH}`)

// 工具清单本身也要完整：少登记一个 Tool，这条防线就有个洞
const missingTools = EXPECTED_TOOLS.filter((name) => !TOOLS.some((entry) => entry.tool === name))
if (missingTools.length > 0) {
  failures.push(`工具清单缺少：${missingTools.join('、')}`)
  console.log(`\n✗ [漂移] 本脚本没有登记这些 Tool：${missingTools.join('、')}`)
}

for (const entry of TOOLS) {
  const contractSchema = schemas[entry.contract]
  if (contractSchema === undefined) {
    failures.push(`${entry.tool}：契约里没有模型 ${entry.contract}`)
    console.log(`\n── ${entry.tool} / ${entry.exportName} ⇄ ${entry.contract}`)
    console.log(`      ✗ [漂移] 契约里没有 ${entry.contract}（契约改名或没生成？）`)
    continue
  }
  const toolSchema = await loadSchema(entry.module, entry.exportName)
  compareTool(entry, toolSchema, contractSchema)
}

// 允许清单是否还有效（清单一腐烂，这条断言就名存实亡）
const stale = ALLOWED_DIFFS.filter((_, index) => !usedAllowances.has(index))
if (stale.length > 0) {
  console.log('\n✗ [漂移] 允许清单里有已失效的条目（差异已不存在，请删掉，别让清单变成空话）：')
  for (const entry of stale) {
    failures.push(`允许清单失效：${entry.tool}.${entry.field}（${entry.kind}）`)
    console.log(`      ✗ ${entry.tool}.${entry.field}（${entry.kind}）—— ${clip(entry.reason)}`)
  }
}

console.log(
  `\n已登记的差异：${usedAllowances.size} / ${ALLOWED_DIFFS.length} 条生效` +
    (warnings.length > 0 ? `；提示 ${warnings.length} 条` : '')
)

if (failures.length > 0) {
  console.log(`\n结果：发现 ${failures.length} 处漂移（Tool 参数与契约不一致）——`)
  for (const line of failures) console.log(`  - ${line}`)
  console.log(
    '\n怎么修：改 Tool 的 TypeBox 参数去对齐 pydantic 契约（契约是唯一来源）；' +
      '若差异是**有意**的，就在本脚本的 ALLOWED_DIFFS 里逐条登记并写清理由（不要放宽比对规则）。'
  )
  process.exit(1)
}

console.log('\n结果：4 个 Tool 参数与契约一致（未登记的差异 = 0）')
process.exit(0)
