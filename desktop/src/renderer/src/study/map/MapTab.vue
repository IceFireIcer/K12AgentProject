<script setup lang="ts">
/**
 * 学习档案 · **学习地图**（依赖图全览）。
 *
 * 这是需求里「多模态教学」那一项的**图形化子集**：不做视频 / PPT，
 * 但把教材的知识结构画出来 —— 而依赖图数据本来就有两个用途
 * （推荐路径 + 检索扩展），现在多了第三个：**给学生看的结构图**。
 *
 * ★ 图是**自绘 SVG**（`map/layout.ts` 纯函数 + `map/GraphMap.vue` 渲染），
 *   不引任何图表库（零依赖、断网可用）。
 * ★ 布局由服务端给的 `layer` 决定纵向（最长前置链），所以箭头永远朝下 ——
 *   「先学上面的、再学下面的」不需要解释。
 */
import { computed } from 'vue'
import { useStudyStore } from '../../stores/study'
import { GRADE_LABELS } from '../../labels'
import GraphMap from './GraphMap.vue'
import { layoutGraph } from './layout'

defineOptions({ name: 'StudyMapTab' })

const study = useStudyStore()

const graph = computed(() => study.graph)
const gradeLabel = computed(() => {
  const level = graph.value?.gradeLevel
  return level ? (GRADE_LABELS[level] ?? level) : '待判定'
})

/**
 * 把契约形状投影成布局输入（**只取布局需要的字段**）。
 *
 * ★ 不直接把 `graph.nodes` 丢给布局：那样布局函数就得依赖生成类型，
 *   而它是纯函数、要能在 `node --test` 里跑（生成类型能 import 但没必要 ——
 *   投影这一层也让「服务端多返回一个字段」不会悄悄改变布局行为）。
 */
const layout = computed(() =>
  layoutGraph(
    (graph.value?.nodes ?? []).map((node) => ({
      kpId: node.kpId,
      name: node.name,
      chapterTitle: node.chapterTitle,
      layer: node.layer,
      mastered: node.mastered
    })),
    (graph.value?.edges ?? []).map((edge) => ({
      fromKpId: edge.fromKpId,
      toKpId: edge.toKpId,
      relation: edge.relation
    }))
  )
)

const masteredCount = computed(() => (graph.value?.nodes ?? []).filter((n) => n.mastered).length)

/** 按章节分组列出（图之外的一份清单：图看结构，清单看「这一章有哪些点」）。 */
const byChapter = computed(() => {
  const groups = new Map<string, Array<{ kpId: string; name: string; mastered: boolean }>>()
  for (const node of graph.value?.nodes ?? []) {
    const key = node.chapterTitle || '未分章'
    const bucket = groups.get(key)
    const item = { kpId: node.kpId, name: node.name, mastered: node.mastered }
    if (bucket) bucket.push(item)
    else groups.set(key, [item])
  }
  // 章节顺序按**章号**排（与章节进度页同一口径：字典序会把「第10章」排错）
  return [...groups.entries()].sort((a, b) => chapterNumber(a[0]) - chapterNumber(b[0]))
})

/** 从「第N章 …」里取 N（取不到给一个大数，排到末尾）。 */
function chapterNumber(title: string): number {
  const match = /^第\s*(\d+)\s*章/.exec(title.trim())
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}
</script>

<template>
  <section class="tab-body" data-testid="study-map">
    <p v-if="study.loading.graph" class="state" data-testid="map-loading">正在读取知识结构…</p>
    <p v-else-if="study.errors.graph" class="state state--error" data-testid="map-error">
      {{ study.errors.graph }}
    </p>

    <template v-else-if="graph">
      <p class="summary" data-testid="map-summary">
        {{ gradeLabel }}知识结构 · {{ graph.nodes.length }} 个知识点 ·
        {{ graph.edges.length }} 条依赖 ·
        已掌握 <strong>{{ masteredCount }}</strong> 个
      </p>

      <p v-if="graph.nodes.length === 0" class="state" data-testid="map-empty">
        这个学段还没有知识点依赖数据。
      </p>

      <template v-else>
        <div class="canvas">
          <GraphMap :layout="layout" />
        </div>
        <p class="legend">
          <span class="legend__item"><span class="dot dot--mastered"></span>已掌握</span>
          <span class="legend__item"><span class="dot"></span>还没掌握</span>
          <span class="legend__item">箭头方向：前置 → 后继（从上往下学）</span>
        </p>

        <h3 class="section">按章节查看</h3>
        <ul class="chapters" data-testid="map-chapters">
          <li v-for="[title, items] in byChapter" :key="title" class="chapter">
            <p class="chapter__title">{{ title }}</p>
            <p class="chapter__kps">
              <span
                v-for="item in items"
                :key="item.kpId"
                class="kp"
                :class="{ 'kp--mastered': item.mastered }"
              >
                {{ item.name || item.kpId }}
              </span>
            </p>
          </li>
        </ul>
      </template>
    </template>
  </section>
</template>

<style scoped>
.tab-body {
  padding: 16px 24px 32px;
}

.summary {
  margin-bottom: 12px;
  font-size: var(--k12-fs-sm);
  color: var(--k12-fg-2);
}

/* 图谱画布 = 一张卡片（E2）：自绘 SVG 压在白面上，边界靠底色差与细线 */
.canvas {
  overflow: auto;
  padding: 4px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-card);
  background: var(--k12-surface);
  box-shadow: var(--k12-shadow-card);
}

.legend {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin-top: 8px;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}

.legend__item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.dot {
  width: 10px;
  height: 10px;
  border-radius: var(--k12-r-flat);
  border: 1px solid var(--k12-border-strong);
  background: var(--k12-surface);
}

.dot--mastered {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent);
}

.section {
  margin: 18px 0 8px;
  font-size: var(--k12-fs-lg);
  font-weight: 650;
  color: var(--k12-fg);
}

.chapters {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.chapter__title {
  font-size: var(--k12-fs-sm);
  font-weight: 600;
  margin-bottom: 5px;
  color: var(--k12-fg);
}

.chapter__kps {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.kp {
  padding: 2px 9px;
  border-radius: var(--k12-r-pill);
  border: 1px solid var(--k12-border);
  background: var(--k12-surface-2);
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}

.kp--mastered {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent-border);
  color: var(--k12-accent-ink);
  font-weight: 600;
}

.state {
  padding: 10px 0;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted-2);
}

.state--error {
  color: var(--k12-warn);
  line-height: var(--k12-lh-body);
}
</style>
