<script setup lang="ts">
/**
 * 教师 / 答辩视角专属内容的**唯一开关**（`stores/viewMode.ts` 的渲染侧落点）。
 *
 * ── 为什么要一个组件，而不是各处写 `v-if="viewMode.isTeacher"` ──────────
 * 全项目有十几处技术细节要「学生看不见、评委看得到」。如果每处各写一个 v-if：
 *   ① 加/删一处时无法穷举核对（哪几处受这个开关控制？只能全仓 grep 字符串）；
 *   ② 缺一个 `data-teacher` 标记，验收脚本就量不出「学生视角下它真的不在 DOM 里」；
 *   ③ 新手容易写成 `v-if="!isTeacher"`（把方向写反，学生看到技术信息、
 *      评委看到空壳），而这种反向错误在界面上**看起来是正常的**。
 * 所以收口到这一个组件：它同时给出 `<slot>` 与 `data-teacher`，两件事都不会漏。
 *
 * ── 两种用法 ──────────────────────────────────────────────────────────────
 *   · 纯隐藏（推荐，绝大多数场景）：
 *       <TeacherGate><p class="note">路由由模型自选…</p></TeacherGate>
 *   · 带标题的小节（用在设置页与右栏这类「成块」的技术分节上）：
 *       <TeacherGate label="检索降级链"> … </TeacherGate>
 *     `label` 会给内容套一个带边框的浅底块，并在左上角写明这是教师视角的内容 ——
 *     评委一眼知道「这块平时不给学生看」，而不是以为学生也在读这些。
 *
 * ⚠️ 这不是权限控制。见 `stores/viewMode.ts` 的说明：开关只防误入，
 *    真正被强制的边界在后端（SQL 层学段隔离 / 判分只在 Python / 代码只在 Worker）。
 */
import { useViewModeStore } from '../stores/viewMode'

withDefaults(
  defineProps<{
    /** 给了就套一层带标题的技术块；不给则只是条件渲染。 */
    label?: string
  }>(),
  { label: '' }
)

const viewMode = useViewModeStore()
</script>

<template>
  <section v-if="viewMode.isTeacher" class="gate" :class="{ 'gate--boxed': label }" data-teacher="true">
    <p v-if="label" class="gate__label">{{ label }}（教师视角）</p>
    <slot />
  </section>
</template>

<style scoped>
.gate--boxed {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px dashed var(--k12-border-strong);
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
}
/* 标题用 xs 而不是 micro：它是标签不是角标（micro 只给 ≤4 字的角标）。 */
.gate__label {
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  color: var(--k12-muted);
}
</style>
