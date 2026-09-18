<script setup lang="ts">
/**
 * `payload` 事件的内联卡片**分派器**：按 `kind` 选卡片组件。
 *
 *   `quiz`      → `cards/QuizCard.vue`（票 14/15：做题、批改、闯关进度）
 *   `animation` → `cards/AnimationCard.vue`（票 16/17：沙箱 iframe + RPC + 容错降级）
 *   `coding`    → `cards/CodingCard.vue`（票 18/19：Monaco + Pyodide Worker）
 *
 * ★ 三个分支**已经穷尽**契约里的 `PayloadKind`（`api/events.ts` 的白名单只放行这三个），
 *   所以这里**没有也不需要**「未识别 kind」的兜底分支 —— 留一个永不渲染的 v-else
 *   只会让人误以为存在第四种 kind（还会自带一个永远禁用的按钮）。
 *   载荷内部认不出字段时，由各卡片自己的 `kind: 'unknown'` 分支退化成可读文案。
 *
 * 载荷是契约里的 `unknown`，所以每个卡片自己只读**明确认识的字段**。
 */
import type { InlineCard } from '../api/events'
import AnimationCard from './AnimationCard.vue'
import CodingCard from './CodingCard.vue'
import QuizCard from './QuizCard.vue'

const props = defineProps<{ card: InlineCard }>()
</script>

<template>
  <!-- 练习卡片：题目 / 批改结果都由它自己按载荷结构判断 -->
  <QuizCard v-if="props.card.kind === 'quiz'" :card="card" />

  <!-- 动画卡片（票 16/17）：sandboxed iframe + postMessage RPC + 失败降级 -->
  <AnimationCard v-else-if="props.card.kind === 'animation'" :card="card" />

  <!-- 编程卡片（票 18/19）：Monaco + Pyodide Worker（代码绝不在主进程跑） -->
  <CodingCard v-else :card="card" />
</template>
