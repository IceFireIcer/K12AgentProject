/**
 * 品牌名的**唯一来源**（主进程与渲染进程共用）。
 *
 * ⚠️ 有三处**无法** import 本文件，改品牌名时必须手工同步（都留了指向这里的注释）：
 *   - `desktop/electron-builder.yml` 的 `productName`（打包配置，只能写字面量）
 *   - `desktop/src/renderer/index.html` 的 `<title>`（纯 HTML，不参与 TS 编译）
 *   - `desktop/package.json` / `server/pyproject.toml` 的 `description`
 *   前两处有守卫测试盯着（`tests/brand.test.ts` 的 G19-1e），漏改会红。
 *
 * ★ 存储目录名**刻意与品牌名解耦**：`userData` 用的是固定 slug
 *   （见 `src/main/index.ts` 的 `applyStableUserDataSlug`），
 *   否则改一次品牌名就等于把学生的 config / learning.db / Pi 会话整体搬家。
 */

/** 面向学生与老师的应用显示名。 */
export const BRAND_NAME = '智团团'

/**
 * 一句话定位（窗口副标题、关于页、报告里引用）。
 *
 * ★ 2026-09-21 对齐需求原文：`docs/项目简介.md` 的定位是「**7×24 小时在线 AI 教师**」，
 *   而这里原来是「陪你学 AI 的通识课小老师」——「通识课小老师」把产品讲小了，
 *   也与提示词里「你就是一位 AI 老师」的自我认知不一致。
 * ⚠️ 曾用值「陪你学 AI 的通识课小老师」留在 git 历史里，不要再改回去
 *   （理由见 `docs/report-material/decisions.md` 的 D-064）。
 */
export const BRAND_TAGLINE = '7×24 小时在线的 AI 老师'
