/**
 * 设计系统脚本（令牌色的唯一来源）。
 *
 * ── 三个脚本的分工 ───────────────────────────────────────────────────────
 *   author-tokens.mjs  挑色：从画布原配色反推 accent-ink（压深到可读），产出 tokens.source.json
 *   gen-tokens.mjs     生成：tokens.source.json → src/renderer/src/assets/tokens.generated.css
 *   check-contrast.mjs 校验：把 18 组 grade × sat 的每一组取值算一遍对比度（--strict 不达标即 exit 1）
 *
 * 日常只跑 `npm run gen:tokens` / `npm run check:contrast`。
 * `author-tokens.mjs` 只在**重新挑色**时手工跑一次（它会覆盖 tokens.source.json）。
 *
 * ⚠️ 生成的 CSS 是**派生产物**，不要手改 —— 改 tokens.source.json 再重新生成。
 * ⚠️ 两轴模型：`--k12-*` 变量挂在 `:root[data-grade][data-sat]` 上，
 *    由 `stores/theme.ts` 写 `<html>` 的 data 属性驱动（学段自适应配色）。
 */
