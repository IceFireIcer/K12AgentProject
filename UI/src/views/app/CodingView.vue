<script setup lang="ts">
/**
 * 编程环境页 —— 对话内联编程卡的**展开视图**。
 *
 * ── 这一版改的是**焦点**，不是装饰 ─────────────────────────────────────
 * 旧版左栏 340px 的「任务简报」把编辑区挤在右侧，而内容区最大的 22px 落在
 * 简报的**任务名**上（`.code__name`）—— 真正的编辑区反而没有焦点
 * （审计断言 7b / 7c 报「焦点倒置 / 缺身份行」）。现在：
 *
 *   ① **身份行**（`PageIdentity`，22px）成为全页唯一大字号：说这页在干什么 +
 *      主路径提示（D1）。关键信息「代码在学生机本地执行」从简报挪进它的 `meta`，
 *      留在最显眼处，不再靠折叠区承担。
 *   ② 简报从 340px **收窄到 268px**（保留它：它是任务的必要上下文，不该被删掉，
 *      但也不该挤住代码）。省下的 72px 全部给右侧编辑区。
 *   ③ 任务名降为 16px（块标题档），简报里的次级信息一律 12–13px。
 *   ④ 「代码在哪里执行 / 安全边界」这类机制与合规说明收进折叠（默认折叠，
 *      标题 13px / 内容 12px）：它不是每轮都要读的上下文，但接线时是硬约束 ——
 *      **折叠，不删**。
 *   ⑤ 步骤三态由 `tasks[].done` + `activeStep` 显式给出（不再让 EP 按 active 猜）：
 *      已完成 = 绿勾 + 绿标题 + 绿连线；当前 = accent-ink + 左侧强调线；
 *      未开始 = muted。三态在颜色 / 图标 / 强调线上都不同，不只差一个图标。
 *
 * 分工（避免同一件事两处实现）：
 *  - 左栏 = 任务简报（要做什么、期望输出、步骤、安全边界）；
 *  - 右侧 = `CodingCard` 本身（编辑区 / 运行 / 输出 / 分级求助都在卡里）。
 *    页面不再重写一份带状态的编辑器，否则「运行状态」会有两份、迟早对不上。
 *
 * ⚠️ Monaco / Pyodide 均未接入（用户决策）。代码区为高亮只读展示，
 * 「运行」给出的是标注过的示例输出。
 * 接线时硬约束：学生代码**绝不在主进程执行**，必须经 IPC 交给渲染进程的 Pyodide Worker。
 */
import { onBeforeUnmount, ref } from 'vue'
import { Lightbulb, FileText, FlaskConical, Download, Send, Check } from 'lucide-vue-next'
import PageIdentity from '@/components/PageIdentity.vue'
import CodingCard from '@/cards/CodingCard.vue'
import { codeTemplate, kpNames } from '@/mocks'

/** 步骤清单：真实版由后端按任务下发；此处与脚手架里的两个 TODO 对齐 */
const tasks = [
  { title: '把一组身高装进列表', done: true },
  { title: '用 sum() 求和得到 total', done: true },
  { title: '算出平均值并 print 出来', done: false }
]

const activeStep = ref(2)

/**
 * 下载代码（.py）。
 * 数据都在前端，所以**真的能下载** —— 不做"按了没反应"的假按钮。
 */
const downloaded = ref(false)
let dlTimer: number | null = null
function downloadCode() {
  const header = `# ${kpNames[codeTemplate.kpId] ?? codeTemplate.kpId}
# 期望输出：${codeTemplate.expectedBehavior}

`
  const blob = new Blob([header + codeTemplate.scaffold], { type: 'text/x-python;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${codeTemplate.kpId}.py`
  a.click()
  URL.revokeObjectURL(url)
  downloaded.value = true
  if (dlTimer !== null) clearTimeout(dlTimer)
  dlTimer = window.setTimeout(() => (downloaded.value = false), 1500)
}

/**
 * 提交批改：**状态机走完整**（idle → submitting → graded）。
 * 原型不真跑代码，但批改结果由 `CodingCard` 的"运行"给出示例输出；
 * 这里负责"提交"这一步的观感与去向说明，不假装模型判过分。
 */
type SubmitPhase = 'idle' | 'submitting' | 'graded'
const submitPhase = ref<SubmitPhase>('idle')
let submitTimer: number | null = null
function submitForReview() {
  if (submitPhase.value === 'submitting') return
  submitPhase.value = 'submitting'
  if (submitTimer !== null) clearTimeout(submitTimer)
  submitTimer = window.setTimeout(() => {
    submitPhase.value = 'graded'
    submitTimer = null
  }, 900)
}

onBeforeUnmount(() => {
  if (dlTimer !== null) clearTimeout(dlTimer)
  if (submitTimer !== null) clearTimeout(submitTimer)
})
</script>

<template>
  <div class="code">
    <!-- 左：任务简报。**收窄到 268px** —— 它是必要的任务上下文（保留），
         但旧版 340px 把编辑区挤成了配角；这里省下的宽度全给右侧。 -->
    <aside class="code__brief">
      <header class="code__brief-head">
        <FileText :size="15" />
        <span class="code__brief-title">任务简报</span>
        <el-tag size="small" type="info" effect="plain">Python</el-tag>
      </header>

      <!-- 任务名 = **块标题档（16px）**。不得回到 22px：那是身份行的档位，
           旧版正是它让简报标题抢了整页焦点（审计 7b）。 -->
      <h2 class="code__name">{{ kpNames[codeTemplate.kpId] ?? codeTemplate.kpId }}</h2>
      <!-- 「代码在本地执行」那句已上移到身份行的 meta（关键信息留在显眼处），
           这里不重复第二遍。 -->
      <p class="code__desc">把一组身高装进列表并算出平均值。</p>

      <el-descriptions :column="1" size="small" border class="code__desc-list">
        <el-descriptions-item label="期望输出">
          <code class="code__mono">{{ codeTemplate.expectedBehavior }}</code>
        </el-descriptions-item>
        <el-descriptions-item label="对应知识点">{{ codeTemplate.kpId }}</el-descriptions-item>
      </el-descriptions>

      <section class="code__sec">
        <span class="code__sec-label">完成步骤</span>
      </section>
      <!-- 三态**显式**给出：已完成走 EP 的 success（绿勾 + 绿标题 + 绿连线），
           当前步走 process（描边 + accent-ink + 浅底），未开始是 wait（muted）。
           `:active` 仍要传：EP 用它算**连接线的填充进度**（不算就退化成三根灰线）；
           而 `:status` 覆盖的是图标与标题色 —— 两者一起才让三态在
           图标 / 颜色 / 标题字重上都分得开，而不是只差一个图标。 -->
      <el-steps direction="vertical" :active="activeStep" class="code__steps">
        <el-step
          v-for="(t, i) in tasks"
          :key="t.title"
          :title="t.title"
          :status="t.done ? 'success' : i === activeStep ? 'process' : 'wait'"
          :class="{ 'code__step--current': !t.done && i === activeStep }"
        />
      </el-steps>

      <div class="code__hint-note">
        <Lightbulb :size="15" />
        <div>
          <p class="code__hint-title">分级求助</p>
          <p class="code__hint-text">
            卡住时用右侧卡片的「求助」，提示按 1 → 2 → 3 逐级给，不会一次把答案说满。
            第 3 级才会给出完整写法。
          </p>
        </div>
      </div>

      <!-- ── 机制 / 合规说明：默认折叠 ──────────────────────────────────
           它不是每次都要读的上下文，却写明了接线时的硬约束 —— 所以折叠、不删。
           ⚠️「代码在本地执行」这条**关键信息不靠它承担**：身份行的 meta 已写明。
           用 el-collapse 而不是自写手风琴：EP 的折叠有正确的 aria-expanded 与键盘
           语义；展开动效由 base.css 的 `--el-transition-duration: 0s` 归零 ——
           本版不做装饰性动效。 -->
      <el-collapse class="code__fold">
        <el-collapse-item name="runtime">
          <template #title>
            <span class="code__fold-t"><FlaskConical :size="14" />代码在哪里执行 · 安全边界</span>
          </template>
          <p class="code__fold-p">
            接线后的运行位置是<strong>渲染进程的 Pyodide Worker</strong>：学生代码经 IPC
            交过去执行，带超时中断（setInterruptBuffer），<strong>绝不在主进程运行</strong>，
            也不与 Python 侧车共享执行环境。
          </p>
          <p class="code__fold-p">
            本原型未接入运行引擎，所以「运行」给的是示例输出 —— 卡内已用「未真实执行」标注。
          </p>
        </el-collapse-item>
      </el-collapse>
    </aside>

    <!-- 右：编程卡（展开尺寸）。PageActions 仍在这个滚动容器内 → 吸顶有效，
         且它的默认内边距（18 / 22）与 .code__stage 的 padding 一致。 -->
    <section class="code__stage">
      <PageActions>
        <template #info>
          <span>题目 {{ codeTemplate.kpId }} · 期望输出 <code class="code__mono">{{ codeTemplate.expectedBehavior }}</code></span>
        </template>
        <el-button @click="downloadCode">
          <Check v-if="downloaded" :size="14" />
          <Download v-else :size="14" />
          <span class="btn__label">{{ downloaded ? '已下载' : '下载代码' }}</span>
        </el-button>
        <el-button
          type="primary"
          :loading="submitPhase === 'submitting'"
          :disabled="submitPhase === 'submitting'"
          @click="submitForReview"
        >
          <Send v-if="submitPhase === 'idle'" :size="14" />
          <span class="btn__label">
            {{ { idle: '提交批改', submitting: '提交中…', graded: '已提交' }[submitPhase] }}
          </span>
        </el-button>
      </PageActions>

      <!-- 身份行（22px，全页唯一）：说的是「这页在干什么」，不是重复顶栏的「编程环境」。
           `meta` 承接原先写在简报里的那句本地执行说明（同一句话说一遍）；
           `hint` 是主路径提示（D1）。 -->
      <PageIdentity
        main="在这里把刚才学的写成代码"
        meta="代码在学生机本地执行，不上传"
        hint="先看任务要求，再在下面补全 TODO 并运行"
      />

      <CodingCard class="code__card" />
      <p class="code__foot-note">
        正式版此区域由 Monaco 编辑器接管；学生代码经 IPC 交给渲染进程的 Pyodide Worker
        执行，绝不在主进程运行，运行结果由 Worker 回传。
      </p>
    </section>
  </div>
</template>

<style scoped>
.code {
  display: flex;
  height: 100%;
  min-height: 0;
}
/* 简报：340px → **268px**。它有必要的任务上下文（保留），但不许挤住编辑区 ——
 * 收窄省下的 72px 全给右侧：本页的主对象是代码，不是简报。 */
.code__brief {
  --el-box-shadow-light: none;
  --el-box-shadow: var(--k12-shadow-float);

  width: 268px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 16px;
  border-right: 1px solid var(--k12-border);
  background: var(--k12-surface-2);
  overflow-y: auto;
}
.code__brief-head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--k12-muted);
}
.code__brief-title {
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg-2);
}
/* 任务名 = **块标题档**。原为 22px（与身份行同权），是旧版焦点倒置的直接原因；
 * 内容区最大的 22px 现在只属于身份行。 */
.code__name {
  font-size: var(--k12-fs-lg);
  font-weight: 650;
  line-height: var(--k12-lh-snug);
  color: var(--k12-fg);
}
.code__desc {
  font-size: var(--k12-fs-sm);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
.code__mono {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  color: var(--k12-accent-ink);
}
.code__desc-list {
  margin-top: -2px;
}
/* 键值对的标签与取值都是 meta：12px。EP 默认吃 `--el-font-size-base`(14px)，
 * 在 268px 的简报里它会比正文还重，所以显式压回 meta 档。 */
.code__desc-list :deep(.el-descriptions__label),
.code__desc-list :deep(.el-descriptions__content) {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
}
.code__sec {
  padding: 2px 0 0;
}
.code__sec-label {
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-fg-2);
}
/* EP 的垂直步骤条默认 flex-grow，会把三个步骤撑满整个侧栏高度、
 * 间距被拉得很稀。这里固定成内容高度。 */
.code__steps {
  margin-top: -4px;
  height: auto;
}
.code__steps :deep(.el-step) {
  flex-grow: 0;
  flex-shrink: 0;
}
/* 当前步骤：EP 的 `process` 只给「主文字色 + 加粗」（不带 accent），这里显式钉成
 * `--k12-accent-ink`，并把圆点填成 accent-soft —— 让「现在做这一步」一眼看得出来。
 *
 * ⚠️ 为什么不做成左侧强调线 / 缩进：垂直步骤条的连接线是**绝对定位在 24px 图标列内**
 *    （`.el-step__line { left: 11px }`），给 `.el-step` 加 padding 会把当前项整体
 *    右移、与其余两项错开，看起来像对齐缺陷。所以强调只落在**图标与标题**上，
 *    三项始终对齐。 */
.code__steps :deep(.code__step--current .el-step__head),
.code__steps :deep(.code__step--current .el-step__title) {
  color: var(--k12-accent-ink);
}
.code__steps :deep(.code__step--current .el-step__icon) {
  background: var(--k12-accent-soft);
}
/* 已完成：绿（EP 的 success 走 --k12-good）—— 与「当前」的 accent-ink 明确分开，
 * 而不是两个都落在主色上、只差一个字重。 */
.code__steps :deep(.el-step__title.is-success),
.code__steps :deep(.el-step__title.is-process) {
  font-weight: 650;
}

.code__hint-note {
  display: flex;
  gap: 10px;
  padding: 12px;
  border-radius: var(--k12-r-card);
  background: var(--k12-warn-soft);
  border: 1px solid var(--k12-warn-border);
  color: var(--k12-warn);
}
.code__hint-note svg {
  flex: none;
  margin-top: 2px;
}
.code__hint-title {
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-warn);
}
.code__hint-text {
  margin-top: 4px;
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}

/* ── 折叠：机制 / 合规说明（默认折叠）────────────────────────────────────
 * 标题 13px、内容 12px —— 它是附录，不与简报正文争字号。
 *
 * 边框：EP 的折叠**自带**上下两条根边框 + header 自己一条下边框，三条叠在一起
 * 会糊成一条粗细不匀的线。这里全部去掉，只由 header 的 `border-top` 出一条
 * 干净的分隔线 —— 在 268px 的窄栏里，一条线就够表达「下面是附录」。
 * **不套 SurfacePanel**：那是卡片，卡片里再塞卡片看不出层次（契约 §5）。 */
.code__fold {
  border: none;
}
.code__fold :deep(.el-collapse-item__header) {
  min-height: 44px;
  line-height: var(--k12-lh-ui);
  border-top: 1px solid var(--k12-border);
  border-bottom: none;
}
.code__fold :deep(.el-collapse-item__wrap) {
  border-bottom: none;
}
.code__fold-t {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg-2);
}
.code__fold :deep(.el-collapse-item__content) {
  padding-bottom: 12px;
}
.code__fold-p {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
.code__fold-p + .code__fold-p {
  margin-top: 6px;
}
.code__fold-p strong {
  color: var(--k12-fg);
  font-weight: 650;
}

.code__stage {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  /* 兄弟块是「操作栏 / 身份行 / 卡片 / 脚注」，按契约 §2 用卡片之间那一档（16px）；
   * 原来是 12px —— 不属于任何一档。
   * ⚠️ 内边距（18 / 22 / 20）必须与 PageActions 的默认 `--pa-pad-y/x` 一致，
   *    否则吸顶时会漏出/盖住内容。改这里就要同步覆盖那两个变量。 */
  gap: var(--k12-gap);
  padding: 18px 22px 20px;
  overflow-y: auto;
}
.code__card {
  /* 展开版：编辑区不高一些说不过去 */
  --cd-editor-max: 460px;
}
.code__foot-note {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-fg-2);
}
</style>
