<script setup lang="ts">
/**
 * 动画讲解页 —— 对话内联动画卡的**展开视图**：同一套术语（概念 / 模板来源 / 时长 /
 * 播放条），同一份数据形状（`AnimationPayload`），只是舞台更大、多了模板库。
 *
 * 引擎不接（用户决策）：不引入 Anime.js、不建 iframe 沙箱，舞台为静态图层结构。
 * 接线时：舞台换成 sandboxed iframe（**禁止 allow-same-origin**），
 * 资源经一次性 nonce 路由托管（iframe 带不了自定义 header）；
 * 播放控制改由 postMessage 驱动，并校验 `payload_id` 防多卡串台。
 *
 * ── 这一版改的是**骨架**，不是装饰 ────────────────────────────────────
 * 旧版是左右分栏：296px 固定宽的模板列表 + 右侧舞台。两者**互相抢** ——
 * 真正的主对象（舞台里的图层结构）被固定窄栏挤住，而内容区最大的 22px
 * 落在舞台标题上，与身份行同权（焦点不在「这页在讲什么」上）。
 *
 * 现在改成**舞台优先**的单列流：
 *
 *   身份行（22px，全页唯一） → 舞台（全宽） → 舞台说明 → 底部横向胶片条
 *
 * 模板从「左侧竖栏」变为**底部横向条**（缩略图条）：舞台独占一行拿到全宽，
 * 模板仍是页面级选择，但退到内容之下。模板项固定宽 220px、固定高 108px，
 * 横向滚动而不换行挤压 —— 条的高度因此可预测，不会随模板数量长高。
 * 舞台标题降为 16px（块标题档），模板名 13px，标记 / 说明 12px。
 *
 * ⚠️ 模板清单取自 `server/resources/templates/*.json` 的真实值（8 个）。
 *    上一版用的是设计稿里手写的 6 条（id 与名称都对不上真实资产），
 *    会让「模板库里有 8 个」这句话在答辩现场被当场证伪。
 *    **这 8 条不得删减或编造** —— 它们是真实资产的对齐表。
 *
 * ⚠️ 本页**刻意不做动效**（无 transition / animation）。「动画讲解页」看起来
 *    最该"动"，但动画引擎未接入是用户决策 —— 舞台是静态图层结构，
 *    播放进度条是静态展示（进度由 `setInterval` 推进，不是缓动动画）。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Play, Pause, RotateCcw, Plus, Wand2, Library } from 'lucide-vue-next'
import SurfacePanel from '@/components/SurfacePanel.vue'
import PageIdentity from '@/components/PageIdentity.vue'
import { animationStages } from '@/mocks'

interface Template {
  id: string
  title: string
  concept: string
  grades: string[]
  durationMs: number
  /** 模板库直取 / AI 生成补充 —— 生成的那条要能一眼看出来 */
  source: 'template' | 'generated'
}

/** 逐条对齐 server/resources/templates/ 的真实资产（8 条） */
const templates = ref<Template[]>([
  { id: 'image-pixels', title: '图像分类：机器把照片看成数字', concept: '图像分类', grades: ['小学低', '小学高', '初中'], durationMs: 4400, source: 'template' },
  { id: 'neural-forward', title: '神经网络：一层层算过去', concept: '神经网络', grades: ['初中', '高中'], durationMs: 4600, source: 'template' },
  { id: 'sorting-bars', title: '排序：把一排数字从小到大摆好', concept: '排序', grades: ['小学高', '初中', '高中'], durationMs: 5200, source: 'template' },
  { id: 'decision-tree', title: '决策树：一串「是 / 否」往下问', concept: '决策树', grades: ['小学高', '初中', '高中'], durationMs: 4800, source: 'template' },
  { id: 'python-variable', title: '变量：给数据起一个名字', concept: '变量', grades: ['初中', '高中'], durationMs: 4200, source: 'template' },
  { id: 'python-loop', title: '循环：同一段代码重复执行', concept: '循环', grades: ['初中', '高中'], durationMs: 4400, source: 'template' },
  { id: 'train-predict', title: '机器学本事：数据 → 训练 → 预测', concept: '数据·训练·预测', grades: ['小学低', '小学高', '初中', '高中'], durationMs: 4800, source: 'template' },
  { id: 'gradient-descent', title: '梯度下降：沿着下坡方向一步步调参数', concept: '梯度下降', grades: ['高中'], durationMs: 5200, source: 'template' }
])

const active = ref(templates.value[0]!.id)
const current = computed(() => templates.value.find((t) => t.id === active.value) ?? templates.value[0]!)

/** 播放时钟：模拟进度，不是动画引擎（舞台仍是静态图层） */
const playing = ref(false)
const progress = ref(0)
let timer: number | null = null

function fmt(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
const elapsedLabel = computed(() => fmt(progress.value * current.value.durationMs))

/** 当前点亮的图层：由播放进度驱动，让静态舞台跟着播放条动 */
const activeLayer = computed(() => {
  if (progress.value <= 0) return -1
  return Math.min(animationStages.length - 1, Math.floor(progress.value * animationStages.length))
})

function stop() {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
  playing.value = false
}

function start() {
  stop()
  if (progress.value >= 1) progress.value = 0
  playing.value = true
  timer = window.setInterval(() => {
    progress.value = Math.min(1, progress.value + 100 / current.value.durationMs)
    if (progress.value >= 1) stop()
  }, 100)
}

function toggle() {
  if (playing.value) stop()
  else start()
}

function restart() {
  stop()
  progress.value = 0
}

/**
 * 生成新动画 —— 演示「模板优先 + 生成补充」里的**生成**那一半。
 *
 * 原型不接模型，所以这里演的是**界面状态机**而不是真的生成：
 * 校验中 → 生成中 → 完成（插入一张「生成」来源的模板）。
 * 失败重试 ≤3 → 降级为文字/静态图 这条链路写在模板条下方的说明里，
 * 真正的重试与降级在接线后由 generate_animation Tool 的 execute() 内部实现
 * （`tool_execution_end` 是只读通知，改不了结果）。
 */
type GenPhase = 'idle' | 'validating' | 'generating' | 'done' | 'degraded'
const genPhase = ref<GenPhase>('idle')
const genError = ref('')
let genTimer: number | null = null

const GEN_LABEL: Record<GenPhase, string> = {
  idle: '',
  validating: '正在校验模板结构…',
  generating: '正在生成图层与关键帧…',
  done: '生成完成，已加入模板库',
  degraded: '生成失败，已降级为静态图 + 文字讲解'
}

/** 按优先级挑一个模板库里还没有的概念，避免生成重复项 */
function pickNewConcept(): Template {
  const pool: Omit<Template, 'id' | 'source'>[] = [
    { title: '梯度下降：沿着下坡方向一步步调参数', concept: '梯度下降', grades: ['高中'], durationMs: 5200 },
    { title: '模型评估：为什么要留一份测试集', concept: '模型评估', grades: ['初中', '高中'], durationMs: 4600 },
    { title: '数据清洗：把表格里的脏数据挑出来', concept: '数据清洗', grades: ['小学高', '初中'], durationMs: 4800 }
  ]
  const existing = new Set(templates.value.map((t) => t.concept))
  return { ...(pool.find((p2) => !existing.has(p2.concept)) ?? pool[0]!), id: `gen-${Date.now()}`, source: 'generated' }
}

function generate() {
  if (genPhase.value === 'validating' || genPhase.value === 'generating') return
  stop()
  genError.value = ''
  genPhase.value = 'validating'
  if (genTimer !== null) clearTimeout(genTimer)
  genTimer = window.setTimeout(() => {
    genPhase.value = 'generating'
    genTimer = window.setTimeout(() => {
      const t = pickNewConcept()
      templates.value = [...templates.value, t]
      active.value = t.id
      progress.value = 0
      genPhase.value = 'done'
      genTimer = null
    }, 1100)
  }, 520)
}

/** 演示降级分支：把「生成失败」这一步做成可点，才能看清降级链真的存在 */
function simulateFailure() {
  stop()
  genPhase.value = 'degraded'
  genError.value = '图层数量超出模板上限（12 > 8），重试 3 次仍不合格'
}

const genBusy = computed(() => genPhase.value === 'validating' || genPhase.value === 'generating')

/** 换模板：回到起点并停住 */
watch(active, restart)
onBeforeUnmount(() => {
  stop()
  if (genTimer !== null) clearTimeout(genTimer)
})
</script>

<template>
  <div class="anim">
    <!-- 身份行（22px，全页唯一）：内容区的最大字号在这里。
         `main` 说的是「这页在讲什么」，不是重复顶栏的「动画讲解」；
         `meta` 承接原先写在左侧栏里的口径（模板优先 / 引擎未接），同一句话说一遍。 -->
    <PageIdentity
      main="把过程一步步画出来看"
      meta="模板优先，生成补充；引擎未接入，此处为静态图层"
      hint="先挑模板，再在舞台上播放"
    />

    <!-- ══ 舞台：全宽主对象（旧版被 296px 侧栏挤住的那一块）══ -->
    <SurfacePanel flush class="anim__stage-card">
      <header class="anim__head">
        <div class="anim__head-text">
          <!-- 16px：块标题档。不得用 22px 去与身份行争焦点 —— 本页最大字号只有一个。 -->
          <h2 class="anim__title">{{ current.title }}</h2>
          <p class="anim__sub">
            模板 <code>{{ current.id }}</code> · 适配 {{ current.grades.join(' / ') }}
          </p>
        </div>
        <button type="button" class="anim__ghost" :disabled="genBusy" @click="generate">
          <Wand2 :size="14" /><span>{{ genBusy ? '生成中…' : '重新生成' }}</span>
        </button>
      </header>

      <!-- 静态图层结构：没有 iframe、没有动效，靠图层点亮状态表达「播放到哪一步」。
           接线后这里换成 sandboxed iframe（禁止 allow-same-origin）。 -->
      <div class="anim__stage">
        <div
          v-for="(layer, li) in animationStages"
          :key="layer.name"
          class="anim__layer"
          :class="{ 'anim__layer--lit': li === activeLayer, 'anim__layer--done': li < activeLayer }"
        >
          <p class="anim__layer-name">{{ layer.name }}</p>
          <div class="anim__dots">
            <span v-for="i in layer.nodes" :key="i" class="anim__node" />
          </div>
          <p class="anim__layer-detail">{{ layer.detail }}</p>
        </div>
        <span class="anim__badge">静态预览 · 引擎未接</span>
      </div>

      <footer class="anim__foot">
        <button type="button" class="anim__play" :title="playing ? '暂停' : '播放'" @click="toggle">
          <component :is="playing ? Pause : Play" :size="15" />
        </button>
        <button type="button" class="anim__ghost anim__ghost--icon" title="重新播放" @click="restart">
          <RotateCcw :size="14" />
        </button>
        <div class="anim__progress">
          <span class="anim__fill" :style="{ width: `${progress * 100}%` }" />
        </div>
        <span class="anim__time k12-num">{{ elapsedLabel }} / {{ fmt(current.durationMs) }}</span>
      </footer>
    </SurfacePanel>

    <p class="anim__note">
      舞台在正式版里是 <strong>sandboxed iframe</strong>（禁止 <code>allow-same-origin</code>），
      动画库内联进 HTML，断网也能演示。
    </p>

    <!-- ══ 底部横向胶片条：舞台在上、模板条在下 ═════════════════════════────
         旧版这里是 296px 的竖向侧栏，与舞台并排互抢。改横向后：
         舞台独占一行拿到全宽，模板仍是页面级选择，但退到内容之下。
         条高固定（项高 108px）、项宽固定 220px、横向滚动不换行 ——
         于是条的高度不随模板数量长高，永远不会反过来挤压舞台。 -->
    <section class="anim__strip" aria-label="动画模板">
      <header class="strip__head">
        <Library :size="14" class="strip__ico" />
        <span class="strip__title">动画模板</span>
        <span class="strip__meta">{{ templates.length }} 个 · 模板优先，生成作补充</span>
      </header>

      <div class="strip__track">
        <button
          v-for="t in templates"
          :key="t.id"
          type="button"
          class="tpl"
          :class="{ 'tpl--on': active === t.id }"
          :aria-current="active === t.id ? 'true' : undefined"
          @click="active = t.id"
        >
          <span class="tpl__top">
            <span class="tpl__name">{{ t.title }}</span>
            <!-- 来源标记：生成的那条必须一眼看出（「AI 生成」不是角标，是说明 → 12px） -->
            <span v-if="t.source === 'generated'" class="tpl__src">AI 生成</span>
          </span>
          <span class="tpl__grades">
            <span v-for="g in t.grades" :key="g" class="tpl__grade">{{ g }}</span>
          </span>
          <span class="tpl__concept">{{ t.concept }} · 时长 {{ fmt(t.durationMs) }}</span>
        </button>

        <button type="button" class="tpl tpl--new" :disabled="genBusy" @click="generate">
          <Plus :size="14" />
          <span>{{ genBusy ? '生成中…' : '用 AI 生成新动画' }}</span>
        </button>
      </div>

      <!-- 生成状态：进度线 + 一句话。生成失败的可点演示放在这里，
           否则「失败重试 ≤3 → 降级」这条链路在界面上完全看不见。 -->
      <div v-if="genPhase !== 'idle'" class="gen" :data-phase="genPhase">
        <div v-if="genBusy" class="gen__line"><span class="gen__fill" /></div>
        <div class="gen__row">
          <span class="k12-dot gen__dot" />
          <span class="gen__text">{{ GEN_LABEL[genPhase] }}</span>
        </div>
        <p v-if="genError" class="gen__err">{{ genError }}</p>
        <button v-if="genPhase === 'done' || genPhase === 'degraded'" type="button" class="gen__again" @click="genPhase = 'idle'">
          知道了
        </button>
      </div>

      <p class="anim__strip-note">
        <span class="k12-label">生成链路</span>
        模板优先，生成作补充：校验 → 失败重试 ≤3 次 → 降级为文字或静态图。
        模板内不得内联 CDN（沙箱断网会白屏）。
      </p>
      <button type="button" class="anim__degrade-demo" @click="simulateFailure">
        模拟一次生成失败（看降级提示）
      </button>
    </section>
  </div>
</template>

<style scoped>
/* 单列流：页面自己只在 `.shell__content` 里纵向排块，不建内层滚动容器 ——
 * 于是内边距 18/22 与 PageActions 的默认 `--pa-pad-y/x` 对齐（本页无 PageActions）。
 *
 * ⚠️ 这里**不写 `height: 100%`**：页面高度由内容决定，滚动交给 `.shell__content`。
 *    旧版写死 `height: 100%` + 内层 `overflow-y: auto`，等于在内容区里再套一个滚动容器，
 *    舞台与模板条各自被切开滚动。 */
.anim {
  display: flex;
  flex-direction: column;
  gap: var(--k12-gap);
  padding: 18px 22px 24px;
}

/* ── 舞台卡（全宽主对象）──────────────────────────────────────────────── */
.anim__head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 18px 12px;
}
.anim__head-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
/* 16px 块标题档（旧版 22px：与身份行同权，焦点不在「这页在讲什么」上） */
.anim__title {
  font-size: var(--k12-fs-lg);
  font-weight: 650;
  line-height: var(--k12-lh-tight);
  color: var(--k12-fg);
}
.anim__sub {
  font-size: var(--k12-fs-xs);
  color: var(--k12-fg-2);
}
/* 代码片是说明文字，不是角标 → 12px */
.anim__sub code {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  padding: 1px 6px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
}
.anim__ghost {
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
  box-shadow: var(--k12-shadow-card);
  border-radius: var(--k12-r-card);

  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 8px 12px;
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  cursor: pointer;
  flex: none;
}
@media (hover: hover) and (pointer: fine) {
.anim__ghost:hover:not(:disabled) {
  border-color: var(--k12-accent-ink);
  color: var(--k12-accent-ink);
}
}
.anim__ghost--icon {
  padding: 8px;
}
.anim__ghost:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* 舞台：用 --fg 深色作底（与内联卡同一套视觉），节点为彩色圆点 */
.anim__stage {
  position: relative;
  min-height: 300px;
  margin: 0 18px;
  padding: 32px 30px 40px;
  border-radius: var(--k12-r-card);
  background: var(--k12-fg);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}
.anim__layer {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 11px;
  flex: 1;
  min-width: 0;
  opacity: 0.62;
}
.anim__layer--done {
  opacity: 0.85;
}
.anim__layer--lit {
  opacity: 1;
}
.anim__layer--lit .anim__node {
  background: var(--k12-accent);
}
.anim__layer-name {
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-screen-fg);
}
.anim__dots {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
  justify-content: center;
}
.anim__node {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--k12-screen-dim);
}
.anim__node--hot {
  background: var(--k12-accent-2);
}
.anim__layer-detail {
  font-size: var(--k12-fs-xs);
  color: var(--k12-screen-dim);
}
/* 保留 11px：名字含 badge，是角上的一个记号（「静态预览 · 引擎未接」） */
.anim__badge {
  position: absolute;
  right: 16px;
  bottom: 14px;
  font-size: var(--k12-fs-micro);
  color: var(--k12-screen-dim);
}

.anim__foot {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px 16px;
}
.anim__play {
  width: 34px;
  height: 34px;
  flex: none;
  border: none;
  border-radius: var(--k12-r-control);
  background: var(--k12-accent);
  color: var(--k12-surface);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
@media (hover: hover) and (pointer: fine) {
.anim__play:hover {
  filter: brightness(1.06);
}
}
/* 播放条：**静态展示**。进度由 setInterval 推进宽度，没有缓动、没有 transition。 */
.anim__progress {
  flex: 1;
  height: 6px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
  overflow: hidden;
}
.anim__fill {
  display: block;
  height: 100%;
  border-radius: var(--k12-r-pill);
  background: var(--k12-accent);
}
.anim__time {
  font-size: var(--k12-fs-xs);
  color: var(--k12-fg-2);
  flex: none;
}

.anim__note {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
  padding: 0 2px;
}
.anim__note code {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  padding: 1px 6px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
  color: var(--k12-accent-ink);
}

/* ── 底部横向胶片条 ──────────────────────────────────────────────────── */
.anim__strip {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.strip__head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--k12-muted);
  padding: 0 2px;
}
.strip__ico {
  flex: none;
}
/* 13px：从侧栏「模板库」标题（22px → 原 13px）移到这里后**不升反稳** ——
 * 它是次级区块标题，不得与身份行的 22px 相争。 */
.strip__title {
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg-2);
}
.strip__meta {
  margin-left: auto;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
/* 横向排开：项宽固定 220px、项高固定 108px → 条高可预测。
 * 窄屏靠横向滚动兜住，不换行挤压舞台。 */
.strip__track {
  display: flex;
  align-items: stretch;
  gap: 10px;
  min-width: 0;
  overflow-x: auto;
  padding-bottom: 2px;
}
.tpl {
  flex: none;
  width: 220px;
  height: 108px;
  overflow: hidden;

  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-card);
  background: var(--k12-surface);
  box-shadow: var(--k12-shadow-card);
  cursor: pointer;
  text-align: left;
}
@media (hover: hover) and (pointer: fine) {
.tpl:hover {
  border-color: var(--k12-accent-ink);
}
}
/* 选中：accent-soft 底 + accent-ink 文字 + accent-border 描边。
 * accent-ink on accent-soft 是机器校验过的达标组合（见 check-contrast.mjs）。 */
.tpl--on {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent-border);
}
.tpl--on .tpl__name,
.tpl--on .tpl__concept,
.tpl--on .tpl__grade {
  color: var(--k12-accent-ink);
}
.tpl__top {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.tpl__name {
  flex: 1;
  min-width: 0;
  font-size: var(--k12-fs-sm);
  font-weight: 620;
  line-height: var(--k12-lh-snug);
  color: var(--k12-fg);
  /* 最多两行：项高固定，长标题截断而不是把条目撑高（撑高会挤压舞台） */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
/* 来源标记：≤4 字，但是**说明**不是角标 → 12px。
 * 它必须一眼看出（这是原设计的要求），用 chip 那对已验证的取色。 */
.tpl__src {
  flex: none;
  margin-top: 1px;
  padding: 1px 6px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-chip-bg);
  color: var(--k12-chip-fg);
  font-size: var(--k12-fs-xs);
  font-weight: 650;
}
.tpl__concept {
  font-size: var(--k12-fs-xs);
  color: var(--k12-fg-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tpl__grades {
  display: flex;
  gap: 4px;
  flex-wrap: nowrap;
  margin-top: auto;
  overflow: hidden;
}
.tpl__grade {
  flex: none;
  padding: 1px 7px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
  color: var(--k12-muted);
  font-size: var(--k12-fs-xs);
}
/* 生成入口与模板项同高，条的高度因此不被它拉高 */
.tpl--new {
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border-style: dashed;
  color: var(--k12-accent-ink);
  font-size: var(--k12-fs-sm);
  font-weight: 600;
}
.tpl--new:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* 生成状态块：进行中显示细进度线，结束显示结果。
 * 刻意不用三点脉冲 —— 那是 AI 味最重的 loader 写法。 */
.gen {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 11px 12px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
}
.gen__line {
  position: relative;
  height: 3px;
  border-radius: var(--k12-r-pill);
  overflow: hidden;
  background: color-mix(in srgb, var(--k12-accent) 16%, transparent);
}
.gen__fill {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--k12-accent);
}
.gen__row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.gen__dot {
  background: var(--k12-muted-2);
}
.gen[data-phase='done'] .gen__dot {
  background: var(--k12-good);
}
.gen[data-phase='degraded'] .gen__dot {
  background: var(--k12-warn);
}
.gen__text {
  font-size: var(--k12-fs-xs);
  font-weight: 550;
  color: var(--k12-fg-2);
}
.gen[data-phase='degraded'] .gen__text {
  color: var(--k12-warn);
}
.gen__err {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
}
.gen__again {
  align-self: flex-start;
  padding: 4px 10px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-control);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  cursor: pointer;
}
.anim__degrade-demo {
  align-self: flex-start;
  padding: 4px 0;
  border: none;
  background: transparent;
  color: var(--k12-muted);
  font-size: var(--k12-fs-xs);
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
}
.anim__degrade-demo:hover {
  color: var(--k12-fg-2);
}
.anim__strip-note {
  background: var(--k12-surface-2);
  border: 1px solid color-mix(in srgb, var(--k12-border) 70%, transparent);
  border-radius: var(--k12-r-inset);

  margin-top: 2px;
  padding: 10px 11px;
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
}
</style>
