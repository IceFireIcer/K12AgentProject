<script setup lang="ts">
/**
 * 个性化学习页（内部 id 仍是 `quiz`）—— 对话内联闯关卡的**展开视图**。
 *
 * ── 版式（骨架，不是装饰）────────────────────────────────────────────
 * 旧版两个极端都走过：先是「四块同权」（左 320px 关卡列表 + 1.7fr 题目 + 1fr 掌握度，
 * 主对象被三面包围），后来改成单列流（关卡条横向铺在页面顶部）。现在：
 * **左 268px 二级导航（教材章节 → 该章小知识点）+ 右主区**。
 *
 *   左栏：关卡总览（大块可折叠，块内一个知识点 = 一关）
 *   右栏：身份行 → 当前关卡标题 → **题目（全宽）**
 *          → 掌握度（题目下方横向铺开） → 判分说明（折叠）
 *
 * 于是全页唯一的 22px 仍是 `PageIdentity`（契约 §4：内容区最大字号必须是主对象那一层），
 * 关卡名降为 16px（块标题档），掌握度/进度是 13px 与 12px。
 * 关卡切换从「页面顶部横向 chip 条」搬进左栏（与智码工坊同一形态），
 * 分块规则与那一页**共用** `study/workshop-path.ts`（不重排、不自己定义知识体系）。
 *
 * ── 数据来源（全部来自 `useQuizStore`，本页不再自带任何样本数据）──────
 *   关卡与阶段 `GET /api/quiz/progress` → `levels`（**服务端已按依赖图拓扑序排好**，
 *              所以这里一行排序都不做；`stage` / `badge` / `mastery` 原样来自 learning.db）
 *   题目       `GET /api/quiz/bank`     → `bank`（`QuizQuestionOut`：**结构上没有 `answer`**）
 *   判分       `POST /api/quiz/grade`   → `attempts[qid].result`（`QuizResult`）
 *   kp 中文名  教材知识点清单（`levels` 只给 kpId，中文名要另取；见 `study/kp-label.ts`）
 *   章节      教材知识点清单的 `chapterTitle`（`knowledge.kpChapterOf`；见左栏分块）
 *
 * ★★ 三条纪律（改这个文件前先读）：
 *  1. **前端没有答案、也不判分**：题库载荷里没有 `answer`，本页也**不渲染 `explanation`**
 *     （解析里往往直接写着答案，它只在判分之后的 `feedback` 里出现）。
 *     提交后只显示服务端给的 `correct` / `feedback` / `masteryDelta`，本地不做任何比对。
 *  2. **答题状态只有一份**：作答草稿在页面里，判分状态在 store 的 `attempts` 里 ——
 *     页面不另存一份对错结论（两处状态必然对不上）。
 *  3. **不编造历史**：契约里**没有**「逐次作答历史」端点，所以「做题记录」列出的是
 *     **本轮**（这一关这一次）的判分小结 —— 不带时间戳、不摆历史行。换关卡即清零
 *     （`selectLevel` 清空 `attempts`），这一点在抽屉里也写明。
 *
 * ⚠️ 「连对 / 经验」在契约里没有对应模型（只有掌握度与学习记录），**不渲染**这两个数 ——
 *   没有数据源的数字画出来就是假统计。徽章（`levels[].badge`）是服务端真实字段，
 *   有就显示、没有就不显示。（这条说明本身也是**写给评委看的**，见下一条。）
 *
 * ★★ 学生视角 / 教师·答辩视角（`stores/viewMode.ts` + `<TeacherGate>`）——
 *   本页此前把几处**写给评委的 API 映射说明直接印在学生页面上**（评审最刺眼的一条：
 *   「『连对 / 经验』在契约里没有对应模型……」「关卡徽章取服务端的 `progress.badge`」）。
 *   现在的纪律：**学生视角一个字不留，教师视角一条不删**（设计合理性那 25% 要证据）。
 *   判据不是「这句话有没有用」，而是「它在向谁解释什么」：
 *     · 向学生解释**他自己的学习** → 留在页面上（「学习中」「答对了」「再试一次」）；
 *     · 向我们解释**实现** → 进 `<TeacherGate>`（kp_id、契约里没有什么模型、关卡怎么播种）。
 *   ★ 学生视角里**绝不出现内部标识**：`kp_id` / `qid` 这类 slug 要么进 `<TeacherGate>`，
 *     要么退回中性占位（`未命名知识点`）—— 界面上摆 `ai-definition-jr` 是开发期产物。
 */
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import {
  Trophy,
  Circle,
  PlayCircle,
  CheckCircle2,
  ChevronRight,
  History,
  X,
  Info,
  RotateCcw
} from 'lucide-vue-next'
import { useQuizStore, type QuizAttempt } from '../stores/quiz'
import { useQuizLayoutStore, type QuizLayout } from '../stores/quizLayout'
import { useFloatPanel } from '../stores/floatPanel'
import TeacherGate from '../components/TeacherGate.vue'
import { useKnowledgeStore } from '../stores/knowledge'
import { QUIZ_TYPE_LABELS, SCORED_BY_LABELS, formatMasteryDelta } from '../labels'
import { isBlankAnswer, optionLetter, type QuizQuestionType } from '../cards/quiz'
// ★ 「一个知识点在界面上叫什么」的口径不写在本页：有中文名用中文名，取不到用中性的
//   「未命名知识点」，**绝不退回 `ai-definition-jr` 这种 slug**（学生看到只会以为报错）。
//   与智码工坊 / 学习档案共用 `study/kp-label.ts` 这一份实现。
import { kpLabel } from '../study/kp-label'
// ★ 关卡按**教材章节**分块的口径同样不写在本页：与智码工坊共用
//   `study/workshop-path.ts` 的纯函数（顺带保证「两页的分块一模一样」，且它有单测）。
import { groupLevelsByChapter, type WorkshopLevel } from '../study/workshop-path'
import type { QuizResultView } from '../api/data'
import { useEscape } from '../composables/useEscape'
import { useFocusReturn } from '../composables/useFocusReturn'
import { scrollIntoViewRespectingMotion } from '../composables/useReducedMotion'

const quiz = useQuizStore()
const floatPanel = useFloatPanel()

/**
 * 「边做边问」—— 打开 / 收起悬浮追问窗（与动画页、编程页同一个入口形态）。
 * 标题取当前关卡的学生话名字；还没选关卡时给中性说法（不摆 kpId）。
 */
function askAboutLevel(event: MouseEvent): void {
  const kpId = quiz.activeKpId
  floatPanel.toggleFrom(event.currentTarget as Element | null, {
    kind: 'quiz',
    title: kpId ? nameOf(kpId) : '这几道题',
    hint: '做题卡住时可以问，问题会带上这一关的上下文。'
  })
}
const knowledge = useKnowledgeStore()
const layoutStore = useQuizLayoutStore()

/**
 * 三个进度阶段的中文名与图标（阶段字面量来自服务端进度，不在前端推导）。
 *
 * ★★ 2026-09-25 去掉关卡锁定：不再有「还没解锁」这一档，**所有关卡都能点进去做题**。
 *   阶段只剩三种进度标记 —— 学习中 / 已闯关 / 已掌握，它们是**反馈**，不是门禁。
 * ★ 左栏每一关的状态只靠**图标 + 颜色 + 状态词**区分（`.qpath__ico[data-stage]` 三档），
 *   不再挂百分比（报告 2.3 / 0.2）：一排 `0%` 不携带信息，只制造焦虑。
 */
const stageMeta: Record<string, { label: string; icon: unknown }> = {
  learning: { label: '学习中', icon: Circle },
  quizzed: { label: '已闯关', icon: PlayCircle },
  mastered: { label: '已掌握', icon: CheckCircle2 }
}

/**
 * 展示用的阶段（认不出的字面量兜一手）。
 *
 * ★ 契约枚举值**没有改**（`ProgressStage` 里仍留着 `locked` 这个旧字面量），所以万一真收到它，
 *   这里按「可作答」呈现、照样可点、**不做任何禁用** —— 防御性兼容：
 *   绝不让界面把任何一关变回一道打不开的门。
 */
const STAGE_FALLBACK: { label: string; icon: unknown } = { label: '可作答', icon: PlayCircle }
function stageView(stage: string): { label: string; icon: unknown } {
  return stageMeta[stage] ?? STAGE_FALLBACK
}

/* ---------------------------------------------------------------- 关卡 */

/**
 * ★ 关卡条 = **本学段关卡路径**（`quiz.pathLevels`），不是整张进度表：
 *   学段换过的学生名下会留着更低学段的旧关卡，整张表渲染出来就是同名关卡并排好几条。
 *   口径见 `study/workshop-path.ts` 的 `pathLevelsOf`（服务端逐行标的 `inPath`）。
 */
const levels = computed(() => quiz.pathLevels)

/**
 * 知识点显示名（教材里的中文名）。
 *
 * ★★ 口径**不写在本页**：`study/kp-label.ts` 的 `kpLabel()` 是全站唯一实现
 *   （与智码工坊、学习档案同一份）：有中文名用中文名，取不到时给中性的
 *   「未命名知识点」，**绝不退回 `ai-definition-jr` 这种 slug**。
 *   为什么不能退回 `kpId`（评审发现：界面上出现过 `ai-definition-jr`）：
 *   它是我们内部的标识，不是学生的语言 —— 学生看到的是「一个读不懂的机器串」，
 *   而且它把「我们怎么给知识点编号」摆给了不该关心这件事的人。
 *   名字的来源仍是教材知识点清单（`knowledge.kpNameOf`，与依赖图谱同一个 `kb.sqlite`）。
 */
function nameOf(kpId: string): string {
  return kpLabel(kpId, null, (id) => knowledge.kpNameOf(id))
}

/* ---------------------------------------------------------------- 关卡导航 */

/**
 * 关卡的**二级导航**：大块 = 教材的一章，块内 = 该章的小知识点。
 *
 * ★★ 分块规则不写在本页（与智码工坊**同一个纯函数**，`study/workshop-path.ts`）：
 *   块名来自教材的 `chapterTitle`（`knowledge.kpChapterOf`），块序与块内关序
 *   全部听服务端给的路径顺序（依赖图拓扑序），本页**一行排序都不做** ——
 *   教材加一章这里就自动多一块，不会静默错位。
 * ★ 数据源是 `quiz.pathLevels`（本学段路径），不是整张进度表：学段换过的学生
 *   名下会留着更低学段的旧关卡，整张表渲染出来就是同名关卡并排好几条。
 */
const modules = computed(() =>
  groupLevelsByChapter(
    levels.value.map((level): WorkshopLevel => ({ kpId: level.kpId, stage: level.stage })),
    (kpId) => knowledge.kpChapterOf(kpId)
  )
)

/**
 * 大块的展开状态。
 *
 * ★ 默认展开的是 ① 当前这一关所在的块、② 第一个还没走完的块 ——
 *   学生一进来看到的就是「我在哪」与「接下来做什么」，其余收起（几十关平铺是一堵墙）。
 * ★ 手动点过之后以手动为准（`moduleOverrides`）：默认值会随换关而变，
 *   不记这一份的话，学生刚展开的块会在下一次换关时被系统收回去。
 */
const moduleOverrides = ref<Record<string, boolean>>({})

/** 默认展开的块键（当前关所在块 + 第一个未走完的块）。 */
const defaultOpenKeys = computed(() => {
  const keys = new Set<string>()
  const current = modules.value.find((mod) =>
    mod.levels.some((level) => level.kpId === quiz.activeKpId)
  )
  if (current) keys.add(current.key)
  const pending = modules.value.find((mod) => mod.doneCount < mod.total)
  if (pending) keys.add(pending.key)
  return keys
})

/** 这一块现在是展开还是收起（手动优先，没手动过用默认值）。 */
function isModuleOpen(key: string): boolean {
  return moduleOverrides.value[key] ?? defaultOpenKeys.value.has(key)
}

function toggleModule(key: string): void {
  moduleOverrides.value = { ...moduleOverrides.value, [key]: !isModuleOpen(key) }
}

/**
 * kpId → 服务端徽章文本（形如「熟练-3」）。
 *
 * ★ 为什么要单独一张表：分块后的 `mod.levels` 只保留 `kpId + stage`
 *   （`WorkshopLevel` 是分组用的最小形状），而徽章只有 `quiz.pathLevels` 上有。
 *   不把徽章塞进分组函数，是为了不让「按章节分组」这件事知道徽章的存在。
 */
const badges = computed(() => {
  const map = new Map<string, string>()
  for (const level of levels.value) if (level.badge) map.set(level.kpId, level.badge)
  return map
})

/** 徽章文本；没有就返回空串（模板据此决定渲不渲染）。 */
function badgeOf(kpId: string): string {
  return badges.value.get(kpId) ?? ''
}

/**
 * 徽章：服务端文本形如「熟练-3」（档位名-答对题数，档位封顶），
 * 这里只显示**档位名**，原始文本放进 `title`（学生 hover 能看到确切值）。
 */
function badgeTier(badge: string): string {
  return badge.split('-', 1)[0] || badge
}

const summary = computed(() => ({
  total: levels.value.length,
  mastered: levels.value.filter((level) => level.stage === 'mastered').length
}))

const activeLevel = computed(
  () => levels.value.find((level) => level.kpId === quiz.activeKpId) ?? null
)

/**
 * 冷启动落位：进度回来后默认选中**第一关**（优先 `learning`，否则按服务端给的顺序取第一个）。
 *
 * ★ 只在学生**还没选过关卡**时做（`activeKpId === ''`），选过之后再不插手 ——
 *   否则刷新进度会把学生正在做的关卡切走。
 * ★ 不猜「第一关」是什么：顺序就是服务端给的拓扑序，`learning` 是服务端播种时
 *   唯一标出来的「现在该学」那一关。
 * ★ 2026-09-25 去掉关卡锁定后，落位不再看阶段能不能进（每一关都能进）——
 *   这里只回答「先停在哪儿」，排序与可作答性都已由服务端保证。
 */
watch(
  [() => quiz.progress, () => quiz.activeKpId],
  () => {
    if (quiz.progress === null || quiz.activeKpId !== '') return
    const first =
      levels.value.find((level) => level.stage === 'learning') ?? levels.value[0]
    if (first) void quiz.selectLevel(first.kpId)
  },
  { immediate: true }
)

/* ---------------------------------------------------------------- 作答 */

/** 作答草稿（提交前的输入；判分结论不在这里，它只在 store 的 `attempts` 里）。 */
const drafts = reactive<Record<string, string>>({})
/** 本地提示（空作答之类），不是 `error` 事件的形态，也不冒充判分结论。 */
const localHint = ref('')

/**
 * 重做本关：**清掉 store 的本轮小结 + 本页的作答草稿**（P3-3）。
 *
 * ★★ 为什么本页也要清（实测缺陷）：`quiz.restart()` 只清 store（`attempts` / 小结计数），
 *   而学生的**选中项与填入的答案**住在本页的 `drafts` 里 —— 于是「重做本关」之后
 *   界面看起来什么都没变：选项仍高亮着上次的选择，学生很容易直接点「提交这题」，
 *   等于把上一轮的答案又交了一遍（而他以为自己在重新做）。
 *   「重做」的语义就是**回到未作答的状态**，两处必须一起清。
 * ★ 不清 `localHint` 之外的东西：题目本身、关卡进度、已落库的判分结果都不动
 *   （那些是服务端的事实，restart 从来不动它们）。
 * ★★ 生成题（D-088）与教材题共用 `attempts` / `drafts` 两处状态，所以这里的
 *   `quiz.restart()` + 清空循环**天然覆盖生成题**：不存在第二种「生成题专用」的
 *   状态要另外清（那正是把它们合并进同一条做题链路的收益）。重做后所有题都回
 *   未作答态，已落库的判分结果一个字不动。
 */
function restartLevel(): void {
  quiz.restart()
  for (const key of Object.keys(drafts)) delete drafts[key]
  localHint.value = ''
  // 单卡模式也要回到第一题：作答全清了，卡片还停在第三题上会让学生以为「重做」没生效。
  cursorQid.value = ''
  finished.value = false
}

/**
 * 「还想再练练」是否已经被点过 —— 自动阶段的 20 上限据此解除。
 *
 * ★ 为什么这个标记住在**页面**而不是 store：20 是这一页的**展示策略**（计划 §4.3：
 *   截断放在渲染层投影，不改数据层）；store 只回答「这个学生有哪些题」。
 * ★ 换关卡由下面那条 `watch(activeKpId)` 复位：新的一关重新进入自动阶段。
 */
const moreUnlocked = ref(false)

/**
 * 本页要做的题 = 教材配套题 + **智团团给这个学生出过的题**（D-088）。
 *
 * ★ 为什么合成一条列表：两者的作答 / 判分 / 反馈**完全是同一条链路**
 *   （答完按 `qid` 走 `POST /api/quiz/grade`，qid 自带随机段不会撞车），
 *   单开一块只会让学生以为自己要做两遍。
 * ★ 去重按 `qid`：生成题的 qid 带 `gen-` 前缀，与题库真题不可能同名
 *   （服务端登记时就整批拒过撞名的），所以去重在这里只是防「同一道生成题取回来两次」。
 * ★★ 自动阶段截断（20 上限）是本页的展示策略，说明见函数体里的注释。
 */
const questions = computed(() => {
  const banked = quiz.bank?.questions ?? []
  const seen = new Set(banked.map((question) => question.qid))
  const extra = quiz.generated.filter((question) => !seen.has(question.qid))
  // ★★ 自动阶段截断（计划 §4.3）：还没点过「还想再练练」时，生成题只取到上限为止，
  //   让「内置 + 生成 ≤ 20」在**屏幕上**成立（后端一行不改）。
  //   取**前** quota 道：`GET /api/quiz/generated` 的列表本来就是「最近登记的在前」
  //   （服务端把最近 limit 道倒过来发），所以前 quota 道 = 最近登记优先。
  //   点过按钮即解除截断 —— 学生主动要更多了，20 不再是这一阶段的边界。
  const quota = Math.max(0, quiz.autoPhaseLimit - banked.length)
  const visibleExtra = moreUnlocked.value ? extra : extra.slice(0, quota)
  return [...banked, ...visibleExtra]
})

/** 哪些 qid 是「智团团出的」——题头那枚标签靠它。 */
const generatedQids = computed(() => new Set(quiz.generated.map((question) => question.qid)))

/**
 * 本关「智团团出的题」在**合并去重之后**还剩几道。
 *
 * ★ 为什么数合并后的列表而不是 `quiz.generated.length`：去重是这一页做的
 *   （见 `questions` 的说明），拿原始条数会让计数与屏幕上真有的题对不上。
 */
const generatedCount = computed(
  () => questions.value.filter((question) => generatedQids.value.has(question.qid)).length
)

/**
 * 关卡头部那条**来源计数**（D-088：让学生看见生成题真的落到了这一关）。
 *
 * ★ 与题头角标同一条判据（{@link generatedQids}），但这里是**整关口径**：
 *   「本关 3 道教材题 + 2 道智团团出的题」比一句「共 5 题」多告诉他一件真事 ——
 *   后两题不是凭空多出来的，是智团团照着他自己的薄弱点出的。
 * ★ 一道生成题都没有时**退回旧写法 `N 题`**：绝不摆「0 道智团团出的题」这种空计数
 *   （凭空多一行，还会让学生以为生成失败了）。
 * ★ 题还没取到时返回空串，整枚标签不渲染（与「空数据不摆仪表盘」同一条纪律）。
 */
const questionCountLabel = computed(() => {
  const total = questions.value.length
  if (total === 0) return ''
  if (generatedCount.value === 0) return `${total} 题`
  const bankCount = total - generatedCount.value
  const parts: string[] = []
  // 题库那半为 0 时省略：「0 道教材题」是不携带信息的一截。
  if (bankCount > 0) parts.push(`${bankCount} 道教材题`)
  parts.push(`${generatedCount.value} 道智团团出的题`)
  return `本关 ${parts.join(' + ')}`
})

/**
 * 题区（`SurfacePanel.quiz__card`）要不要渲染。
 *
 * ★ 报告 1.6：空数据时不摆空仪表盘。一关都没有（教材还没准备好）时，
 *   这张卡只能写「先选一关」—— 而上面根本没有关卡可选，等于把学生指向一个不存在的东西。
 *   于是这种状态下**整块不渲染**：页面上只剩关卡区那一句灰字（唯一的一处空态说明）。
 * ★ 读取中与读失败仍要渲染：那两种状态有话说（`.quiz__fail` / `EmptyState`）。
 */
const showQuestionPanel = computed(
  () =>
    levels.value.length > 0 ||
    quiz.progressLoading ||
    quiz.bridgeError !== null ||
    quiz.progressError !== null
)

/** 题目 + 它当前的作答状态（一次算好，模板里不再反复查表）。 */
const questionRows = computed(() =>
  questions.value.map((question, index) => ({
    question,
    index,
    attempt: quiz.attempts[question.qid] ?? null,
    /** 这道是智团团给这个学生出的（题头标出来，学生才知道它从哪来）。 */
    fromAssistant: generatedQids.value.has(question.qid)
  }))
)

/* ---------------------------------------------------------------- 答题排版 */

/**
 * 排版模式（**一次一张** / 全部铺开）—— 唯一来源是 `stores/quizLayout.ts`（localStorage 持久化）。
 *
 * ★ 页面**不另存一份 ref**：两份状态里必然有一份会过期（与学段 / 章节那两个入口同一条纪律）。
 *   写接口只走 store 的 `set()`，它顺手落盘 —— 学生下次打开还是自己选的那样。
 */
const layout = computed<QuizLayout>({
  get: () => layoutStore.mode,
  set: (next) => layoutStore.set(next)
})

/** 两档排版的文案（学生的话，不带任何机制说明）。 */
const LAYOUT_OPTIONS = [
  { label: '一次一张', value: 'single' },
  { label: '全部铺开', value: 'list' }
]

/**
 * 单卡模式停在哪一题：记 **qid**，不记下标。
 *
 * ★ 为什么不记下标：题集不是常量 —— 智团团给这个学生出的题是**另一次请求**取回来的
 *   （`loadGenerated`），晚到就会把下标整体挤一位，学生面前的题会莫名其妙换成别的。
 *   qid 是题库 / 生成题各自的稳定标识，题集怎么变都对得上；对不上（换关卡、重取题库）
 *   就落回第一题，见 `currentIndex`。
 */
const cursorQid = ref('')

/** 单卡模式：最后一题也答对、并且点了「下一题」→ 卡片换成收尾卡。 */
const finished = ref(false)

/** 当前停在第几题（0 基）。找不到 `cursorQid`（换关卡 / 题集变了）就落到第一题。 */
const currentIndex = computed(() => {
  const rows = questionRows.value
  if (rows.length === 0) return 0
  const index = rows.findIndex((row) => row.question.qid === cursorQid.value)
  return index >= 0 ? index : 0
})

/** 单卡模式当前那一行（题集为空时为 `null`）。 */
const currentRow = computed(() => questionRows.value[currentIndex.value] ?? null)

/** 单卡模式且已经走完最后一题：题体与卡脚都不渲染，换成收尾卡。 */
const showFinish = computed(
  () => layout.value === 'single' && questions.value.length > 0 && finished.value
)

/**
 * 这一次要**渲染出来**的题。
 *
 * ★★ 两种排版的差别只有这一处：列表模式 = 全部 `questionRows`，单卡模式 = 当前那一行。
 *   模板、题体、作答链路、判分状态**一份都没有第二份** —— 同一条规则写两遍，
 *   缺陷只会出现在没改的那一份上（P-143）。
 */
const visibleRows = computed(() => {
  if (layout.value === 'list') return questionRows.value
  if (showFinish.value) return []
  return currentRow.value === null ? [] : [currentRow.value]
})

/**
 * 当前这道题是不是已经有**终态**（答对了）。
 *
 * ★ 判据只读后端判分结果里的 `correct`（与 `submitDisabled` 同一口径，前端不比对答案）：
 *   「下一题」邀请的是「做完这一题」，而不是「点过提交」。答错留在原地重试是正当的。
 */
const currentSettled = computed(() => currentRow.value?.attempt?.result?.correct === true)

/** 题号步骤的状态：只读后端判分结论（前端不推断对错）。 */
function stepState(attempt: QuizAttempt | null): 'correct' | 'wrong' | 'todo' {
  const result = attempt?.result
  if (result?.correct === true) return 'correct'
  if (result) return 'wrong'
  return 'todo'
}

/** 题号步骤的读屏文案（含题号与状态，读屏用户不必去猜颜色）。 */
function stepLabel(index: number, attempt: QuizAttempt | null): string {
  const name = `第 ${index + 1} 题`
  const state = stepState(attempt)
  if (state === 'correct') return `${name}，答对了`
  if (state === 'wrong') return `${name}，还没做对`
  return `${name}，还没做过`
}

/**
 * 题目来源的**中文说法**（`bank` / `generated` 是契约里的枚举）。
 *
 * ★ 说人话：`本地题库` / `模型生成` 是我们这边的实现语言（学生不知道什么叫"题库"、
 *   也不该关心它在哪、更不知道"模型生成"意味着什么）。对学生有意义的是
 *   「这是教材配的题」还是「这是智团团现给你出的题」。
 *   ⚠️ 文案与对话内练习卡片（`cards/QuizCard.vue` 的 `sourceLabel`）**必须一字不差** ——
 *   同一件事在两条路径上说法不同，读起来就像两个不同的功能。
 */
const sourceLabel = computed(() => {
  const source = quiz.bank?.source
  if (source === 'bank') return '教材配套题'
  if (source === 'generated') return '智团团出的题'
  return ''
})

function pick(qid: string, option: string) {
  drafts[qid] = option
  localHint.value = ''
}

function onInput(qid: string, event: Event) {
  const target = event.target as HTMLInputElement | null
  drafts[qid] = target ? target.value : ''
}

/**
 * 提交键的文案与禁用（**一题一个终态**）。
 *
 * ★★ 修的是什么（评审发现的真实缺陷）：旧文案是
 *   `row.attempt?.result ? '再提交一次' : '提交这题'` —— **答对之后**按钮还在请学生
 *   「再提交一次」，于是他真的会再点一次，而服务端的反馈里写着「这次就不重复计分」。
 *   一个邀请学生做无用功、做完还被系统告知「不算」的按钮。
 *
 * 判据只读**后端判分结果**里的 `correct`（`QuizResultView`，那一个布尔是唯一权威，
 * 前端不自己比对答案）：
 *   · 答对 → 「已完成」且**禁用**（终态：再提交一次不会改变任何结论）；
 *   · 答错 → 仍然可点，文案是「再试一次」（那才是这个按钮真正在邀请他做的事）；
 *   · 判分在途 → 「正在判分…」且禁用（防连点：连点会判两次、写两次掌握度）。
 *
 * ⚠️ 注意禁用的是**按钮的交互**，不是把按钮藏起来：它仍在 DOM 里、
 *    `data-testid="quiz-submit"` 仍然数得到（探针要能证明的是「它被禁用了」，
 *    而不是「它不见了」—— 后者会让界面在学生答对后看起来像坏掉了）。
 */
function submitLabel(attempt: QuizAttempt | null): string {
  if (attempt?.submitting === true) return '正在判分…'
  if (!attempt?.result) return '提交这题'
  return attempt.result.correct ? '已完成' : '再试一次'
}

/** 提交键是否禁用：判分在途，或**这道题已经答对**（终态，再点没有意义）。 */
function submitDisabled(attempt: QuizAttempt | null): boolean {
  if (attempt?.submitting === true) return true
  return attempt?.result?.correct === true
}

/** 题目列表的根元素（答对后用它把视线送到下一题，见 `advanceAfterCorrect`）。 */
const listRef = ref<HTMLElement | null>(null)

/**
 * 答对之后把注意力送到**下一道还没答对的题**上。
 *
 * ★ 为什么要有这一步：一道题答对之后它的提交键变成禁用的「已完成」——
 *   如果学生没注意到，视线仍停在那一题上，「接下来做什么」就没有答案；
 *   而这是**三题一关**的练习，往下走才是常态。
 * ★ 找不到下一题（最后一题，或后面的题都已经答对）时**什么都不做**：
 *   不滚动、不弹提示 —— 「点完画面对不上」的假动作比不做更差。
 * ★ 查找用模板里已经有的 `data-testid="quiz-question-N"`（题号即序号），
 *   不另外维护一份 DOM ref 数组：两份状态里必然有一份会过期。
 * ★ 减动效偏好（`useReducedMotion`，全站同一口径）：它是一次**移动**，所以
 *   减动效下走**瞬移**（`scrollIntoViewRespectingMotion` 是唯一实现）——
 *   内容照样送到眼前，只是不再滑过去（CSS 的 `@media` 收不掉 JS 发起的滚动）。
 */
async function advanceAfterCorrect(index: number): Promise<void> {
  const next = questionRows.value.find(
    (row) => row.index > index && row.attempt?.result?.correct !== true
  )
  if (!next) return
  await nextTick()
  scrollIntoViewRespectingMotion(
    listRef.value?.querySelector<HTMLElement>(`[data-testid="quiz-question-${next.index + 1}"]`),
    { block: 'center' }
  )
}

/* ── 单卡模式的推进（步骤条 / 上一题 / 下一题）──────────────────────────── */

/**
 * 跳到第 index 题 —— 步骤条、上一题、下一题**共用的唯一入口**。
 *
 * ★ 跳题是自由的：想回看重看、想先做会做的，都不拦（「做完一题换下一题」是**默认节奏**，
 *   不是一道门）。所以这里不做「必须答对才能往后」这类校验，校验只在「下一题」那个按钮上
 *   （它邀请的是往下走这一步，就得有个明确条件）。
 */
function goTo(index: number): void {
  const rows = questionRows.value
  if (rows.length === 0) return
  const target = rows[Math.min(Math.max(index, 0), rows.length - 1)]
  if (target === undefined) return
  finished.value = false
  cursorQid.value = target.question.qid
  void focusCurrentQuestion()
}

function prevQuestion(): void {
  if (currentIndex.value <= 0) return
  goTo(currentIndex.value - 1)
}

/** 「下一题」：只有当前题答对才可点（答错留在原地接着想）；最后一题 → 收尾卡。 */
function nextQuestion(): void {
  if (!currentSettled.value) return
  if (currentIndex.value >= questionRows.value.length - 1) {
    finished.value = true
    void focusFinish()
    return
  }
  goTo(currentIndex.value + 1)
}

/**
 * 切卡后的**焦点与视线**（无障碍：换卡是内容替换，不接管的话焦点会掉回 `body`，
 * 键盘用户要从头 Tab 一遍才知道新题在哪）。
 *
 * ★ 落点是新题的题干（`.qitem__stem`，模板里带 `tabindex="-1"`）而不是某个输入框：
 *   读屏会先把题干念出来 —— 学生从「这是什么题」开始，而不是从「光标在哪个选项上」开始。
 * ★ 滚动用 `block: 'nearest'`：只把题挪进视野，不把整页甩到顶部；
 *   减动效下不滑（统一走 `scrollIntoViewRespectingMotion`）。
 */
async function focusCurrentQuestion(): Promise<void> {
  await nextTick()
  const stem = listRef.value?.querySelector<HTMLElement>('.qitem__stem') ?? null
  if (stem === null) return
  stem.focus({ preventScroll: true })
  scrollIntoViewRespectingMotion(stem, { block: 'nearest' })
}

/** 收尾卡根元素（走完最后一题后焦点交给它，理由同 `focusCurrentQuestion`）。 */
const finishRef = ref<HTMLElement | null>(null)
async function focusFinish(): Promise<void> {
  await nextTick()
  finishRef.value?.focus({ preventScroll: true })
}

/**
 * 换关卡 → 单卡回到第一题。
 *
 * ★ 判据是「哪一关」这个**身份**：切走再切回来要停在第一题，而不是停在上次离开的那一题
 *   （那一题的作答已随 `selectLevel` 清掉，停在它上面等于给学生看一道空题）。
 */
watch(
  () => quiz.activeKpId,
  () => {
    cursorQid.value = ''
    finished.value = false
    // ★ 新的一关重新进入自动阶段：20 上限的解除状态跟着关卡走（`moreUnlocked` 的说明）。
    moreUnlocked.value = false
  }
)

/** 提交一题：非空校验 + 交给 store（判分只在后端）。防连点在 store 里。 */
async function submit(qid: string, index: number) {
  const answer = (drafts[qid] ?? '').trim()
  if (isBlankAnswer(answer)) {
    localHint.value = '先写下你的答案，再点提交。'
    return
  }
  localHint.value = ''
  await quiz.submit(qid, answer)
  // 只有这一提交**真的被判定为对**才往下送；答错要留在原地接着想（retry 是正当的）。
  // ★ 列表模式才自动滚到下一道没做对的题；单卡模式的推进由学生点「下一题」触发
  //   （那正是这一版新增的节奏：一题做完，再由他决定什么时候换卡）。
  if (quiz.attempts[qid]?.result?.correct === true && layout.value === 'list') {
    await advanceAfterCorrect(index)
  }
}

/* ── 「还想再练练」：这一屏的题都判过分之后再要一批 ────────────────────────
 * 落点**两处**（计划 §4.5）：列表模式跟在题目列表之后（DOM 顺序天然随列表末端移动），
 * 单卡模式进收尾卡的动作区。两处都必须是 `el-button`（次要动作）——
 * 收尾卡里已经有 `.k12-cta`（去下一关），一屏只允许一个主色填充，
 * 而且 `scripts/verify-guard-mutations.mjs` 的 ⑤ 只替换第一处 `.k12-cta`。
 * ------------------------------------------------------------------------ */

/**
 * 按钮的出现条件：**屏幕上这一份题**全部判分过（不要求全对，与自动触发同口径）。
 *
 * ★ 判据用截断后的 `questions`，不是全量：被 20 上限挡在屏幕外的历史题学生根本
 *   做不了，要求它们也判分过会让按钮永远不出现。
 */
const canRequestMore = computed(
  () =>
    questions.value.length > 0 &&
    questions.value.every((question) => quiz.attempts[question.qid]?.result != null)
)

/** 失败后同一个按钮就是重试（不另起第二个控件，收尾卡的次要动作位也只留一个）。 */
const moreButtonLabel = computed(() => (quiz.moreError !== null ? '再试一次' : '还想再练练'))

/**
 * 点「还想再练练」：先解除 20 上限（学生主动要更多了），再交给 store 生成。
 *
 * ★ 生成中 / 失败 / 降级三种状态全部**读 store**（`moreGenerating` / `moreError` /
 *   `moreNotice`）—— 本页再养一份必然与它过期（与答题状态同一条纪律）。
 * ★ 单卡模式点完回到题流：新题追加后收尾卡不再成立，走既有的 `goTo`（它顺手复位
 *   `finished`），与「回去接着做」是同一个入口。
 */
async function requestMore(): Promise<void> {
  moreUnlocked.value = true
  await quiz.generateMore()
  if (layout.value === 'single' && finished.value && firstUnsettledIndex.value >= 0) {
    goTo(firstUnsettledIndex.value)
  }
}

/* ---------------------------------------------------------------- 本轮小结 */

/** 小结里的一行：只收**已经判过分**的题（结论来自后端，本地不推断对错）。 */
interface SummaryRow {
  index: number
  qid: string
  type: QuizQuestionType
  stem: string
  result: QuizResultView
}

/**
 * 本轮判分小结 = 已判分的那几题（按题号顺序）。
 *
 * ⚠️ 这不是"做题记录"：契约里没有逐次作答的历史端点，库里也没有可供前端查询的
 *    作答时间线（学习记录是给统计用的聚合）。所以这里**只结本轮**，且不写时间戳。
 */
const summaryRows = computed<SummaryRow[]>(() => {
  const rows: SummaryRow[] = []
  for (const row of questionRows.value) {
    const result = row.attempt?.result
    if (!result) continue
    rows.push({
      index: row.index,
      qid: row.question.qid,
      type: row.question.type,
      stem: row.question.stem,
      result
    })
  }
  return rows
})

/** 本轮正确率（store 算的；一题都没判过时为 `null`，界面据此隐藏）。 */
const accuracyPercent = computed(() =>
  quiz.accuracy === null ? null : Math.round(quiz.accuracy * 100)
)

/* ---------------------------------------------------------------- 收尾卡 */

/**
 * 收尾卡（单卡模式走完最后一题时的最后一张卡）。
 *
 * ★ 它只回答两个问题：**这一关做得怎么样**（答对几题）与**接下来去哪**
 *   （还有没做对的就回去接着做，全做对了就「看本轮小结 / 去下一关」）。
 * ★ 所有数字都来自**后端判分结论**（`correct`）与题库本身，不新增任何统计口径。
 */

/** 本关**答对**的题（只数后端判成 correct 的，前端不推断对错）。 */
const correctRows = computed(() =>
  questionRows.value.filter((row) => row.attempt?.result?.correct === true)
)

/** 第一道**还没答对**的题（收尾卡的「回去接着做」跳它；全答对了就是 -1）。 */
const firstUnsettledIndex = computed(() =>
  questionRows.value.findIndex((row) => row.attempt?.result?.correct !== true)
)

/**
 * 拓扑序里的下一关。
 *
 * ★ 顺序就是服务端给的 `levels` 顺序（它已按依赖图拓扑序排好），前端**一行排序都不做**。
 * ★ 已经是最后一关 → `null`：收尾卡不渲染「去下一关」——不摆一个点了没反应的入口。
 */
const nextLevel = computed(() => {
  const list = levels.value
  const index = list.findIndex((level) => level.kpId === quiz.activeKpId)
  if (index < 0) return null
  return list[index + 1] ?? null
})

function backToUnsettled(): void {
  const index = firstUnsettledIndex.value
  if (index >= 0) goTo(index)
}

function goNextLevel(): void {
  const target = nextLevel.value
  if (target !== null) void quiz.selectLevel(target.kpId)
}

/* ---------------------------------------------------------------- 掌握度 */

/**
 * 掌握度条的颜色分档（**只是界面分档**，不是判分口径 —— 判分与阶段都在后端）。
 * 阈值与学习档案里的展示口径一致（≥70% 好 / ≥40% 待加强 / 其余偏低）。
 */
function barColor(percent: number): string {
  if (percent >= 70) return 'var(--k12-good)'
  if (percent >= 40) return 'var(--k12-warn)'
  return 'var(--k12-bad)'
}

/**
 * 「本关 + 相邻两关」的掌握度。
 *
 * ★ 数据来自服务端进度（`levels[].mastery`，与关卡列表同一个来源），
 *   所以面板里的数字与上面的关卡条**不可能对不上**。
 * ★ 为什么带相邻两关：单看本关只是一条进度条，看不出"我在路径的哪一段"；
 *   相邻两关按服务端的**拓扑序**取（上一关 / 下一关指路径次序，不是"依赖方向"的断言）。
 */
const masteryRows = computed(() => {
  const list = levels.value
  const index = list.findIndex((level) => level.kpId === quiz.activeKpId)
  if (index < 0) return []
  return [index - 1, index, index + 1]
    .filter((cursor) => cursor >= 0 && cursor < list.length)
    .map((cursor) => ({
      kpId: list[cursor]!.kpId,
      name: nameOf(list[cursor]!.kpId),
      percent: Math.round(list[cursor]!.mastery * 100),
      role: cursor === index ? '本关' : cursor < index ? '上一关' : '下一关'
    }))
})

/* ---------------------------------------------------------------- 二级界面 */

/** 本轮小结抽屉：模态的焦点契约（移入 → 层内循环 → 关闭归还）挂在它上面。 */
const historyOpen = ref(false)
const drawerRef = ref<HTMLElement | null>(null)

/** Esc 关闭：模态必须有键盘出口，否则键盘用户被卡在里面。 */
useEscape(() => { historyOpen.value = false }, () => historyOpen.value)

/** 打开时焦点移入抽屉、Tab 在层内循环、关闭归还触发元素（契约 §8）。 */
useFocusReturn(drawerRef, () => historyOpen.value)

onMounted(() => {
  // 幂等取数：进度（关卡）与知识点清单（名字）各一次
  void quiz.loadProgress()
  void knowledge.loadPoints()
})
</script>

<template>
  <div class="quiz">
    <!-- ── 左：二级导航（大块 = 教材章节，块内 = 该章的小知识点）──────────
         ★ 数据只来自服务端：关卡顺序是 `quiz.pathLevels`（服务端拓扑序），
           章节名来自教材知识点清单（`knowledge.kpChapterOf`），
           分块规则住在 `study/workshop-path.ts`（与智码工坊同一个纯函数）——
           本页**一行排序都不做**，块序 = 各章在服务端路径里第一次出现的位置。
         ★ 窄窗口：左栏宽度钉死、块名与知识点名一律 ellipsis，右栏 `min-width: 0`，
           不允许出现横向滚动。 -->
    <aside class="quiz__nav">
      <section class="qnav" aria-label="关卡">
        <header class="qnav__head">
          <Trophy :size="14" class="qnav__ico" />
          <span class="qnav__label">关卡</span>
          <span v-if="quiz.progressLoading && levels.length === 0" class="qnav__state">读取中…</span>
          <!-- 「边做边问」：打开悬浮追问窗（与动画页 / 编程页同一个入口形态）。
               它是**次要动作**，走 chip 形态而不是 `.k12-cta`。 -->
          <button
            type="button"
            class="qnav__ask"
            data-testid="quiz-view-ask"
            title="打开追问窗，边做边问"
            @click="askAboutLevel"
          >
            边做边问
          </button>
        </header>

        <!-- `data-testid="quiz-levels"` 仍落在**关卡容器的外层**：
             「这一页有没有关卡可点」这个判断与分块细节无关。 -->
        <div v-if="levels.length > 0" class="qmods" data-testid="quiz-levels">
          <section v-for="(mod, modIndex) in modules" :key="mod.key" class="qmod" :data-key="mod.key">
            <!-- 大块头：可点的折叠开关（键盘可达，`aria-expanded` 如实报状态） -->
            <button
              type="button"
              class="qmod__head k12-tap"
              :aria-expanded="isModuleOpen(mod.key)"
              :data-open="isModuleOpen(mod.key)"
              :data-testid="'quiz-module-' + modIndex"
              @click="toggleModule(mod.key)"
            >
              <ChevronRight
                :size="13"
                class="qmod__ico"
                :data-open="isModuleOpen(mod.key)"
                aria-hidden="true"
              />
              <span class="qmod__title">{{ mod.title }}</span>
              <span class="qmod__count k12-num">{{ mod.doneCount }} / {{ mod.total }}</span>
            </button>
            <ul v-show="isModuleOpen(mod.key)" class="qpath">
              <li
                v-for="level in mod.levels"
                :key="level.kpId"
                class="qpath__item"
                :data-stage="level.stage"
                :class="{ 'qpath__item--on': quiz.activeKpId === level.kpId }"
              >
                <button
                  type="button"
                  class="qpath__btn"
                  :data-testid="'quiz-level-' + level.kpId"
                  :data-active="quiz.activeKpId === level.kpId ? 'true' : 'false'"
                  :aria-current="quiz.activeKpId === level.kpId ? 'step' : undefined"
                  :title="nameOf(level.kpId) + ' · ' + stageView(level.stage).label"
                  @click="quiz.selectLevel(level.kpId)"
                >
                  <component
                    :is="stageView(level.stage).icon"
                    :size="13"
                    class="qpath__ico"
                    :data-stage="level.stage"
                  />
                  <span class="qpath__name">{{ nameOf(level.kpId) }}</span>
                  <span class="qpath__stage">{{ stageView(level.stage).label }}</span>
                  <!-- 徽章是服务端字段（`progress.badge`，形如「熟练-3」），没有就不渲染。
                       卡片上**没有百分比**（报告 2.3）：状态由图标 + 状态词说。 -->
                  <span v-if="badgeOf(level.kpId)" class="qpath__badge" :title="badgeOf(level.kpId)">{{ badgeTier(badgeOf(level.kpId)) }}</span>
                </button>
              </li>
            </ul>
          </section>
        </div>
        <!-- 空态：**对学生只说他的处境**（现在没有可闯的关卡），机制另说（见下） -->
        <p v-else-if="!quiz.progressLoading" class="qnav__empty" data-testid="quiz-levels-empty">
          还没有可以闯的关卡，教材内容准备好之后这里会一关一关地排出来。
        </p>

        <!-- 关卡是怎么来的（**教师 / 答辩视角**）：这是实现说明，不是给学生的解释。
             学生视角整段不渲染；教师视角里它一直可见（评委要看这条链路）。 -->
        <TeacherGate label="关卡是怎么来的">
          <p class="qnav__note">
            服务端会在首次打开闯关页时按依赖图播种关卡路径；知识库为空时这里是空的。
          </p>
        </TeacherGate>

        <!-- ★★ 契约映射说明（**教师 / 答辩视角**）—— 缺陷现场：这段 memo 原本直接印在
             学生页面上（「『连对 / 经验』在契约里没有对应模型……」「关卡徽章取服务端的
             progress.badge」）。它只说明**缺的是什么**：契约里没有「连对 / 经验」这类模型，
             所以这两个数不渲染；徽章是真实字段，有就显示。教师视角**一个字没删**。 -->
        <TeacherGate label="为什么不显示「连对 / 经验」">
          <p class="qnav__note qnav__note--row">
            <Info :size="13" />
            <span>
              「连对 / 经验」在契约里没有对应模型（只有掌握度与学习记录），本页不显示这两个数；
              关卡徽章取服务端的 <code>progress.badge</code>，没有时为空。
            </span>
          </p>
        </TeacherGate>
      </section>
    </aside>

    <!-- ── 右：主区。PageActions 在这个滚动容器内 → 吸顶有效。 ────────────── -->
    <section class="quiz__main">
    <PageActions>
      <template #info>
        <!-- ★ 进度数字**只有一种格式**（报告 2.3）：`已掌握 N / M`。
             原来的「闯关进度 N / M 已掌握」是同一批数字的第二种说法 —— 全站统一成一种。
             ★ 一关都没有时整格不渲染（报告 1.6：空态下不出现「已掌握 0 / 0」这种仪表盘读数）。 -->
        <span v-if="summary.total > 0">已掌握 {{ summary.mastered }} / {{ summary.total }}</span>
      </template>
      <!-- 重做本关：清空本页的作答与小结（**不**清除已落库的判分结果）。
           有东西可清时才出现，避免摆一个按了没反应的按钮。
           ★ P3-3：清的是「store 的小结 + 本页的作答草稿」两处（见 `restartLevel` 的说明）——
             只清 store 会让上次的选项一直高亮，学生以为没重做、把旧答案又交一遍。 -->
      <el-button v-if="quiz.gradedCount > 0" @click="restartLevel()">
        <RotateCcw :size="14" />
        <span class="btn__label">重做本关</span>
      </el-button>
      <el-button :disabled="quiz.gradedCount === 0" @click="historyOpen = true">
        <History :size="14" />
        <span class="btn__label">本轮小结</span>
        <span class="btn__count">{{ quiz.gradedCount }}</span>
      </el-button>
    </PageActions>

    <!-- 身份行：本页「在讲什么」+ 主路径提示（22px，全页唯一） -->
    <PageIdentity
      main="这几道题检验你刚才学的那一点"
      meta="客观题由规则判分，主观题由模型判分"
      hint="先选关卡，再逐题作答，每提交一题都会当场判分"
    />

    <!-- 取数失败（桥缺失 / 端点报错）：一句可读中文 + 重试，绝不让页面静默空着。 -->
    <div v-if="quiz.bridgeError || quiz.progressError" class="quiz__fail" data-testid="quiz-fail">
      <Info :size="15" />
      <div class="quiz__fail-text">
        <p class="quiz__fail-title">闯关进度没读上来</p>
        <p class="quiz__fail-msg">{{ quiz.bridgeError || quiz.progressError }}</p>
      </div>
      <el-button size="small" @click="quiz.loadProgress(true)">重试</el-button>
    </div>

    <!-- ── 当前关卡标题（16px 块标题档：不得追平身份行的 22px）──────────
         ★ 一关都没有时整块不渲染（报告 1.6）：空数据下摆一行「当前关卡 / 还没选关卡」
           是仪表盘读数，不是给学生看的东西。 -->
    <header v-if="levels.length > 0" class="quiz__head">
      <div class="quiz__head-text">
        <span class="quiz__kicker">当前关卡</span>
        <h2 class="quiz__title">{{ activeLevel ? nameOf(activeLevel.kpId) : '还没选关卡' }}</h2>
      </div>
      <div v-if="activeLevel" class="quiz__chips">
        <el-tag v-if="activeLevel.badge" size="small" effect="plain" round :title="activeLevel.badge">
          徽章 {{ badgeTier(activeLevel.badge) }}
        </el-tag>
        <el-tag v-if="questionCountLabel" size="small" effect="plain" round data-testid="quiz-source-count">{{ questionCountLabel }}</el-tag>
        <el-tag v-if="sourceLabel" size="small" effect="plain" round>{{ sourceLabel }}</el-tag>
        <!-- kp_id：**教师 / 答辩视角**才有。学生视角里去掉它 ——
             标题已经写着这一关的中文名，裸 slug（`ai-definition-jr`）是内部标识，不是他的语言。 -->
        <TeacherGate>
          <code class="quiz__kp">{{ activeLevel.kpId }}</code>
        </TeacherGate>
      </div>
    </header>

    <!-- ── 题目：全宽。作答草稿在页面里，判分状态在 store 里 ───────────────
         ★ 一关都没有时**整块不渲染**（见 `showQuestionPanel`）：那时这张卡只能写
           「先选一关」，而上面根本没有关卡可选 —— 空态留给关卡区那一句灰字。 -->
    <SurfacePanel v-if="showQuestionPanel" class="quiz__card" shine>
      <!-- ① 进度没读上来 / 读取中 / 还没选关卡：三种"题区为空"的原因分开说，
           不让取数失败看起来像"学生还没选关卡"。 -->
      <EmptyState
        v-if="!activeLevel && (quiz.bridgeError || quiz.progressError)"
        tone="error"
        title="闯关进度没读上来"
        :desc="quiz.bridgeError ?? quiz.progressError ?? ''"
      />

      <EmptyState
        v-else-if="!activeLevel && quiz.progressLoading"
        tone="loading"
        title="正在读取闯关进度…"
      />

      <EmptyState
        v-else-if="!activeLevel"
        title="先选一关"
        desc="上面每一关是一批知识点，选一关就能开始作答。"
      />

      <!-- ② 取题中 -->
      <!-- 取题中：只说「正在发生什么 + 学生得到什么承诺」。
           旧文案「题目来自本地题库（答案留在后端，不下发到界面）」是**我们的实现**，
           不是学生需要知道的（答案不在界面上的**承诺**另有表述）。 -->
      <EmptyState
        v-else-if="quiz.bankLoading && !quiz.bank"
        tone="loading"
        title="正在取题…"
        desc="题目马上就好，答案不会出现在界面上，放心自己练。"
      />

      <!-- ③ 取题失败 -->
      <div v-else-if="quiz.bankError" class="quiz__fail" data-testid="quiz-bank-error">
        <Info :size="15" />
        <div class="quiz__fail-text">
          <p class="quiz__fail-title">这关的题目没取到</p>
          <p class="quiz__fail-msg">{{ quiz.bankError }}</p>
        </div>
        <el-button size="small" @click="quiz.loadBank(activeLevel.kpId)">重试</el-button>
      </div>

      <!-- ④ 这一关还没有题 -->
      <EmptyState
        v-else-if="questions.length === 0"
        title="这一关暂时没有题目"
        desc="可以先在对话里让老师现场出几道，或者换一关试试。"
      />

      <!-- ⑤ 题目：默认「一次一张」，也可切回「全部铺开」——
           两种排版**共用这一段模板**，差别只有「一次渲染几行」（`visibleRows`）。 -->
      <template v-else>
        <!-- 卡头：左侧是单卡模式的进度与题号步骤条，右侧是排版开关。
             ★ 开关是**对象级操作**（它作用的对象就是这张题卡），按 `docs/ui/版式契约.md` §7
               放卡头，不进页面顶部那排（那里只放导出 / 刷新这类页面级动作）。 -->
        <div class="qcard__head">
          <div v-if="layout === 'single'" class="qcard__progress">
            <span class="qcard__at k12-num" data-testid="quiz-position">
              第 {{ currentIndex + 1 }} / {{ questions.length }} 题
            </span>
            <!-- 题号步骤条：状态只读**后端判分结论**，而且**可点** ——
                 想回看哪一题、想重做哪一题，点哪一颗就到哪一题（不必按顺序翻）。 -->
            <ol class="steps" data-testid="quiz-steps">
              <li v-for="row in questionRows" :key="row.question.qid">
                <button
                  type="button"
                  class="step k12-tap"
                  :class="{ 'step--on': !showFinish && row.index === currentIndex }"
                  :data-state="stepState(row.attempt)"
                  :aria-current="!showFinish && row.index === currentIndex ? 'step' : undefined"
                  :aria-label="stepLabel(row.index, row.attempt)"
                  :data-testid="`quiz-step-${row.index + 1}`"
                  @click="goTo(row.index)"
                >
                  <span class="k12-num">{{ row.index + 1 }}</span>
                </button>
              </li>
            </ol>
          </div>
          <el-segmented
            v-model="layout"
            class="qcard__switch"
            :options="LAYOUT_OPTIONS"
            aria-label="题目显示方式"
            data-testid="quiz-layout-toggle"
          />
        </div>

        <ol v-if="!showFinish" ref="listRef" class="qlist" data-testid="quiz-questions">
          <li
            v-for="row in visibleRows"
            :key="row.question.qid"
            class="qitem"
            :data-testid="`quiz-question-${row.index + 1}`"
            :data-qid="row.question.qid"
            :data-type="row.question.type"
          >
            <div class="qitem__head">
              <span class="qitem__no">第 {{ row.index + 1 }} 题</span>
              <el-tag size="small" effect="plain" round>{{ QUIZ_TYPE_LABELS[row.question.type] }}</el-tag>
              <!-- ★ 这道题的来源（D-088）：教材配套题不标（那是默认），只标**智团团出的** -->
              <el-tag
                v-if="row.fromAssistant"
                size="small"
                effect="plain"
                round
                type="warning"
                data-testid="quiz-generated-badge"
              >智团团出的题</el-tag>
              <span v-if="row.attempt?.result" class="qitem__done">已判分</span>
            </div>

            <!-- `tabindex="-1"`：切卡后焦点落在这里（换卡是内容替换，不接管的话焦点会掉回 body，
                 键盘用户要从头 Tab 一遍才知道新题在哪）。它不进 Tab 顺序（-1），只作落点。 -->
            <p class="qitem__stem" tabindex="-1">{{ row.question.stem }}</p>

            <!-- 选择题：点选项即选中（提交的是选项文本；字母与原文后端都认） -->
            <div v-if="row.question.type === 'choice'" class="opts">
              <label
                v-for="(option, optionIndex) in row.question.options ?? []"
                :key="`${row.question.qid}-${optionIndex}`"
                class="opt"
                :class="{ 'opt--on': drafts[row.question.qid] === option }"
                data-testid="quiz-option"
              >
                <input
                  type="radio"
                  :name="`quiz-${row.question.qid}`"
                  :value="option"
                  :checked="drafts[row.question.qid] === option"
                  @change="pick(row.question.qid, option)"
                />
                <span class="opt__letter">{{ optionLetter(optionIndex) }}</span>
                <span class="opt__text">{{ option }}</span>
              </label>
            </div>

            <!-- 填空 / 代码填空：单空文本作答（代码填空用等宽字） -->
            <input
              v-else
              class="ans"
              :class="{ 'ans--code': row.question.type === 'code_blank' }"
              type="text"
              :value="drafts[row.question.qid] ?? ''"
              :placeholder="row.question.type === 'code_blank' ? '填进空里的代码，例如 + 或 +=' : '把你想到的答案写在这里'"
              spellcheck="false"
              data-testid="quiz-answer-input"
              @input="onInput(row.question.qid, $event)"
            />

            <!-- 主提交键：走设计系统的 `.k12-cta`（全站主要动作只有一份配方）。
                 文案与禁用见 `submitLabel` / `submitDisabled`：答对即终态（「已完成」+禁用），
                 答错仍可点（「再试一次」）。
                 ⚠️ 旧的「判分在本地完成，答案不下发到界面」是**判分实现说明**，
                 已从学生视角去掉（答案是否下发是承诺、不是机制，页面上别用机制去证明它）。 -->
            <div class="qitem__foot">
              <button
                type="button"
                class="k12-cta"
                data-testid="quiz-submit"
                :disabled="submitDisabled(row.attempt)"
                @click="submit(row.question.qid, row.index)"
              >
                {{ submitLabel(row.attempt) }}
              </button>
            </div>

            <!-- 逐题错误（传输层失败 / 判分端点报错）：原样显示服务端那句话 -->
            <p v-if="row.attempt?.error" class="qitem__err" role="alert" data-testid="quiz-answer-error">
              {{ row.attempt?.error }}
            </p>

            <!-- 逐题反馈：结论全部来自后端判分，前端只展示 -->
            <div v-if="row.attempt?.result" class="fb" data-testid="quiz-feedback">
              <span class="fb__verdict" :data-ok="row.attempt.result.correct">
                {{ row.attempt.result.correct ? '答对了' : '再想一想' }}
              </span>
              <span class="fb__chip">{{ formatMasteryDelta(row.attempt.result.masteryDelta) }}</span>
              <span class="fb__chip">{{ SCORED_BY_LABELS[row.attempt.result.scoredBy] }}</span>
              <p class="fb__text">{{ row.attempt.result.feedback }}</p>
            </div>
          </li>
        </ol>

        <p v-if="localHint" class="qlist__hint" data-testid="quiz-hint">{{ localHint }}</p>

        <!-- 「还想再练练」：列表模式渲染在题目列表**之后** —— 题变长，按钮跟着列表末端
             走（DOM 顺序天然如此，没有任何定位 / 测量逻辑）。单卡模式见收尾卡的动作区。 -->
        <div v-if="layout === 'list' && canRequestMore" class="qmore" data-testid="quiz-more-list">
          <el-button
            :loading="quiz.moreGenerating"
            :disabled="quiz.moreGenerating"
            data-testid="quiz-more-list-btn"
            @click="requestMore()"
          >
            {{ moreButtonLabel }}
          </el-button>
          <p v-if="quiz.moreNotice" class="qmore__note">{{ quiz.moreNotice }}</p>
          <p v-if="quiz.moreError" class="qmore__error" role="alert">{{ quiz.moreError }}</p>
          <TeacherGate label="「还想再练练」的题从哪来">
            <p class="qmore__note">
              点这个按钮会把本轮全部题目的作答轨迹随请求上行；主进程据此现场生成 10 道续练题，
              先登记到这名学生自己的题库（先登记、后下发），再把无答案的题目追加到列表尾部。
              自动阶段的配额是 20（内置 + 生成），点过这个按钮之后解除。
            </p>
          </TeacherGate>
        </div>

        <!-- 卡脚：单卡模式的「上一题 / 下一题」。
             ★ 它们**不用** `.k12-cta`：一屏只允许一个主色填充（这一屏的主行动是「提交这题」），
               而且 `scripts/verify-guard-mutations.mjs` 的 ⑤ 只替换第一处 `.k12-cta` ——
               多一处会让那条变异验证静默失效。 -->
        <div v-if="layout === 'single' && !showFinish" class="qcard__foot" data-testid="quiz-nav">
          <el-button :disabled="currentIndex === 0" data-testid="quiz-prev" @click="prevQuestion()">
            上一题
          </el-button>
          <el-button
            :disabled="!currentSettled"
            :title="currentSettled ? '换到下一题' : '答对这一题，就能往下走'"
            data-testid="quiz-next"
            @click="nextQuestion()"
          >
            下一题
          </el-button>
        </div>

        <!-- 收尾卡：一关走完（最后一题答对 + 点了「下一题」）。
             题目与卡脚这时都不渲染，所以这里那个 `.k12-cta` 是**这一屏唯一的**主色按钮。 -->
        <div
          v-if="showFinish"
          ref="finishRef"
          class="qcard__finish"
          data-testid="quiz-finish"
          tabindex="-1"
        >
          <p class="qcard__finish-title">这一关做完了</p>
          <p class="qcard__finish-score k12-num" data-testid="quiz-finish-score">
            答对 {{ correctRows.length }} / 共 {{ questions.length }} 题
          </p>
          <p v-if="firstUnsettledIndex >= 0" class="qcard__finish-left">
            还有 {{ questions.length - correctRows.length }} 题没做对
          </p>
          <div class="qcard__finish-actions">
            <el-button
              v-if="firstUnsettledIndex >= 0"
              data-testid="quiz-finish-back"
              @click="backToUnsettled()"
            >
              回去接着做
            </el-button>
            <el-button data-testid="quiz-finish-summary" @click="historyOpen = true">看本轮小结</el-button>
            <!-- 关卡顺序是**服务端给的拓扑序**（前端不排序）；已经是最后一关就不渲染这个按钮 ——
                 不摆一个点了没反应的入口。 -->
            <button
              v-if="nextLevel"
              type="button"
              class="k12-cta"
              data-testid="quiz-finish-next-level"
              @click="goNextLevel()"
            >
              去下一关：{{ nameOf(nextLevel.kpId) }}
            </button>
            <!-- ★ 次要动作必须用 el-button：这个动作区里已经有 `.k12-cta`（去下一关），
                 一屏只允许一个主色填充，且变异脚本 ⑤ 只替换第一处 `.k12-cta`。 -->
            <el-button
              v-if="canRequestMore"
              :loading="quiz.moreGenerating"
              :disabled="quiz.moreGenerating"
              data-testid="quiz-more-single"
              @click="requestMore()"
            >
              {{ moreButtonLabel }}
            </el-button>
          </div>
          <p v-if="quiz.moreNotice" class="qmore__note">{{ quiz.moreNotice }}</p>
          <p v-if="quiz.moreError" class="qmore__error" role="alert">{{ quiz.moreError }}</p>
        </div>
      </template>
    </SurfacePanel>

    <!-- ── 掌握度：移到题目**下方**横向铺开（不再与题目并排争焦点）──────
         ★ 没有行可显示时**整块不渲染**（报告 1.6：空数据不摆空仪表盘）——
           于是这里不再有「还没有关卡数据…」那句无数据的灰字：它已经不可能被渲染到。 -->
    <SurfacePanel v-if="masteryRows.length > 0" class="mastery">
      <header class="mastery__head">
        <span class="mastery__title">本关与相邻关卡的掌握度</span>
        <!-- 括号里原来是「（服务端进度里的 mastery）」—— 字段名对学生的意义 = 没有。
             学生要回答的问题是「这个百分比是哪来的、算不算数」：答案是「每次答完题自动累加」。 -->
        <span class="mastery__meta">每次答题后自动更新</span>
      </header>
      <!-- 百分比**只留在这里**（报告 2.3：点开后的明细可以有数字，关卡卡片上没有） -->
      <div class="mastery__rows" data-testid="quiz-mastery">
        <div v-for="row in masteryRows" :key="row.kpId" class="mrow">
          <div class="mrow__top">
            <span class="mrow__role">{{ row.role }}</span>
            <span class="mrow__name">{{ row.name }}</span>
            <span class="mrow__pct k12-num">{{ row.percent }}%</span>
          </div>
          <el-progress
            :percentage="row.percent"
            :stroke-width="6"
            :show-text="false"
            :color="barColor(row.percent)"
            class="mrow__bar"
          />
        </div>
      </div>
    </SurfacePanel>

    <!-- ── 判分说明：收进折叠（默认折叠，它不该和题目抢注意力）──────────
         「客观题规则判分 / 主观题模型判分」已由身份行的 meta 说了，
         这里只放它装不下的机制细节，避免同一句话说两遍。 -->
    <SurfacePanel class="howto" flush>
      <el-collapse class="howto__collapse">
        <!-- 学生视角：只回答他真会问的两件事 —— 「掌握度怎么变」「同一题再答会怎样」
             （第二句是**判分口径的实话**：首次作答决定，重复提交只更新结论、不重复计分）。 -->
        <el-collapse-item title="判分与掌握度说明" name="how">
          <p class="howto__p">
            每题提交后马上判分，掌握度会跟着变一点：答对往上、答错往下，单次变化有上限
            （答得再好也不会一次从 0 涨满）。同一道题重复提交只更新这题的结论，
            正确率与掌握度不会因此重复计分，<strong>第一次作答</strong>才是计分的那一次。
          </p>
          <p class="howto__p">答案与解析不会出现在界面上，判分之后才会以反馈的形式告诉你思路。</p>

          <!-- ★ 上面那些**机制**（字段名、端点、IPC 链路）挪进教师 / 答辩视角：
               它们是这套判分链路「设计合理性」那一项的证据，一条都没删，只是换了读者。 -->
          <TeacherGate label="判分链路的机制细节">
            <p class="howto__p">
              掌握度变化限幅 ±0.2（防一次答题从 0 到 1）。
              题库里的标准答案只保留在 Python 侧，发给界面的一律是无 <code>answer</code> 的
              <code>QuizQuestionOut</code>（解析也不下发 —— 它往往直接写着答案，只在判分后的
              <code>feedback</code> 里出现）。提交后经 IPC → sidecar <code>/api/quiz/grade</code> 判分，
              返回 <code>QuizResult</code>（含 <code>masteryDelta</code>）；同一题重交只更新结论，
              不会把正确率重复计数。
            </p>
          </TeacherGate>
        </el-collapse-item>
      </el-collapse>
    </SurfacePanel>
    </section>

    <!-- 本轮小结抽屉：二级界面。遮罩 + 从右滑入的实色面板。 -->
    <Teleport to="body">
      <div v-if="historyOpen" class="hw" @click.self="historyOpen = false">
        <aside ref="drawerRef" class="hw__panel" role="dialog" aria-modal="true" aria-label="本轮判分小结">
          <header class="hw__head">
            <History :size="16" />
            <div class="hw__head-text">
              <p class="hw__title">本轮判分小结</p>
              <p class="hw__sub" data-testid="quiz-summary-line">
                本轮已判分 {{ quiz.gradedCount }} 题 · 对 {{ quiz.correctCount }} 题
                <template v-if="accuracyPercent !== null"> · 正确率 {{ accuracyPercent }}%</template>
              </p>
            </div>
            <button type="button" class="hw__close" title="关闭" aria-label="关闭" @click="historyOpen = false">
              <X :size="16" />
            </button>
          </header>

          <div class="hw__body">
            <!-- ⚠️ 只列**已判分**的题：没判过的题不占位（也不编造"未作答"的历史行）。 -->
            <p v-if="summaryRows.length === 0" class="hw__empty">
              这一关还没有判分的题目，提交一题之后这里会按题号列出它的判分结论。
            </p>

            <template v-else>
              <div
                v-for="row in summaryRows"
                :key="row.qid"
                class="hw__row"
                :data-testid="`quiz-summary-${row.index + 1}`"
              >
                <div class="hw__row-top">
                  <span class="hw__kp">第 {{ row.index + 1 }} 题 · {{ QUIZ_TYPE_LABELS[row.type] }}</span>
                  <!-- ⚠️ 放的是 **qid**，不是时间（这是**教师 / 答辩视角**才有的标识）：
                       契约里没有逐次作答的历史端点，库里那些带时间的记录只用于统计聚合，
                       前端读不到，所以不编造时间戳 —— 但**也不把 qid 摆给学生**：
                       `prog-loop-jr-q1` 对他没有任何意义（题号已经在左边写着了）。 -->
                  <TeacherGate>
                    <span class="hw__qid k12-num">{{ row.qid }}</span>
                  </TeacherGate>
                </div>
                <p class="hw__stem">{{ row.stem }}</p>
                <div class="hw__row-mid">
                  <span class="hw__score" :data-full="row.result.correct">
                    {{ row.result.correct ? '答对' : '再想一想' }}
                  </span>
                  <span class="hw__by">{{ SCORED_BY_LABELS[row.result.scoredBy] }}</span>
                  <span class="hw__delta" :data-up="row.result.masteryDelta >= 0">
                    {{ formatMasteryDelta(row.result.masteryDelta) }}
                  </span>
                </div>
                <p class="hw__fb">{{ row.result.feedback }}</p>
              </div>
            </template>

            <!-- 纯文本插值（不走 `markdown.ts`），所以这里**不能写星号**：
                 那一对 `**` 是原样渲染给学生的，读起来像排版坏了。
                 强调改用 `<strong>`；星号只留给模型输出那条通路（由 markdown.ts 解析）。 -->
            <p class="hw__note">
              这是<strong>本轮</strong>（这一关、这一次）的判分小结，按题号列出；换关卡即清零
              （已落库的判分结果不会被撤销）。对错由后端判分决定，答案与解析都不下发到界面。
            </p>
          </div>
        </aside>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* 两栏：左侧二级导航（大块 = 教材章节 → 小知识点）+ 右侧主区。
 * 每栏各自滚动，所以右栏的 PageActions 吸顶基准是 `.quiz__main`；
 * 内边距 18/22 与它的默认 `--pa-pad-y/x` 一致（无需覆盖那两个变量）。 */
.quiz {
  /* 左导航 + 右主区：两栏各自滚动（与智码工坊同一形态）。
   * ⚠️ 根容器必须给确定高度（.shell__content 是 flex 子项、有确定高度），
   *   否则右栏的 overflow-y: auto 不会生效。 */
  display: flex;
  height: 100%;
  min-height: 0;
}

/* ── 左：二级导航（大块 = 教材章节，块内 = 该章的小知识点）─────────────
 * 与智码工坊 .code__brief 同一形态：左栏只回答「我在哪 / 接下来去哪」，
 * 右栏才是这一页的主对象（题目）。
 * ★ 宽度钉死、内容一律 ellipsis，右栏 min-width: 0 —— 窄窗口压的是右栏，
 *   不允许出现横向滚动。 */
.quiz__nav {
  width: 268px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px 14px;
  border-right: 1px solid var(--k12-border);
  background: var(--k12-surface-2);
  overflow-y: auto;
  overflow-x: hidden;
}

/* ── 右：主区（PageActions 在这个滚动容器内 → 吸顶有效）───────────────
 * ⚠️ 内边距必须与 PageActions 的默认 --pa-pad-y / --pa-pad-x（18 / 22）一致，
 *   否则吸顶时会漏出 / 盖住内容。 */
.quiz__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--k12-gap);
  padding: 18px 22px 24px;
  overflow-y: auto;
}
/* ★★ 列里的每一块**不许被压扁**（2026-09-30 修，用户报「底部那条白条是什么」）。
 *   flex 列的默认 `flex-shrink: 1`：内容比容器高时，浏览器先**压缩子项**而不是
 *   让它溢出滚动 —— 实测最后那块「判分与掌握度说明」被从 56px 压成 **21px**，
 *   而它内部的折叠标题仍有 48px 且被卡片的圆角裁掉 ⇒ 屏幕上只剩一条**没有任何字的
 *   白条**（看起来像删代码留下的残渣，其实是布局被压缩）。
 *   判据：`overflow-y: auto` 的 flex 列里，子项一律 `flex: none` —— 空间不够时
 *   **滚动**，不许改写子项的高度。 */
.quiz__main > * {
  flex: none;
}

/* PageActions 里的按钮文字与计数 */
.btn__label {
  margin-left: 6px;
}
.btn__count {
  margin-left: 6px;
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
  font-variant-numeric: tabular-nums;
}

/* ── 取数失败横幅（页面级 / 题区级共用同一形状）────────────────────── */
.quiz__fail {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 13px 15px;
  border-radius: var(--k12-r-card);
  background: var(--k12-bad-soft);
  border: 1px solid var(--k12-bad-border);
  color: var(--k12-bad);
}
.quiz__fail-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.quiz__fail-title {
  font-size: var(--k12-fs-body-sm);
  font-weight: 650;
  color: var(--k12-fg);
}
.quiz__fail-msg {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}

/* ── 二级导航：大块（教材的一章）→ 块内小知识点 ────────────────────────
 * ★ 块名来自教材 chapterTitle，块序与块内关序来自服务端的路径顺序
 *   （study/workshop-path.ts 的 groupLevelsByChapter），本页不排序。 */
.qnav {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.qnav__head {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--k12-muted);
}
.qnav__ico {
  flex: none;
}
.qnav__label {
  font-size: var(--k12-fs-body-sm);
  font-weight: 650;
  color: var(--k12-fg-2);
}
.qnav__state {
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted-2);
}
/* 「边做边问」：与关卡标签同一行的次要动作（描边 chip 形态），推到左栏右端。 */
.qnav__ask {
  margin-left: auto;
  padding: 4px 10px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-family: inherit;
  font-size: var(--k12-fs-caption);
  font-weight: 600;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .qnav__ask:hover {
    border-color: var(--k12-accent-ink);
    color: var(--k12-accent-ink);
  }
}
/* 空态：对学生只说他的处境（现在没有可闯的关卡），机制在 TeacherGate 里。 */
.qnav__empty {
  padding: 8px 11px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface);
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
}
.qmods {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.qmod {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
/* 大块头：可点的折叠开关（.k12-tap 保底 28px 触控高度）。 */
.qmod__head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-control);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-body-sm);
  font-weight: 650;
  text-align: left;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .qmod__head:hover {
    border-color: var(--k12-accent-border);
    color: var(--k12-accent-ink);
  }
}
.qmod__head[data-open='true'] {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent-border);
  color: var(--k12-accent-ink);
}
/* 箭头：收起时向右、展开时向下 —— 形状本身说明「里面还有东西」。 */
.qmod__ico {
  flex: none;
  color: var(--k12-muted);
  transition: transform var(--k12-dur-state) var(--k12-ease-state);
}
.qmod__head[data-open='true'] .qmod__ico {
  color: var(--k12-accent-ink);
}
.qmod__ico[data-open='true'] {
  transform: rotate(90deg);
}
@media (prefers-reduced-motion: reduce) {
  :root:not([data-k12-reduced-motion='off']) .qmod__ico {
    transition: none;
  }
}
.qmod__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.qmod__count {
  flex: none;
  font-size: var(--k12-fs-caption);
  font-weight: 600;
  color: var(--k12-muted);
}
.qmod__head[data-open='true'] .qmod__count {
  color: var(--k12-accent-ink);
}
.qpath {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.qpath__item {
  min-width: 0;
}
.qpath__btn {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: var(--k12-r-inset);
  background: transparent;
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-body-sm);
  text-align: left;
  cursor: pointer;
  min-height: 30px;
}
@media (hover: hover) and (pointer: fine) {
  .qpath__btn:hover {
    background: var(--k12-surface);
    border-color: var(--k12-border);
  }
}
/* 三档进度：颜色 + 图标形状（stageMeta 的 icon）一起区分（与旧关卡条同一口径）。 */
.qpath__ico {
  flex: none;
}
.qpath__ico[data-stage='mastered'] {
  color: var(--k12-good);
}
.qpath__ico[data-stage='quizzed'] {
  color: var(--k12-accent-ink);
}
.qpath__ico[data-stage='learning'] {
  color: var(--k12-warn);
}
.qpath__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 状态词是 meta —— 12px，不是 11px（11px 只许给角标）。 */
.qpath__stage {
  flex: none;
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
  white-space: nowrap;
}
/* 徽章：≤4 字的角标 —— 11px 只在这一档允许，原始文本在 title 里。 */
.qpath__badge {
  flex: none;
  padding: 1px 6px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
  font-size: var(--k12-fs-label);
  font-weight: 650;
  white-space: nowrap;
}
/* 选中：整行 accent-soft 底 + accent 边（沿用原关卡 chip 的选中材质）。 */
.qpath__item--on .qpath__btn {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent-border);
}
.qpath__item--on .qpath__name {
  color: var(--k12-accent-ink);
  font-weight: 650;
}
.qpath__item--on .qpath__stage {
  color: var(--k12-accent-ink);
}
/* ── 教师 / 答辩视角里那两段说明（学生视角整块不渲染）─────────────────
 * ⚠️ 里面**不自带底色 / 内边距**：TeacherGate 已经给了一个浅底虚线框，
 *   再叠一层同色底等于白叠。文字样式与页面其它 meta 一致（12px / muted）。 */
.qnav__note {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
}
.qnav__note--row {
  display: flex;
  align-items: flex-start;
  gap: 7px;
}
.qnav__note--row svg {
  flex: none;
  margin-top: 2px;
  color: var(--k12-muted-2);
}
.qnav__note code {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-caption);
  color: var(--k12-accent-ink);
}

/* ── 当前关卡标题（16px：块标题档，**不得**用 22px 与身份行争焦点）──── */
.quiz__head {
  display: flex;
  align-items: flex-end;
  gap: 14px;
}
.quiz__head-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.quiz__kicker {
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
}
.quiz__title {
  /* 当前关卡标题 = 区块标题档（h2 24px，优化报告 §2.1）。 */
  font-size: var(--k12-fs-h2);
  font-weight: 650;
  line-height: var(--k12-lh-tight);
  color: var(--k12-fg);
}
.quiz__chips {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
/* kp_id 是长标识（meta）→ 12px + 等宽 */
.quiz__kp {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-caption);
  padding: 2px 7px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
  color: var(--k12-accent-ink);
}

/* 题目卡片全宽：不设 max-width、不与任何东西并排 */
.quiz__card {
  max-width: none;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ── 卡头：单卡进度 + 题号步骤条 + 排版开关 ────────────────────────────────
 * 排版开关是**对象级操作**（作用对象就是这张题卡），按 `docs/ui/版式契约.md` §7 放这里，
 * 不进页面顶部那排（那里只放导出 / 刷新这类页面级动作）。 */
.qcard__head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.qcard__progress {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  min-width: 0;
}
.qcard__at {
  font-size: var(--k12-fs-caption);
  font-weight: 650;
  color: var(--k12-muted);
}
/* 题号步骤条：一颗 = 一题；**可点**（想回看哪一题就点哪一题）。
 * 高度由 `.k12-tap` 给（28px 触控下限），这里只定宽度与形状，不写死高度。 */
.steps {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin: 0;
  padding: 0;
  list-style: none;
}
.step {
  width: 28px;
  border-radius: var(--k12-r-flat);
  border: 1px solid var(--k12-border);
  background: var(--k12-surface-2);
  color: var(--k12-muted);
  font-size: var(--k12-fs-caption);
  font-weight: 650;
  cursor: pointer;
}
/* 状态色（只读后端判分结论）：答对 = good、还没做对 = warn、还没做 = 中性。
 * 「我在哪一题」是另一个问题 —— 用 `.step--on` 的 accent 描边表达，两者不互相顶掉。 */
.step[data-state='correct'] {
  border-color: var(--k12-good);
  background: color-mix(in srgb, var(--k12-good) 14%, var(--k12-surface));
  color: var(--k12-fg);
}
.step[data-state='wrong'] {
  border-color: var(--k12-warn-border);
  background: var(--k12-warn-soft);
  color: var(--k12-warn);
}
.step--on {
  border-color: var(--k12-accent-ink);
  box-shadow: 0 0 0 2px var(--k12-accent-soft);
}
.step:focus-visible {
  outline: 2px solid var(--k12-accent);
  outline-offset: 2px;
}
/* 开关推到卡头右端（列表模式下卡头里只有它一个，也仍然靠右）。 */
.qcard__switch {
  margin-left: auto;
}

/* ── 题目列表 ────────────────────────────────────────────────────────── */
.qlist {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin: 0;
  padding: 0;
  list-style: none;
}
/* 每道题 = 白卡（`SurfacePanel.quiz__card`）里的一块**浅灰嵌入面**。
 * ★ 报告 4.1/4.2：这里原来是「浅灰底 + 1px 边框」的完整卡片，套在已经是白底 + 边框 + 投影的
 *   SurfacePanel 里 → 卡中卡（边框不携带层级）。改法是**去掉它的描边，留底色**：
 *   边框属于外层那张卡，内层靠一块 soft 面就够分层（报告 4.3「闯关每题盒保留」）。
 * ⚠️ 反过来（留边框、去底色）会把选项行变成白底白面 —— 选项就完全没有边界了。
 * ⚠️ `.fb`（逐题反馈）留着它的描边：它是这一块里唯一的「结论」面，不是纯说明。 */
.qitem {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
}
.qitem__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.qitem__no {
  font-size: var(--k12-fs-caption);
  font-weight: 650;
  color: var(--k12-muted);
}
.qitem__done {
  font-size: var(--k12-fs-caption);
  font-weight: 600;
  color: var(--k12-good);
}
/* 题干 = 这一块的主对象：14px 正文，行高放宽（题干常带代码与换行） */
.qitem__stem {
  font-size: var(--k12-fs-body);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg);
  white-space: pre-wrap;
  word-break: break-word;
}
/* 题干同时是切卡后的**焦点落点**（模板上的 `tabindex="-1"`）：只在键盘路径上露一圈环。
 * outline 不参与布局，所以这一圈不会把题干挤动一个像素。 */
.qitem__stem:focus-visible {
  outline: 2px solid var(--k12-accent);
  outline-offset: 2px;
}
.opts {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* 选项行：浅灰题块上的一片可点白面（报告 4.3「选项行可减描边（仅选中态有边）」）。
 * ★ 未选中时**没有可见描边**（`transparent` 而不是删掉 border —— 这样 hover / 选中
 *   加边时**不会挤动文字**，几何一个字不变）；hover 与选中态仍各有自己的边。 */
.opt {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 9px 12px;
  border-radius: var(--k12-r-inset);
  border: 1px solid transparent;
  background: var(--k12-surface);
  cursor: pointer;
  font-size: var(--k12-fs-body);
  line-height: var(--k12-lh-body);
}
@media (hover: hover) and (pointer: fine) {
  .opt:hover {
    border-color: var(--k12-accent-ink);
  }
}
.opt--on {
  border-color: var(--k12-accent-ink);
  background: var(--k12-accent-soft);
}
.opt input {
  margin-top: 4px;
  accent-color: var(--k12-accent);
}
/* 选项字母 A/B/C 是角标语义（只有一个字母）→ 11px 允许 */
.opt__letter {
  font-size: var(--k12-fs-label);
  font-weight: 650;
  color: var(--k12-muted);
}
.opt__text {
  flex: 1;
  min-width: 0;
  word-break: break-word;
}
.ans {
  width: 100%;
  padding: 10px 12px;
  border-radius: var(--k12-r-inset);
  border: 1px solid var(--k12-border-strong);
  background: var(--k12-surface);
  font: inherit;
  font-size: var(--k12-fs-body);
  color: var(--k12-fg);
}
.ans--code {
  font-family: var(--k12-font-mono);
}
.ans:focus-visible {
  outline: 2px solid var(--k12-accent-border);
  outline-offset: 1px;
}
/* 提交键独占这一行（原来旁边还挂着「判分在本地完成」那句实现说明，已去掉）。 */
.qitem__foot {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.qitem__err {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body);
  color: var(--k12-bad);
}
.qlist__hint {
  font-size: var(--k12-fs-caption);
  color: var(--k12-warn);
}

/* ── 「还想再练练」（列表尾部 / 收尾卡动作区共用）─────────────────────────
 * 次要动作走 el-button（不用 .k12-cta）；列表模式下它就是一个普通块级元素，
 * 跟在 .qlist 之后 → 题目追加后天然随列表末端下移，不需要任何定位逻辑。 */
.qmore {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}
/* 降级 / 失败的行内说明（不摆错误卡）：一句学生能读懂的话。 */
.qmore__note {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
}
.qmore__error {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-ui);
  color: var(--k12-bad);
}

/* ── 卡脚：单卡模式的上一题 / 下一题 ──────────────────────────────────────
 * 它们是**次要动作**（这一屏的主色填充是「提交这题」）：走 `el-button`，
 * 不用 `.k12-cta`（一屏只允许一个主色填充，且变异脚本 ⑤ 只替换第一处 `.k12-cta`）。 */
.qcard__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

/* ── 收尾卡：一关走完的最后一张卡（题体与卡脚这时都不渲染）──────────────── */
.qcard__finish {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 12px 14px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
}
.qcard__finish:focus-visible {
  outline: 2px solid var(--k12-accent);
  outline-offset: 2px;
}
/* 18px = 卡片 / 区块标题档（`docs/ui/版式契约.md` §1），仍远低于 24px 的身份行。 */
.qcard__finish-title {
  font-size: var(--k12-fs-body-lg);
  font-weight: 650;
  color: var(--k12-fg);
}
.qcard__finish-score {
  font-size: var(--k12-fs-body);
  font-weight: 650;
  color: var(--k12-fg);
}
.qcard__finish-left {
  font-size: var(--k12-fs-body-sm);
  color: var(--k12-muted);
}
.qcard__finish-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

/* 逐题反馈：结论来自后端判分，前端只摆出来 */
.fb {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
}
.fb__verdict {
  font-size: var(--k12-fs-caption);
  font-weight: 650;
  color: var(--k12-warn);
}
.fb__verdict[data-ok='true'] {
  color: var(--k12-good);
}
.fb__chip {
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
  font-variant-numeric: tabular-nums;
}
.fb__text {
  flex: 1 1 100%;
  font-size: var(--k12-fs-body-sm);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
  word-break: break-word;
}

/* ── 掌握度：题目下方横向铺开 ────────────────────────────────────────── */
.mastery {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.mastery__head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.mastery__title {
  font-size: var(--k12-fs-body-sm);
  font-weight: 650;
  color: var(--k12-fg-2);
}
.mastery__meta {
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
}
.mastery__rows {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.mrow {
  flex: 1 1 200px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mrow__top {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
/* 「本关 / 上一关 / 下一关」是 ≤4 字的角标 → 11px 允许 */
.mrow__role {
  flex: none;
  padding: 1px 6px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
  font-size: var(--k12-fs-label);
  font-weight: 650;
  color: var(--k12-muted);
}
.mrow__name {
  flex: 1;
  min-width: 0;
  font-size: var(--k12-fs-body-sm);
  color: var(--k12-fg-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mrow__pct {
  flex: none;
  font-size: var(--k12-fs-caption);
  font-weight: 650;
  color: var(--k12-fg-2);
  font-variant-numeric: tabular-nums;
}
.mrow__bar {
  width: 100%;
}

/* ── 判分说明（折叠：13px 标题 / 12px 正文）────────────────────────── */
.howto {
  padding: 2px 14px 6px;
}
.howto__collapse {
  border: none;
}
.howto__p {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
.howto__p code {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-caption);
  padding: 1px 5px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
  color: var(--k12-accent-ink);
}

/* ── 本轮小结抽屉 ────────────────────────────────────────────────────── */
.hw {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  justify-content: flex-end;
  background: color-mix(in srgb, var(--k12-fg) 30%, transparent);
}
.hw__panel {
  width: min(440px, 92vw);
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--k12-surface);
  border-left: 1px solid var(--k12-border-strong);
  box-shadow: var(--k12-shadow-float);
}
.hw__head {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--k12-border);
  color: var(--k12-muted);
}
.hw__head-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.hw__title {
  font-size: var(--k12-fs-body-lg);
  font-weight: 650;
  color: var(--k12-fg);
}
.hw__sub {
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
}
.hw__close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: var(--k12-r-inset);
  background: transparent;
  color: var(--k12-muted);
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .hw__close:hover {
    background: var(--k12-surface-2);
    color: var(--k12-fg-2);
  }
}
.hw__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.hw__empty {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body);
  color: var(--k12-muted);
}
.hw__row {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 12px 13px;
  border-radius: var(--k12-r-card);
  background: var(--k12-surface-2);
}
.hw__row-top {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.hw__kp {
  flex: 1;
  min-width: 0;
  font-size: var(--k12-fs-body-sm);
  font-weight: 650;
  color: var(--k12-fg);
}
/* 题号 / qid / 判分方 / 掌握度增减 / 脚注：都是 meta → 12px */
.hw__qid {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
}
.hw__stem {
  font-size: var(--k12-fs-body-sm);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
  word-break: break-word;
}
.hw__row-mid {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.hw__score {
  font-size: var(--k12-fs-caption);
  font-weight: 650;
  color: var(--k12-warn);
}
.hw__score[data-full='true'] {
  color: var(--k12-good);
}
.hw__by {
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
}
.hw__delta {
  margin-left: auto;
  font-size: var(--k12-fs-caption);
  font-weight: 650;
  color: var(--k12-bad);
}
.hw__delta[data-up='true'] {
  color: var(--k12-good);
}
.hw__fb {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
  word-break: break-word;
}
.hw__note {
  margin-top: 4px;
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body);
  color: var(--k12-muted);
}
</style>
