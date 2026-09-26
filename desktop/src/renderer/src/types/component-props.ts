/**
 * 共享组件的**属性词表**（优化报告 §4.2「组件 API 标准化」）。
 *
 * ---------------------------------------------------------------------------
 * 这份文件解决什么
 * ---------------------------------------------------------------------------
 * 报告点名的三类问题：① 命名不统一（`tone` / `variant` / `type` 三种叫法）；
 * ② 布尔属性混乱（`flush` / `no-padding` 两种风格）；③ 缺少 TypeScript 约束
 * （props 写成 `string` 而不是枚举）。这份文件把①②的**词表**与③的**类型**钉在一处，
 * 组件从这里 import 自己那一条轴，而不是各写各的联合类型字面量。
 *
 * ── 三条命名纪律（新增组件 / 改组件前先读）─────────────────────────────────
 *   1. **颜色/样式变体一律叫 `variant`**（不叫 `type`，也不叫 `style`）；
 *   2. **表面层级一律叫 `tone`**（card / inset / float / plain）；
 *   3. **尺寸一律叫 `size`**，布尔属性一律**正向命名**（`flush` / `disabled` /
 *      `loading`，不写 `is-disabled` / `no-padding` / `has-no-...`）。
 *
 * ⚠️ 枚举值统一小写 + 连字符（`primary-low` 这种），不写驼峰、不写大写。
 *   例外是 `SurfaceTone` 里的短单词 —— 它们本来就只有一个词。
 */

/** 颜色 / 样式变体（**统一叫 `variant`**）。 */
export type ControlVariant = 'primary' | 'secondary' | 'tertiary'

/** 尺寸（**统一叫 `size`**）。 */
export type ControlSize = 'sm' | 'md' | 'lg'

/** 表面层级（`SurfacePanel` 的四档；见 base.css 的层次系统）。 */
export type SurfaceTone = 'card' | 'inset' | 'float' | 'plain'

/** 空状态四态（`EmptyState`）。 */
export type EmptyStateTone = 'empty' | 'loading' | 'error' | 'success'

/** 骨架屏形态（`Skeleton`）。 */
export type SkeletonVariant = 'text' | 'row' | 'card'

/**
 * 徽章五档（与 `server/app/routes/quiz.py` 的 `BADGE_LEVELS` 顺序一一对应）。
 *
 * ★ 定义与解析实现住在 `components/badge-level.ts`（零 import，便于 node 直接单测），
 *   这里**再导出**给词表消费者 —— 词的唯一出处仍然是那一个文件。
 */
export type { BadgeLevel } from '../components/badge-level'
export { BADGE_LEVELS } from '../components/badge-level'

/** 表面内边距（`SurfacePanel.padding` **四选一**，不再是任意字符串）。 */
export type SurfacePadding = 'none' | 'sm' | 'md' | 'lg'

/** 表面圆角（`SurfacePanel.radius` **三选一**）。 */
export type SurfaceRadius = 'inset' | 'card' | 'control'

/**
 * 全局组件属性接口（报告 §4.2 的「定义全局 ComponentProps 接口」）。
 *
 * ★ 组件不会直接 `implements` 它（Vue 的 `defineProps` 是结构化声明），
 *   它是**词表与轴命名的单一出处**：写新组件时从这里挑轴，
 *   而不是又造一个 `type` / `kind` / `look`。
 */
export interface ComponentProps {
  /** 颜色 / 样式变体（不用 `type`）。 */
  variant?: ControlVariant
  /** 表面层级 / 语义色调。 */
  tone?: SurfaceTone | EmptyStateTone
  /** 尺寸（不用 `scale` / `density`）。 */
  size?: ControlSize
}
