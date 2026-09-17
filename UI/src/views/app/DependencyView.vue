<script setup lang="ts">
/**
 * 依赖图谱（画布「9. 依赖图谱」）。
 *
 * ⚠️ 依赖语义全项目一致：**`from` 是前置、`to` 是后继**（方向搞反是静默错）。
 * 后端对应递归 CTE（带 depth 上限防环），这里用等价的 BFS 做前端展示。
 *
 * 两个方向必须都支持，且**不能只换标签不换数据**：
 *  - `successor`：沿 `from === 当前` 向外走 → 看「学完这个能学什么」
 *  - `prerequisite`：沿 `to === 当前` 向外走 → 看「学这个之前要先会什么」
 */
import { computed, ref } from 'vue'
import { GitBranch, Download, Search, GitCompare, Layers } from 'lucide-vue-next'
import { dependencyEdges, dependencyNodes, dependencyRoot, mastery, kpNames } from '@/mocks'

/** 图谱里出现的所有 kp（用于按 kp_id 取名） */
const ALL_KP: Record<string, { name: string; grade: 'junior' | 'primary_high' }> = {
  'ph-image-classification': { name: '图像分类', grade: 'primary_high' },
  'jr-data-features': { name: '数据与特征', grade: 'junior' },
  'jr-decision-tree': { name: '决策树', grade: 'junior' },
  'jr-py-variable': { name: '变量', grade: 'junior' },
  'jr-task-types': { name: '分类任务与回归任务', grade: 'junior' },
  'jr-py-loop': { name: '循环', grade: 'junior' },
  'jr-py-list-dict': { name: '列表与字典', grade: 'junior' },
  'jr-neural-basics': { name: '神经网络基础', grade: 'junior' },
  'jr-model-train-eval': { name: '模型训练与评估入门', grade: 'junior' }
}

const view = ref<'successor' | 'prerequisite'>('successor')
const highlight = ref<string>(dependencyRoot)

/**
 * BFS：按当前方向从选中的 kp 向外逐层展开。
 * 同一层内按 kp_id 排序，保证渲染稳定（不随对象键顺序抖动）。
 */
const graph = computed(() => {
  const dir = view.value
  const start = highlight.value
  const seen = new Map<string, { kpId: string; depth: number; relation: 'prerequisite' | 'related'; via: string }>()
  seen.set(start, { kpId: start, depth: 0, relation: 'related', via: '' })

  let frontier = [start]
  let depth = 0
  // 图上最大深度有限（<10），但显式加上限防脏数据成环
  while (frontier.length && depth < 12) {
    depth += 1
    const next: string[] = []
    for (const cur of frontier) {
      for (const e of dependencyEdges) {
        const [a, b] = dir === 'successor' ? [e.from, e.to] : [e.to, e.from]
        if (a !== cur || seen.has(b)) continue
        seen.set(b, { kpId: b, depth, relation: e.relation, via: cur })
        next.push(b)
      }
    }
    frontier = next
  }

  const nodes = [...seen.values()].sort((a, b) => a.depth - b.depth || a.kpId.localeCompare(b.kpId))

  const layers = new Map<number, typeof nodes>()
  for (const n of nodes) {
    const arr = layers.get(n.depth) ?? []
    arr.push(n)
    layers.set(n.depth, arr)
  }

  // 当前视图下真正被用到的边（只保留相邻层之间、且方向正确的那些）
  //
  // ⚠️ 显示时**始终按 `from` = 前置 → `to` = 后继 的原始语义输出**，
  //    不随视图翻转端点 —— 一翻转就会读成「数据与特征 是 图像分类 的前置」，
  //    与事实正好相反。视图只决定「从根往哪个方向走」，不改边的书写方向。
  const usedEdges = dependencyEdges
    .filter((e) => seen.has(e.from) && seen.has(e.to))
    .filter((e) => {
      const f = seen.get(e.from)!
      const t = seen.get(e.to)!
      // 后继视图：前置在浅层、后继在深层；前置视图：前置在深层
      return view.value === 'successor' ? t.depth === f.depth + 1 : f.depth === t.depth + 1
    })

  return { nodes, layers: [...layers.entries()].sort((a, b) => a[0] - b[0]).map(([d, ns]) => ({ depth: d, nodes: ns })), usedEdges }
})

function nameOf(kpId: string) {
  return ALL_KP[kpId]?.name ?? kpNames[kpId] ?? kpId
}

function masteryOf(kpId: string) {
  const m = mastery.find((x) => x.kpId === kpId)
  return m ? Math.round(m.score * 100) : null
}

/** 可切换的根节点：图谱里出现过的全部 kp */
const quickList = Object.keys(ALL_KP).filter((id) => dependencyNodes.some((n) => n.kpId === id))

const directionLabel = computed(() => (view.value === 'successor' ? '后继（学完能学什么）' : '前置（要先会什么）'))
</script>

<template>
  <div class="dg">
    <!-- 顶栏 -->
    <header class="dg__bar">
      <div class="dg__title-block">
        <h2 class="dg__title">知识点依赖图谱</h2>
        <p class="dg__sub">
          语义：<code>from</code> = 前置，<code>to</code> = 后继 · 后端用递归 CTE（带 depth 上限防环），此处为等价 BFS
        </p>
      </div>
      <div class="dg__views">
        <button
          type="button"
          class="dg__view"
          :class="{ 'dg__view--on': view === 'successor' }"
          @click="view = 'successor'"
        >
          后继视图
        </button>
        <button
          type="button"
          class="dg__view"
          :class="{ 'dg__view--on': view === 'prerequisite' }"
          @click="view = 'prerequisite'"
        >
          前置视图
        </button>
      </div>
      <button type="button" class="dg__ghost"><Download :size="13" /><span>导出</span></button>
    </header>

    <div class="dg__body">
      <!-- 左：分层图 -->
      <section class="dg__canvas">
        <div v-for="layer in graph.layers" :key="layer.depth" class="layer">
          <div class="layer__rail">
            <span class="layer__badge">depth {{ layer.depth }}</span>
          </div>
          <div class="layer__nodes">
            <button
              v-for="n in layer.nodes"
              :key="n.kpId"
              type="button"
              class="node"
              :class="{ 'node--on': highlight === n.kpId, 'node--root': n.depth === 0 }"
              @click="highlight = n.kpId"
            >
              <span class="node__name">{{ nameOf(n.kpId) }}</span>
              <span class="node__id">{{ n.kpId }}</span>
              <div class="node__foot">
                <!--
                  两个概念必须分开显示，否则语义会读反：
                  - `direction`：相对当前选中根的**方向**（后继 / 前置）—— 随视图切换
                  - `relation`：这条边的**类型**（前置边 prerequisite / 相关边 related）
                -->
                <span class="node__dir" :data-dir="view">
                  {{ view === 'successor' ? '后继' : '前置' }}
                </span>
                <span class="node__rel" :data-rel="n.relation">
                  {{ n.relation === 'prerequisite' ? '前置边' : '相关边' }}
                </span>
                <span v-if="masteryOf(n.kpId) !== null" class="node__pct">{{ masteryOf(n.kpId) }}%</span>
              </div>
            </button>
          </div>
        </div>
      </section>

      <!-- 右：边清单与说明 -->
      <aside class="dg__side">
        <div class="panel">
          <header class="panel__head">
            <GitBranch :size="13" />
            <span class="panel__title">依赖边</span>
            <span class="panel__meta">{{ graph.usedEdges.length }} 条 · {{ directionLabel }}</span>
          </header>
          <div class="edges">
            <div v-for="e in graph.usedEdges" :key="e.from + '>' + e.to" class="edge">
              <code class="edge__from">{{ e.from }}</code>
              <span class="edge__arrow">→</span>
              <code class="edge__to">{{ e.to }}</code>
              <span class="edge__rel">{{ e.relation === 'prerequisite' ? '前置边' : '相关边' }}</span>
              <span class="edge__w">{{ e.weight }}</span>
            </div>
          </div>
        </div>

        <div class="panel">
          <header class="panel__head">
            <Layers :size="13" />
            <span class="panel__title">当前选中</span>
          </header>
          <p class="sel__name">{{ nameOf(highlight) }}</p>
          <p class="sel__id">{{ highlight }}</p>
          <div class="sel__row">
            <span class="sel__k">掌握度</span>
            <span class="sel__v">{{ masteryOf(highlight) ?? '—' }}{{ masteryOf(highlight) !== null ? '%' : '' }}</span>
          </div>
          <div class="sel__row">
            <span class="sel__k">用作</span>
            <span class="sel__v">推荐路径 + 检索扩展</span>
          </div>
        </div>

        <div class="panel panel--note">
          <header class="panel__head">
            <GitCompare :size="13" />
            <span class="panel__title">用途与约束</span>
          </header>
          <ul class="notes">
            <li>依赖图同时服务「推荐路径规划」与「检索上下文扩展」，两个用途都保留。</li>
            <li>导入阶段用 DFS 检测环，防止递归 CTE 死循环。</li>
            <li>扩展只作补充上下文，且有数量上限。</li>
            <li>悬空 <code>to_kp_id</code> 报错而非静默跳过。</li>
          </ul>
        </div>

        <div class="panel">
          <header class="panel__head">
            <Search :size="13" />
            <span class="panel__title">快速定位</span>
          </header>
          <div class="quick">
            <button
              v-for="id in quickList"
              :key="id"
              type="button"
              class="quick__b"
              :class="{ 'quick__b--on': highlight === id }"
              @click="highlight = id"
            >
              {{ nameOf(id) }}
            </button>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.dg {
  padding: 14px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.dg__bar {
  display: flex;
  align-items: center;
  gap: 12px;
}
.dg__title-block {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.dg__title {
  font-size: var(--k12-fs-xl);
  font-weight: 650;
  color: var(--k12-fg);
}
.dg__sub {
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted);
}
.dg__sub code {
  font-family: var(--k12-font-mono);
  font-size: 9.5px;
  color: var(--k12-accent);
}
.dg__views {
  display: flex;
  gap: 3px;
  padding: 3px;
  border-radius: var(--k12-r-lg);
  background: var(--k12-surface-2);
  flex: none;
}
.dg__view {
  padding: 6px 12px;
  border: none;
  border-radius: var(--k12-r-md);
  background: transparent;
  color: var(--k12-muted);
  font-size: var(--k12-fs-xs);
  font-weight: 550;
  cursor: pointer;
}
.dg__view--on {
  background: var(--k12-surface);
  color: var(--k12-accent);
  font-weight: 650;
}
.dg__ghost {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-md);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  cursor: pointer;
  flex: none;
}

.dg__body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 12px;
  align-items: start;
}
.dg__canvas {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border-radius: var(--k12-r-4xl);
  background: var(--k12-glass);
  border: 1px solid var(--k12-glass-border);
}
.layer {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.layer__rail {
  width: 58px;
  flex: none;
  padding-top: 6px;
}
.layer__badge {
  display: inline-block;
  padding: 2px 7px;
  border-radius: var(--k12-r-xs);
  background: var(--k12-surface-2);
  color: var(--k12-muted-2);
  font-family: var(--k12-font-mono);
  font-size: 8.5px;
}
.layer__nodes {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.node {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 150px;
  padding: 10px 11px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-2xl);
  background: var(--k12-surface);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.16s ease, background 0.16s ease;
}
.node:hover {
  border-color: var(--k12-accent-border);
}
.node--on {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent);
}
.node--root {
  border-width: 2px;
}
.node__name {
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-fg);
}
.node__id {
  font-family: var(--k12-font-mono);
  font-size: 8.5px;
  color: var(--k12-muted-2);
}
.node__foot {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}
.node__dir {
  padding: 1px 6px;
  border-radius: var(--k12-r-xs);
  background: var(--k12-surface-2);
  color: var(--k12-muted);
  font-size: 8.5px;
  font-weight: 650;
}
.node__rel {
  padding: 1px 6px;
  border-radius: var(--k12-r-xs);
  font-size: 8.5px;
  font-weight: 650;
}
.node__rel[data-rel='prerequisite'] {
  background: var(--k12-accent-soft);
  color: var(--k12-accent);
}
.node__rel[data-rel='related'] {
  background: var(--k12-warn-soft);
  color: var(--k12-warn);
}
.node__pct {
  margin-left: auto;
  font-size: var(--k12-fs-micro);
  font-weight: 650;
  color: var(--k12-fg-2);
}

.dg__side {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.panel {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 12px 13px;
  border-radius: var(--k12-r-3xl);
  background: var(--k12-glass);
  border: 1px solid var(--k12-glass-border);
}
.panel--note {
  background: var(--k12-surface);
}
.panel__head {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--k12-muted);
}
.panel__title {
  font-size: var(--k12-fs-xs);
  font-weight: 650;
}
.panel__meta {
  margin-left: auto;
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted-2);
}
.edges {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.edge {
  display: flex;
  align-items: center;
  gap: 6px;
}
.edge__from,
.edge__to {
  font-family: var(--k12-font-mono);
  font-size: 9px;
  padding: 2px 5px;
  border-radius: var(--k12-r-xs);
  background: var(--k12-surface-2);
  color: var(--k12-fg-2);
}
.edge__arrow {
  color: var(--k12-accent);
  font-weight: 700;
}
.edge__rel {
  padding: 1px 6px;
  border-radius: var(--k12-r-xs);
  background: var(--k12-surface-2);
  color: var(--k12-muted-2);
  font-size: 8.5px;
}
.edge__w {
  margin-left: auto;
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted-2);
}
.sel__name {
  font-size: var(--k12-fs-lg);
  font-weight: 650;
  color: var(--k12-fg);
}
.sel__id {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted-2);
}
.sel__row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sel__k {
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted);
}
.sel__v {
  margin-left: auto;
  font-size: var(--k12-fs-micro);
  font-weight: 620;
  color: var(--k12-fg);
}
.notes {
  margin: 0;
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.notes li {
  font-size: var(--k12-fs-micro);
  line-height: 1.7;
  color: var(--k12-muted);
}
.notes code {
  font-family: var(--k12-font-mono);
  font-size: 9.5px;
  color: var(--k12-accent);
}
.quick {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.quick__b {
  padding: 4px 9px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface);
  color: var(--k12-muted);
  font-size: var(--k12-fs-micro);
  cursor: pointer;
}
.quick__b--on {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent-border);
  color: var(--k12-accent);
  font-weight: 650;
}
</style>
