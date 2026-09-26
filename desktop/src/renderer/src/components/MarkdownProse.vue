<script setup lang="ts">
/**
 * **正文的 Markdown 渲染**（唯一实现，多处共用）。
 *
 * ★★ 为什么要有这个组件（P1-4）：极简 Markdown 渲染（`../markdown.ts`）本来只在
 *    对话页的气泡里用；学习记录页的「历史会话只读回看」是**直接插值** `{{ message.text }}`，
 *    于是学生展开自己的历史会话时，看到的是 `**贴着标签的盒子**` 与 ``` ```python ``` 围栏
 *    —— 与对话页里同一段话的长相完全不同。两处各写一份渲染模板必然再次漂移，
 *    所以正文渲染归口到这里（判据仍是 `parseMarkdown` 那份纯函数，输出结构化数据、
 *    **不用 `v-html`**，XSS 面为零）。
 *
 * ★ 流式期间也照常解析：模型逐字吐字时 `**` 可能只到一半，而 `parseInline` 对未闭合的
 *    星号**原样保留**，所以不会出现「字忽然消失再出现」的闪动（见 `markdown.ts`）。
 */
import { computed } from 'vue'
import { parseMarkdown, type MarkdownBlock } from '../markdown'

const props = withDefaults(
  defineProps<{
    /** 正文（模型输出或历史会话里的原文）。 */
    text: string
    /** 生成中：在末尾画一个闪烁光标（对话页用；只读回看不传）。 */
    streaming?: boolean
  }>(),
  { streaming: false }
)

const blocks = computed<MarkdownBlock[]>(() => parseMarkdown(props.text))
</script>

<template>
  <div class="md">
    <template v-for="(block, blockIndex) in blocks" :key="blockIndex">
      <pre v-if="block.kind === 'code'" class="md-code"><code>{{ block.runs[0]?.text ?? '' }}</code></pre>
      <hr v-else-if="block.kind === 'divider'" class="md-hr" />
      <p
        v-else-if="block.kind === 'heading'"
        class="md-heading"
        :class="`md-heading--${block.level ?? 3}`"
      >
        <template v-for="(run, runIndex) in block.runs" :key="runIndex">
          <strong v-if="run.kind === 'strong'">{{ run.text }}</strong>
          <code v-else-if="run.kind === 'code'">{{ run.text }}</code>
          <template v-else>{{ run.text }}</template>
        </template>
      </p>
      <ul v-else-if="block.kind === 'list' && block.ordinal === undefined" class="md-list">
        <li>
          <template v-for="(run, runIndex) in block.runs" :key="runIndex">
            <strong v-if="run.kind === 'strong'">{{ run.text }}</strong>
            <code v-else-if="run.kind === 'code'">{{ run.text }}</code>
            <template v-else>{{ run.text }}</template>
          </template>
        </li>
      </ul>
      <ol v-else-if="block.kind === 'list'" class="md-list" :start="block.ordinal">
        <li>
          <template v-for="(run, runIndex) in block.runs" :key="runIndex">
            <strong v-if="run.kind === 'strong'">{{ run.text }}</strong>
            <code v-else-if="run.kind === 'code'">{{ run.text }}</code>
            <template v-else>{{ run.text }}</template>
          </template>
        </li>
      </ol>
      <p v-else class="md-p">
        <template v-for="(run, runIndex) in block.runs" :key="runIndex">
          <strong v-if="run.kind === 'strong'">{{ run.text }}</strong>
          <code v-else-if="run.kind === 'code'">{{ run.text }}</code>
          <template v-else>{{ run.text }}</template>
        </template>
      </p>
    </template>
    <!-- 流式光标：生成中的那一轮末尾（只读回看不传 `streaming`） -->
    <span v-if="streaming" class="caret" aria-hidden="true" />
  </div>
</template>

<style scoped>
/* ★★ 字体从**调用方继承**（不自带字号）：同一个组件在两个场景里的字号本来就不同 ——
 *   对话气泡是正文档（`--k12-fs-md`），学习记录页的历史会话是紧凑列表（`--k12-fs-xs`）。
 *   自带字号会让其中一处必然错档（而那正是「同一段话两处长不一样」的老问题）。 */
.md {
  font-size: inherit;
  line-height: var(--k12-lh-body);
  color: inherit;
  word-break: break-word;
}
.md > * + * {
  margin-top: 0.7em;
}
.md strong {
  color: var(--k12-fg);
  font-weight: 650;
}
.md code {
  padding: 1px 5px;
  /* 代码块内联片：走 r-sm（6px，报告 §1.3 的 chip/小元素档）。 */
  border-radius: var(--k12-r-sm);
  background: var(--k12-surface-2);
  border: 1px solid var(--k12-border);
  font-family: var(--k12-font-mono);
  font-size: 0.92em;
}
.md-heading {
  color: var(--k12-fg);
  font-weight: 650;
  line-height: 1.4;
}
.md-heading--1 {
  /* 正文里的一级小标题：比正文重一档（h3 20px）。 */
  font-size: var(--k12-fs-h3);
}
.md-heading--2 {
  font-size: var(--k12-fs-body-lg);
}
.md-heading--3 {
  font-size: var(--k12-fs-body);
}
.md-list {
  margin: 0;
  padding-left: 1.35em;
  display: flex;
  flex-direction: column;
  gap: 0.35em;
}
.md-list li::marker {
  color: var(--k12-muted);
}
.md-code {
  margin: 0;
  padding: 12px 14px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
  border: 1px solid var(--k12-border);
  overflow-x: auto;
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-body-sm);
  line-height: 1.6;
}
.md-hr {
  margin: 0;
  border: 0;
  border-top: 1px solid var(--k12-border);
}
.caret {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: var(--k12-accent);
  animation: blink 1s step-end infinite;
}
@keyframes blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0;
  }
}
</style>
