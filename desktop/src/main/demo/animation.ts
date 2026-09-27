/**
 * 演示沙箱的**动画渲染**：把「按知识点渲染一份**真能播**的动画」收成**唯一一处实现**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么必须只有一处
 * ══════════════════════════════════════════════════════════════════════════
 * 预置数据里有三处要用到动画：三轮脚本第 1 轮那张动画卡、预置历史回看时的那一张、
 * 以及动画讲解页「我的动画」里的两条。三处各写一份取数 + 字段映射的话，
 * 它们迟早不是同一份产物（各自一个 `payloadId`、各自一次渲染）——
 * 而这个问题**只有现场才看得见**（动画卡与动画库两条点开播不出东西）。
 * 所以取数与映射都收在本文件，调用方只管「拿到就用、拿不到就降级」。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三条硬判据（缺一条，动画在沙箱里就播不出来）
 * ══════════════════════════════════════════════════════════════════════════
 *   ① 走**真实端点** `POST /api/animation/render`（路径工厂在 `wire/data.ts`，
 *      不在本文件里手写端点字符串）—— 模板缺失 / 服务没起来时宁可降级成文字，
 *      **绝不在这里编一份 HTML 顶上**：编出来的东西在沙箱里跑不起来，
 *      现场就是一整块空白（比一句文字要点糟得多）。
 *   ② `payloadId` 必须与请求里下发的**逐字相同**：服务端把它烘进产物
 *      （`window.__K12_PAYLOAD_ID__`），沙箱按它过滤每一条 `postMessage` ——
 *      两边不一致时 `ready` 会被当成别人的，卡片 5 秒后必然走超时降级。
 *   ③ 取不到就返回 `null`（调用方走各自的既有降级），**不抛异常**：
 *      sidecar 还没起来是演示的常态（本机回环、冷启动），它是状态不是错误。
 *
 * ★ **取到才缓存**（与 `script.ts` 的资产取数同一条纪律）：失败不被记住，
 *   否则「启动竞态」那一次失败会让这一整场演示里那两条动画永远只剩文字要点。
 *
 * ⚠️ 本文件只在主进程加载（它经 `apiFetch` 取数）。**不碰任何落盘路径**：
 *    预置内容从不写盘，进程一退出就没了。
 */

import { apiFetch } from '../bridge/client.ts'
// ★ 路径工厂从真实的取数层 import（`wire/data.ts` 是动画渲染端点的唯一真相）——
//   在这里另写一份端点字符串，改端点时就会漏掉这一处。
import { ANIMATION_RENDER_PATH } from '../wire/data.ts'
import { DEMO_GRADE_LEVEL, demoSavedAnimationRow, type DemoSavedAnimationRender } from './data.ts'

/**
 * 一份**可播**的渲染产物。
 *
 * 字段与契约 `AnimationPayload` 同形，外加两样渲染侧要用的东西：
 *   · `payloadId`：产物里烘的那把防串台 id（**从 HTML 里读回来的那份真值**）；
 *   · `gradeLevel`：这份是按哪个学段做的（卡片上「按当前学段重画」的判据）。
 */
export interface DemoRenderedAnimation {
  concept: string
  html: string
  durationMs: number
  fallbackText: string
  fallbackImage: string | null
  source: 'template'
  payloadId: string
  gradeLevel: string
}

/** 渲染的超时（本机回环，正常毫秒级；与 `script.ts` 的内容态取数同量级）。 */
const RENDER_TIMEOUT_MS = 8_000

/**
 * 记忆化：键是 `kpId|templateId@payloadId`（同一组只会渲染一次 —— 一次演示里
 * 同一条动画可能被卡片、回看、动画库三条路各要一次）。
 *
 * ★ 键里带 `templateId`：显式钉模板与按知识点自动命中**是两次不同的渲染**，
 *   共用一把键会让后一次拿到前一次的产物（而两次的 `payloadId` 可能恰好相同）。
 * ★ 只存**成功**的那次，失败不进表（见文件头「取到才缓存」）。
 */
const renderedCache = new Map<string, DemoRenderedAnimation>()

/** 读一个字符串字段（认不出回落空串）。 */
function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 读一个数字字段（认不出回落 `fallback`）。 */
function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * 从产物 HTML 里取回**烘焙在里面的** `payload_id`（认不出返回 `null`）。
 *
 * ★★ 为什么必须读回来而不是信自己发出去的那个：这个 id 的真身就是拼装器写下的
 *   那一行（`compose_animation_html`），卡片按**自己手里那个**校验每条 `postMessage`。
 *   读不回来 = 这张卡片永远等不到 `ready`（5 秒后必然降级）—— 那还不如现在就降级。
 *   判据与渲染侧 `stores/animation.ts` 的 `readBakedPayloadId`、
 *   主进程 `agent/extensions/animation.ts` 的 `readSavedPayloadId` **完全一致**，
 *   并用 `^[A-Za-z0-9_-]{1,64}$`（服务端 `validate_payload_id` 的同一个白名单）卡住字符集。
 */
function readBakedPayloadId(html: string): string | null {
  const matched = /window\.__K12_PAYLOAD_ID__\s*=\s*"([^"]*)"/.exec(html)
  const candidate = matched?.[1] ?? ''
  return /^[A-Za-z0-9_-]{1,64}$/.test(candidate) ? candidate : null
}

/** 真的发一次请求（记忆化与失败处置都在 {@link renderDemoAnimation}）。 */
async function renderOnce(
  kpId: string,
  payloadId: string,
  templateId: string | undefined
): Promise<DemoRenderedAnimation | null> {
  let response: Response
  try {
    response = await apiFetch(ANIMATION_RENDER_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // ★ `payloadId` 显式给（不给的话服务端会落默认的 `"preview"`，
      //   而沙箱的消息按它防串台 —— 两边对不上时 `ready` 会被当成别人的）。
      //
      // ★ `templateId` 只在调用方**明确点名**时才带上：给了它就由服务端 `find_template`
      //   直接取那一份（`resources.py` 的 `match_reason = "explicit"`），不再走
      //   `pick_template` 的「按知识点命中」。两个字段一起发是**如实描述这一轮**：
      //   `kpId` 是这张卡讲的知识点（服务端在没给 templateId 时才用它自动匹配），
      //   `templateId` 是这一轮选定的观感。服务端不校验两者的归属关系 ——
      //   所以「模板真的覆盖这个知识点」由 `tests/demo-seed.test.ts` 对着随包资产断言。
      body: JSON.stringify({
        kpId,
        ...(templateId === undefined ? {} : { templateId }),
        gradeLevel: DEMO_GRADE_LEVEL,
        params: {},
        payloadId
      }),
      signal: AbortSignal.timeout(RENDER_TIMEOUT_MS)
    })
  } catch {
    // sidecar 还没起来 / 超时 / 连接被拒 —— 都不是异常，是「这次取不到」。
    return null
  }
  if (!response.ok) return null

  let raw: unknown
  try {
    raw = (await response.json()) as unknown
  } catch {
    return null
  }

  const record = (raw ?? {}) as Record<string, unknown>
  const html = text(record.html)
  // ★★ 空 HTML 一律当成「没取到」：交出去的话卡片会拿到一份空产物 ——
  //    渲染侧的 `shouldMountIframe` 只在**空串**时当场走降级，非空但跑不起来的产物
  //    要等沙箱 5 秒超时才降级，中间那一整块空白就是现场最难看的东西。
  if (html.trim() === '') return null

  const baked = readBakedPayloadId(html)
  if (baked === null) return null

  return {
    concept: text(record.concept),
    html,
    durationMs: num(record.durationMs, 0),
    fallbackText: text(record.fallbackText),
    // ★ 模板自带的静态兜底图（自包含 dataURL）照原样带出去：降级时显示的是
    //   **真实产物**里那张图，与真实运行时的降级面一致。
    fallbackImage: text(record.fallbackImage) || null,
    source: 'template',
    // ★ 正常路径下它与请求里下发的那个**逐字相同**（服务端原样回烘）；
    //   万一它换了 id，就以产物里的为准 —— 卡片手里那个必须与 HTML 里那个字字相同。
    payloadId: baked,
    gradeLevel: DEMO_GRADE_LEVEL
  }
}

/**
 * 按知识点渲染一份**可播**的动画（真实模板产物）。
 *
 * @param kpId 知识点 id（没给 `templateId` 时，服务端按它 `pick_template` 精确命中随包模板）。
 * @param payloadId 这把动画的身份（服务端会逐字烘进 HTML；沙箱按它防串台）。
 * @param templateId 可选：**点名**要用哪一份随包模板（`server/resources/templates/<id>.json`）。
 *   给它的场景是「这一轮用哪份模板是**照截图比出来的**、要把它钉住」（见 `script.ts` 里
 *   第 1 轮那张卡）；不给就还是按知识点自动命中。名字写错 → 服务端 404 → 走降级，
 *   **不在这里编一份顶上**（见文件头第 ① 条）。
 * @returns 渲染产物；`null` = 这次没取到（调用方走既有降级，**不要**自己编一份）。
 */
export async function renderDemoAnimation(
  kpId: string,
  payloadId: string,
  templateId?: string
): Promise<DemoRenderedAnimation | null> {
  const key = `${kpId}|${templateId ?? ''}@${payloadId}`
  const cached = renderedCache.get(key)
  if (cached !== undefined) return cached

  const result = await renderOnce(kpId, payloadId, templateId)
  // ★ 见文件头：只缓存成功的那一次（失败要留给下一次机会）。
  if (result !== null) renderedCache.set(key, result)
  return result
}

/**
 * 从「我的动画」库里取一条（`savedId` 认不出 → `null`）并渲染成**可播**产物。
 *
 * ★ 库条目没有落盘的 HTML（演示**零写入**，没有任何东西写到磁盘上），
 *   所以这里按它登记的知识点**现渲染一份**：学生看到的是真实模板的产物，
 *   而不是一段事先编好的假动画。
 * ★ 库条目的 `payloadId` 由本文件生成（`demo-saved-<库 id>`，字符集符合服务端白名单）——
 *   它是这一条的身份，与产物里烘焙的那个必须字字相同（见 {@link renderDemoAnimation}）。
 */
export async function renderDemoSavedAnimation(
  savedId: string
): Promise<DemoSavedAnimationRender | null> {
  const row = demoSavedAnimationRow(savedId)
  if (row === null) return null
  const rendered = await renderDemoAnimation(row.kpId, `demo-saved-${row.id}`)
  return rendered === null ? null : { html: rendered.html, payloadId: rendered.payloadId }
}
