<script setup lang="ts">
/**
 * 吉祥物「团团」的标记（空态 / 成功态上的那张小图）。
 *
 * ── 为什么单独一个组件 ────────────────────────────────────────────────
 * 「团团」在界面里有若干出现位（侧栏品牌标、空对话大标记、每条回答的小头像、
 * 以及本轮新增的空态 / 高光态）。图片 URL 的唯一来源是 `brand-logo.ts`
 * （它已经解释了为什么不能各写一份路径：换素材时漏一处就是裂图，且不报错），
 * 本组件只负责**排版与尺寸**这一个维度。
 *
 * ★ 用的是**已有素材**（`desktop/resources/brand/*.png`，
 *   由 `server/scripts/make_brand_icons.py` 从 `logos/` 生成），
 *   **没有新造插画**：新增素材会同时牵动打包体积、生成脚本与 .gitignore 的
 *   模型/资源边界，而收益只是「多几张图」。空态的情感化靠文案 + 这一张图就够。
 *
 * ★ 用 `<img>` 而不是内联 SVG：素材本来就在运行时目录里、且已有四学段版本；
 *   内联 SVG 只能画个替代品 —— 那会出现「两套团团长得不一样」。
 */
import { DEFAULT_LOGO_URL } from '../brand-logo'

withDefaults(
  defineProps<{
    /** 直径（px）。三个用途：48 空态 / 32 成功态 / 28 紧凑。 */
    size?: number
  }>(),
  { size: 48 }
)
</script>

<template>
  <img
    class="mascot"
    data-testid="mascot"
    :src="DEFAULT_LOGO_URL"
    alt=""
    aria-hidden="true"
    :style="{ width: `${size}px`, height: `${size}px` }"
  />
</template>

<style scoped>
.mascot {
  display: block;
  /* 素材是正方形 PNG，圆角裁一下让它落在浅色圆底上时不显生硬 */
  border-radius: var(--k12-r-pill);
  object-fit: contain;
  /* 克制：不做循环动画（全站只允许 loading 转圈那一个）。 */
}
</style>
