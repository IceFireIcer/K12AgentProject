<script setup lang="ts">
/**
 * `blocked` 事件的呈现：内容被安全终审撤回。
 *
 * ★ 原则（执行文档 §5）：**撤回正文、换成安全提示**（正文已由 `api/events.ts` 的
 *   分发函数替换成 `safeText`）。撤回原因只作为开发者线索展示，不当作回答正文。
 * ★ 学生看到的是 `safeText`（已经在气泡正文里），这里是那句「为什么刚才变了」。
 *
 * ── ★★ 撤回原因绝不给学生看（2026-09-20 走查）─────────────────────────────
 *   `notice.reason` 是后端 `SafetyVerdict.to_payload()` 的诊断串，实测形态是
 *   「命中内容安全规则：越狱/绕过规则（regex:reveal_system_prompt）」。摆给学生有三重问题
 *   （详见 `labels.ts` 的 `BLOCKED_STUDENT_NOTICE` 说明）：看不懂、以为自己犯了错、
 *   而且把「用正则匹配哪几类词」这份**防御策略**交代给了想绕过它的人。
 *   所以：
 *     · 学生看到的是一句人话 `BLOCKED_STUDENT_NOTICE`（`labels.ts` 的唯一实现）；
 *     · `reason` 原文一字不删地进**教师 / 答辩视角**（排障与「内容安全只做后端审核」
 *       这条约束的证据都在那里）；
 *     · `data-testid="blocked-notice"` 在两种视角下都在（体检脚本按它取撤回提示文本）。
 */
import type { BlockedNotice } from '../api/events'
import { BLOCKED_STUDENT_NOTICE } from '../labels'
import TeacherGate from './TeacherGate.vue'

defineProps<{ notice: BlockedNotice }>()
</script>

<template>
  <div class="blocked" data-testid="blocked-notice">
    <div class="head">
      <!-- ★ 角标也从「已撤回不安全内容」改成中性的说法：后者是在给**学生的话**
           贴一个「不安全」的判定，小学生读到只会以为自己犯了错。
           `blocked-badge` 这个 testid 保留（排障与体检都把这一块当整体看）。 -->
      <span class="chip chip--warn" data-testid="blocked-badge">已换一种说法</span>
      <!-- ★ 说「为什么刚才变了」，但说的是**学生能接住的那半句**：
           不出现 regex / 越狱 / 规则名，也不要求他做任何事。 -->
      <span class="label">{{ BLOCKED_STUDENT_NOTICE }}</span>
    </div>
    <TeacherGate label="安全终审原因">
      <p class="reason">{{ notice.reason }}</p>
    </TeacherGate>
  </div>
</template>

<style scoped>
.blocked {
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-warn-soft);
  border: 1px solid var(--k12-warn-border);
}

.head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

/* 状态胶囊：全局不再提供 .chip（见 base.css 的材质层），本组件自带一份。 */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 10px;
  border-radius: var(--k12-r-pill);
  border: 1px solid var(--k12-border);
  background: var(--k12-surface-2);
  color: var(--k12-muted);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  line-height: var(--k12-lh-ui);
}

.chip--warn {
  background: var(--k12-warn-soft);
  border-color: var(--k12-warn-border);
  color: var(--k12-warn);
}

/* 这句是**给学生的话**（不是元信息）：用正文色与正文档字号，不缩成灰色小字。
 * 此前它是「我们换了一个更合适的说法」那种短标签，所以是 `muted` + `sm`；
 * 现在它承载的是「刚才那条为什么换了、接下来能怎么办」，读起来必须像一句人话。 */
.label {
  font-size: var(--k12-fs-sm);
  line-height: var(--k12-lh-ui);
  color: var(--k12-fg-2);
}

.reason {
  margin-top: 6px;
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted-2);
  word-break: break-word;
}
</style>
