/**
 * 把**当前学段**写到 `<html data-grade>` 上 —— 主题（含壁纸）的唯一开关。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（2026-10-02 查出来的一个真缺口）
 * ══════════════════════════════════════════════════════════════════════════
 * `tokens.generated.css` 里 18 组配色**全部**挂在 `:root[data-grade="…"][data-sat="…"]`
 * 上，而全仓**没有任何一处写这个属性** —— 也就是说四学段的主题色从落地起就没生效过，
 * 界面一直跑在 `:root` 的默认档上。做壁纸时必须先把它补上，否则四张图选不出来。
 *
 * 本模块只做一件事：**把主进程报的当前学段映射成那个属性**。
 * 它不参与任何业务判定（学段判定仍然只在服务端 + `stores/chat.ts`）。
 *
 * ⚠️ 属性值用**连字符**形态（`primary-low`），与 `tokens.generated.css` 的选择器逐字一致；
 *   `GradeLevel` 类型里是下划线（`primary_low`），转换只在这里做一次。
 */

import { watch } from 'vue'
import type { GradeLevel } from '@shared/ipc-events'
import { useChatStore } from './chat'

/** `GradeLevel` → `data-grade` 的属性值（tokens 的选择器认的是连字符形态）。 */
export function gradeDomValue(grade: GradeLevel | null): string {
  if (grade === null) return 'default'
  return grade.replace(/_/g, '-')
}

/**
 * 开始跟随当前学段（在 App 挂载时调用一次）。
 *
 * ★ `immediate: true`：首帧就要定下来 —— 否则会先按「默认档」画一帧壁纸与配色，
 *   等 `grade:get` 回来再跳一次（现场看得见的那一下闪烁）。
 * ★ 拿不到学段（`null`，冷启动还没判出来时）写 `default`：
 *   `tokens.generated.css` 有这一档，壁纸则回落到令牌里的默认那张（初中）。
 */
export function installGradeTheme(): void {
  const chat = useChatStore()
  const root = document.documentElement
  watch(
    () => chat.currentGrade,
    (grade) => {
      root.dataset.grade = gradeDomValue(grade)
    },
    { immediate: true }
  )
}
