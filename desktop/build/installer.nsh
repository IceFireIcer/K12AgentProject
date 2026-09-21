; ───────────────────────────────────────────────────────────────────────────
; 自定义 NSIS 安装向导页面 —— electron-builder 的 `nsis.include` 读的就是这个文件。
;
; ★ 它被**原样 include 进生成的安装脚本**，且位置在 `installer.nsi` **之前**
;   （见 `NsisTarget` 的 `sharedHeader + computeFinalScript(...)`）——
;   所以这里定义的宏，`assistedInstaller.nsh` 里的 `!ifmacrodef` 能看得见。
;
; ★ 这里只做一件事：**把欢迎页加回来**。
;
;   为什么需要补：electron-builder 的**引导式**安装器（`nsis.oneClick: false`）
;   **默认没有欢迎页** —— `assistedInstaller.nsh` 只在「宏 `customWelcomePage`
;   已定义」时才 `!insertmacro MUI_PAGE_WELCOME`。不补这一页，双击安装包
;   第一眼就是「选择安装范围（为所有用户 / 仅为我）」，学生不知道自己在装什么、
;   也不知道后面还会问什么。补上之后是标准五页：
;
;     欢迎 → 安装范围 → 安装位置 → 安装中 → 完成
;
; ⚠️ **这个文件只在真正打包时才被 makensis 编译**（开发机通常没装 NSIS，
;   日常 `npm test` 碰不到它），所以这里只允许放**标准、成型的 NSIS 片段**：
;   写错会让整条打包链失败，而失败点离改动很远（下一轮 nightly 才暴露）。
;   要加新页面就照 electron-builder 官方文档给的宏名来，**不要自创宏**。
;
; ⚠️ 也**不要**在这里 `SetShellVarContext` / `RMDir` 任何 `$APPDATA` 路径：
;   学生的全部数据（config.json / learning.db / Pi 会话）都在
;   `$APPDATA\k12-agent-desktop`，那是卸载器**唯一**被允许决定要不要动的地方，
;   而它由 `nsis.deleteAppDataOnUninstall: false` 统一管着（D-067）。
;   守卫：`tests/installer-config.test.ts` 的 G21-2 / G21-4。
; ───────────────────────────────────────────────────────────────────────────

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend
