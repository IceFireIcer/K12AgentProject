<script setup lang="ts">
/**
 * 教材知识库（**教师控制台** —— 数据层检视视图）。
 *
 * ★★ 这一页只属于**教师 / 答辩视角**（`stores/ui.ts` 的 `PAGES.knowledge.nav === 'teacher'`，
 *    学生视角下侧栏根本不给入口）。所以它不再假装是一页「谁都能看的教材目录」：
 *    页头第一句就说明它是**数据层检视**，技术列（kp_id / 向量状态 / 文件路径）照旧保留 ——
 *    那正是这一页存在的理由（答辩要看「库里到底有什么、有没有真的嵌进去」）。
 *
 * ★ 学生需要「看教材」这件事由**学习档案 → 章节进度**承担（`study/ChaptersTab.vue`），
 *   不在这里做第二份 —— 两处各写一套必然会分叉。
 *
 * ★ 这一页的主角是**表**，不是统计。
 *   此前顶部 4 个磁贴的数字用了 22px（xl 档），而表格正文只有 13px ——
 *   于是"知识库"这一页最重的东西是 4 个装饰性统计，真正的主对象（知识点表）
 *   被压住了，内容区的最大字号也来自磁贴而不是页面身份（焦点错了）。
 *   现在：身份行 22px（PageIdentity）> 卡头 16px > 表格 13px，
 *   统计降级为表格上方**一行 12px** 的口径说明（meta 档，不是标题档）。
 *
 * ── 数据来源（**全部来自 `useKnowledgeStore`，本页不再自带任何样本行**）──
 *   体检数字   `GET /api/knowledge/stats`   → `stats.counts` / `embeddingDim` / `vecReady` …
 *   知识点清单 `GET /api/knowledge/points`  → 表格每一行
 *   导入教材   `POST /api/knowledge/import` → 逐条校验结果
 *   重建索引   `POST /api/knowledge/rebuild`（长任务，回执带耗时）
 *   统计口径全在 Python 侧算（这是混合后端的硬边界：TS 不读 SQLite、不数行）。
 *
 * ★ 控件换成了 Element Plus：搜索框 → `el-input`（带空态），表格 → `el-table`
 *   （带空态与列排序），标签 → `el-tag`。手写 `<table>` 没有排序、没有空态、窄屏会横向溢出。
 *
 * ★★ 两个按钮都是**重活**（重建要跑整份教材的分块 + 嵌入，实测 ~6s 纯 CPU；
 *    导入默认重建，所以它同样是重活），因此两处都**先问一句**再动手 ——
 *    用全站唯一的确认框（`stores/confirm.ts`），而不是「按下去就开始跑」。
 */
import { computed, onMounted, ref } from 'vue'
import { RefreshCw, Upload, FileUp, AlertTriangle, CheckCircle2 } from 'lucide-vue-next'
import { useKnowledgeStore } from '../stores/knowledge'
import { useConfirm } from '../stores/confirm'
import { GRADE_LABELS } from '../labels'
import { GRADE_LEVELS } from '../api/grade'
import EmptyState from '../components/EmptyState.vue'
import TeacherGate from '../components/TeacherGate.vue'
import type { GradeLevel } from '@shared/ipc-events'

const knowledge = useKnowledgeStore()
const confirm = useConfirm()

/** 内容类型的中文名（契约里 `contentType` 是自由字符串，认不出就原样显示）。 */
const TYPE_LABEL: Record<string, string> = {
  concept: '概念',
  principle: '原理',
  practice: '实践',
  ethics: '伦理',
  project: '项目'
}

/** 学段标签色（只为扫读时能区分四档，不承载语义）。 */
const GRADE_TAG: Record<GradeLevel, 'primary' | 'success' | 'warning' | 'info'> = {
  primary_low: 'warning',
  primary_high: 'success',
  junior: 'primary',
  senior: 'info'
}

/**
 * 学段筛选项。
 * ★ 值就是契约里的 `GradeLevel` 字面量（学段过滤直接写进 store 的 `gradeFilter`），
 *   中文名取自 `labels.ts` —— 本页不另写一份「小学低 / 小学高」的简称表。
 */
const GRADE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部' },
  ...GRADE_LEVELS.map((level) => ({ value: level as string, label: GRADE_LABELS[level] }))
]

/** 关键词只在**取回来的全量清单**上做本地过滤（服务端已按 `gradeFilter` 分派过一次）。 */
const keyword = ref('')

const filtered = computed(() => {
  const rows = knowledge.filteredPoints
  const kw = keyword.value.trim()
  if (!kw) return rows
  return rows.filter(
    (row) => row.name.includes(kw) || row.kpId.includes(kw) || row.chapterTitle.includes(kw)
  )
})

/* ---------------------------------------------------------------- 导入 */

const fileInput = ref<HTMLInputElement | null>(null)

/**
 * 导入时带上当前选中的学段。
 *
 * ★ 选了具体学段就递过去（服务端会拿它与文件头的 `grade_level` 比对，
 *   不一致时作为**一条 problem** 报回来）；停在「全部」就不指定，
 *   由文件头自己声明 —— 这里不猜一个学段。
 */
const importGrade = computed<GradeLevel | undefined>(() =>
  (GRADE_LEVELS as readonly string[]).includes(knowledge.gradeFilter)
    ? (knowledge.gradeFilter as GradeLevel)
    : undefined
)

/**
 * 选文件 → 读全文 → **确认** → 交给 store 导入。
 *
 * ★ 前端**不做任何校验**：文件头、kp_id 与文件名是否一致、超纲术语、学段错位
 *   全部由 Python 侧判定（那里的术语文表才是权威）。本页只把「未通过的原因」逐条显示。
 * ★ 选中后立刻清空 input：同一个文件再选一次也要能再次触发 `change`
 *   （不清空的话第二次导入静默无反应）。
 * ★★ **确认放在选完文件之后**：这时候才知道学生选的是哪一份（文件名 + 大小能进确认框），
 *    比「先问一句要不要导入、再让他去选文件」有用得多；而且这一步是重活
 *    （服务端的 `rebuild` 默认为 true —— 导入完会把整份教材重新嵌入一遍，
 *    实测 ~6s 纯 CPU），所以必须让他知道「按下去会等几秒、机器会忙一阵」。
 * ★ 取消 = 什么都不做，**不包括**重选文件（input 已经清空，再点按钮即可重选）。
 */
async function onFilePicked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  input.value = ''
  if (!file) return
  const markdown = await file.text()

  const ok = await confirm.ask({
    title: `导入「${file.name}」？`,
    body:
      '导入后会把整份教材重新分块并嵌入一遍（几秒钟，期间电脑会忙一阵），' +
      '完成后这个知识点立刻能被检索到。文件内容有问题时会逐条列出来，不会写进库。',
    confirmText: '导入并重建'
  })
  if (!ok) return

  await knowledge.importMarkdown({
    fileName: file.name,
    markdown,
    ...(importGrade.value ? { gradeLevel: importGrade.value } : {})
  })
}

/* ---------------------------------------------------------------- 重建 */

/** 重建耗时（回执里的 `elapsedMs`）：秒级显示成「3.2s」，毫秒级显示成「820ms」。 */
function formatElapsed(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return ''
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

const elapsedText = computed(() => formatElapsed(knowledge.lastElapsedMs))

/**
 * 发起重建 —— **先确认**。
 *
 * ★ 这是全站最重的一个按钮：整份教材重新分块 + 嵌入（实测 ~6s，教材变多会更久），
 *   期间 CPU 跑满、界面上的其它操作会变卡。按下去之前必须有一句话说明这件事
 *   （`danger: true` 是因为它**没有中间状态可取消** —— 开始了就得等它跑完）。
 * ★ 这里**没有**假进度、也没有计时器：`rebuildPhase` 由 store 按真实回执推进
 *   （`running` → `done` / `failed`），主进程对这条通道用的是长超时（整份教材的
 *   分块 + 嵌入是秒级到十几秒的活）。失败时 `rebuildMessage` 是服务端给的**可读中文**，
 *   直接用那条消息驱动失败态，不在前端编原因。
 */
async function rebuild() {
  const ok = await confirm.ask({
    title: '重建索引？',
    body:
      '会把整份教材重新分块、重新算一遍向量（几秒钟，期间电脑会忙一阵）。' +
      '你自己导入的教材会一起算进去，不会丢；期间可以继续用别的页面。',
    confirmText: '开始重建',
    danger: true
  })
  if (!ok) return
  await knowledge.rebuild()
}

/* ---------------------------------------------------------------- 口径行 */

/**
 * 口径行：这些数字是**这一页所检视的那份数据的量纲**，是表格的 caption，不是主角。
 *
 * ⚠️ 它们此前是几个 22px（`--k12-fs-xl`）的磁贴 —— 与身份行同档，而表格正文只有 13px。
 *    现在是一行 12px（meta 档）：数字靠 650 字重 + tabular-nums 可扫读，**不再靠字号争焦点**。
 * ⚠️ `stats` 还没回来时**不渲染**（不拿 0 冒充"库是空的"）。
 */
const scope = computed(() => {
  const stats = knowledge.stats
  if (!stats) return []
  const parent = stats.counts?.parent_chunk ?? 0
  const child = stats.counts?.child_chunk ?? 0
  return [
    { value: String(knowledge.knowledgePointCount), label: '个知识点' },
    { value: String(knowledge.chunkCount), label: `个分块（父 ${parent} / 子 ${child}）` },
    { value: String(knowledge.dependencyCount), label: '条依赖边' },
    { value: `${stats.embeddingDim} 维`, label: `嵌入（${stats.embeddingModel || '模型未标注'}）` },
    { value: knowledge.vecReady ? '可用' : '不可用', label: '向量索引' },
    { value: knowledge.userRebuilt ? '用户重建' : '随包资产', label: '当前知识库' },
    { value: String(knowledge.gradeCount), label: '个学段有内容' }
  ]
})

/**
 * 操作栏左侧那句总说明。
 *
 * ★★ **这里不再放 `kb.sqlite` 的完整路径。**
 *   原来这一槽是 `数据层检视视图 · <完整 Windows 路径>` —— 两个问题：
 *     ① 路径里带着开发机的用户名与目录结构，而它在**页面的操作栏**（最显眼的一行）；
 *     ② 路径很长（实测 ~90 字符），把这一行顶到换行，两个按钮被挤到下面一行。
 *   现在这里只留「这是一页什么页」，**路径移到下方明确标注的技术读数块里**
 *   （`<TeacherGate label="技术读数">`），并按末尾几段截短。
 * ★ 这一槽不能空着：`.pa__info { flex: 1 }` 是这条栏把操作推到右边的唯一依仗，
 *   槽为空会被 `.pa__info:empty { display: none }` 收掉，两个按钮就会跑到左边去。
 */
const viewScopeLabel = computed(() =>
  knowledge.stats?.userRebuilt ? '数据层检视视图 · 本机知识库（你重建过的那一份）' : '数据层检视视图 · 本机知识库'
)

/**
 * 知识库文件的**完整路径** —— 只给技术读数块用（学生看不到这一页）。
 *
 * ★ 取不到时给空串（`<TeacherGate>` 里那一行整块不渲染），不编一个假路径出来。
 */
const kbPath = computed(() => knowledge.stats?.kbPath ?? '')

/**
 * 把长路径截成「… + 末尾几段」。
 *
 * ★ 为什么是**路径**而不是只给目录：老师说「到底在用哪一份库」时，
 *   要的是「哪个目录下的哪个文件」—— 只给目录名会丢掉「随包 / 用户重建」这层区别。
 * ★ 完整路径进 `title`（悬停可见），所以截短**不丢失信息**，只是不占版面。
 * ★ 只保留末尾 3 段（如 `…\server\_data\shared\kb.sqlite`）：
 *   再长就会把这一行顶到换行，那正是原来那个问题的成因。
 */
function shortenPath(full: string, keep = 3): string {
  const parts = full.split(/[/\\]/).filter((part) => part.length > 0)
  if (parts.length <= keep) return full
  return `…\\${parts.slice(-keep).join('\\')}`
}

const kbPathShort = computed(() => (kbPath.value ? shortenPath(kbPath.value) : ''))

/** 取数失败（桥缺失 / 端点报错）：三种来源合成一条可读中文，先到先得。 */
const loadError = computed(
  () => knowledge.bridgeError ?? knowledge.statsError ?? knowledge.pointsError
)

onMounted(() => {
  // 幂等：store 里已有数据时连加载态都不翻（切回本页不会闪一下）
  void knowledge.loadAll()
})
</script>

<template>
  <div class="kb">
    <PageActions>
      <!-- ⚠️ `#info` 里**只留原句不重复的那一半**：「教材来源：人工编写 Markdown +
           元数据（不做 PDF 解析）」已经由下面身份行的 `meta` 承担，两处同一句话是冗余。
           ⚠️ 但整个槽**不能空着**：`.pa__info { flex: 1 }` 是这条栏把操作推到右边的唯一
           依仗，槽为空会被 `.pa__info:empty { display: none }` 收掉，
           两个按钮就会跑到**左边**去 —— 与本项目其余各页的按钮位置不一致。
           ⚠️ 这里也**不放完整路径**（那会把这一行顶到换行，两个按钮被挤下去）——
           路径在下面明确标注的技术读数块里，且是截短过的。 -->
      <template #info>
        <span>{{ viewScopeLabel }}</span>
      </template>
      <input
        ref="fileInput"
        type="file"
        accept=".md,.markdown"
        class="kb__file"
        data-testid="kb-file-input"
        @change="onFilePicked"
      />
      <el-button :loading="knowledge.importing" :disabled="knowledge.importing" @click="fileInput?.click()">
        <Upload v-if="!knowledge.importing" :size="14" />
        <span class="btn__label">{{ knowledge.importing ? '导入中…' : '导入教材' }}</span>
      </el-button>
      <el-button
        :loading="knowledge.rebuildPhase === 'running'"
        :disabled="knowledge.rebuildPhase === 'running'"
        @click="rebuild"
      >
        <RefreshCw v-if="knowledge.rebuildPhase !== 'running'" :size="14" />
        <span class="btn__label">
          {{
            knowledge.rebuildPhase === 'running'
              ? '重建中…'
              : knowledge.rebuildPhase === 'failed'
                ? '重试'
                : '重建索引'
          }}
        </span>
      </el-button>
    </PageActions>

    <!-- 身份行（22px）：内容区的最大字号在这里，不在统计上。
         `meta` 承接了原本写在 PageActions `#info` 里的「教材来源」口径 —— 同一句话只留一处。 -->
    <PageIdentity
      main="库里到底有什么教材"
      meta="教材来源：人工编写 Markdown + 元数据（不做 PDF 解析）"
      hint="先按学段筛，再搜知识点；导入或重建前会先问一句，确认后才开始"
    />

    <!-- ── 这一页是什么 ────────────────────────────────────────────────
         学生视角下侧栏根本没有这个入口（`PAGES.knowledge.nav === 'teacher'`），
         所以这里不必再遮技术词 —— 但要**说清这一页的位置**：
         它是数据层检视，学生看教材的地方是「学习档案 → 章节进度」。 -->
    <TeacherGate label="这一页是什么">
      <p class="kb__tech">
        这是教材知识库的**数据层检视**页（教师 / 答辩用）：表里每一行都是
        <code>kb.sqlite</code> 里的真实记录，用来核对「教材进来了没有、向量嵌上了没有」。
        学生看教材进度走「学习档案 → 章节进度」，不需要这一页。
      </p>
    </TeacherGate>

    <!-- 取数失败（sidecar 没起来 / 桥缺失）：说清原因，别让表格空着让人以为是"库里没有"。
         ★ 用全站统一的 EmptyState（原来是自己拼的一块红条），title 给人话，
           原始报错收进技术块 —— 这一页是教师控制台，报错原文对排障有用，
           但不该与「你该怎么办」混成一段。 -->
    <EmptyState
      v-if="loadError"
      tone="error"
      title="读不到知识库"
      desc="本地知识库服务暂时没响应。先确认后端已启动，再点下面这个按钮重试。"
      data-testid="kb-load-error"
    >
      <el-button size="small" @click="knowledge.loadAll(true)">重试</el-button>
    </EmptyState>

    <!-- 重建失败：失败原因来自服务端（模型缺失 / 维度不符 / 教材格式错），逐字显示 + 可重试。 -->
    <EmptyState
      v-else-if="knowledge.rebuildPhase === 'failed'"
      tone="error"
      title="重建索引失败"
      desc="教材还是原来的那一份，没有损坏。修好下面说的原因之后再重试一次。"
      data-testid="kb-rebuild-fail"
    >
      <el-button size="small" @click="rebuild">重试</el-button>
    </EmptyState>

    <!-- 出错的**原始原因**：教师排障要它，所以一条都不删，只是单独收进技术块
         （与上面两句「你该怎么办」分开 —— 混成一段时，人会以为那串状态码才是要读的东西）。 -->
    <TeacherGate v-if="loadError" label="原始报错">
      <p class="kb__tech">{{ loadError }}</p>
    </TeacherGate>
    <TeacherGate v-else-if="knowledge.rebuildPhase === 'failed'" label="原始报错">
      <p class="kb__tech">{{ knowledge.rebuildMessage }}</p>
    </TeacherGate>

    <!-- 导入回执：说清"选了什么、认出了什么 / 哪几条没过"。
         ⚠️ 位置固定在**身份行与表格卡片之间**（不插进卡片内部）——
         卡片是"一块内容"，卡头 / 工具条 / 表格 / 卡脚必须连续，
         否则"这一条属于这张表"的从属关系就散了。
         ⚠️ 「内容被拒」**不是** HTTP 失败（回执是 `{ok:true, data:{ok:false, problems:[…]}}`），
         所以它显示成校验清单，而不是一句"导入失败"。 -->
    <div
      v-if="knowledge.importedFile"
      class="kb__import"
      :data-state="knowledge.importing ? 'running' : knowledge.importRejected ? 'rejected' : 'accepted'"
      data-testid="kb-import"
    >
      <FileUp v-if="!knowledge.importRejected" :size="15" />
      <AlertTriangle v-else :size="15" />
      <div class="kb__import-text">
        <p class="kb__import-name">
          {{ knowledge.importedFile.name }}
          <span class="k12-unit">{{ knowledge.importedFile.sizeKb }} KB</span>
        </p>

        <p v-if="knowledge.importing" class="kb__import-meta">正在校验并入库…</p>

        <template v-else-if="knowledge.importRejected">
          <p class="kb__import-meta">教材没有被接收 —— 下面每一条都要改掉才能入库：</p>
          <ul class="kb__problems" data-testid="kb-import-problems">
            <li v-for="(problem, index) in knowledge.importProblems" :key="`${index}-${problem}`">
              {{ problem }}
            </li>
          </ul>
        </template>

        <p v-else class="kb__import-meta">
          {{ knowledge.importMessage || '已通过校验并入库。' }}
        </p>
      </div>
      <el-button text @click="knowledge.dismissImport()">知道了</el-button>
    </div>

    <!-- 口径行：这一行是**表格的 caption**，不是主角（12px，meta 档）。 -->
    <p v-if="scope.length > 0" class="kb__scope" data-testid="kb-scope">
      <template v-for="(item, index) in scope" :key="item.label">
        <span v-if="index" class="kb__scope-sep" aria-hidden="true">·</span>
        <span class="kb__scope-item">
          <span class="k12-num kb__scope-n">{{ item.value }}</span> {{ item.label }}
        </span>
      </template>
    </p>
    <p v-else-if="knowledge.statsLoading" class="kb__scope kb__scope--pending">正在读取知识库体检数字…</p>

    <!-- ── 技术读数：这一页真正在检视的**是哪一份文件** ────────────────────
         它必须在这里、而不是页头那一行：页头是「这一页能做什么」，
         而文件路径是**排障时要核对的东西**（老师/评委问「你现在用的是哪一份库」）。
         截短后 3 段显示、完整路径进 `title`，所以既看得清又不顶版。 -->
    <TeacherGate v-if="kbPathShort" label="技术读数">
      <p class="kb__tech">
        正在检视的知识库文件：<code class="kb__path" :title="kbPath">{{ kbPathShort }}</code>
      </p>
      <p class="kb__tech">
        随包知识库是只读的；重建后写入的是用户目录下的这一份，检索时优先用它。
      </p>
    </TeacherGate>

    <SurfacePanel class="card">
      <header class="card__head">
        <div class="card__head-text">
          <h2 class="card__title">知识点与章节</h2>
        </div>
        <!-- 重建完成：时间 + 真实耗时（回执里的 elapsedMs，不是估算）。 -->
        <span v-if="knowledge.rebuildPhase === 'done'" class="index-done" data-testid="kb-rebuilt">
          <CheckCircle2 :size="14" />
          <span>
            索引已重建 · {{ knowledge.indexedAt
            }}<template v-if="elapsedText"> · 用时 {{ elapsedText }}</template>
          </span>
        </span>
      </header>

      <div class="toolbar">
        <el-input
          v-model="keyword"
          placeholder="搜索知识点、章节或 kp_id"
          clearable
          class="toolbar__search"
        />
        <el-radio-group v-model="knowledge.gradeFilter" size="small">
          <el-radio-button v-for="option in GRADE_OPTIONS" :key="option.value" :value="option.value">
            {{ option.label }}
          </el-radio-button>
        </el-radio-group>
      </div>

      <el-table
        :data="filtered"
        size="small"
        class="tbl"
        :border="false"
        data-testid="kb-table"
      >
        <!-- 列宽预算（1440 窗口）：内容区 1440 − 248 侧栏 − 44 页内边距 − 32 卡内边距 ≈ 1116。
             固定列合计 190+96+100+80+88 = 554，余下的按 min-width 分给「知识点」与「章节」。
             「章节」给到 230+（最长的一条「第4章 用 Python 处理数据」约 200px）——
             它是这一行里唯一能说明"这条知识点在教材的哪里"的信息，不该被截断。
             ⚠️ **各列宽度之和必须 ≤ 最紧那一档的可用宽度**，否则表格横向溢出：
                而 Element Plus 在这种情况下**表头不会跟着表体滚** ——
                实测（1280 窗口、右栏展开）：表体被压到 929 而表头仍是 988，
                结果「向量」列的表头被切掉一半（只剩「向」），表头与表体也错位。
                最紧的一档是 **1280 + 右栏展开**（1016 内容区 → 表体 929），
                比 1120（右栏自动收起，内容区反而 1052）更紧 —— 容易误判成「窗口越小越紧」。
             ★ 本表当前：186+176+120+176+100+80+88 = **926 ≤ 929** ✓（改列宽前重算这一条）。 -->
        <el-table-column prop="kpId" label="kp_id" width="186" show-overflow-tooltip>
          <template #default="{ row }">
            <code class="mono">{{ row.kpId }}</code>
          </template>
        </el-table-column>
        <!-- ★ 知识点列：**总宽预算的约束**比「放得下最长那条」更硬。
             最长的一条是「教学短板（难自动分层适配）」（需要 ~222px），
             但七列之和必须 ≤ 929（见顶部说明），给不起 222。
             取舍：**截断 + 悬停看全文**（`show-overflow-tooltip`）——
             截断至少是「明说被截了」，而表格横向溢出会让**表头被切掉一半**（更坏）。 -->
        <el-table-column prop="name" label="知识点" min-width="176" show-overflow-tooltip />
        <!-- ★ 宽度按**内容**定，不是按「大概够」定（实测踩到过）：
             学段标签最长「小学高年级」（标签本身 75px）+ `.cell` 左右内边距 8×2 +
             标签的 border/padding，实际需要 **111px**；原来写 96px，
             Element Plus 于是把它裁成「小学低年级 …」—— 多出来的那个省略号
             既不是数据的一部分，也不是任何一列的标题，看着像界面坏了。
             ⚠️ 改窄了会再触发一次（列宽改小是**静默**的：只多一个省略号，不报错）。 -->
        <el-table-column prop="gradeLevel" label="学段" width="120">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" :type="GRADE_TAG[row.gradeLevel as GradeLevel] ?? 'info'">
              {{ GRADE_LABELS[row.gradeLevel as GradeLevel] ?? row.gradeLevel }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="chapterTitle" label="章节" min-width="176" show-overflow-tooltip>
          <template #default="{ row }">
            {{ row.chapterTitle || '—' }}
          </template>
        </el-table-column>
        <el-table-column prop="contentType" label="内容类型" width="100">
          <template #default="{ row }">
            <span class="type">{{ TYPE_LABEL[row.contentType] ?? row.contentType ?? '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="chunkCount" label="分块" width="80" align="right" sortable />
        <!-- 该行有没有向量：`false` 意味着这条知识点只能靠 FTS / 大纲降级命中 -->
        <el-table-column prop="embedded" label="向量" width="88">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" :type="row.embedded ? 'success' : 'warning'">
              {{ row.embedded ? '已嵌入' : '未嵌入' }}
            </el-tag>
          </template>
        </el-table-column>
        <template #empty>
          <!-- 空态 / 加载态 / 出错态共用一个组件：三种时刻的位置与结构完全一样，
               分开写只会让「加载中说成没有数据」这类错话各处复现一次。
               ⚠️ 出错时**不重复**上面那块错误卡的文案 —— 这里只说「表为什么是空的」，
                  处置按钮在上面那一块（同一页不放两个一样作用的按钮）。 -->
          <EmptyState
            v-if="loadError"
            tone="error"
            title="这一张表暂时读不出来"
            desc="上面那块说明了原因，修好后点它的「重试」即可。"
          />
          <EmptyState
            v-else-if="knowledge.points === null"
            tone="loading"
            title="正在读取知识点清单…"
          />
          <EmptyState
            v-else
            tone="empty"
            title="没有匹配的知识点"
            desc="换个关键词，或者把上面的学段筛选切回「全部」。"
          />
        </template>
      </el-table>

      <p class="card__note">
        表内每一行都是本地知识库的真实记录（`kb.sqlite` 的 kp / chunk 表），条数不写死 ——
        表头那行口径说明里的数字就是当前库里的实际条数。
        父子 chunk 策略：小子块检索、命中回父块作上下文。
      </p>
    </SurfacePanel>
  </div>
</template>

<style scoped>
/* ── 教师视角里的技术说明 ────────────────────────────────────────────────
 * 与栅格里的说明同档（13px / `--k12-fs-xs`）：它们是**排障读物**，不是页面正文，
 * 但也不是 ≤4 字的角标 —— 12px（`--k12-fs-micro`）只留给角标。 */
.kb__tech {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
.kb__tech code {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
}
/* 路径：等宽 + 浅底，可换行（截短后仍可能很长，`break-all` 保证它不顶破容器）。
 * 完整路径在 `title` 上，悬停可见 —— 截短是不占版面，不是丢信息。 */
.kb__path {
  display: inline-block;
  max-width: 100%;
  padding: 2px 6px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
  color: var(--k12-accent-ink);
  word-break: break-all;
}

.kb__file {
  display: none;
}

/* ── 导入回执 ─────────────────────────────────────────────────────────────
 * 三种状态（校验中 / 已接收 / 内容被拒）共用一块卡片，靠 `data-state` 换色调：
 *   running / accepted → 学段墨色（"这条正在进来 / 进来了"）
 *   rejected           → 告警色（"这几条没过"），但**不是**错误横幅 ——
 *                        校验被拒是正常结果，学生照着清单改文件就行。
 */
.kb__import {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 13px 15px;
  border-radius: var(--k12-r-card);
  background: var(--k12-surface);
  border: 1px solid var(--k12-accent-border);
  box-shadow: var(--k12-shadow-card);
  color: var(--k12-accent-ink);
}
.kb__import[data-state='rejected'] {
  border-color: var(--k12-warn-border);
  color: var(--k12-warn);
}
.kb__import-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.kb__import-name {
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg);
}
.kb__import-meta {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
/* 未通过的原因**逐条**列出（缺文件头 / kp_id 不符 / 学段错位 / 超纲术语）；
   它们必须能被一条条对照着改文件，合成一句话就失去了可操作性。 */
.kb__problems {
  margin: 2px 0 0;
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.kb__problems li {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}

.kb {
  padding: 18px 22px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  /* ⚠️ 这个内边距与 `PageActions` 的吸顶必须对齐：它靠负外边距拉回内容区边缘，
   *    数值由 `--pa-pad-y` / `--pa-pad-x` 传入（默认 18 / 22，与此处相同）。
   *    若改了上面的 padding，**必须**在这里覆盖这两个变量，否则吸顶时会露内容。 */
}

/**
 * 口径行 —— 表格的 caption（12px，meta 档）。
 *
 * ★ 这里就是本次返工的核心：这些数字曾经是几个 **22px** 的磁贴，
 *   与身份行同档、把 13px 的表格压在下面。现在降到 12px：
 *   数字仍能被一眼扫到，但靠的是**字重 650 + 等宽数字对齐**，不是字号。
 *   于是内容区的最大字号重新归身份行（22px）所有。
 */
.kb__scope {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
}
.kb__scope--pending {
  color: var(--k12-muted-2);
}
.kb__scope-item {
  white-space: nowrap;
}
/* 数字：可读性档次高于它周围的说明文字（fg 对 muted），但**同字号** */
.kb__scope-n {
  font-weight: 650;
  color: var(--k12-fg);
}
/* 分隔点：说明性的装饰，不配更淡的 `--k12-muted-2`（它在页面底色上只有 2.67:1，
 * 会变成"读不清又不明显"的噪点）。分隔点与两侧文字同档同色，靠字符本身分组。 */
.kb__scope-sep {
  color: var(--k12-muted);
}

.card {
  /* 表格卡片铺满内容区：这一页的主角是表，不给它留白边。
   * SurfacePanel 是 flex item，默认 stretch，这里写死 100% 只是把"满幅"变成**显式意图**。 */
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.card__head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.card__head-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.card__title {
  font-size: var(--k12-fs-lg);
  font-weight: 620;
  color: var(--k12-fg);
}
.card__note {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
.btn__label {
  margin-left: 6px;
}
.index-done {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  color: var(--k12-good);
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
}
.toolbar__search {
  flex: 1;
  min-width: 0;
  max-width: 420px;
}

.tbl {
  width: 100%;

  /**
   * ★ 把表格正文的字号**拿回来**（实测发现的问题，不是猜测）。
   *
   * `base.css` 已声明表格正文是 13px（`--k12-fs-sm`：次级正文 / 可读的键值）。
   * 但 EP 的 `size="small"` 会把自己压到 12px（`--el-font-size-extra-small`）：
   * 两条规则**特异性相同**（都是单类），谁在文档里靠后谁赢 —— 而 EP 的样式随本路由的
   * chunk 注入、晚于主样式表，于是在这一页 **12px 胜出**。
   * 后果恰好打在最痛的地方：这张表是整页的主角，正文却被降到 meta（12px）档，
   * 与表头同字号 ——「标题与数据一样大」的塌陷。
   * 就地重新声明一次即可（`.tbl[data-v]` 特异性高于 `.el-table--small`）。
   * 表头仍归 `base.css` 的 `.el-table th.el-table__cell`（特异性更高）压成 12px：
   * 表头是标签、正文是数据，**差一档正是想要的**。
   */
  font-size: var(--k12-fs-sm);
}

/**
 * 行高 = 这一页的阅读节奏。
 *
 * EP 的 `size="small"` 只给单元格 4px 纵向内边距（`.el-table--small .el-table__cell`），
 * 配上 13px 正文与 23px 的行框，一行只有 ~31px —— 真实数据读起来是全挤在一起的。
 * 表是这一页的主角，它的行距不该比别处的行列还紧。这里把纵向内边距提到 10px
 * （行高 ~44px），**字号单独在 `.tbl` 上声明**：间距差才是节奏，不是字号差（契约 §2）。
 *
 * 横向同时从 small 档的 8px 提到 12px —— 与 EP 默认档一致，也与 13px 正文相称。
 *
 * ⚠️ `:deep()` 是必须的：`.el-table__cell` / `.cell` 由 EP 渲染，不在本组件的 scoped
 *    作用域内。用 `padding`（而非 `height`）让单元格内容自己决定高度，多行文本不会溢出。
 */
.tbl :deep(.el-table__cell) {
  padding: 10px 0;
}
/* 表头比数据行略紧：它是标签，不是数据 */
.tbl :deep(th.el-table__cell) {
  padding: 8px 0;
}
.tbl :deep(.cell) {
  padding: 0 12px;
}

/* ── 两个 meta：都是 12px（`--k12-fs-xs`）───────────────────────────────
 * ⚠️ 它们此前是 11px（`--k12-fs-micro`）。11px 是**角标档**（≤4 字），
 *    而 kp_id 是代码标识符、内容类型是分类名 —— 两者都是要被读的 meta。
 *    降到 11px 的实际后果：表格里最需要逐字读的列反而最小。 */
.mono {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  padding: 2px 6px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
  color: var(--k12-accent-ink);
}
.type {
  font-size: var(--k12-fs-xs);
  color: var(--k12-fg-2);
}
</style>
