<script setup lang="ts" generic="T">
/**
 * 长列表虚拟化包装（优化报告 §5.2 的「长列表虚拟化」；D10 的照做口径）。
 *
 * ---------------------------------------------------------------------------
 * 它解决什么、为什么长成这个样子
 * ---------------------------------------------------------------------------
 * 学习记录与会话侧栏都是**会随时间变长**的列表：1000 条会话全量挂 DOM，
 * 每次重渲染都要走一遍 Vue 的 diff 与浏览器布局 —— 表现就是滚动时掉帧。
 *
 * ★★ 两条设计约束（都不是"顺手"）：
 *   ① **超过阈值才虚拟化**（默认 60 条）：虚拟滚动会改变 DOM 形状（行被放进
 *      `DynamicScrollerItem` 的绝对定位容器里），而本仓的真机探针是**按 DOM 结构**
 *      量几何的（`ux-audit` 的 D10 量树形连接线、右键菜单、折叠几何）。短列表走
 *      原样渲染，探针与既有断言一个字不用改；长列表才进虚拟通道。
 *      ⚠️ 阈值不是"性能开关"，是「**两种渲染路径的分界**」——改它之前先读这句。
 *   ② **行模板只有一份**：两条路径共用调用方给的那一段 slot（`<slot :item>`）。
 *      抄两份行模板 = 同一条规则两份实现，缺陷只会出现在没改的那一份上（P-143）。
 *
 * ★ 用 `DynamicScroller` 而不是 `RecycleScroller`：我们的行高**不固定**
 *   （会话行有/没有分支标记、有没有摘要都不一样的行数）。固定行高的回收器会把
 *   高度估算错，表现是行重叠或大片空白 —— 动态测量那一版才不会。
 *
 * 用法：
 *   <VirtualList class="list" :items="rows" :min-item-size="56" data-testid="sessions-list">
 *     <template #default="{ item }"><li class="item">…</li></template>
 *   </VirtualList>
 */
import { computed } from 'vue'
import { DynamicScroller, DynamicScrollerItem } from 'vue-virtual-scroller'
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css'

defineOptions({ name: 'VirtualList', inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    /** 列表数据（每项必须有唯一的 key 字段，默认 `id`）。 */
    items: T[]
    /** 行高下限（px；动态测量以它为起点）。 */
    minItemSize?: number
    /** 超过这个条数才启用虚拟滚动（见文件头的约束①）。 */
    virtualizeAt?: number
    /** 唯一键字段名（默认 `id`）。 */
    keyField?: string
    /** 短列表那一条路径的容器标签（默认 `ul`，保持既有语义）。 */
    tag?: string
  }>(),
  { minItemSize: 56, virtualizeAt: 60, keyField: 'id', tag: 'ul' }
)

/**
 * 行模板（**两条路径共用这一段**）。用 `defineSlots` 显式标出 `item` 的类型：
 * 泛型组件里这样写，调用方 `#default="{ item }"` 才拿得到真实类型（而不是 `unknown`）。
 */
defineSlots<{ default(props: { item: T }): unknown }>()

/** 是否走虚拟通道（`>` 而不是 `>=`：阈值那一条本身还是原来的路径）。 */
const virtual = computed(() => props.items.length > props.virtualizeAt)

/** 取唯一键（认不出就退回下标 —— 绝不抛，列表脏数据不该把页面搞崩）。 */
function keyOf(item: unknown, index: number): string | number {
  if (item && typeof item === 'object') {
    const value = (item as Record<string, unknown>)[props.keyField]
    if (typeof value === 'string' || typeof value === 'number') return value
  }
  return index
}
</script>

<template>
  <!-- 长列表：动态测量行高 + 只挂可视区（v-bind="$attrs" 把 class / data-testid 透传给滚动容器） -->
  <DynamicScroller
    v-if="virtual"
    v-bind="$attrs"
    class="vl"
    :items="items"
    :min-item-size="minItemSize"
    :key-field="keyField"
  >
    <template #default="{ item, index, active }">
      <DynamicScrollerItem :item="item" :active="active" :index="index" :key="keyOf(item, index)">
        <slot :item="item" />
      </DynamicScrollerItem>
    </template>
  </DynamicScroller>

  <!-- 短列表：原样渲染（DOM 形状与虚拟化之前完全一致，探针不受影响） -->
  <component :is="tag" v-else v-bind="$attrs" class="vl vl--plain">
    <template v-for="(item, index) in items" :key="keyOf(item, index)">
      <slot :item="item" />
    </template>
  </component>
</template>

<style scoped>
/* 两条路径的共同形状：滚动容器 + 纵向排布（行内的间距由调用方的样式负责，
 * 因为虚拟化的行是绝对定位的，`gap` 在那一侧不生效 —— 别在这里写 gap）。 */
.vl {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
</style>
