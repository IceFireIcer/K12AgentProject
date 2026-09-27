<script setup lang="ts">
/**
 * 运行透视：把「一轮提问背后发生了什么」摊开的那一页。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 两个子页（顶栏的分段切换；数据是同一份 `TurnDiagnostics`）
 * ══════════════════════════════════════════════════════════════════════════
 *   ① 分块总览（默认，三栏；与报告 §4.2 的布局一一对应）
 *      左：轮次时间轴（点节点 → 中栏定位到那一轮）
 *      中：十二个分块（这一轮逐段的运行时证据）
 *      右：原始信封（结构化数据，证明「这些都是运行时真的产生的」）
 *   ② 调用顺序（`components/diag/DiagSequence.vue`）
 *      把这一轮**按真实发生的先后**一条横条一个步骤摊开：学生输入 → 入口预检 → 学段 →
 *      提示词（逐段）→ 画像 → 组装完成 → 推理 → 工具（逐次）→ 检索（逐级）→ 输出 →
 *      终审 → 拦截 → 结束。每条横条最前面是分类，右侧是这一步的数字。
 *      ★ 它**不新增取数路径**：吃的还是本页选中的那一轮（`diagnostics.active`）。
 *
 * ★★ 数据只有一个来源：`stores/diagnostics.ts` 的 `TurnDiagnostics` 快照。
 *   浮窗读的是同一个 store、同一个 `DiagSummary` —— 两处显示同一份数（不做两套 UI）。
 * ★ 本页在**教师档及以上**可达（`PAGES.demo.nav === 'teacher'`）：不载入任何预置数据、
 *   普通运行态下，老师也能看「这一轮背后调用了什么、走了哪条链路」。
 *   **学生档看不到它**（技术证据不进学生面）—— 守卫钉着这一条。
 *   技术词的原文集中在 `components/diag/evidence.ts`（两个子页的名字也在那儿），
 *   由守卫按文件豁免（见那个文件头）。
 *   ⚠️ 这一段（含子页的标签）不许写死进本文件的模板：本页**不在**豁免名单里。
 *
 * ⚠️ 本页**不产生**任何运行时数据（不重算、不补数）：拿不到就如实显示空。
 */
import { computed, onActivated, onMounted, ref } from 'vue'
import { Eraser, RefreshCw } from 'lucide-vue-next'
import {
  DIAG_BLOCKS,
  DIAG_VIEWS,
  GUARD_CATALOG,
  PAGE_HEADINGS,
  PROMPT_STAGE_LABELS,
  RETRIEVAL_LEVEL_LABELS,
  SAFETY_STAGE_LABELS
} from '../components/diag/evidence'
import DiagSequence from '../components/diag/DiagSequence.vue'
import DiagSummary from '../components/diag/DiagSummary.vue'
import { useDiagnosticsStore } from '../stores/diagnostics'
import { useDemoSeedStore } from '../stores/demoSeed'
import { useStudentStore } from '../stores/student'
import { useSidecarStore } from '../stores/sidecar'
import { PAGES, useUiStore, type PageName } from '../stores/ui'

const diagnostics = useDiagnosticsStore()
const demoSeed = useDemoSeedStore()
const student = useStudentStore()
const sidecar = useSidecarStore()
const ui = useUiStore()

/**
 * 顶栏的导航快捷按钮：不用回侧栏找，按讲解节奏直接切页。
 *
 * ★ 文案直接读 `PAGES[page].title`（页名的**唯一来源**）：页名改了这里跟着改，
 *   不会在页面里长出第二个名字。所以这里只列 key，不写死中文。
 */
const SHORTCUT_PAGES: readonly PageName[] = ['chat', 'study', 'quiz', 'animation']

const notice = ref('')

// ★ 进入本页时问一次「现在是不是沙箱态」：那颗开关已经搬到设置页的「技术详情」里，
//   但本页的「清空记录」在沙箱态下**要多做一件事**（把脚本进度归零，见 `clearAll`），
//   判据就是 `demoSeed.seeded` —— 不读一次就会按旧值决定要不要归零。
//   `onMounted` 与 `onActivated` 都挂：本页在 `<KeepAlive>` 里，切走再回来不会重挂 ——
//   只挂 mounted 的话，别处切了档位再回来，这里读到的还是旧的那个状态。
//   ⚠️ 首次进入两条都会触发、于是读两次：它是幂等的只读（代价一次 invoke），不值得加去重状态。
onMounted(() => {
  void demoSeed.refresh()
})
onActivated(() => {
  void demoSeed.refresh()
})

const turn = computed(() => diagnostics.active)

/**
 * 当前子页（`DIAG_VIEWS[].id`）。
 *
 * ★ 默认必须是「分块总览」：`scripts/ux-probe-demo.mjs` 与 `tests/probe-anchors.test.ts`
 *   都钉着那一屏的三栏（`.cols` 下恰好三个子元素），探针跑的就是默认态。
 *   ⚠️ 切换时是**整块换掉** `.cols`（`v-if` / `v-else`）—— 不要往里塞第四个兄弟。
 */
const view = ref<(typeof DIAG_VIEWS)[number]['id']>('blocks')

function switchView(next: (typeof DIAG_VIEWS)[number]['id']): void {
  view.value = next
}

/** 回到最新一轮（在时间轴上点过旧轮次之后，用它跳回跟随状态）。 */
function backToLatest(): void {
  diagnostics.select(null)
}

/**
 * 这一轮属于哪条会话（沙箱态下由 `demoSeed` 提供；普通运行态回空串）。
 *
 * ★ 时间轴上十二个节点只写「第 N 轮」的话，看不出哪几轮属于侧栏的哪条历史会话 ——
 *   而这一屏要讲的正是「每条会话里它都做了什么」。映射是**只读**的：
 *   `TurnDiagnostics` 的结构一个字没动（那是采集器与落盘剥离的公共契约）。
 * ★ 拿不到就回空串，模板据此不渲染那一行（普通运行态下与改动前逐像素相同）。
 */
function sessionTitle(turn: number): string {
  return demoSeed.titleOf(turn)
}

/** 沙箱那一块：主进程看不到这些事件，只有渲染进程能补（见 `stores/diagnostics.ts`）。 */
const sandboxText = computed(() => {
  const sandbox = turn.value?.sandbox
  if (!sandbox) return '本轮还没有沙箱事件（没跑代码、没播动画时就是这样）。'
  const parts: string[] = []
  if (sandbox.codeExecutedIn) parts.push('学生代码在渲染进程的执行环境里运行（主进程与数据服务都没有执行入口）')
  if (sandbox.interrupted) parts.push('死循环被执行超时真正中断（不是干等）')
  if (sandbox.outputTruncated) parts.push('输出超过上限被截断')
  if (sandbox.animationReadyTimeout) parts.push('动画沙箱 5 秒未就绪，已整段降级为文字')
  return parts.length > 0 ? parts.join('；') : '本轮没有发生沙箱事件。'
})

/**
 * 运行时那一块：读的是**既有的**连接状态（`stores/sidecar.ts`），不重新探测、不新造计数器。
 *
 * ★ `restarts` 与 `ignoredStdoutLines` 是握手协议里早就有的诊断字段（票 02）：
 *   前者是「自上次就绪以来崩溃重启过几次」，后者应当恒为 0（stdout 是保留通道）。
 *   这两个数比任何一句「我们做了进程管理」都有说服力。
 */
const runtimeLines = computed(() => {
  const state = sidecar.state
  const lines = [`本地数据服务：${sidecar.phaseText}`]
  if (state) {
    if (state.port !== null) lines.push(`本地服务端口：${state.port}`)
    lines.push(`崩溃重启次数：${state.restarts}（自上次就绪以来）`)
    lines.push(`保留通道被误用的行数：${state.ignoredStdoutLines}（正常恒为 0）`)
  }
  if (sidecar.errorText) lines.push(`最近一次错误：${sidecar.errorText}`)
  return lines
})

/** 当前学生标识：读的是主进程定的那个身份（本页只展示，不做任何切换）。 */
const studentLabel = computed(() => {
  const id = student.student?.studentId ?? ''
  return id === '' ? '（还没取到）' : `${id}（昵称 ${student.nickname}）`
})

async function clearAll(): Promise<void> {
  // ★ 沙箱态下「清空记录」**额外**把脚本进度归零（顺带收掉正在放的那一轮）：
  //   不清的话，下一次提问会从上一场停下的那半轮接着放 —— 看起来像卡带。
  if (demoSeed.seeded) demoSeed.resetProgress()
  const result = await diagnostics.clear()
  notice.value = result.ok ? '已清空记录。' : result.message
}
</script>

<template>
  <section class="demo" data-testid="demo-view">
    <header class="bar">
      <div class="bar__lead">
        <h1 class="bar__title">{{ PAGE_HEADINGS.title }}</h1>
        <p class="bar__sub">{{ PAGE_HEADINGS.lead }}</p>
      </div>
      <!-- 子页分段切换（手写，与右栏那组分页同一手法：`el-segmented` 的等分宽度
           会把四字标签截成「分…」，而这里只有两个段，手写 8 行完全可预测）。
           ★ 标签文案取自 evidence.ts 的 DIAG_VIEWS —— 本页不在技术词豁免名单里。 -->
      <div class="views" role="tablist" aria-label="运行透视的两个子页" data-testid="demo-views">
        <button
          v-for="item in DIAG_VIEWS"
          :key="item.id"
          type="button"
          role="tab"
          class="views__tab"
          :class="{ 'views__tab--on': view === item.id }"
          :aria-selected="view === item.id"
          :data-view="item.id"
          :data-testid="`demo-views-${item.id}`"
          :title="item.hint"
          @click="switchView(item.id)"
        >
          {{ item.label }}
        </button>
      </div>
      <div class="bar__tools">
        <span class="chip" data-testid="demo-student">{{ studentLabel }}</span>
        <button
          v-for="page in SHORTCUT_PAGES"
          :key="page"
          type="button"
          class="btn"
          @click="ui.go(page)"
        >
          {{ PAGES[page].title }}
        </button>
        <span class="bar__sep" aria-hidden="true" />
        <button type="button" class="btn" data-testid="demo-refresh" @click="diagnostics.refresh()">
          <RefreshCw :size="13" />重新读取
        </button>
        <button type="button" class="btn" @click="backToLatest()">回到最新一轮</button>
        <button type="button" class="btn btn--danger" data-testid="demo-clear" @click="clearAll()">
          <Eraser :size="13" />清空记录
        </button>
      </div>
    </header>

    <p v-if="notice" class="notice" data-testid="demo-notice">{{ notice }}</p>
    <p v-if="diagnostics.bridgeError" class="notice notice--warn">{{ diagnostics.bridgeError }}</p>
    <p v-if="diagnostics.fromDisk" class="notice" data-testid="demo-from-disk">
      下面这些是上一次运行留下的记录（落盘只留结构与结论，正文不落盘）。
    </p>

    <!-- ⚠️ 两个子页**整块互斥**（`v-if` / `v-else`）：探针断言 `.cols` 下恰好三栏，
         所以「调用顺序」不许作为第四栏插进 `.cols` 里。 -->
    <div v-if="view === 'blocks'" class="cols">
      <aside class="col col--timeline">
        <h2 class="col__title">轮次时间轴</h2>
        <p v-if="diagnostics.turns.length === 0" class="empty">{{ PAGE_HEADINGS.timelineEmpty }}</p>
        <ol v-else class="timeline" data-testid="demo-timeline">
          <li v-for="item in diagnostics.turns" :key="item.turn">
            <button
              type="button"
              class="node"
              :data-on="String(item.turn === turn?.turn)"
              @click="diagnostics.select(item.turn)"
            >
              <span class="node__turn">第 {{ item.turn }} 轮</span>
              <span class="node__meta">
                {{ item.prompt.totalTokens }} tok · {{ item.tools.length }} 次工具
                <template v-if="item.interceptions.length > 0"> · {{ item.interceptions.length }} 次拦截</template>
              </span>
              <span class="node__signal" :data-ok="String(item.done.ok)">
                {{ item.done.ok ? '完成' : item.done.status }}
              </span>
              <!-- 这一轮属于哪条会话（历史轮次才有；跨整行，不挤那三列） -->
              <span v-if="sessionTitle(item.turn)" class="node__session">
                {{ sessionTitle(item.turn) }}
              </span>
            </button>
          </li>
        </ol>
      </aside>

      <main class="col col--blocks" data-testid="demo-blocks">
        <DiagSummary :turn="turn" />

        <section class="block">
          <h3 class="block__title">{{ DIAG_BLOCKS[0].title }}</h3>
          <p class="block__lead">{{ DIAG_BLOCKS[0].lead }}</p>
          <p v-if="turn" class="kv">学生输入：<span class="kv__v">{{ turn.input.text || '（正文不落盘）' }}</span></p>
          <p v-if="turn" class="kv">
            入口判定：<span class="kv__v">
              {{ turn.input.safetyInput.verdict === 'pass' ? '通过' : '拦下' }}
              {{ turn.input.safetyInput.reason ?? '' }}
            </span>
          </p>
        </section>

        <section class="block">
          <h3 class="block__title">{{ DIAG_BLOCKS[1].title }}</h3>
          <p class="block__lead">{{ DIAG_BLOCKS[1].lead }}</p>
          <p v-if="turn" class="kv">本轮生效：<span class="kv__v">{{ turn.grade.applied }}</span></p>
          <p v-if="turn" class="kv">判定层：<span class="kv__v">{{ turn.grade.decidedBy ?? '待判定' }}</span></p>
          <p v-if="turn" class="kv">复核状态：<span class="kv__v">{{ turn.grade.layer2 }}</span></p>
          <p v-if="turn" class="kv">下一轮待生效：<span class="kv__v">{{ turn.grade.pending ?? '无变化' }}</span></p>
          <p v-if="turn" class="kv">累计轮次：<span class="kv__v">{{ turn.grade.cumulativeTurns }}</span></p>
          <p v-if="turn" class="kv">
            冷却剩余：<span class="kv__v">{{ turn.grade.cooldownRemainingTurns }} 轮</span>
          </p>
          <p v-if="turn?.grade.note" class="kv">最近结论：<span class="kv__v">{{ turn.grade.note }}</span></p>
        </section>

        <section class="block">
          <h3 class="block__title">{{ DIAG_BLOCKS[2].title }}</h3>
          <p class="block__lead">{{ DIAG_BLOCKS[2].lead }}</p>
          <p v-if="turn" class="kv">
            体量：<span class="kv__v">{{ turn.prompt.chars }} 字符 / 约 {{ turn.prompt.totalTokens }} tok / {{ turn.prompt.segments.length }} 段</span>
          </p>
          <ul v-if="turn" class="stages">
            <li v-for="override in turn.prompt.overrides" :key="override.stage" class="stage">
              <span class="stage__mark" :data-ok="String(override.applied)">{{ override.applied ? '已生效' : '未生效' }}</span>
              <span class="stage__name">{{ PROMPT_STAGE_LABELS[override.stage] ?? override.stage }}</span>
              <span class="stage__note">{{ override.note }}</span>
            </li>
          </ul>
          <details v-for="segment in turn?.prompt.segments ?? []" :key="segment.id" class="seg">
            <summary class="seg__sum">
              {{ segment.label }} · {{ segment.chars }} 字符 / 约 {{ segment.tokens }} tok
              <span v-if="segment.truncated" class="seg__cut">（展示已截断）</span>
            </summary>
            <pre class="pre">{{ segment.text }}</pre>
          </details>
          <p v-if="turn && !turn.prompt.hostPathClean" class="warn">提示词里出现了本机路径（本轮被记为缺陷）。</p>
        </section>

        <section class="block">
          <h3 class="block__title">{{ DIAG_BLOCKS[3].title }}</h3>
          <p class="block__lead">{{ DIAG_BLOCKS[3].lead }}</p>
          <template v-if="turn">
            <p class="kv">本轮注入：<span class="kv__v">{{ turn.studentContext.injected ? '是' : '否' }}</span></p>
            <p class="kv">字节指纹：<span class="kv__v">{{ turn.studentContext.byteHash || '无' }}</span></p>
            <p class="kv">
              与上一轮：<span class="kv__v">{{ turn.studentContext.sameAsPrev ? '逐字节相同（前缀可复用）' : '不同（前缀要从这里往后重算）' }}</span>
            </p>
            <p class="kv">体量：<span class="kv__v">{{ turn.studentContext.chars }} 字符</span></p>
            <details v-if="turn.studentContext.text" class="seg">
              <summary class="seg__sum">画像块原文</summary>
              <pre class="pre">{{ turn.studentContext.text }}</pre>
            </details>
          </template>
        </section>

        <section class="block">
          <h3 class="block__title">{{ DIAG_BLOCKS[4].title }}</h3>
          <p class="block__lead">{{ DIAG_BLOCKS[4].lead }}</p>
          <p v-if="turn && !turn.reasoning.available" class="kv">
            本轮没有可展示的推理：<span class="kv__v">{{ turn.reasoning.note }}</span>
          </p>
          <details v-else-if="turn" class="seg">
            <summary class="seg__sum">展开已过滤的推理（默认折叠）</summary>
            <pre class="pre">{{ turn.reasoning.filtered }}</pre>
          </details>
        </section>

        <section class="block">
          <h3 class="block__title">{{ DIAG_BLOCKS[5].title }}</h3>
          <p class="block__lead">{{ DIAG_BLOCKS[5].lead }}</p>
          <p v-if="turn && turn.tools.length === 0" class="empty">这一轮没有调用工具。</p>
          <ol v-else-if="turn" class="tools">
            <li v-for="tool in turn.tools" :key="tool.seq" class="tool">
              <span class="tool__seq">{{ tool.seq }}</span>
              <span class="tool__name">{{ tool.name }}</span>
              <span class="tool__meta">{{ Math.round(tool.latencyMs) }}ms · {{ tool.ok ? '成功' : '失败' }}</span>
              <span v-if="tool.degraded" class="tool__badge">{{ tool.degraded }}</span>
            </li>
          </ol>
        </section>

        <section class="block">
          <h3 class="block__title">{{ DIAG_BLOCKS[6].title }}</h3>
          <p class="block__lead">{{ DIAG_BLOCKS[6].lead }}</p>
          <template v-if="turn?.retrieval">
            <p class="kv">检索词：<span class="kv__v">{{ turn.retrieval.query || '（不落盘）' }}</span></p>
            <p class="kv">最终档位：<span class="kv__v">{{ RETRIEVAL_LEVEL_LABELS[turn.retrieval.degraded] ?? turn.retrieval.degraded }}</span></p>
            <p class="kv">命中：<span class="kv__v">{{ turn.retrieval.hitCount }} 条（其中跨学段延伸 {{ turn.retrieval.compatCount }} 条）</span></p>
            <p class="kv">学段过滤：<span class="kv__v mono">{{ turn.retrieval.gradeFilter || '（后端未提供）' }}</span></p>
            <ul class="levels">
              <li v-for="level in turn.retrieval.levels" :key="level.level" class="level" :data-tried="String(level.tried)">
                <span class="level__name">{{ RETRIEVAL_LEVEL_LABELS[level.level] ?? level.level }}</span>
                <span class="level__state">{{ level.tried ? (level.ok ? `命中 ${level.hits} 条` : '未命中') : '未走到这一档' }}</span>
                <span v-if="level.note" class="level__note">{{ level.note }}</span>
              </li>
            </ul>
          </template>
          <p v-else class="empty">这一轮没有查教材（模型直接作答）。</p>
        </section>

        <section class="block">
          <h3 class="block__title">{{ DIAG_BLOCKS[7].title }}</h3>
          <p class="block__lead">{{ DIAG_BLOCKS[7].lead }}</p>
          <ul v-if="turn" class="stages">
            <li v-for="stage in turn.safetyFinal.stages" :key="stage.stage" class="stage">
              <span class="stage__mark" :data-ok="String(stage.verdict === 'pass')">
                {{ stage.verdict === 'pass' ? '通过' : stage.verdict === 'blocked' ? '拦下' : '未跑' }}
              </span>
              <span class="stage__name">{{ SAFETY_STAGE_LABELS[stage.stage] ?? stage.stage }}</span>
              <span v-if="stage.reason" class="stage__note">{{ stage.reason }}</span>
            </li>
          </ul>
          <p v-if="turn" class="kv">
            终审次数：<span class="kv__v">{{ turn.safetyFinal.finalizations }} 次 · 撤回 {{ turn.safetyFinal.retractions }} 次 · 缓冲 {{ turn.safetyFinal.bufferedChars }} 字符</span>
          </p>
        </section>

        <section class="block">
          <h3 class="block__title">{{ DIAG_BLOCKS[8].title }}</h3>
          <p class="block__lead">{{ DIAG_BLOCKS[8].lead }}</p>
          <p class="kv"><span class="kv__v">{{ sandboxText }}</span></p>
        </section>

        <section class="block">
          <h3 class="block__title">{{ DIAG_BLOCKS[9].title }}</h3>
          <p class="block__lead">{{ DIAG_BLOCKS[9].lead }}</p>
          <p v-if="diagnostics.interceptions.length === 0" class="empty">
            还没有任何拦截记录。先做一次会被拦下的动作（例如被冷却挡下的学段变更）。
          </p>
          <ul v-else class="blocks" data-testid="demo-interceptions">
            <li v-for="(item, index) in diagnostics.interceptions" :key="`${item.turn}-${index}`" class="blocked">
              <span class="blocked__turn">第 {{ item.turn }} 轮</span>
              <span class="blocked__src">{{ item.source }}</span>
              <span class="blocked__why">{{ item.reason }}</span>
              <span v-if="item.detail" class="blocked__detail">{{ item.detail }}</span>
            </li>
          </ul>
        </section>

        <section class="block">
          <h3 class="block__title">{{ DIAG_BLOCKS[10].title }}</h3>
          <p class="block__lead">{{ DIAG_BLOCKS[10].lead }}</p>
          <p v-for="line in runtimeLines" :key="line" class="kv">
            <span class="kv__v">{{ line }}</span>
          </p>
        </section>

        <section class="block">
          <h3 class="block__title">{{ DIAG_BLOCKS[11].title }}</h3>
          <p class="block__lead">{{ DIAG_BLOCKS[11].lead }}</p>
          <ul class="guards">
            <li v-for="row in GUARD_CATALOG" :key="row.id" class="guard">
              <span class="guard__id">{{ row.id }}</span>
              <span class="guard__what">{{ row.what }}</span>
            </li>
          </ul>
        </section>
      </main>

      <aside class="col col--raw">
        <h2 class="col__title">原始信封</h2>
        <p class="col__lead">{{ PAGE_HEADINGS.rawHint }}</p>
        <p v-if="!turn" class="empty">还没有数据。</p>
        <pre v-else class="pre pre--raw" data-testid="demo-raw">{{ JSON.stringify(turn, null, 2) }}</pre>
      </aside>
    </div>

    <!-- ② 调用顺序：同一轮信封的**时间读法**（组件自己负责滚动，见它的文件头）。 -->
    <div v-else class="seqwrap" data-testid="demo-sequence">
      <DiagSequence :turn="turn" />
    </div>
  </section>
</template>

<style scoped>
.demo {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px 24px;
  min-height: 0;
  height: 100%;
  overflow: hidden;
}
.bar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}
.bar__title {
  margin: 0;
  /* 分块标题 = 区块标题档（h2 24px，优化报告 §2.1）。 */
  font-size: var(--k12-fs-h2);
  font-weight: 700;
  color: var(--k12-fg);
}
.bar__sub {
  margin: 4px 0 0;
  max-width: 720px;
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body);
  color: var(--k12-muted);
}
.bar__tools {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
/* 分段切换：一条轨道 + 两段（选中那段是纸面 + 强调墨色边）。 */
.views {
  flex: none;
  display: flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-control);
  background: var(--k12-surface-2);
}
.views__tab {
  min-width: 76px;
  min-height: 26px;
  padding: 0 12px;
  border: 1px solid transparent;
  border-radius: var(--k12-r-sm);
  background: transparent;
  color: var(--k12-muted);
  font-family: inherit;
  font-size: var(--k12-fs-caption);
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}
.views__tab[data-view='blocks'][aria-selected='true'],
.views__tab[data-view='sequence'][aria-selected='true'] {
  border-color: var(--k12-accent-border);
  background: var(--k12-surface);
  color: var(--k12-accent-ink);
}
@media (hover: hover) and (pointer: fine) {
  .views__tab:hover:not([aria-selected='true']) {
    color: var(--k12-fg-2);
  }
}
/* 导航快捷按钮与「读写动作」之间的一道细分隔（只用既有令牌）。 */
.bar__sep {
  flex: none;
  align-self: stretch;
  width: 1px;
  margin: 0 2px;
  background: var(--k12-border);
}
.chip {
  padding: 4px 9px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-label);
}
.btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 30px;
  padding: 0 11px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-caption);
  font-weight: 600;
  cursor: pointer;
}
.btn--danger {
  color: var(--k12-warn);
  border-color: var(--k12-warn);
}
.notice {
  margin: 0;
  padding: 7px 10px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
  font-size: var(--k12-fs-caption);
  color: var(--k12-fg-2);
}
.notice--warn {
  color: var(--k12-warn);
}
.cols {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr) 320px;
  gap: 12px;
}
/* 「调用顺序」子页的落点：与 `.cols` 同级、同高，内部由组件自己滚动。 */
.seqwrap {
  flex: 1;
  min-height: 0;
  display: flex;
}
.col {
  min-height: 0;
  overflow-y: auto;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-card);
  background: var(--k12-surface);
  padding: 12px;
}
.col__title {
  margin: 0 0 8px;
  font-size: var(--k12-fs-body-sm);
  font-weight: 700;
  color: var(--k12-fg);
}
.col__lead {
  margin: 0 0 8px;
  font-size: var(--k12-fs-label);
  color: var(--k12-muted);
}
.timeline {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.node {
  width: 100%;
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 6px;
  align-items: center;
  padding: 7px 9px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface);
  text-align: left;
  cursor: pointer;
}
.node[data-on='true'] {
  border-color: var(--k12-accent-ink);
  background: var(--k12-accent-soft);
}
.node__turn {
  font-size: var(--k12-fs-caption);
  font-weight: 650;
  color: var(--k12-fg);
}
.node__meta {
  font-size: var(--k12-fs-label);
  color: var(--k12-muted);
}
.node__signal {
  font-size: var(--k12-fs-label);
  color: var(--k12-muted);
}
.node__signal[data-ok='false'] {
  color: var(--k12-warn);
}
/* 会话标题：跨满整行（`.node` 是三列网格，多出来的这一行自己占一整行）。 */
.node__session {
  grid-column: 1 / -1;
  font-size: var(--k12-fs-label);
  color: var(--k12-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.blocks {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.block {
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-card);
  padding: 12px;
  background: var(--k12-surface);
}
.block__title {
  margin: 0;
  font-size: var(--k12-fs-body-sm);
  font-weight: 700;
  color: var(--k12-fg);
}
.block__lead {
  margin: 4px 0 8px;
  font-size: var(--k12-fs-label);
  line-height: var(--k12-lh-body);
  color: var(--k12-muted);
}
.kv {
  margin: 0 0 4px;
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
}
.kv__v {
  color: var(--k12-fg-2);
}
.mono {
  font-family: var(--k12-font-mono, monospace);
}
.empty {
  margin: 0;
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
}
.warn {
  margin: 6px 0 0;
  font-size: var(--k12-fs-caption);
  color: var(--k12-warn);
}
.stages,
.levels,
.tools,
.guards {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.stage,
.level,
.tool,
.guard {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
  font-size: var(--k12-fs-caption);
  color: var(--k12-fg-2);
}
.stage__mark {
  flex: none;
  padding: 1px 6px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-warn-soft);
  color: var(--k12-warn);
  font-size: var(--k12-fs-label);
  font-weight: 650;
}
.stage__mark[data-ok='true'] {
  background: var(--k12-surface-2);
  color: var(--k12-fg-2);
}
.stage__name {
  font-weight: 600;
}
.stage__note,
.level__note,
.guard__what {
  flex: 1;
  min-width: 0;
  color: var(--k12-muted);
  font-size: var(--k12-fs-label);
}
.tool__seq {
  flex: none;
  width: 16px;
  color: var(--k12-muted-2);
}
.tool__name {
  font-family: var(--k12-font-mono, monospace);
  font-weight: 600;
}
.tool__meta {
  color: var(--k12-muted);
}
.tool__badge,
.blocked__src {
  padding: 1px 6px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-warn-soft);
  color: var(--k12-warn);
  font-size: var(--k12-fs-label);
}
.levels {
  margin-top: 8px;
}
.level[data-tried='false'] {
  opacity: 0.7;
}
.level__name,
.level__state {
  flex: none;
}
.blocked {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
  padding: 7px 9px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-warn-soft);
  font-size: var(--k12-fs-caption);
  color: var(--k12-fg-2);
}
.blocked__turn {
  font-weight: 650;
  color: var(--k12-warn);
}
.blocked__why {
  flex: 1;
  min-width: 0;
}
.blocked__detail {
  width: 100%;
  font-size: var(--k12-fs-label);
  color: var(--k12-muted);
}
.guard__id {
  flex: none;
  font-family: var(--k12-font-mono, monospace);
  font-weight: 650;
  color: var(--k12-accent-ink);
}
.seg {
  margin-top: 6px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-flat);
  padding: 6px 8px;
}
.seg__sum {
  cursor: pointer;
  font-size: var(--k12-fs-caption);
  color: var(--k12-fg-2);
}
.seg__cut {
  color: var(--k12-muted);
}
.pre {
  margin: 6px 0 0;
  padding: 8px;
  max-height: 260px;
  overflow: auto;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
  color: var(--k12-fg-2);
  font-family: var(--k12-font-mono, monospace);
  font-size: var(--k12-fs-label);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.pre--raw {
  max-height: none;
}
</style>
