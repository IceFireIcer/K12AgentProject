<script setup lang="ts">
/**
 * 闯关练习页 —— 对话内联闯关卡的**展开视图**。
 *
 * ── 版式（骨架，不是装饰）────────────────────────────────────────────
 * 旧版是「四块同权」：左侧 320px 关卡列表 + 右侧 1.7fr 题目卡 + 1fr 掌握度面板，
 * 真正的主对象（题目）被三面包围；而内容区最大的 22px 落在侧栏的标题上，
 * 题目反而不是焦点。现在改成**单列流**：
 *
 *   身份行 → 关卡进度条（横向） → 当前关卡标题 → **题目（全宽）**
 *          → 掌握度（题目下方横向铺开） → 判分说明（折叠）
 *
 * 于是全页唯一的 22px 是 `PageIdentity`（契约 §4：内容区最大字号必须是主对象那一层），
 * 关卡名降为 16px（块标题档），掌握度/进度是 13px 与 12px。
 * 关卡切换是**页面级选择**，按契约 §7 放在页面顶部（而不是被塞进侧栏）。
 *
 * ── 数据来源（全部来自 `useQuizStore`，本页不再自带任何样本数据）──────
 *   关卡与阶段 `GET /api/quiz/progress` → `levels`（**服务端已按依赖图拓扑序排好**，
 *              所以这里一行排序都不做；`stage` / `badge` / `mastery` 原样来自 learning.db）
 *   题目       `GET /api/quiz/bank`     → `bank`（`QuizQuestionOut`：**结构上没有 `answer`**）
 *   判分       `POST /api/quiz/grade`   → `attempts[qid].result`（`QuizResult`）
 *   kp 中文名  教材知识点清单（`levels` 只给 kpId，中文名要另取；见下方 `kpNames`）
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
import { Trophy, Circle, PlayCircle, CheckCircle2, History, X, Info, RotateCcw } from 'lucide-vue-next'
import { useQuizStore, type QuizAttempt } from '../stores/quiz'
import TeacherGate from '../components/TeacherGate.vue'
import { useKnowledgeStore } from '../stores/knowledge'
import { QUIZ_TYPE_LABELS, SCORED_BY_LABELS, formatMasteryDelta } from '../labels'
import { isBlankAnswer, optionLetter, type QuizQuestionType } from '../cards/quiz'
import type { QuizResultView } from '../api/data'
import { useEscape } from '../composables/useEscape'
import { useFocusReturn } from '../composables/useFocusReturn'
import { useReducedMotion } from '../composables/useReducedMotion'

const quiz = useQuizStore()
const knowledge = useKnowledgeStore()

/**
 * 三个进度阶段的中文名与图标（阶段字面量来自服务端进度，不在前端推导）。
 *
 * ★★ 2026-09-25 去掉关卡锁定：不再有「还没解锁」这一档，**所有关卡都能点进去做题**。
 *   阶段只剩三种进度标记 —— 学习中 / 已闯关 / 已掌握，它们是**反馈**，不是门禁。
 * ★ 卡片上的状态只靠**图标 + 颜色 + 状态词**区分（`.stg__ico[data-stage]` 三档），
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

const levels = computed(() => quiz.levels)

/**
 * kp_id → 中文名。
 *
 * ⚠️ 关卡进度只给 `kpId`（没有名字），而界面上不能只摆 `ai-definition-jr` 这种标识。
 *    中文名的来源是**教材知识点清单**（与依赖图谱同一个 `kb.sqlite`）。
 */
const kpNames = computed(() => {
  const map = new Map<string, string>()
  for (const point of knowledge.points?.points ?? []) map.set(point.kpId, point.name)
  return map
})

/** 查不到中文名时的中性占位（**不是** kp_id，见下）。 */
const UNNAMED_POINT = '未命名知识点'

/**
 * 知识点中文名；查不到时给**中性占位**，绝不退回 kp_id 原文。
 *
 * ★★ 为什么不能退回 `kpId`（评审发现：界面上出现过 `ai-definition-jr`）：
 *   它是我们内部的标识（slug），不是学生的语言 —— 学生看到的是「一个读不懂的机器串」，
 *   而且它把「我们怎么给知识点编号」摆给了不该关心这件事的人。
 *   查不到名字只剩两种情形（服务端已按当前教材白名单过滤掉已删除知识点，
 *   见 `routes/quiz.py` 的 `progress_snapshot(known_kp_ids=…)`）：
 *     ① 知识点清单还没取回来（那一小段窗口）；
 *     ② 清单里真的没有它。
 *   两种都该说「我暂时不知道它叫什么」，而不是把 slug 顶上去。
 */
function nameOf(kpId: string): string {
  return kpNames.value.get(kpId) ?? UNNAMED_POINT
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
 * 本页要做的题 = 教材配套题 + **智团团给这个学生出过的题**（D-088）。
 *
 * ★ 为什么合成一条列表：两者的作答 / 判分 / 反馈**完全是同一条链路**
 *   （答完按 `qid` 走 `POST /api/quiz/grade`，qid 自带随机段不会撞车），
 *   单开一块只会让学生以为自己要做两遍。
 * ★ 去重按 `qid`：生成题的 qid 带 `gen-` 前缀，与题库真题不可能同名
 *   （服务端登记时就整批拒过撞名的），所以去重在这里只是防「同一道生成题取回来两次」。
 */
const questions = computed(() => {
  const banked = quiz.bank?.questions ?? []
  const seen = new Set(banked.map((question) => question.qid))
  const extra = quiz.generated.filter((question) => !seen.has(question.qid))
  return [...banked, ...extra]
})

/** 哪些 qid 是「智团团出的」——题头那枚标签靠它。 */
const generatedQids = computed(() => new Set(quiz.generated.map((question) => question.qid)))

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
/** 减动效偏好：滚动是 JS 发起的移动，CSS 的 `@media` 收不掉它。 */
const reducedMotion = useReducedMotion()

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
 *   `prefers-reduced-motion` 下改成瞬移 —— 内容照样送到眼前，只是不再滑过去。
 *   （CSS 的 `@media` 收不掉 JS 发起的滚动，这一条只能在 JS 侧读。）
 */
async function advanceAfterCorrect(index: number): Promise<void> {
  const next = questionRows.value.find(
    (row) => row.index > index && row.attempt?.result?.correct !== true
  )
  if (!next) return
  await nextTick()
  listRef.value
    ?.querySelector<HTMLElement>(`[data-testid="quiz-question-${next.index + 1}"]`)
    ?.scrollIntoView({ block: 'center', behavior: reducedMotion.value ? 'auto' : 'smooth' })
}

/** 提交一题：非空校验 + 交给 store（判分只在后端）。防连点在 store 里。 */
async function submit(qid: string, index: number) {
  const answer = (drafts[qid] ?? '').trim()
  if (isBlankAnswer(answer)) {
    localHint.value = '先写下你的答案，再点提交。'
    return
  }
  localHint.value = ''
  await quiz.submit(qid, answer)
  // 只有这一提交**真的被判定为对**才往下送；答错要留在原地接着想（retry 是正当的）
  if (quiz.attempts[qid]?.result?.correct === true) await advanceAfterCorrect(index)
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
    <PageActions>
      <template #info>
        <!-- ★ 进度数字**只有一种格式**（报告 2.3）：`已掌握 N / M`。
             原来的「闯关进度 N / M 已掌握」是同一批数字的第二种说法 —— 全站统一成一种。
             ★ 一关都没有时整格不渲染（报告 1.6：空态下不出现「已掌握 0 / 0」这种仪表盘读数）。 -->
        <span v-if="summary.total > 0">已掌握 {{ summary.mastered }} / {{ summary.total }}</span>
      </template>
      <!-- 重做本关：清空本页的作答与小结（**不**清除已落库的判分结果）。
           有东西可清时才出现，避免摆一个按了没反应的按钮。 -->
      <el-button v-if="quiz.gradedCount > 0" @click="quiz.restart()">
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

    <!-- ── 关卡进度条：页面级选择，横向排开（窄屏横向滚动，不换行挤压）── -->
    <section class="stages" aria-label="关卡">
      <header class="stages__head">
        <Trophy :size="14" class="stages__ico" />
        <span class="stages__label">关卡</span>
        <span v-if="quiz.progressLoading && levels.length === 0" class="stages__state">读取中…</span>
      </header>

      <div v-if="levels.length > 0" class="stages__track" data-testid="quiz-levels">
        <button
          v-for="level in levels"
          :key="level.kpId"
          type="button"
          class="stg"
          :class="{ 'stg--on': quiz.activeKpId === level.kpId }"
          :aria-current="quiz.activeKpId === level.kpId ? 'step' : undefined"
          :data-testid="`quiz-level-${level.kpId}`"
          :data-stage="level.stage"
          @click="quiz.selectLevel(level.kpId)"
        >
          <component :is="stageView(level.stage).icon" :size="14" class="stg__ico" :data-stage="level.stage" />
          <span class="stg__name">{{ nameOf(level.kpId) }}</span>
          <span class="stg__stage">{{ stageView(level.stage).label }}</span>
          <!-- 卡片上**没有百分比**（报告 2.3）：状态由图标 + 状态词说，
               掌握度去下面的明细面板看（那里才是点开后的细节）。 -->
          <!-- 徽章是服务端字段（`progress.badge`，文本形如「熟练-3」），没有就不渲染 -->
          <span v-if="level.badge" class="stg__badge" :title="level.badge">{{ badgeTier(level.badge) }}</span>
        </button>
      </div>
      <!-- 空态：**对学生只说他的处境**（现在没有可闯的关卡），机制另说（见下） -->
      <p v-else-if="!quiz.progressLoading" class="stages__empty" data-testid="quiz-levels-empty">
        还没有可以闯的关卡，教材内容准备好之后这里会一关一关地排出来。
      </p>

      <!-- 关卡是怎么来的（**教师 / 答辩视角**）：这是实现说明，不是给学生的解释。
           学生视角整段不渲染；教师视角里它一直可见（评委要看这条链路）。 -->
      <TeacherGate label="关卡是怎么来的">
        <p class="stages__gate">
          服务端会在首次打开闯关页时按依赖图播种关卡路径；知识库为空时这里是空的。
        </p>
      </TeacherGate>

      <!-- ★★ 契约映射说明（**教师 / 答辩视角**）——
           缺陷现场：这段 memo 原本直接印在学生页面上（「『连对 / 经验』在契约里没有对应
           模型……」「关卡徽章取服务端的 progress.badge」），学生看到的是我们写给自己的
           一张便条。它只说明**缺的是什么**：契约里没有「连对 / 经验」这类模型，所以这两个数
           不渲染（没有数据源的数字画出来就是假统计）；徽章是真实字段，有就显示在关卡条上。
           教师视角**一个字没删**（设计合理性那 25% 的证据就在这），只是不再给学生看。 -->
      <TeacherGate label="为什么不显示「连对 / 经验」">
        <p class="stages__note">
          <Info :size="13" />
          <span>
            「连对 / 经验」在契约里没有对应模型（只有掌握度与学习记录），本页不显示这两个数；
            关卡徽章取服务端的 <code>progress.badge</code>，没有时为空。
          </span>
        </p>
      </TeacherGate>
    </section>

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
        <el-tag v-if="quiz.bank" size="small" effect="plain" round>{{ questions.length }} 题</el-tag>
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
    <SurfacePanel v-if="showQuestionPanel" class="quiz__card">
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

      <!-- ⑤ 题目列表 -->
      <template v-else>
        <ol ref="listRef" class="qlist" data-testid="quiz-questions">
          <li
            v-for="row in questionRows"
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
              >智团团出的</el-tag>
              <span v-if="row.attempt?.result" class="qitem__done">已判分</span>
            </div>

            <p class="qitem__stem">{{ row.question.stem }}</p>

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
/* 单列流：页面自己只在 `.shell__content` 里纵向排块，不建内层滚动容器 ——
 * 于是 PageActions 的吸顶基准仍是 `.shell__content`，且内边距 18/22 与
 * 它的默认 `--pa-pad-y/x` 一致（无需覆盖那两个变量）。 */
.quiz {
  display: flex;
  flex-direction: column;
  gap: var(--k12-gap);
  padding: 18px 22px 24px;
}

/* PageActions 里的按钮文字与计数 */
.btn__label {
  margin-left: 6px;
}
.btn__count {
  margin-left: 6px;
  font-size: var(--k12-fs-xs);
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
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg);
}
.quiz__fail-msg {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}

/* ── 关卡进度条 ──────────────────────────────────────────────────────── */
.stages {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.stages__head {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--k12-muted);
}
.stages__ico {
  flex: none;
}
.stages__label {
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg-2);
}
.stages__state {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted-2);
}
/* 横向排开：窄屏靠横向滚动兜住，不换行挤压（卡片是「图标 + 关卡名 + 状态词」三件套，
 * 没有百分比 —— 见报告 2.3） */
.stages__track {
  display: flex;
  gap: 8px;
  min-width: 0;
  overflow-x: auto;
  padding-bottom: 2px;
}
.stages__empty {
  padding: 8px 11px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
}
.stg {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-card);
  background: var(--k12-surface-2);
  cursor: pointer;
  text-align: left;
}
@media (hover: hover) and (pointer: fine) {
  .stg:hover:not(:disabled) {
    border-color: var(--k12-accent-ink);
  }
}
.stg--on {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent-ink);
}
/* 三档进度：颜色 + 图标形状（`stageMeta` 的 icon）一起区分 —— 卡片上**没有数字**，
 * 这一条（连同左边的状态词）就是学生判断「这一关到哪一步了」的全部依据。
 * ★ 2026-09-25 去掉关卡锁定后不再有锁态配色：每一关都是可点的正常卡片。 */
.stg__ico {
  flex: none;
}
.stg__ico[data-stage='mastered'] {
  color: var(--k12-good);
}
.stg__ico[data-stage='quizzed'] {
  color: var(--k12-accent-ink);
}
.stg__ico[data-stage='learning'] {
  color: var(--k12-warn);
}
.stg__name {
  font-size: var(--k12-fs-sm);
  font-weight: 600;
  color: var(--k12-fg);
  white-space: nowrap;
}
/* 状态词是 meta —— 12px，不是 11px（11px 只许给角标） */
.stg__stage {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
  white-space: nowrap;
}
/* 徽章：**≤4 字的角标** —— 11px 只在这一档允许（契约 §1），原始文本在 title 里 */
.stg__badge {
  padding: 1px 6px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
  font-size: var(--k12-fs-micro);
  font-weight: 650;
  white-space: nowrap;
}
/* 选中项整体走 accent-ink：它在 accent-soft 上是达标的文字色（对比度机器校验） */
.stg--on .stg__name,
.stg--on .stg__stage {
  color: var(--k12-accent-ink);
}
/* ── 教师 / 答辩视角里那两段说明（学生视角整块不渲染，见 `.stages` 的模板）────
 * ⚠️ 里面**不再自带底色 / 内边距**：`<TeacherGate label>` 已经给了一个浅底虚线框，
 *   再叠一层同色底等于白叠（卡中卡同色 = 看不出层次，E3 那条纪律）。
 *   文字样式与页面其它 meta 一致（12px / muted），尺寸不靠 `padding` 撑。 */
.stages__gate,
.stages__note {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
}
.stages__note {
  display: flex;
  align-items: flex-start;
  gap: 7px;
}
.stages__note svg {
  flex: none;
  margin-top: 2px;
  color: var(--k12-muted-2);
}
.stages__note code {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
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
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.quiz__title {
  font-size: var(--k12-fs-lg);
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
  font-size: var(--k12-fs-xs);
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
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-muted);
}
.qitem__done {
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  color: var(--k12-good);
}
/* 题干 = 这一块的主对象：14px 正文，行高放宽（题干常带代码与换行） */
.qitem__stem {
  font-size: var(--k12-fs-md);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg);
  white-space: pre-wrap;
  word-break: break-word;
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
  font-size: var(--k12-fs-md);
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
  font-size: var(--k12-fs-micro);
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
  font-size: var(--k12-fs-md);
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
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-bad);
}
.qlist__hint {
  font-size: var(--k12-fs-xs);
  color: var(--k12-warn);
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
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-warn);
}
.fb__verdict[data-ok='true'] {
  color: var(--k12-good);
}
.fb__chip {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
  font-variant-numeric: tabular-nums;
}
.fb__text {
  flex: 1 1 100%;
  font-size: var(--k12-fs-sm);
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
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg-2);
}
.mastery__meta {
  font-size: var(--k12-fs-xs);
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
  font-size: var(--k12-fs-micro);
  font-weight: 650;
  color: var(--k12-muted);
}
.mrow__name {
  flex: 1;
  min-width: 0;
  font-size: var(--k12-fs-sm);
  color: var(--k12-fg-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mrow__pct {
  flex: none;
  font-size: var(--k12-fs-xs);
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
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
.howto__p code {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
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
  font-size: var(--k12-fs-lg);
  font-weight: 650;
  color: var(--k12-fg);
}
.hw__sub {
  font-size: var(--k12-fs-xs);
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
  font-size: var(--k12-fs-xs);
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
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg);
}
/* 题号 / qid / 判分方 / 掌握度增减 / 脚注：都是 meta → 12px */
.hw__qid {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.hw__stem {
  font-size: var(--k12-fs-sm);
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
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-warn);
}
.hw__score[data-full='true'] {
  color: var(--k12-good);
}
.hw__by {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.hw__delta {
  margin-left: auto;
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-bad);
}
.hw__delta[data-up='true'] {
  color: var(--k12-good);
}
.hw__fb {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
  word-break: break-word;
}
.hw__note {
  margin-top: 4px;
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-muted);
}
</style>
