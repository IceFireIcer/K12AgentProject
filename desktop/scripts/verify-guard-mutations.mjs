#!/usr/bin/env node
/**
 * 变异验证：把每处修复**改回坏写法**，确认对应守卫真的变红。
 *
 * 为什么必须有这一步（本项目纪律，见 AGENTS.md §7「没验过会红的守卫不算守卫」）：
 * 一条永远通过的断言和没有断言是一样的 —— 而「永远通过」最常见的成因不是写错判据，
 * 是**判据选错了锚点**（比如拿注释里的字面量当锚点，见本轮 student-view-discipline
 * 里踩到的两次）。只有把修复撤掉、看着它变红，才能证明这条守卫真的在守那件事。
 *
 * 用法：`node scripts/verify-guard-mutations.mjs`（在 desktop/ 下跑）
 * 策略：备份原文件 → 应用变异 → 跑指定测试 → 恢复原文件（finally 保证恢复）。
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(desktopRoot, '..')
const TEST = 'tests/student-view-discipline.test.ts'

/**
 * 跑一次测试，返回「是否变红」。
 *
 * ★ 守卫不止住在一个测试文件里，所以每条变异可以自带目标：
 *   - 缺省（不写 `runner` / `testFile`）：桌面端
 *     `node --test --test-name-pattern <expect> tests/student-view-discipline.test.ts`；
 *   - `testFile`：换一个桌面测试文件（如 `tests/installer-config.test.ts`）；
 *   - `runner: 'server'`：`uv run python -m unittest tests.test_grade`
 *     （`expect` 用作子串匹配的红条名）。
 */
function runExpect(mutation) {
  const isServer = mutation.runner === 'server'
  const testFile = mutation.testFile ?? TEST
  const command = isServer ? 'uv' : 'node'
  const args = isServer
    ? ['run', 'python', '-m', 'unittest', 'tests.test_grade']
    : ['--test', '--test-name-pattern', mutation.expect, testFile]
  const cwd = isServer ? join(repoRoot, 'server') : desktopRoot
  let output = ''
  let threw = false
  try {
    output = execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    threw = true
    output = String(error.stdout ?? '') + String(error.stderr ?? '')
  }
  // `node --test` 报 `fail N`；`unittest` 报 `FAILED (failures=N)`。
  // ★ 还要确认**红的是我们期望的那条**（别的用例红了也算红，
  //   那会让变异验证变成「只要有任何失败就通过」）。所以额外要求 expect 出现在输出里。
  const failed = isServer
    ? /FAILED \((failures|errors)=[1-9]/.test(output)
    : threw || /fail [1-9]/.test(output)
  const matchedExpect = isServer || mutation.testFile ? output.includes(mutation.expect) : true
  return { red: failed && matchedExpect, output }
}

/** 每条变异：改哪个文件、把什么改成什么、期望哪条用例变红。 */
const MUTATIONS = [
  {
    name: '① 术语扫描：把运维话塞回学生可见文案',
    file: 'src/renderer/src/components/ContextRail.vue',
    // ⚠️ 锚点跟着 2026-09-21 的自称统一走了（「团团」→「智团团」）——
    //    改名后这里没同步过一次，变异直接「找不到锚点」而**静默失效**（脚本会报出来）。
    find: `        : \`智团团这次只用了「\${label}」和更低学段的教材，不会超纲。\`,`,
    replace: `        : \`本次仅使用「\${label}」及以下教材块（隔离在 SQL 层强制，模型改不了 WHERE）\`,`,
    expect: '出现开发者术语'
  },
  {
    name: '② slug 扫描：让学生看到 kp_id',
    file: 'src/renderer/src/views/Quiz.vue',
    find: "const UNNAMED_POINT = '未命名知识点'",
    replace: "const UNNAMED_POINT = 'ai-definition-jr'",
    expect: '不得出现原始 kp slug'
  },
  {
    name: '③ 默认视角：把默认改成教师视角',
    file: 'src/renderer/src/stores/viewMode.ts',
    find: "      ? 'teacher'\n      : 'student'",
    replace: "      ? 'teacher'\n      : 'teacher'",
    expect: '默认视角必须是学生'
  },
  {
    name: '④ 知识库页：把 nav 改回 true（学生又看得到运维页）',
    file: 'src/renderer/src/stores/ui.ts',
    find: "    nav: 'teacher',",
    replace: '    nav: true,',
    expect: '参考资料库是教师专属页'
  },
  {
    name: '⑤ CTA：把闯关页主提交键的类名换成本地皮肤',
    file: 'src/renderer/src/views/Quiz.vue',
    find: 'class="k12-cta"',
    replace: 'class="qitem__btn"',
    expect: '五处核心主行动按钮'
  },
  {
    name: '⑥ 安全提示：把规则原文摆回学生那一半',
    file: 'src/renderer/src/components/BlockedNotice.vue',
    find: '<TeacherGate label="安全终审原因">\n      <p class="reason">{{ notice.reason }}</p>\n    </TeacherGate>',
    replace: '<p class="reason">{{ notice.reason }}</p>',
    expect: '安全拦截提示只给学生一句人话'
  },
  {
    name: '⑦ 导出文件名：改回内部命名法',
    file: 'src/renderer/src/views/Dependency.vue',
    find: '`${BRAND_NAME}-${gradeLabel.value}学习地图-${todayStamp()}.csv`',
    replace: '`dependency-edges-${gradeLabel.value}.csv`',
    expect: '导出文件名用品牌名'
  },
  {
    name: '⑧ 错题本刷新：撤掉 onActivated 的重取',
    file: 'src/renderer/src/views/Study.vue',
    find: 'onActivated(() => {\n  void study.loadMistakes()\n})',
    replace: 'onActivated(() => {\n  void 0\n})',
    expect: '判分之后错题本必须失效重拉'
  },
  {
    name: '⑨ 提交键：答对后仍允许「再提交一次」',
    file: 'src/renderer/src/cards/QuizCard.vue',
    find: "return result.correct ? '已完成' : '再试一次'",
    replace: "return result === null ? '提交这题' : '再提交一次'",
    expect: '答对后提交键必须是禁用的'
  },
  {
    name: '⑩ 空态：撤回 success 色调（退回冷灰色占位）',
    file: 'src/renderer/src/study/MistakesTab.vue',
    find: 'tone="success"',
    replace: 'tone="empty"',
    expect: '空态必须是引导 / 高光'
  },
  {
    name: '⑪ 模板几何：把 viewBox 高度改回装不下',
    file: '../server/resources/templates/decision-tree.json',
    // JSON 里 body 是转义过的字符串，所以匹配到的是带反斜杠的那份
    find: 'viewBox=\\"0 0 460 268\\"',
    replace: 'viewBox=\\"0 0 460 230\\"',
    expect: '必须全部落在自己声明的 viewBox 内'
  },
  {
    name: '⑫ 反向对照：把答辩证据删干净（「学生视角干净了」的坏解法）',
    file: 'src/renderer/src/components/rail-evidence.ts',
    find: "{ key: 'fts', label: 'FTS5 关键词兜底' },",
    replace: "{ key: 'fts', label: '关键词检索' },",
    expect: '原始证据一个字都没丢'
  },
  {
    name: '⑬ 豁免的凭据：把技术词挪进**学生**那一节（豁免是按文件给的，理由却是「只在高级区」）',
    file: 'src/renderer/src/views/Settings.vue',
    find: '<SurfacePanel class="card" data-section="grade" data-testid="settings-grade-block">',
    replace: '<SurfacePanel class="card" data-section="grade" data-testid="settings-grade-block">\n        <!-- 变异：假装这里多了一句给学生看的运维说明 -->\n        <p>端口号 8756，向量维度 512</p>',
    expect: '豁免必须名副其实'
  },
  {
    name: '⑭ 高级区恒真：把「高级设置」摊给所有学生（review 实测的第四种绕过）',
    file: 'src/renderer/src/views/Settings.vue',
    find: '<section v-if="advancedVisible" class="adv" data-testid="settings-advanced">',
    replace: '<section v-if="true || advancedVisible" class="adv" data-testid="settings-advanced">',
    expect: '豁免必须名副其实'
  },
  {
    name: '⑮ 教师专属页的判据写反：知识库又回到学生侧栏',
    file: 'src/renderer/src/stores/ui.ts',
    // 只把第一行判断改掉（`=== true` → `!== false`）：这一处改动就足以让
    // `nav: 'teacher'` 也返回 true —— 正是「守卫写反」的形态。
    find: '  if (meta.nav === true) return true',
    replace: '  if (meta.nav !== false) return true',
    // 期望红的是**行为**那条（它真的调了谓词）；上一条源码守卫抓不到这种改动，
    // 这正是当初补行为守卫的原因。
    expect: '真的按三态工作'
  },
  {
    name: '⑯ 重建索引的能力被摘掉（只剩 store 里的方法，按钮没了）',
    file: 'src/renderer/src/views/Knowledge.vue',
    // ⚠️ 必须 `all: true`：`@click="rebuild"` 在文件里出现**两次**
    //   （工具栏的主按钮 + 错误态里的「重试」）。只改第一处时第二处仍匹配我的断言，
    //   守卫照绿 —— 变异验证第一次跑就抓到了这个假绿。
    find: '@click="rebuild"',
    replace: '@click="void 0"',
    all: true,
    expect: '豁免必须名副其实'
  },
  {
    name: '⑳ 人设名：把某一学段的自称改回旧的「小 AI 老师」',
    file: 'src/main/agent/prompts/primary-low.ts',
    find: "你是「${PRIMARY_LOW_NAME}」，一位会讲故事的老师",
    replace: "你是「小 AI 老师」，一位会讲故事的老师",
    expect: '自称统一'
  },
  {
    name: '㉑ 按需调用：删掉「什么时候不必用工具」那一节',
    file: 'src/main/agent/prompts/rules.ts',
    find: "  need: '# 什么时候要用工具，什么时候不用'",
    replace: "  need: '# 工具使用'",
    expect: '按需调用'
  },
  {
    name: '㉒ 硬绑定：把「先查教材再讲」塞回去',
    file: 'src/main/agent/prompts/rules.ts',
    find: '- 教材是**参考**：需要原话、出处，或学生明确问「书上怎么说的」时，才用检索工具取回原文；',
    replace: '- 回答教材里的知识点前，先用检索工具取回教材原文再讲；',
    expect: '硬绑定'
  },
  {
    name: '㉓ 章节口径：改回「优先围绕本章」',
    file: 'src/main/agent/extensions/profile.ts',
    find: '`- 学生当前在看：${chapter}（只是背景，不必刻意围绕它）`',
    replace: '`- 学生当前在看：${chapter}（回答与检索优先围绕本章）`',
    expect: '纯背景'
  },
  {
    name: '㉔ 页面标题：改回「学习档案」，并把分组改回两组',
    file: 'src/renderer/src/stores/ui.ts',
    find: "    title: '学习记录',",
    replace: "    title: '学习档案',",
    expect: '页面标题与分组'
  },
  {
    name: '⑰ 卡片又把 kp_id 直接印出来（复审找到的三处漏网）',
    file: 'src/renderer/src/cards/ProgressCard.vue',
    find: '<span v-if="levelName(level.kpId)" class="level__name">{{ levelName(level.kpId) }}</span>',
    replace: '<span class="level__name">{{ level.kpId }}</span>',
    expect: '不得直接渲染 kp_id 或 qid'
  },
  {
    name: '⑱ 历史回看漏掉译文（档案页又能读到内部指令）',
    file: 'src/renderer/src/study/SessionsTab.vue',
    find: 'text: chat.studentFacingUserText(message.text)',
    replace: 'text: message.text',
    expect: '回看历史的三条路'
  },
  {
    name: '⑲ 关卡进度又直出后端文案（HTTP 状态码印到学生页）',
    file: 'src/renderer/src/stores/quiz.ts',
    find: "else progressError.value = toStudentFacingMessage(result.message, { topic: 'quiz' })",
    replace: 'else progressError.value = result.message',
    expect: '不得直出'
  },

  /* ------------------------------------------------------------------ *
   * 学段判定机制（2026-09-21 / D-065）—— 守卫在**服务端**的 test_grade.py
   * ------------------------------------------------------------------ */
  {
    name: '㉕ 冷却：改回「两个会话的轮次号相减」（活锁原形）',
    runner: 'server',
    file: '../server/app/grade/rules.py',
    // 把「按真实轮数算」改回「拿两个轮次号相减」——那正是 P-113 的活锁做法。
    find: `    if elapsed_turns is not None:
        return max(0, window - max(0, int(elapsed_turns)))`,
    replace: `    if elapsed_turns is not None:
        return max(0, window - max(0, int(turn) - int(anchor_turn or 0)))`,
    expect: 'test_cooldown_releases_across_sessions'
  },
  {
    name: '㉖ 深度：撤掉「只上不下」（问得浅又能降级）',
    runner: 'server',
    file: '../server/app/grade/signals.py',
    find: 'return _reading("depth", current_level, level, raw, only_up=True)',
    replace: 'return _reading("depth", current_level, level, raw)',
    expect: 'test_depth_never_pulls_the_grade_down'
  },
  {
    name: '㉗ 词汇：撤掉日常口语的「只上不下」（用词日常又能降级）',
    runner: 'server',
    file: '../server/app/grade/signals.py',
    find: `            "vocab", current_level, "primary_low", "口语=" + ",".join(daily[:6]), only_up=True`,
    replace: `            "vocab", current_level, "primary_low", "口语=" + ",".join(daily[:6])`,
    expect: 'test_daily_terms_are_neutral_not_downgrading'
  },
  {
    name: '㉘ 降级标注：改回「没提议就报 no_llm」（把正常工作说成坏了）',
    runner: 'server',
    file: '../server/app/grade/rules.py',
    find: `    if layer2_status is not None:
        degraded = layer2_status if layer2_status in DEGRADED_LAYER2_STATUSES else None
    else:`,
    replace: `    if False:
        degraded = None
    else:`,
    expect: 'test_degraded_reports_the_real_channel_status'
  },
  {
    name: '㉙ D-066：把决策权交回规则（第 5 轮后 LLM 又只是提议）',
    runner: 'server',
    file: '../server/app/grade/rules.py',
    // 让 `llm_decides` 恒为假 —— 那就是「决策权还在规则引擎」的旧口径
    find: 'llm_decides = proposal is not None and cumulative >= LLM_DECIDES_FROM_TURN',
    replace: 'llm_decides = False',
    expect: 'test_llm_decides_from_the_fifth_cumulative_turn'
  },
  {
    name: '㉚ D-066：累计轮次改回「只看本会话」（规则在短会话里永远等不到 LLM）',
    runner: 'server',
    file: '../server/app/grade/rules.py',
    find: `            "SELECT COUNT(DISTINCT COALESCE(session_id, '') || '|' || "
            "substr(raw, 1, instr(raw, '|') - 1)) AS turns "
            "FROM grade_signals WHERE raw LIKE 't%|%'"`,
    replace: `            "SELECT COUNT(DISTINCT "
            "substr(raw, 1, instr(raw, '|') - 1)) AS turns "
            "FROM grade_signals WHERE raw LIKE 't%|%' AND session_id = "
            "(SELECT session_id FROM grade_signals ORDER BY id DESC LIMIT 1)"`,
    expect: 'test_cumulative_turns_counts_across_sessions'
  },
  {
    name: '㉛ D-066：decided_by 不落库（界面标签退回「都在冒充 AI 推算」）',
    runner: 'server',
    file: '../server/app/grade/rules.py',
    find: `                        signal_mark,
                        decision.decided_by,`,
    replace: `                        signal_mark,
                        None,`,
    expect: 'test_decided_by_is_recorded_on_the_history_row'
  },

  /* ------------------------------------------------------------------ *
   * 安装包与版本号（D-067）—— 守卫在 `tests/installer-config.test.ts`
   * ------------------------------------------------------------------ */
  {
    name: '㉜ 安装器改回一键装（双击就装完、没有向导页）',
    testFile: 'tests/installer-config.test.ts',
    file: 'electron-builder.yml',
    find: '  oneClick: false',
    replace: '  oneClick: true',
    expect: 'G21-1'
  },
  {
    name: '㉝ 卸载时删学生数据（installer 会把 %APPDATA% 整目录删掉）',
    testFile: 'tests/installer-config.test.ts',
    file: 'electron-builder.yml',
    find: '  deleteAppDataOnUninstall: false',
    replace: '  deleteAppDataOnUninstall: true',
    expect: 'G21-3'
  },
  {
    name: '㉞ 抽掉欢迎页（引导式安装器默认没有，抽掉后第一眼就是「选择安装范围」）',
    testFile: 'tests/installer-config.test.ts',
    file: 'build/installer.nsh',
    find: '!macro customWelcomePage\n  !insertmacro MUI_PAGE_WELCOME\n!macroend',
    replace: '; 变异：欢迎页被抽掉\n!macro customWelcomePage\n!macroend',
    expect: 'G21-4'
  },
  {
    name: '㉟ 版本号越界不再报错（0.1.70000 → makensis 才炸，离改动很远）',
    testFile: 'tests/installer-config.test.ts',
    file: 'scripts/build-version.mjs',
    find: '    if (part > MAX_VERSION_PART) {',
    replace: '    if (false && part > MAX_VERSION_PART) {',
    expect: 'G21-6'
  },
  {
    name: '㊱ 打包前不盖版本号（每个 nightly 都叫 0.1.0、安装包互相覆盖）',
    testFile: 'tests/installer-config.test.ts',
    file: '../.github/workflows/nightly.yml',
    find: '        run: npm run version:stamp',
    replace: '        run: echo "变异：不盖版本号"',
    expect: 'G21-7'
  },

  /* ------------------------------------------------------------------ *
   * 安装包体积（2026-09-21 / D-068）—— 守卫在 tests/bundle-budget.test.ts
   * 这四条守的都是「**跑应用看不出来**」的事：包多打一份照跑，只是安装包变胖。
   * ------------------------------------------------------------------ */
  {
    name: '㊲ 渲染依赖回归：把 element-plus 从 devDependencies 删掉（它已经进过一次包，167MB）',
    testFile: 'tests/bundle-budget.test.ts',
    file: 'package.json',
    find: '    "element-plus": "^2.14.5",\n',
    replace: '',
    expect: 'G24-2'
  },
  {
    name: '㊳ 语言包裁剪被去掉：electronLanguages 里删掉 en-US（英文系统上原生对话框缺文本）',
    testFile: 'tests/bundle-budget.test.ts',
    file: 'electron-builder.yml',
    find: '  - en-US\n',
    replace: '',
    expect: 'G24-4'
  },
  {
    name: '㊴ pyodide 重复副本回归：files 里去掉 !resources/pyodide/**（同一份 15.7MB 资源打两遍）',
    testFile: 'tests/bundle-budget.test.ts',
    file: 'electron-builder.yml',
    find: "  - '!resources/pyodide/**'\n",
    replace: '',
    expect: 'G24-5'
  },
  {
    name: '㊵ 产物累积口子重开：撤掉 renderer 的 emptyOutDir（历史 chunk 又留在产物目录里）',
    testFile: 'tests/bundle-budget.test.ts',
    file: 'electron.vite.config.ts',
    find: 'build: { emptyOutDir: true },',
    replace: 'build: {},',
    expect: 'G24-7'
  },

  /* ------------------------------------------------------------------ *
   * 会话删除（2026-09-22）—— 守卫在 tests/session-delete.test.ts
   * 这几条守的是**破坏性操作**上的闸门：路径判据、顺序、可读失败。
   * 它们全都「跑起来看着正常」——只有在删错东西 / 删不干净时才暴露。
   * ------------------------------------------------------------------ */
  {
    name: '㊶ 删除少了目录包含那道防线（只按 id 对齐就 unlink → 指哪删哪）',
    testFile: 'tests/session-delete.test.ts',
    file: 'src/main/study/sessions.ts',
    find: `  if (!isInside(options.sessionDir, info.path)) {`,
    replace: `  if (false && !isInside(options.sessionDir, info.path)) {`,
    expect: '别的学生'
  },
  {
    name: '㊷ 删除顺序反过来（先删文件、再切会话 → Pi 把文件重新写出来）',
    testFile: 'tests/session-delete.test.ts',
    file: 'src/main/ipc/handlers.ts',
    find: `    const swapped = await swapToSession({ kind: 'new' })`,
    replace: `    const swapped = { ok: true as const, message: '' }`,
    // ⚠️ `expect` 是 `--test-name-pattern` 的**测试名**（不是报错文本）：
    //    写成报错里那句话会让这个模式匹配不到任何用例 → 一个都不跑 → 变异「没抓到」。
    expect: '删当前会话'
  },
  {
    name: '㊸ 删除失败也清空当前对话（清空了又什么都没恢复 = 最坏的失败形态）',
    testFile: 'tests/session-delete.test.ts',
    file: 'src/renderer/src/stores/chat.ts',
    find: `      if (!result.ok) return { ok: false, message: result.message }`,
    replace: `      if (!result.ok) {
        resetConversation()
        return { ok: false, message: result.message }
      }`,
    expect: '原样回传'
  },
  {
    name: '㊹ 删完当前会话不对齐屏幕（屏幕上留着一段已经不存在的对话）',
    testFile: 'tests/session-delete.test.ts',
    file: 'src/renderer/src/stores/chat.ts',
    find: `        await applyCurrentSessionState({ replace: true })`,
    replace: `        await Promise.resolve()`,
    expect: '不许留着一段已经不存在的对话'
  },

  /* ------------------------------------------------------------------ *
   * 「还没配置模型」的显示（2026-09-22）—— 守卫在 tests/llm-unconfigured.test.ts
   * 这条守的是「界面在说自己没有的东西」：一个 Key 都没填时显示着模型名。
   * ------------------------------------------------------------------ */
  {
    name: '㊺ 未配置时又把模型名当「当前模型」（用户以为已经配好了）',
    testFile: 'tests/llm-unconfigured.test.ts',
    file: 'src/renderer/src/labels.ts',
    find: `  return hasKey && modelId !== '' ? 'ready' : 'unconfigured'`,
    replace: `  return modelId !== '' ? 'ready' : 'unconfigured'`,
    // ⚠️ 同上：`expect` 匹配的是**测试名**（'★★ 判据：没读到设置 = 读取中｜没 Key = 未配置｜…'）
    expect: '没读到设置'
  },

  /* ------------------------------------------------------------------ *
   * 两栏默认收起（2026-09-22）—— 守卫在 tests/panel-collapse.test.ts
   * ------------------------------------------------------------------ */
  {
    name: '㊻ 两栏默认改回展开（首屏又被两栏挤窄）',
    testFile: 'tests/panel-collapse.test.ts',
    file: 'src/renderer/src/stores/panels.ts',
    find: `export const PANEL_DEFAULT_OPEN = false`,
    replace: `export const PANEL_DEFAULT_OPEN = true`,
    // ⚠️ 同上：`expect` 匹配测试名（'★★ 两栏的默认状态是【收起】…'）
    expect: '默认状态是【收起】'
  },
  {
    name: '㊼ 收起只裁剪宽度（子元素仍有 236px 矩形 → 体检把看不见的东西量成可点的）',
    testFile: 'tests/panel-collapse.test.ts',
    file: 'src/renderer/src/views/Chat.vue',
    find: `.chat__side--closed :deep(.sl) {
  display: none;
}`,
    replace: `.chat__side--closed :deep(.sl) {
  overflow: hidden;
}`,
    expect: 'display: none'
  },

  /* ------------------------------------------------------------------ *
   * 未开始的会话在三条路径上长得一样（2026-09-22）—— 守卫在 tests/opening-guidance.test.ts
   * ------------------------------------------------------------------ */
  {
    name: '㊽ 开场判据退回「消息条数为 0」（切回来时丢整个空态）',
    testFile: 'tests/opening-guidance.test.ts',
    file: 'src/main/ipc/handlers.ts',
    find: `  if (instance.hasUserTurn) {`,
    replace: `  if (instance.messageCount > 0) {`,
    expect: '学生开口了没有'
  },
  {
    name: '㊾ 未开始的会话又把开场白当普通消息铺回去（界面进不了空态）',
    testFile: 'tests/opening-guidance.test.ts',
    file: 'src/main/ipc/handlers.ts',
    // ⚠️ 锚点跟着源码的**换行形态**走过一次：这条 return 以前写成一行
    //    （`return { started: false, messages: [], opening: fetched.text, openingKpId: fetched.kpId }`），
    //    后来多了一个 `openingKpName` 字段并被格式化成分行对象字面量 ——
    //    旧锚点于是「找不到」，这条变异**静默失效**（脚本会报 ⚠️ 并计入失败，所以不会被当成通过）。
    //    改成按「对象字面量的前几行」定位：`opening: fetched.text` 是这条分支独有的。
    find: `    return {
      started: false,
      messages: [],
      opening: fetched.text,`,
    replace: `    return {
      started: false,
      messages: [...instance.restoredMessages],
      opening: fetched.text,`,
    // 同一条用例（判据那条）里的断言 —— 它同时守着两件事：判据 + 未开始时不铺消息
    expect: '学生开口了没有'
  },

  /* ------------------------------------------------------------------ *
   * 学生面**排版标记**纪律（2026-09-22 报告 1.8 + 第 3 章「破折号专项」）
   * —— 守卫在 `tests/student-view-discipline.test.ts` 的 ⑰（两条 + 凭据那条）
   * 与 `tests/llm-unconfigured.test.ts` 的空态那条。
   * 这几条守的都是「字面标记被印到学生眼前」：跑起来一切正常，只有学生读到的字不对
   * （动画页那句「一串**是 / 否**问题」就是这么来的）。
   * ------------------------------------------------------------------ */
  {
    name: '51 排版标记：把 `**加粗**` 写进学生可见文案（裸插值路径原样上屏）',
    file: 'src/renderer/src/views/Quiz.vue',
    find: "const UNNAMED_POINT = '未命名知识点'",
    replace: "const UNNAMED_POINT = '**未命名**知识点'",
    expect: '未渲染的 Markdown 标记'
  },
  {
    name: '52 破折号：把「章节已清空」那句改回 `——` 连接（学生文案的 LLM 指纹）',
    file: 'src/renderer/src/stores/chat.ts',
    find: "'学段变了，之前选的教材章节已清空。可以重新选一章，或直接自由问答。'",
    replace: "'学段变了，之前选的教材章节已清空 —— 可以重新选一章，或直接自由问答。'",
    expect: '不得用破折号'
  },
  {
    name: '53 例外的凭据：把高级区那处破折号搬进**学生那一节**（按文件豁免会假绿）',
    file: 'src/renderer/src/views/Settings.vue',
    find: '<SurfacePanel class="card" data-section="grade" data-testid="settings-grade-block">',
    replace:
      '<SurfacePanel class="card" data-section="grade" data-testid="settings-grade-block">\n        <!-- 变异：学生那一节多了一句带破折号的说明 -->\n        <p>学段与章节随时可以换 —— 之前学过的记录都还在</p>',
    expect: '例外表必须名副其实'
  },
  {
    name: '54 对话页空态：入口卡改成渲染空数组（「现在还能干什么」没了兑现者）',
    testFile: 'tests/llm-unconfigured.test.ts',
    file: 'src/renderer/src/views/Chat.vue',
    find: '                v-for="e in entries"',
    replace: '                v-for="e in []"',
    expect: '还答不了'
  },

  /* ------------------------------------------------------------------ *
   * 桥没接上时的两条通路（2026-09-22 报告 0.2 / D-063）
   * —— 守卫在 `tests/student-view-discipline.test.ts` 的 ⑱ 与
   * `tests/renderer-chapter.test.ts` 的「桥缺 setChapter」那条。
   * 一条守**屏幕**（不许有方法名 / 通道名），一条守**控制台**（接线细节一个字都不许丢）。
   * ------------------------------------------------------------------ */
  {
    name: '55 桥文案：把接线说明塞回学生面那句（方法名 + preload 又印给学生）',
    file: 'src/renderer/src/api/chapter.ts',
    find: "export const CHAPTER_SET_MISSING_HINT = '暂时换不了章节。先直接问问题就好，需要时请老师帮忙看看。'",
    replace:
      "export const CHAPTER_SET_MISSING_HINT =\n" +
      "  '选择章节还没有接线：preload 白名单缺少 setChapter，需要先在主进程注册' +\n" +
      "  '「章节设定」通道（invoke，带回执），再由 preload 暴露 `setChapter`。接线后刷新页面即可生效。'",
    expect: '屏幕上是学生话'
  },
  {
    name: '56 接线诊断：把「缺哪个方法」从控制台那句里删掉（意图丢了，屏幕也没补回来）',
    file: 'src/renderer/src/api/chapter.ts',
    // ⚠️ 要把**两处**都换掉才算真删：这句 detail 里方法名出现了两次
    //   （「缺少 setChapter」+「再由 preload 暴露 setChapter」）。只改一处时守卫照样绿 ——
    //   第一版变异就是这么写的，结果「没抓到」的其实是变异自己没生效（不是守卫失灵）。
    find:
      "      'preload 白名单缺少 setChapter：需要主进程注册 chapter:set（invoke，带回执 —— 学生要看到改没改成），' +\n" +
      "        '再由 preload 暴露 setChapter。接线后重启渲染进程即可生效；在那之前界面只读（能看到正在学哪一章、换不了）。'",
    replace:
      "      'preload 白名单缺少写入方法：需要主进程注册那条 invoke 通道（带回执 —— 学生要看到改没改成），' +\n" +
      "        '再由 preload 暴露它。接线后重启渲染进程即可生效；在那之前界面只读（能看到正在学哪一章、换不了）。'",
    expect: '屏幕上是学生话'
  },
  {
    name: '57 数据面桥文案：把「缺的是哪个方法」写回学生面那句（又印给学生）',
    file: 'src/renderer/src/api/data.ts',
    find: "export const DATA_BRIDGE_MISSING_HINT = '这部分内容暂时打不开。先回对话页就好，需要时请老师帮忙看看。'",
    replace:
      "export const DATA_BRIDGE_MISSING_HINT =\n" +
      "  '本地数据通道未接通：主进程没有提供 window.api.readQuizBank。' +\n" +
      "  '（分步接线时的老产物，或测试替身没装全。）'",
    expect: '屏幕上是学生话'
  },
  {
    name: '58 api/settings.ts 的豁免：把技术词塞进学生那句（豁免理由不再成立）',
    file: 'src/renderer/src/api/settings.ts',
    // 这个文件仍在 `TERM_EXEMPT_FILES` 里（技术词守卫整份跳过它），
    // 所以这条只有**豁免的凭据**能抓到 —— 抓不到就说明那段理由又是一纸空文。
    find: "export const SETTINGS_BRIDGE_MISSING_HINT = '设置暂时打不开。先回对话页就好，需要时请老师帮忙看看。'",
    replace:
      "export const SETTINGS_BRIDGE_MISSING_HINT =\n" +
      "  '设置暂时打不开。先回对话页就好 —— 云端 embedding 端点也没配上，需要时请老师帮忙看看。'",
    expect: '豁免必须名副其实'
  },
  {
    name: '59 动画讲解页：把一次性托管地址绑回舞台 iframe（P-131 的第二个出口）',
    file: 'src/renderer/src/views/Animation.vue',
    // 用户 2026-09-26 第二次撞到的那条路径：卡片改内联后，托管地址的消费者只剩这一页。
    // 锚点是**当前实现**那一行（`:srcdoc="anim.payload?.html"`），改了实现要同步这里 ——
    // 锚点漂了脚本会打印「找不到锚点」并把这条算作未验证，不会静默放过。
    find: '            :srcdoc="stagePayload?.html"',
    replace: '            :src="anim.hosted?.url"',
    testFile: 'tests/animation-extension.test.ts',
    expect: '动画讲解页的舞台也只从内联 HTML 挂 iframe'
  },
  {
    name: '60 托管链的类别守卫：在**卡片**里取回 resourceUrl（准备绑 DOM 的第一步）',
    file: 'src/renderer/src/cards/AnimationCard.vue',
    // 第 59 条验的是「讲解页把 `:srcdoc` 改回 `:src`」——那种改法会被本页自己的守卫抓到。
    // 这一条验的是**类别守卫**：换个文件、换个写法（先取回地址，再随便怎么用）也必须红。
    // 之所以选「取回 resourceUrl」而不是「直接绑 DOM」：绑法穷举不完（`v-bind="{src}"`、
    // `iframeEl.value.src=`、`window.open`…），而「引用标识符」是所有绑法的必经第一步。
    // ⚠️ 锚点必须落在**卡片自己那条守卫看不见**的行上：mountIframe 那行原样保留，
    //    否则这条变异会由卡片守卫变红，验不到类别守卫。
    find: 'const mountIframe = ref<boolean>(shouldMountIframe(view.html))',
    replace:
      'const hostedUrl = view.resourceUrl\n' +
      'const mountIframe = ref<boolean>(shouldMountIframe(view.html))',
    testFile: 'tests/animation-extension.test.ts',
    expect: '渲染层里只有能力层能碰到一次性托管链'
  },
  {
    name: '61 动画舞台：去掉比例声明，高度退回写死的 340px（字又被缩到 7.8px）',
    file: 'src/renderer/src/views/Animation.vue',
    // 这一条守的是**学生实际读到几号字**：真机探针 `npm run ux:stage` 量到修前缩放 0.485×、
    // 节点字 7.8px。探针要跑起整个应用，而变异验证跑的是单测，所以同一条不变量在
    // `tests/ux-pages-regression.test.ts` 里另有一条**离线可跑**的 CSS 守卫 —— 变异打它。
    // ⚠️⚠️ 锚点必须落在**单行**以内：本仓工作区是 CRLF（`.gitattributes` 只在提交时归一成 LF），
    //   `find` 里写 `\n` 永远匹配不到 —— 本条第一版就是多行锚点，脚本打印「找不到锚点」才发现。
    find: '  aspect-ratio: 720 / 468;',
    replace: '  /* 变异：去掉比例声明 ⇒ iframe 高度退回 min-height 的 340px */',
    testFile: 'tests/ux-pages-regression.test.ts',
    expect: '动画舞台的高度必须'
  },

  /* ── 2026-09-26 便携版修复轮（P0-1 / P0-2 / P2-3）─────────────────────
   * 这三条分别是「数据丢失」「页面死胡同」「字小到读不了」——都属于
   * **改错了不会让任何逻辑断言变红**的类型，所以各配一条变异。 */
  {
    name: '62 便携数据目录：把「exe 同级」当成一定持久（P0-1 数据丢失的原始写法）',
    file: 'src/main/portable.ts',
    // 变异：短路掉「临时目录」这一档判定 ⇒ 单文件形态又会把数据写进 %TEMP% 解压目录。
    // ⚠️ 锚点单行（工作区 CRLF）。
    find: '  if (isThrowawayDir(candidate, input.tempDir, unpackDirName)) {',
    replace: '  if (false && isThrowawayDir(candidate, input.tempDir, unpackDirName)) {',
    testFile: 'tests/portable-data-dir.test.ts',
    expect: 'G-P0-1a'
  },
  {
    name: '63 动画页导航：分页 tab 被关进 v-show 的 pane（P0-2 死胡同的原始结构）',
    file: 'src/renderer/src/views/Animation.vue',
    // 变异：把「智团团准备的」那个 pane 的起点整体上移，让导航落在它内部 ——
    // 等价于「切到我的动画时导航跟着消失」。这里用最小改动模拟：把导航那段整体
    // 移进 pane（脚本只做文本替换，所以改成把 pane 的 div 变成**包住导航**的写法）。
    find: '    <!-- ══ 分页导航（智团团准备的 / 我的动画）+ 换年级：**两个页签都常驻** ═════════',
    replace:
      '    <div v-show="anim.activeTab === \'builtin\'"><!-- 变异：导航被关进 pane --><!-- ══ 分页导航（智团团准备的 / 我的动画）+ 换年级═════════',
    testFile: 'tests/animation-dead-end.test.ts',
    expect: '分页导航不在'
  },
  {
    name: '64 卡片舞台：下限缩回 300px（P2-3「肉眼 7–8px」的原始几何）',
    file: 'src/renderer/src/cards/AnimationCard.vue',
    find: '  --k12-anim-min: 480px;',
    replace: '  --k12-anim-min: 300px;',
    testFile: 'tests/animation-card-stage.test.ts',
    expect: 'G-P2-3a'
  }
]

let failures = 0
/**
 * ★ 可选筛选：`node scripts/verify-guard-mutations.mjs 62 63` 只跑编号匹配的那几条。
 *
 * 为什么需要它（实测）：整份清单跑一轮要在 Windows 上反复改写 60+ 个文件，
 * 偶发 `UNKNOWN: open …`（杀软/索引器持有句柄）会让脚本**在循环中途崩掉**，
 * 而那时正在变异的文件**留在变异状态**（本轮实测：三个文件被留成变异内容，
 * 其中 `decision-tree.json` 连备份都已经是变异后的值 —— 只能靠 git 恢复）。
 * 分片跑既避开这个坑，也让「只验本轮新增的那几条」变成一次调用。
 */
const only = process.argv.slice(2).filter((arg) => /^\d+$/.test(arg))
const selected =
  only.length === 0
    ? MUTATIONS
    : MUTATIONS.filter((mutation) => only.some((id) => mutation.name.startsWith(id)))
if (only.length > 0) {
  console.log(`（只跑匹配 ${only.join(' / ')} 的 ${selected.length} 条变异）`)
}

for (const mutation of selected) {
  const path = join(desktopRoot, mutation.file)
  const backupPath = `${path}.mutation-backup`
  let restored = false
  try {
    copyFileSync(path, backupPath)
    const original = readFileSync(path, 'utf8')
    const needle = mutation.find
    const haystack = original
    if (!haystack.includes(needle)) {
      console.log(`⚠️  ${mutation.name}\n    找不到锚点（${JSON.stringify(needle.slice(0, 60))}）—— 变异没生效，这条守卫**未被验证**`)
      failures += 1
      continue
    }
    const mutated = mutation.all
      ? haystack.split(needle).join(mutation.replace)
      : haystack.replace(needle, mutation.replace)
    writeFileSync(path, mutated, 'utf8')

    // 跑测试：期望它变红
    const { red } = runExpect(mutation)
    if (red) {
      console.log(`✅ ${mutation.name} → 守卫变红（${mutation.expect}）`)
    } else {
      console.log(`❌ ${mutation.name} → 守卫**仍然是绿的**！这条断言没有在守那件事`)
      failures += 1
    }
  } finally {
    // ★ 恢复用**内容回写**（而不是 copyFileSync）：Windows 上 copyFileSync 会因为
    //   目标文件句柄被占而偶发失败，而 readFileSync 已经拿到了原文，回写最稳。
    try {
      const original = readFileSync(backupPath, 'utf8')
      writeFileSync(path, original, 'utf8')
      unlinkSync(backupPath)
      restored = true
    } catch {
      // 恢复失败要在下面报出来（比静默留着变异更危险）
      try {
        copyFileSync(`${path}.mutation-backup`, path)
        unlinkSync(`${path}.mutation-backup`)
        restored = true
      } catch {
        // 两条路都失败才认输
      }
    }
    if (!restored) {
      console.log(`‼️  ${mutation.name}：原文件恢复失败，请手查 ${path}`)
      failures += 1
    }
  }
}

console.log(
  failures === 0
    ? `\n全部 ${selected.length} 条变异都被守卫抓到 ✅（并已逐条恢复原文件）`
    : `\n有 ${failures} 条变异**没被抓到**或未生效 —— 那些断言等于没有 ⚠️`
)
process.exit(failures === 0 ? 0 : 1)
