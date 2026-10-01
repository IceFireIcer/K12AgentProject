/**
 * 画像新功能的一组守卫（§1.6 数据源映射 + §5.2 #2/#4/#7/#9/#12）。
 *
 * ★★ 为什么这些断言要**读源码文本**而不是调函数：
 *   实现横跨 Python（数据域）与 TypeScript（编排域），跨语言没法直接调；
 *   而本仓库既有的做法就是「按源码文本正向断言」（见 onboarding-guards.test.ts）。
 *
 * ★ 断言一律**正向**：写「必须包含什么」/「这个键必须在白名单里」，
 *   不写「禁止某历史实现」式断言（tickets/README 的常驻守卫段）。
 */

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

import {
  IDENTITY_LOCAL_FORBIDDEN,
  LLM_VISIBLE_TAG_SET,
  ONBOARDING_STATES
} from "../src/shared/profile-tags.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "..", "..")
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8")

const LEARNING = read("server/app/store/learning.py")
const PROFILE = read("server/app/routes/profile.py")
const STUDY = read("server/app/routes/study.py")
const QUIZ = read("server/app/routes/quiz.py")
const ADAPTATION = read("desktop/src/main/agent/prompts/adaptation.ts")
const BLOCK = read("desktop/src/main/agent/prompts/profile-block.ts")

/* ================================================================== *
 * §1.6 数据源映射：已有数据必须真的被投影成标签
 * ================================================================== */

test("§1.6 自动标签存在，且覆盖计划列出的三条数据源", () => {
  assert.ok(
    LEARNING.includes("def sync_observed_tags("),
    "存储层必须有唯一的观察标签收敛函数（计划 §1.6 的数据源映射）"
  )
  // 判分/答题已有数据 → 知识点 / 掌握度 / 错误模式
  for (const key of ["mastery", "knowledge_point", "error_type"]) {
    assert.ok(LEARNING.includes(`put("${key}"`), `判分数据必须投影出 ${key}`)
  }
  // signals.py 元认知路 → 情绪 / 强度
  for (const key of ["emotion", "intensity"]) {
    assert.ok(LEARNING.includes(`put("${key}"`), `元认知信号必须投影出 ${key}`)
  }
  // safety guard → 安全级别
  assert.ok(LEARNING.includes(`put("safety_level"`), "安全档位必须被投影")
})

test("§1.6 自动标签**只写白名单键**（禁做 #2–6、#8 的写法层保证）", () => {
  // 从 put("<key>" 里抽出所有被写入的键
  const written = [...LEARNING.matchAll(/put\("([a-z_]+)"/g)].map((m) => m[1])
  assert.ok(written.length >= 5, "至少应投影 5 个观察标签")
  for (const key of written) {
    assert.ok(LLM_VISIBLE_TAG_SET.has(key), `自动写入的键不在白名单里：${key}`)
  }
  // 反向：身份列一个都不许出现（G-B 的口径）
  for (const field of IDENTITY_LOCAL_FORBIDDEN) {
    assert.ok(!written.includes(field), `身份列绝不允许被当标签写：${field}`)
  }
})

test("§1.6 自动标签挂在判分路径上，且**非致命**", () => {
  assert.ok(
    QUIZ.includes("_sync_observed_tags_safely("),
    "判分之后必须触发观察标签投影"
  )
  assert.ok(
    QUIZ.includes("def _sync_observed_tags_safely("),
    "同步必须有独立函数（两条判分路径共用同一个收敛点）"
  )
  // ★ 判分是学生最不能失败的动作：整段必须被 try/except 包住
  const helper = QUIZ.slice(QUIZ.indexOf("def _sync_observed_tags_safely("))
  const body = helper.slice(0, helper.indexOf("def _record_attempt("))
  assert.ok(body.includes("except Exception"), "观察标签同步必须非致命（判分不许被它拖垮）")
})

/* ================================================================== *
 * §5.2 #9 / #7 / #12 —— 三条都不得跨学生
 * ================================================================== */

test("§5.2 #9 兴趣过滤存在，且**不推翻随机**（D-074 是用户裁决）", () => {
  assert.ok(PROFILE.includes("_interest_terms("), "必须有兴趣词提取")
  assert.ok(PROFILE.includes("_match_interest("), "必须有兴趣命中")
  assert.ok(
    PROFILE.includes("interest_terms=interest_terms"),
    "推荐必须把兴趣词传下去"
  )
  // ★★ 关键：随机仍在。兴趣只是加权，不是「只推兴趣」。
  assert.ok(PROFILE.includes("rng.shuffle(pool)"), "推荐仍然必须是随机的（D-074）")
  const shuffleAt = PROFILE.indexOf("rng.shuffle(pool)")
  const interestAt = PROFILE.indexOf("_match_interest(conn, pool, interest_terms)")
  assert.ok(
    interestAt > shuffleAt,
    "兴趣加权必须发生在打乱**之后**（先随机再提权，而不是先过滤后随机）"
  )
})

test("§5.2 #7 兴趣漂移只读、不写标签（D-020：推断不得覆盖学生明说）", () => {
  const start = PROFILE.indexOf("def _interest_drift(")
  assert.ok(start > 0, "必须有兴趣漂移检测")
  const body = PROFILE.slice(start, PROFILE.indexOf("class RecommendationResponse"))
  // 只读：不得出现任何写入原语
  for (const writer of ["upsert_tag", "set_preference", "set_identity_flags", "set_real_name"]) {
    assert.ok(!body.includes(writer), `兴趣漂移是**只读**的，不得调用 ${writer}`)
  }
  assert.ok(body.includes("parent_consent"), "漂移提示也是画像，必须过家长同意闸（G-G）")
})

test("§5.2 #12 报告含画像摘要，且同过家长同意闸", () => {
  assert.ok(STUDY.includes("_report_profile_summary("), "报告必须含画像摘要")
  assert.ok(STUDY.includes("profile_summary=profile_summary"), "摘要必须接进响应")
  const start = STUDY.indexOf("def _report_profile_summary(")
  const body = STUDY.slice(start, start + 1200)
  assert.ok(body.includes("parent_consent"), "摘要也是画像，必须过家长同意闸（G-G）")
  assert.ok(
    body.includes('record.key != "anon_student_id"'),
    "匿名标识是 join 钥匙，不是「孩子的特点」，不许出现在报告里"
  )
})

test("禁做 #9：画像出口都不带第二个学生的入参（结构上做不出跨学生聚合）", () => {
  for (const [name, body] of [
    ["_report_profile_summary", STUDY.slice(STUDY.indexOf("def _report_profile_summary(")).slice(0, 400)],
    ["_recommendation_basis", PROFILE.slice(PROFILE.indexOf("def _recommendation_basis(")).slice(0, 400)],
    ["_interest_terms", PROFILE.slice(PROFILE.indexOf("def _interest_terms(")).slice(0, 400)],
  ] as const) {
    assert.ok(
      body.includes("student_id: str"),
      `${name} 必须按单个 student_id 作用域（禁做 #9）`
    )
    // ★★ 必须先剥掉**注释与文档字符串**再判：这些函数的 docstring 里**写着**
    //   「没有 GROUP BY / 排名」，直接扫全文会让那句自我说明自证其罪
    //   （集成期实测踩到：第一版按行首过滤，而 docstring 的正文行不以 # 开头）。
    const code = body.replace(/"""[\s\S]*?"""/g, "").replace(/#[^\n]*/g, "")
    assert.ok(
      !/GROUP BY|COUNT\(\*\)\s*(AS\s+)?rank/i.test(code),
      `${name} 里不得出现跨学生聚合/排名`
    )
  }
})

/* ================================================================== *
 * §5.2 #4 / #2 —— 风格编排与偏好建议
 * ================================================================== */

test("§5.2 #4 风格驱动工具编排存在，且**只调先后**（不新增 Tool）", () => {
  assert.ok(
    ADAPTATION.includes("export function renderStyleToolSectionBody("),
    "必须有风格驱动的工具编排段"
  )
  // 段的标题必须在**全集**里（否则 stripPromptSections 清不掉它）
  assert.ok(
    BLOCK.includes("STYLE_TOOL_SECTION_HEADING"),
    "新段标题必须定义在 profile-block.ts"
  )
  assert.ok(
    BLOCK.includes("TURN_SECTION_HEADINGS"),
    "段标题全集必须存在（清理要靠它）"
  )
  // ★ 收尾锚点要用**数组自己的** `]`：声明里还有 `readonly string[]` 的方括号，
  //   从声明起点找第一个 `]` 会切在 `string]` 上（集成期实测踩到）。
  const headingsStart = BLOCK.indexOf("export const TURN_SECTION_HEADINGS")
  const headingsOpen = BLOCK.indexOf("= [", headingsStart)
  const headingsBlock = BLOCK.slice(headingsOpen, BLOCK.indexOf("\n]", headingsOpen))
  assert.ok(
    headingsBlock.includes("STYLE_TOOL_SECTION_HEADING"),
    "★ 风格段必须登记进 TURN_SECTION_HEADINGS，否则它永远不会被清掉（会逐轮堆积）"
  )
  // ★ 不新增 Tool：不能出现 registerTool
  assert.ok(!ADAPTATION.includes("registerTool"), "风格编排只调先后，不得注册新 Tool")
})

test("§5.2 #4 数据不足时**什么都不注入**（回落 = 空串，不猜）", () => {
  const start = ADAPTATION.indexOf("export function renderStyleToolSectionBody(")
  const body = ADAPTATION.slice(start, ADAPTATION.indexOf("export function buildTurnSections("))
  assert.ok(
    body.includes("if (hay.length === 0) return ''"),
    "没有风格标签时必须返回空串（不注入）"
  )
  assert.ok(
    body.includes("return lines.join('\\n')"),
    "命中才拼正文"
  )
})

test("§5.2 #2 偏好建议是**纯函数**，绝不写库（三条铁律第 1 条）", () => {
  const start = BLOCK.indexOf("export function inferPreferences(")
  assert.ok(start > 0, "必须有偏好自动识别")
  const body = BLOCK.slice(start, BLOCK.indexOf("/** 一个可注入的稳定段", start))
  // ★ L3 永远不能写 L1/L2：源码里不得出现任何写路径
  for (const writer of ["acceptPreference", "savePreference", "writeFileSync", "fetch(", "postJson"]) {
    assert.ok(!body.includes(writer), `偏好建议不得含写路径：${writer}`)
  }
  assert.ok(body.includes("return suggestions"), "只返回建议，由用户决定采不采纳")
  assert.ok(body.includes("source === 'declared'"), "已由学生明说的键不再建议（L2 > L3）")
})

/* ================================================================== *
 * 既有红线不得被新功能破坏
 * ================================================================== */

test("新功能没有扩大引导状态机（G-I 仍然只有 not_started 弹）", () => {
  assert.deepEqual([...ONBOARDING_STATES].sort(), ["done", "in_progress", "not_started", "skipped"])
})

test("新功能没有把身份层带进标签（G-B 仍然零重叠）", () => {
  for (const field of IDENTITY_LOCAL_FORBIDDEN) {
    assert.ok(!LLM_VISIBLE_TAG_SET.has(field), `身份列不得进白名单：${field}`)
  }
})

/* ================================================================== *
 * §5.2 #11 画像变化时间线 —— 两条会互相拆台的红线
 * ================================================================== */

const MIGRATIONS = read("server/app/store/migrations.py")

test("§5.2 #11 时间线有真实的变更序列（迁移 v6 + append-only 表）", () => {
  assert.ok(
    MIGRATIONS.includes("profile_tag_history"),
    "时间线必须有真实的变更序列表（profile_tags 的键唯一，只存当前值，给不出历史）"
  )
  assert.ok(
    MIGRATIONS.includes("version=6"),
    "新表必须走一次新迁移（不改已发布的 v1~v5）"
  )
  // append-only：只 INSERT，没有 UPDATE / DELETE
  const start = LEARNING.indexOf("def _append_tag_history(")
  assert.ok(start > 0, "写入必须收敛到一个函数")
  const body = LEARNING.slice(start, LEARNING.indexOf("def tag_history(", start))
  assert.ok(body.includes("INSERT INTO profile_tag_history"), "变更记录只追加")
  assert.ok(!/UPDATE\s+profile_tag_history/i.test(body), "时间线是 append-only：不得改写历史")
  assert.ok(!/DELETE\s+FROM\s+profile_tag_history/i.test(body), "时间线是 append-only：不得删除历史")
})

test("§5.2 #11 ★★ 短期情绪标签绝不进时间线（否则架空 TTL = 禁做 #11）", () => {
  // 写入侧：显式排除
  const writeStart = LEARNING.indexOf("def _append_tag_history(")
  const writeBody = LEARNING.slice(writeStart, LEARNING.indexOf("def tag_history(", writeStart))
  assert.ok(
    writeBody.includes("if key in EPHEMERAL_TAG_SET:"),
    "写入侧必须排除 emotion/intensity/trigger —— 记了它们，读取侧的 TTL 就被架空了"
  )
  // 读取侧：再挡一次
  const readStart = LEARNING.indexOf("def tag_history(")
  const readBody = LEARNING.slice(readStart, LEARNING.indexOf("def _tag_value(", readStart))
  assert.ok(
    readBody.includes("key in EPHEMERAL_TAG_SET"),
    "读取侧必须再挡一次（纵深防御：两处都挡才叫红线）"
  )
  // 投影侧：不额外引入情绪
  const projStart = PROFILE.indexOf("def _timeline_events(")
  const projBody = PROFILE.slice(projStart, PROFILE.indexOf("def _recommendation_basis(", projStart))
  assert.ok(
    !/emotion|intensity|trigger/.test(projBody),
    "时间线投影不得直接引用情绪类标签"
  )
})

test("§5.2 #11 时间线只汇三处真实序列，不从别处推断时间", () => {
  const start = PROFILE.indexOf("def _timeline_events(")
  const body = PROFILE.slice(start, PROFILE.indexOf("def _recommendation_basis(", start))
  for (const source of ["store.grade_history(", "store.tag_history(", "store.onboarding_answers("]) {
    assert.ok(body.includes(source), "时间线必须包含这一处真实序列：" + source)
  }
  // ★ 不得从 mastery / preference 之类「没有时间序列」的地方硬凑时间
  assert.ok(
    !body.includes("store.mastery_map(") && !body.includes("store.preferences("),
    "没有时间序列的数据源不得被用来编时间"
  )
})

test("§5.2 #11 时间线同过家长同意闸，且不跨学生（G-G / 禁做 #9）", () => {
  const start = PROFILE.indexOf("def _timeline_events(")
  const body = PROFILE.slice(start, PROFILE.indexOf("def _recommendation_basis(", start))
  assert.ok(body.includes("parent_consent"), "时间线也是画像，必须过家长同意闸（G-G）")
  assert.ok(body.includes("student_id: str"), "必须按单个 student_id 作用域（禁做 #9）")
  const code = body.replace(/"""[\s\S]*?"""/g, "").replace(/#[^\n]*/g, "")
  assert.ok(!/GROUP BY|COUNT\(\*\)\s*(AS\s+)?rank/i.test(code), "不得出现跨学生聚合/排名")
})

test("§5.2 #11 时间线的 IPC 能力是**可选**的（缺了不拖垮标签卡）", () => {
  const bridge = read("desktop/src/renderer/src/api/profile-card.ts")
  assert.ok(
    bridge.includes("timeline?:"),
    "时间线在画像桥上必须是可选成员：它是后加的读通道，缺了不该让标签卡一起下线"
  )
  const resolveStart = bridge.indexOf("export function resolveProfileCardBridge(")
  const resolveBody = bridge.slice(resolveStart, bridge.indexOf("const TAG_SOURCES", resolveStart))
  assert.ok(
    resolveBody.includes("typeof api.readProfileTimeline === 'function'"),
    "必须**单独**判它，而不是并进那个四方法探测"
  )
})

/* ================================================================== *
 * 迁移 v7：origin（变更出处）—— 与 source（可信度）正交的第二个维度
 * ================================================================== */

test("v7 迁移给 profile_tag_history 补 origin 列，且不改已发布的 v6", () => {
  assert.ok(MIGRATIONS.includes("version=7"), "必须走一次新迁移（不改已发布的 v1~v6）")
  assert.ok(
    MIGRATIONS.includes("ADD COLUMN origin"),
    "origin 列靠幂等 ALTER 补出（SQLite 的 ADD COLUMN 没有 IF NOT EXISTS）"
  )
  // ★ 回填纪律：只对唯一可确定的映射填，observed 留 NULL（不替过去编造）
  assert.ok(
    MIGRATIONS.includes("'cold_start' WHERE source = 'declared'"),
    "declared → cold_start（五问是唯一写 declared 的路，可确定）"
  )
  assert.ok(
    MIGRATIONS.includes("'refresh' WHERE source = 'inferred'"),
    "inferred → refresh（只有持续迭代写 inferred，可确定）"
  )
  assert.ok(
    !/origin\s*=\s*'projection'/.test(MIGRATIONS),
    "绝不给旧行回填 projection —— 投影与概括都写 observed，猜不了就不猜"
  )
})

test("origin 词表在后端与两处写入口都是封闭的（三态，无第四态）", () => {
  assert.ok(
    LEARNING.includes('frozenset({"cold_start", "refresh", "projection"})'),
    "origin 必须是封闭三态词表"
  )
  // 写入侧：两条会撞车的路必须**显式**声明各自出处
  assert.ok(
    LEARNING.includes("origin=TAG_ORIGIN_PROJECTION"),
    "行为投影必须显式声明 projection，不吃 refresh 兜底"
  )
  assert.ok(
    LEARNING.includes("origin=TAG_ORIGIN_REFRESH"),
    "持续迭代概括必须显式声明 refresh"
  )
})

test("同一个 source 的不同 origin 必须能分开（这就是加 origin 的全部理由）", () => {
  // 读取侧：origin 过一遍封闭词表（纵深防御），脏值当 None
  const readStart = LEARNING.indexOf("def tag_history(")
  const readBody = LEARNING.slice(readStart, LEARNING.indexOf("def _tag_value(", readStart))
  assert.ok(
    readBody.includes("in TAG_ORIGINS"),
    "读取侧必须再挡一次 origin 词表：库里被塞脏值也不流出去"
  )
})

test("origin 不把内部枚举名当人话显示（双视角纪律 D-063）", () => {
  // 后端拼一句中文进 detail；渲染层**不**写枚举 → 文字的映射
  assert.ok(
    PROFILE.includes("_TAG_ORIGIN_NOTES"),
    "出处必须由后端折成中文（渲染层不认枚举名）"
  )
  const view = read("desktop/src/renderer/src/components/card/ProfileTags.vue")
  for (const token of ["cold_start", "refresh", "projection"]) {
    assert.ok(
      !view.includes(`'${token}'`) && !view.includes(`"${token}"`),
      `渲染层不得出现 origin 枚举字面量：${token}`
    )
  }
})
