/**
 * 演示沙箱的**覆盖层**：沙箱态下把「学生态」读请求拦下来，回预置数据。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它接在哪、为什么接在那里
 * ══════════════════════════════════════════════════════════════════════════
 * 接在 `bridge/client.ts` 的 `apiFetch` **最前面** —— 在 `endpoint === null` 检查**之前**。
 * 这个位置是刻意的，也是这一整条链路成立的前提：
 *
 * ★★ **sidecar 还没起来时也要能演示**。放到端点检查之后，沙箱态下每一条读请求
 *   都会先抛「sidecar 尚未就绪（无端口与 token），无法发起 /api 请求。」
 *   —— 于是断网 / 冷启动的现场演示**一条数据都出不来**。
 *   覆盖层要挡的恰好是「这些数据不从服务端取」，所以它必须在「有没有服务端」之前。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 两条判据（哪一类拦、哪一类放行）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * | 类别 | 例子 | 这里怎么做 |
 * | --- | --- | --- |
 * | **学生态**（这个人用过的痕迹） | 画像 / 掌握度 / 闯关进度 / 学习报告 / 错题 / 章节进度 / 会话 / 动画库 / 学段 / 设置显示态 | **拦下来，回预置值** |
 * | **内容态**（随包资产，与谁在学无关） | 题库 / 代码模板 / 动画模板 / 知识点名 / 知识库统计 / 资源托管 | **一律透传**（走真实后端） |
 *
 * ★ 这条分界是**判据**，不是风格：内容态一旦被假掉，演示里就会出现
 *   「假题目配假答案」这种一戳就破的东西；而学生态不预置，页面就是空的。
 *   所以下面的白名单只管学生态 —— **内容态路径一个都不许进这个文件**。
 *
 * ⚠️ 未激活时是**严格 no-op**：直接 `null`，连 URL 都不解析。
 *   这条有单测与变异验证盯着（「让覆盖层在未激活时也返回预置载荷」必须变红）。
 */

import { isDemoSeeded } from './state.ts'
// ★ 动画库那条要**真的渲染一次**（本机模板产物）才播得出来，见下面「我的动画」那一段。
import { renderDemoSavedAnimation } from './animation.ts'
import {
  demoChapterBody,
  demoChaptersBody,
  demoGradeHistoryBody,
  demoGradeSignalsBody,
  demoGradeStateBody,
  demoGraphBody,
  demoMistakesBody,
  demoOpeningBody,
  demoProfileBody,
  demoQuizGeneratedBody,
  demoQuizProgressBody,
  demoIdentityBody,
  demoProfileTagsBody,
  demoRecommendationBody,
  demoReportBody,
  demoSavedAnimationItemBody,
  demoSavedAnimationListBody,
  demoSettingsBody,
  demoStudentBody
} from './data.ts'

/** 学习报告的天数上限（与 `study/client.ts` 的 `STUDY_MAX_REPORT_DAYS` 同口径）。 */
const MAX_REPORT_DAYS = 90

/** 默认报告窗口（与服务端默认一致）。 */
const DEFAULT_REPORT_DAYS = 7

/** 合成一个 JSON 响应（`Response` 在 Electron 主进程里是全局的）。 */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

/**
 * `GET /api/students` 的合成清单：**只有一位**。
 *
 * ★★ 沙箱态下必须拦这条：真实账号列表一旦上屏，演示就把本机的学生泄漏出去了。
 *    账号门/账号菜单从这里读到的只有这一位，点「切换」也只会在同一个人身上打转。
 * ★ id / 昵称 / 学段都取自预置画像（**不另写一份字面量**）：两处一旦漂，
 *   界面上显示的这个账号与画像里的就不是同一个人了。
 */
function demoAccountsBody(): unknown[] {
  const student = demoStudentBody()
  return [
    {
      studentId: typeof student.studentId === 'string' ? student.studentId : '',
      nickname: typeof student.nickname === 'string' ? student.nickname : '',
      gradeLevel: typeof student.gradeLevel === 'string' ? student.gradeLevel : '',
      createdAt: typeof student.createdAt === 'number' ? student.createdAt : 0,
      lastActiveAt: typeof student.lastActiveAt === 'number' ? student.lastActiveAt : 0,
      currentChapter: typeof student.currentChapter === 'string' ? student.currentChapter : ''
    }
  ]
}

/** 从查询串里读报告天数（认不出用默认值；越界则夹到边界内）。 */
function readReportDays(url: URL): number {
  const raw = url.searchParams.get('days')
  if (raw === null || raw === '') return DEFAULT_REPORT_DAYS
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_REPORT_DAYS
  return Math.min(parsed, MAX_REPORT_DAYS)
}

/**
 * 沙箱态下的读请求覆盖。
 *
 * ★ 它是 `async` 的**只有一个原因**：动画库「取一条」要先真渲染一份产物
 *   （见下面那一段）。其余每一条分支都在**同一个 tick 里**返回 ——
 *   调用方（`apiFetch`）多一个 `await`，普通态下的热路径没有任何额外动作。
 *
 * @param path 请求路径（可带查询串），与 `apiFetch` 收到的那个逐字相同。
 * @param init 请求初始化（本函数**只看方法**：只拦 GET）。
 * @returns 命中学生态读白名单 → 合成响应；未激活 / 未命中 / 非 GET → `null`（严格透传）。
 */
export async function demoResponseFor(path: string, init: RequestInit = {}): Promise<Response | null> {
  // ★★ 严格 no-op：未激活时连 URL 都不解析（保证「普通态下这一层不存在」）。
  if (!isDemoSeeded()) return null

  const method = (init.method ?? 'GET').toUpperCase()
  // 只拦读。写操作在 IPC 处理器层就被拒了（回一句可读中文，**绝不**让状态码上屏）——
  // 走到这里的写请求说明有人绕过了那层，放它透传反而会写坏真实数据。
  if (method !== 'GET') return null

  let url: URL
  try {
    // ★ 只借它解析路径与查询串：`apiFetch` 传进来的 path 是相对路径，
    //   基址是什么不影响 `pathname` / `searchParams` 的取值。
    url = new URL(path, 'http://127.0.0.1')
  } catch {
    return null
  }
  const pathname = url.pathname

  /* ── 设置显示态（「早就配好、一直在用」那一栏）──────────────────────────── */
  if (pathname === '/api/settings') return jsonResponse(demoSettingsBody())

  /* ── 账号（本机多个学生）──────────────────────────────────────────────────
   * ★★ 这条也必须拦：真实账号列表上屏 = 演示泄漏本机学生（见 demoAccountsBody）。
   *   只拦 GET —— 建号/改名/删号在 IPC 处理器层就被拒了，覆盖层放它们透传没有意义。
   * ------------------------------------------------------------------ */
  if (pathname === '/api/students') return jsonResponse(demoAccountsBody())

  /* ── 学生身份 / 画像 / 推荐 / 开场引导 / 报告 / 章节 ───────────────────── */
  const profile = /^\/api\/profile\/([^/]+)(?:\/([a-z]+))?$/.exec(pathname)
  if (profile) {
    switch (profile[2] ?? '') {
      case '':
        return jsonResponse(demoProfileBody())
      case 'recommendation':
        return jsonResponse(demoRecommendationBody())
      // ★ 2026-10-03 补：右栏画像那一块读的是 /tags（不是上面那个 /{id}）——
      //   漏了它，四个字段就全走真实后端的空态兜底文案（用户报障）。
      case 'tags':
        return jsonResponse(demoProfileTagsBody())
      // ★★ 2026-10-03：漏了它 = 演示把**本机真实学生姓名**上屏（见 demoIdentityBody）。
      //   它与 /tags、/{id} 是**三条独立的读通道**，少拦一条就漏一处。
      case 'identity':
        return jsonResponse(demoIdentityBody())
      case 'opening':
        return jsonResponse(demoOpeningBody())
      case 'report':
        return jsonResponse(demoReportBody(readReportDays(url)))
      case 'chapter':
        return jsonResponse(demoChapterBody())
      default:
        return null
    }
  }

  /* ── 学段（状态 / 信号 / 轨迹）──────────────────────────────────────────── */
  const grade = /^\/api\/grade\/(state|signals|history)\/[^/]+$/.exec(pathname)
  if (grade) {
    switch (grade[1]) {
      case 'state':
        return jsonResponse(demoGradeStateBody())
      case 'signals':
        return jsonResponse(demoGradeSignalsBody())
      default:
        return jsonResponse(demoGradeHistoryBody())
    }
  }

  /* ── 错题 / 闯关进度 / 我的生成题 ───────────────────────────────────────── */
  const quiz = /^\/api\/quiz\/(mistakes|progress|generated)\/[^/]+$/.exec(pathname)
  if (quiz) {
    switch (quiz[1]) {
      case 'mistakes':
        return jsonResponse(demoMistakesBody())
      case 'progress':
        return jsonResponse(demoQuizProgressBody())
      default:
        return jsonResponse(demoQuizGeneratedBody())
    }
  }

  /* ── 教材章节清单 / 依赖图全览（节点与边是真实的，只有「已掌握」是预置的）── */
  const study = /^\/api\/(knowledge\/chapters|graph\/overview)\/([^/]+)$/.exec(pathname)
  if (study) {
    const gradeLevel = study[2] ?? ''
    return jsonResponse(
      study[1] === 'knowledge/chapters' ? demoChaptersBody(gradeLevel) : demoGraphBody(gradeLevel)
    )
  }

  /* ── 学生动画库（清单 / 取一条）──────────────────────────────────────────
   * ★ 取一条时**真的去渲染一次**（`renderDemoSavedAnimation` → 真实的
   *   `POST /api/animation/render`，内容态，本文件不拦）：库里存的是**成品 HTML**，
   *   而演示不落盘、没有任何文件可以读，所以这里按登记的知识点现取一份真模板产物。
   *   取不到就回空 `html` —— 渲染侧既有「没有 HTML 就显示文字要点」的降级路径，
   *   **不编一份 HTML 顶上**（编出来的动画在沙箱里跑不起来，现场是一整块空白）。
   * ★ 因此本函数是 `async` 的：那条渲染要走一次网络。除它以外的分支都当场返回。
   * ------------------------------------------------------------------ */
  const saved = /^\/api\/animation\/saved\/([^/]+)(?:\/([^/]+))?$/.exec(pathname)
  if (saved) {
    if (saved[2] === undefined) return jsonResponse(demoSavedAnimationListBody())
    const rendered = await renderDemoSavedAnimation(saved[2])
    const item = demoSavedAnimationItemBody(saved[2], rendered)
    return item === null ? null : jsonResponse(item)
  }

  // ★ 走到这里 = 内容态（题库 / 代码模板 / 动画模板 / 知识点名 / 知识库统计 …）
  //   或别的未登记路径：**一律透传**，交给真实后端。
  return null
}
