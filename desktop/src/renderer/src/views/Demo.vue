<script setup lang="ts">
/**
 * 演示驾驶舱：把「一次提问背后发生了什么」摊开的那一页。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三栏的分工（与报告 §4.2 的布局一一对应）
 * ══════════════════════════════════════════════════════════════════════════
 *   左：轮次时间轴（点节点 → 中栏定位到那一轮）
 *   中：十二个分块 + 三张卡（这一轮逐段的机制证据）
 *   右：原始信封（结构化数据，证明「这些都是运行时真的产生的」）
 *
 * ★★ 数据只有一个来源：`stores/diagnostics.ts` 的 `TurnDiagnostics` 快照。
 *   浮窗读的是同一个 store、同一个 `DiagSummary` —— 两处显示同一份数（不做两套 UI）。
 * ★ 本页只在**演示 / 调试档**可达（`PAGES.demo.nav === 'debug'`），
 *   所以这里可以直说技术口径的话；技术词的原文集中在 `components/diag/evidence.ts`，
 *   由守卫按文件豁免（见那个文件头的说明）。
 *
 * ⚠️ 本页**不产生**任何运行时数据（不重算、不补数）：拿不到就如实显示空。
 */
import { computed, ref } from 'vue'
import { Eraser, Moon, RefreshCw, Sun, Download } from 'lucide-vue-next'
import {
  CONTRACT_CHAIN,
  DEMO_HEADINGS,
  DIAG_BLOCKS,
  GRADE_MATRIX_ROWS,
  GUARD_CATALOG,
  HIDDEN_MECHANISM_CARDS,
  MD_FENCE,
  PROMPT_STAGE_LABELS,
  RETRIEVAL_LEVEL_LABELS,
  SAFETY_STAGE_LABELS
} from '../components/diag/evidence'
import DiagSummary from '../components/diag/DiagSummary.vue'
import { useDiagnosticsStore } from '../stores/diagnostics'
import { useStudentStore } from '../stores/student'
import { useSidecarStore } from '../stores/sidecar'
import { resolveStudyBridge } from '../api/study'
import { todayStamp } from '../study/export-naming'
import { BRAND_NAME } from '@shared/brand'

const diagnostics = useDiagnosticsStore()
const student = useStudentStore()
const sidecar = useSidecarStore()

/** 实时 = 跟最新一轮；回放 = 停在选中的那一轮（演示时节奏可控）。 */
const live = ref(true)
const exporting = ref(false)
const exportNotice = ref('')

const turn = computed(() => diagnostics.active)

function pick(current: number): void {
  live.value = false
  diagnostics.select(current)
}

function goLive(): void {
  live.value = true
  diagnostics.select(null)
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
 *   演示时这两个数比任何一句「我们做了进程管理」都有说服力。
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

/** 演示学生标识：读的是主进程定的那个身份（本页只展示，不做任何切换）。 */
const studentLabel = computed(() => {
  const id = student.student?.studentId ?? ''
  return id === '' ? '（还没取到）' : `${id}（昵称 ${student.nickname}）`
})

/**
 * 导出演示包（Markdown：脱敏信封 + 工具轨迹图 + 四学段对比）。
 *
 * ★ 走**既有**的 `file:export` 通道（保存对话框 + 文件名清理都在主进程），
 *   不新增后缀、不新增通道 —— 演示包是给人看的文档，不是机器接口。
 */
async function exportPackage(): Promise<void> {
  const current = turn.value
  if (!current) {
    exportNotice.value = '还没有可导出的轮次。'
    return
  }
  const lookup = resolveStudyBridge()
  if (!lookup.ready) {
    exportNotice.value = lookup.message
    return
  }
  exporting.value = true
  try {
    const nodes = current.tools
      .map((tool) => `  C${tool.seq}["${tool.name}<br/>${tool.ok ? 'ok' : 'fail'} · ${Math.round(tool.latencyMs)}ms"]:::${tool.ok ? 'ok' : 'fail'}`)
      .join('\n')
    const lines = [
      `# ${BRAND_NAME} 演示包（第 ${current.turn} 轮）`,
      '',
      `- 导出时间：${todayStamp()}`,
      `- 轮次：第 ${current.turn} 轮（状态 ${current.done.status}，总耗时 ${current.done.totalMs}ms）`,
      `- 学段：${current.grade.applied}（判定层 ${current.grade.decidedBy ?? '待判定'}）`,
      `- 提示词体量：${current.prompt.chars} 字符 / 约 ${current.prompt.totalTokens} tok`,
      `- 画像块指纹：${current.studentContext.byteHash || '本轮未注入'}`,
      '',
      '## 工具调用轨迹',
      '',
      MD_FENCE.mermaid,
      'flowchart TD',
      '  classDef ok fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20',
      '  classDef fail fill:#ffebee,stroke:#c62828,color:#b71c1c',
      `  T_START(["第 ${current.turn} 轮 · 学生提问"])`,
      nodes,
      nodes ? '  T_START --> C1' : '  T_START --> T_END(["本轮没有调用工具"])',
      MD_FENCE.close,
      '',
      '## 脱敏后的轮次信封',
      '',
      MD_FENCE.json,
      JSON.stringify(current, null, 2),
      MD_FENCE.close,
      ''
    ]
    const result = await lookup.bridge.exportMarkdown({
      fileName: `${BRAND_NAME}-演示包-${todayStamp()}`,
      content: lines.join('\n')
    })
    exportNotice.value = result.ok ? `已导出：${result.fileName}` : result.message
  } finally {
    exporting.value = false
  }
}

async function clearAll(): Promise<void> {
  const result = await diagnostics.clear()
  live.value = true
  exportNotice.value = result.ok ? '已清空演示记录。' : result.message
}
</script>

<template>
  <section class="demo" data-testid="demo-view">
    <header class="bar">
      <div class="bar__lead">
        <h1 class="bar__title">{{ DEMO_HEADINGS.title }}</h1>
        <p class="bar__sub">{{ DEMO_HEADINGS.lead }}</p>
      </div>
      <div class="bar__tools">
        <span class="chip" data-testid="demo-student">{{ studentLabel }}</span>
        <button type="button" class="btn" :data-on="String(live)" @click="goLive()">
          <Sun :size="13" />实时
        </button>
        <button type="button" class="btn" :data-on="String(!live)" @click="live = false">
          <Moon :size="13" />回放
        </button>
        <button type="button" class="btn" :disabled="exporting" @click="exportPackage()">
          <Download :size="13" />导出演示包
        </button>
        <button type="button" class="btn" data-testid="demo-refresh" @click="diagnostics.refresh()">
          <RefreshCw :size="13" />重新读取
        </button>
        <button type="button" class="btn btn--danger" data-testid="demo-clear" @click="clearAll()">
          <Eraser :size="13" />一键清空
        </button>
      </div>
    </header>

    <p v-if="exportNotice" class="notice" data-testid="demo-notice">{{ exportNotice }}</p>
    <p v-if="diagnostics.bridgeError" class="notice notice--warn">{{ diagnostics.bridgeError }}</p>
    <p v-if="diagnostics.fromDisk" class="notice" data-testid="demo-from-disk">
      下面这些是上一次运行留下的记录（落盘只留结构与结论，正文不落盘）。
    </p>

    <div class="cols">
      <aside class="col col--timeline">
        <h2 class="col__title">轮次时间轴</h2>
        <p v-if="diagnostics.turns.length === 0" class="empty">{{ DEMO_HEADINGS.timelineEmpty }}</p>
        <ol v-else class="timeline" data-testid="demo-timeline">
          <li v-for="item in diagnostics.turns" :key="item.turn">
            <button
              type="button"
              class="node"
              :data-on="String(item.turn === turn?.turn)"
              @click="pick(item.turn)"
            >
              <span class="node__turn">第 {{ item.turn }} 轮</span>
              <span class="node__meta">
                {{ item.prompt.totalTokens }} tok · {{ item.tools.length }} 次工具
                <template v-if="item.interceptions.length > 0"> · {{ item.interceptions.length }} 次拦截</template>
              </span>
              <span class="node__signal" :data-ok="String(item.done.ok)">
                {{ item.done.ok ? '完成' : item.done.status }}
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
            还没有任何拦截记录。演示时先做一次「被拦下」的动作（例如被冷却挡下的学段变更）。
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
          <p class="kv">防漂移链：<span class="kv__v">{{ CONTRACT_CHAIN }}</span></p>
          <ul class="guards">
            <li v-for="row in GUARD_CATALOG" :key="row.id" class="guard">
              <span class="guard__id">{{ row.id }}</span>
              <span class="guard__what">{{ row.what }}</span>
            </li>
          </ul>
        </section>

        <section class="block">
          <h3 class="block__title">四学段横向对比</h3>
          <p class="block__lead">同一句提问在四个学段下的语气与深度差异（演示时点学段指示器即可现场切换）。</p>
          <table class="matrix">
            <thead>
              <tr><th>学段</th><th>语气</th><th>深度</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in GRADE_MATRIX_ROWS" :key="row.grade">
                <td>{{ row.grade }}</td>
                <td>{{ row.tone }}</td>
                <td>{{ row.depth }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section class="block">
          <h3 class="block__title">隐藏机制补充</h3>
          <p class="block__lead">不属于某一轮，但属于「看不见的评分权重」那一批。</p>
          <ul class="cards">
            <li v-for="card in HIDDEN_MECHANISM_CARDS" :key="card.title" class="card">
              <strong class="card__title">{{ card.title }}</strong>
              <span class="card__body">{{ card.body }}</span>
            </li>
          </ul>
        </section>
      </main>

      <aside class="col col--raw">
        <h2 class="col__title">原始信封</h2>
        <p class="col__lead">{{ DEMO_HEADINGS.rawHint }}</p>
        <p v-if="!turn" class="empty">还没有数据。</p>
        <pre v-else class="pre pre--raw" data-testid="demo-raw">{{ JSON.stringify(turn, null, 2) }}</pre>
      </aside>
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
.btn[data-on='true'] {
  border-color: var(--k12-accent-ink);
  color: var(--k12-accent-ink);
  background: var(--k12-accent-soft);
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
.guards,
.cards {
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
.guard,
.card {
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
.guard__what,
.card__body {
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
.card__title {
  flex: none;
  color: var(--k12-fg);
}
.matrix {
  width: 100%;
  margin-top: 6px;
  border-collapse: collapse;
  font-size: var(--k12-fs-caption);
}
.matrix th,
.matrix td {
  padding: 5px 7px;
  border: 1px solid var(--k12-border);
  text-align: left;
  color: var(--k12-fg-2);
}
.matrix th {
  background: var(--k12-surface-2);
  color: var(--k12-muted);
  font-weight: 650;
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
