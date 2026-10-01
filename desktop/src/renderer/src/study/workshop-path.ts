/**
 * 智码工坊的**关卡分组**（纯函数，可单测；零运行时依赖，Node 可直接 import）。
 *
 * ── 为什么要有这个文件
 * 学习路径（`/api/quiz/progress`）平铺下来是几十关，学生既看不出「我在哪一坨」，
 * 也看不出「这一坨走完了没有」。按教材**章节**分块之后，一屏里先出现的是几个大块
 * （「AI 基础概念 3/7」），再展开才是具体关卡 —— 这就是「先看大块，再进小关」。
 *
 * ── 分组键为什么是 `chapterTitle`（真实数据），而不是写死 5 个模块
 *   · `/api/knowledge/points` 的每一行都带 `chapterTitle`（教材里就有，7 章）；
 *   · 写死一份「AI 初识 / 数据与算力 / 编程基石 / …」是**第二份真相**：
 *     教材加一章、或某个知识点换了章节，硬编码那张表不会报错，只会静默错位
 *     （学生会看到「人工智能的定义」被塞进「算法逻辑」里）。
 *   ★ 所以这里**只做投影，不做知识判断**：章节叫什么、有几章，全部听教材的。
 *
 * ── 顺序：听服务端的，一个都不重排
 * `levels` 是服务端按**依赖图拓扑序**排好的（先学的在前）。本模块：
 *   · 组内关卡保持服务端顺序（不排序、不按名字排）；
 *   · 模块顺序 = 各章在 `levels` 里**第一次出现**的位置 ——
 *     这样「先出现的章节排在前面」与依赖图是一致的，而不是按章节名字典序。
 *
 * ── 关于「未解锁」（改这一段之前必须读）
 * 2026-09-25 起**没有关卡锁定**：后端播种时每一关都是 `stage="learning"`
 * （`routes/quiz.py`：`seed_progress(..., stage="learning")`）。所以：
 *   · `learning` 就是「可作答 / 还没通关」，**不是**「正在学第 N 关」；
 *   · 界面上不存在「未解锁」这一档，也**不许**把关卡置灰或禁用 ——
 *     这里是两态（已通关 / 可作答），不是三态。
 */

/** 分组用的最小关卡形状（只取分组需要的两个字段，不把整条契约拖进来）。 */
export interface WorkshopLevel {
  kpId: string
  /** 服务端给的阶段：`learning` / `quizzed` / `mastered`（`locked` 是历史字面量）。 */
  stage: string
}

/** 一个模块（= 教材的一章）。 */
export interface WorkshopModule {
  /**
   * 分组键（教材章节原文）。
   *
   * ⚠️ 空串是**合法**的：知识点清单还没读到 / 该 kp 不在当前教材里时，
   *    `chapterOf` 返回 `null`，那些关卡统一落进「其他关卡」那一组。
   */
  key: string
  /** 模块标题（已洗掉「第一章.」这类序号前缀，见 {@link moduleTitle}）。 */
  title: string
  /** 本模块的关卡（顺序 = 服务端拓扑序）。 */
  levels: WorkshopLevel[]
  /** 已通关的关数（`quizzed` / `mastered`）。 */
  doneCount: number
  /** 本模块总关数。 */
  total: number
}

/** 取不到章节时那一组的键与标题（界面上要看得懂，不摆空字符串）。 */
export const FALLBACK_MODULE_KEY = '__other__'
export const FALLBACK_MODULE_TITLE = '其他关卡'

/** 「已通关」的判据（`quizzed` 与 `mastered` 都算走过这一关）。 */
export function isLevelDone(stage: string): boolean {
  return stage === 'quizzed' || stage === 'mastered'
}

/**
 * 教材章节原文 → 界面上的模块名。
 *
 * `chapterTitle` 的原文是目录名（`第一章.人工智能的基础概念`）：
 * 那个「第一章.」是给排序用的（`store/learning.py` 只认阿拉伯数字排章节），
 * 摆到学生面前是噪音 —— 他要读的是「人工智能的基础概念」。
 *
 * @returns 标题；认不出序号前缀时原样返回（trim 后），空值返回 `null`。
 */
export function moduleTitle(chapterTitle: string | null | undefined): string | null {
  const raw = (chapterTitle ?? '').trim()
  if (raw === '') return null
  // `第一章.人工智能的基础概念` / `第2章、…` / `第一章 …` 三种写法都见过，一并处理
  const stripped = raw.replace(/^第[0-9一二三四五六七八九十百]+章\s*[.、:：\-—\s]*/, '')
  return stripped === '' ? raw : stripped
}

/**
 * 把一条平铺的学习路径按教材章节分成若干模块。
 *
 * @param levels 服务端给的学习路径（**顺序就是依赖图拓扑序**，本函数不重排）
 * @param chapterOf 知识点 → 章节原文（`knowledge.kpChapterOf`）；返回 `null` = 查不到
 */
export function groupLevelsByChapter(
  levels: WorkshopLevel[],
  chapterOf: (kpId: string) => string | null
): WorkshopModule[] {
  const modules: WorkshopModule[] = []
  const indexByKey = new Map<string, WorkshopModule>()

  for (const level of levels) {
    const rawChapter = chapterOf(level.kpId)
    const title = moduleTitle(rawChapter)
    const key = title === null ? FALLBACK_MODULE_KEY : (rawChapter ?? '').trim()
    let module = indexByKey.get(key)
    if (!module) {
      module = {
        key,
        title: title ?? FALLBACK_MODULE_TITLE,
        levels: [],
        doneCount: 0,
        total: 0
      }
      indexByKey.set(key, module)
      modules.push(module)
    }
    module.levels.push(level)
    module.total += 1
    if (isLevelDone(level.stage)) module.doneCount += 1
  }

  return modules
}

/**
 * ★★ 只留**本学段关卡路径**上的关卡（服务端逐行给的 `inPath`；口径见 P-085）。
 *
 * 为什么需要它（真机截图里的症状）：学段换过的学生（小学低 → 小学高 → 初中）名下会
 * **同时**留着三个学段的关卡行 —— 同一个概念在同一个模块里出现三次，名字一字不差、
 * 内容按学段不同（「人工智能的定义」×3）。服务端已经在每一行上表态「这一行在不在
 * 本学段路径上」，**路径视图**（智码工坊 / 闯关）只渲染 `true` 的那些；
 * 「学习记录」那种记录视图照旧渲染整份（P-086：旧记录不删，只是不冒充路径）。
 *
 * ⚠️ 字段缺失（老 sidecar / 演示数据）按**在路径上**处理：宁可多显示一关，
 *    也不要因为一个字段读不到就把学生的关卡整批吞掉。
 */
export function pathLevelsOf<T extends { inPath?: boolean }>(levels: readonly T[]): T[] {
  return levels.filter((level) => level.inPath !== false)
}

/**
 * 「继续闯关」要跳到哪一关。
 *
 * ★ 规则只有一条：**第一个还没通关的关卡**（服务端顺序里的），全部通关了就回到第一关。
 *   不猜「学生上次停在哪」—— 那条信息只有 learning.db 里有，前端没有它也不该自己记一份。
 *
 * @returns 关卡 id；路径为空时返回空串（调用方据此把按钮置灰，而不是给一个假动作）。
 */
export function nextLevelId(levels: WorkshopLevel[]): string {
  const pending = levels.find((level) => !isLevelDone(level.stage))
  return pending?.kpId ?? levels[0]?.kpId ?? ''
}
