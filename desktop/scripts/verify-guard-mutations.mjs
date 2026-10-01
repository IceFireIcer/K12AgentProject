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
    // ⚠️ 锚点跟着 2026-09-30 的左侧二级导航改造走：原来的 `UNNAMED_POINT` 常量
    //    随「显示名统一走 kpLabel()」一起删了 —— 这里改用**页面上真实可见的那句空态文案**，
    //    学生可见文本里出现 slug 形态的串时，扫描器必须报出来。
    find: '还没有可以闯的关卡，教材内容准备好之后这里会一关一关地排出来。',
    replace: '还没有可以闯的关卡（ai-definition-jr），教材内容准备好之后这里会一关一关地排出来。',
    expect: '不得出现原始 kp slug'
  },
  {
    name: '③ 默认视角：把默认改成教师视角',
    file: 'src/renderer/src/stores/viewMode.ts',
    // ⚠️ 锚点跟着 2026-09-26 的三档改造走（原来是 `? 'teacher'\n : 'student'` 两行写法）——
    //    锚点失配时脚本会**显式报出来**（找不到锚点 = 这条变异静默失效，等于没验）。
    find: "return raw === 'teacher' ? 'teacher' : raw === 'debug' ? 'debug' : 'student'",
    replace: "return raw === 'teacher' ? 'teacher' : raw === 'debug' ? 'debug' : 'teacher'",
    expect: '默认视角必须是学生'
  },
  {
    name: '④ 教师专属页：把 nav 改成恒可见（学生侧栏又冒出运维页）',
    file: 'src/renderer/src/stores/ui.ts',
    // ⚠️ 2026-09-30 起「参考资料库」是**学生可见**页（`nav: true`）—— 这条变异现在改的是
    //    仅剩的教师专属页「运行透视」，`expect` 也随之改为当下真实的用例名。
    //    旧名（「参考资料库是教师专属页」）已经**匹配不到任何用例** → 0 个用例 = 绿的，
    //    这条变异就静默失效了（本轮 guards:mutation 就是这么把它报出来的）。
    find: "    nav: 'teacher',",
    replace: '    nav: true,',
    expect: '上面那些判据必须'
  },
  {
    name: '⑤ CTA：把闯关页主提交键的类名换成本地皮肤',
    file: 'src/renderer/src/views/Quiz.vue',
    // ⚠️ 必须 `all: true`：2026-09-26 起闯关页有**两处** `.k12-cta`（单卡屏的「提交这题」
    // 与收尾卡的主行动，运行时互斥）。只替换第一处的话，另一处仍能满足「至少 2 处」，
    // 这条变异会**静默失效**（脚本会报「守卫仍然是绿的」）。
    find: 'class="k12-cta"',
    replace: 'class="qitem__btn"',
    all: true,
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
    find: "return item.result.correct ? '已完成' : '再试一次'",
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
    // ⚠️ 锚点含这一行的**完整属性**（2026-09-30 漂过一次：卡片玻璃光效给这行加了 `shine`）——
    //    再给它加属性时这里要同步，否则变异不生效、这条守卫就变成了没被验证的。
    find: '<SurfacePanel class="card" data-section="grade" data-testid="settings-grade-block" shine>',
    replace: '<SurfacePanel class="card" data-section="grade" data-testid="settings-grade-block" shine>\n        <!-- 变异：假装这里多了一句给学生看的运维说明 -->\n        <p>端口号 8756，向量维度 512</p>',
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
    // ★ 锚点跟随 electron.vite.config.ts 的多行排版（2026-09-28 重校）：
    //   原先写死单行 'build: { emptyOutDir: true },'，配置一旦排版就再也匹配不上。
    find: '    build: {\n      emptyOutDir: true,',
    replace: '    build: {',
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
    // 锚点同 ②：跟着 2026-09-30 的二级导航改造，换成页面上真实可见的那句空态文案。
    find: '还没有可以闯的关卡，教材内容准备好之后这里会一关一关地排出来。',
    replace: '**还没有**可以闯的关卡，教材内容准备好之后这里会一关一关地排出来。',
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
    // ⚠️ 与 ⑬ 同一个锚点（同一行），改一处要两处一起改。
    find: '<SurfacePanel class="card" data-section="grade" data-testid="settings-grade-block" shine>',
    replace:
      '<SurfacePanel class="card" data-section="grade" data-testid="settings-grade-block" shine>\n        <!-- 变异：学生那一节多了一句带破折号的说明 -->\n        <p>学段与章节随时可以换 —— 之前学过的记录都还在</p>',
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
  },
  {
    name: '65 运行透视：把页面放回学生侧栏（nav 改成恒可见）',
    file: 'src/renderer/src/stores/ui.ts',
    // ⚠️ 锚点必须**唯一**：2026-09-27 这一页从 `'debug'` 换到 `'teacher'` 之后，
    //    单拎 `    nav: 'teacher',` 会先命中 knowledge 那一项（变异 ④ 守的就是它），
    //    于是这条变异改错页面、静默失效（脚本会报「守卫仍然是绿的」）。
    //    带上紧随其后的 `icon` 行，锚点才落在 demo 这一项上。
    find: "    nav: 'teacher',\n    icon: 'Radar'",
    replace: '    nav: true,',
    testFile: 'tests/demo-mode.test.ts',
    expect: '演示证据模块'
  },
  {
    name: '66 演示信封：落盘时把学生正文原样写出去',
    file: 'src/main/agent/diagnostics.ts',
    find: "    input: { text: '', safetyInput: { ...turn.input.safetyInput } },",
    replace: '    input: { text: turn.input.text, safetyInput: { ...turn.input.safetyInput } },',
    testFile: 'tests/demo-mode.test.ts',
    expect: '落盘前剥离'
  },
  {
    name: '67 档位表：把最高档从顺序表里删掉（教师档与演示档的包含关系塌掉）',
    file: 'src/renderer/src/stores/ui.ts',
    find: "export const VIEW_MODE_ORDER: readonly ViewMode[] = ['student', 'teacher', 'debug']",
    replace: "export const VIEW_MODE_ORDER: readonly ViewMode[] = ['student', 'teacher', 'teacher']",
    testFile: 'tests/demo-mode.test.ts',
    expect: '档位高低表'
  },
  {
    name: '68 闯关排版：把默认从「一次一张」改回「全部铺开」',
    file: 'src/renderer/src/stores/quizLayout.ts',
    // ⚠️ 锚点单行（工作区 CRLF）。这条去掉的就是用户这次要的默认节奏：
    //   默认铺开 = 这次改动对「打开就看」的学生完全没生效。
    find: "export const QUIZ_LAYOUT_DEFAULT: QuizLayout = 'single'",
    replace: "export const QUIZ_LAYOUT_DEFAULT: QuizLayout = 'list'",
    testFile: 'tests/quiz-layout-mode.test.ts',
    expect: '默认排版是「一次一张」'
  },
  {
    name: '69 教材引用：把折叠块改成默认展开（那一堆引用又铺满屏幕）',
    file: 'src/renderer/src/components/ChatMessage.vue',
    // ★ 锚点跟随 ChatMessage.vue 的多行排版（2026-09-28 重校）：
    //   原先写死单行，而 <details> 的属性早已各占一行 —— 锚点从写下那天起就没匹配过。
    find: '<details\n            v-if="turn.citations.length > 0"\n            class="cites"',
    replace: '<details\n            open\n            v-if="turn.citations.length > 0"\n            class="cites"',
    testFile: 'tests/citation-collapse.test.ts',
    expect: '教材引用默认收起'
  },
  /* ------------------------------------------------------------------ *
   * 设计 token 守卫（优化报告 §1.1 字体系统 / §1.2 间距网格）
   * —— 守卫在 `tests/design-tokens.test.ts` 与 `tests/spacing-grid.test.ts`
   * ------------------------------------------------------------------ */
  {
    name: '70 字号层次：把身份行从 h1(32) 改回 h2(24)',
    file: 'src/renderer/src/assets/base.css',
    // ⚠️ 锚点单行（工作区 CRLF）。
    find: '  font-size: var(--k12-fs-h1);\n  font-weight: 650;',
    replace: '  font-size: var(--k12-fs-h2);\n  font-weight: 650;',
    testFile: 'tests/design-tokens.test.ts',
    expect: '四处层次落点'
  },
  {
    name: '71 字号层次：把卡头从 h3(20) 改回 body-lg(18)',
    file: 'src/renderer/src/assets/base.css',
    find: '  font-size: var(--k12-fs-h3);\n}\n.k12-card-body {',
    replace: '  font-size: var(--k12-fs-body-lg);\n}\n.k12-card-body {',
    testFile: 'tests/design-tokens.test.ts',
    expect: '四处层次落点'
  },
  {
    name: '72 顶栏层级：把页面名颜色从 fg-2 改回 fg（chrome 抢焦点）',
    file: 'src/renderer/src/components/AppTopbar.vue',
    find: '  color: var(--k12-fg-2);\n  /* 窄窗口下**截断标题**',
    replace: '  color: var(--k12-fg);\n  /* 窄窗口下**截断标题**',
    testFile: 'tests/design-tokens.test.ts',
    expect: '四处层次落点'
  },
  {
    name: '73 顶栏分隔：把底边从 border-strong 改回 border',
    file: 'src/renderer/src/components/AppTopbar.vue',
    find: '  border-bottom: 1px solid var(--k12-border-strong);',
    replace: '  border-bottom: 1px solid var(--k12-border);',
    testFile: 'tests/design-tokens.test.ts',
    expect: '四处层次落点'
  },
  {
    name: '74 字号别名：把 --k12-fs-micro 从别名改成写死的 12px',
    file: 'src/renderer/src/assets/base.css',
    find: '  --k12-fs-micro: var(--k12-fs-label);',
    replace: '  --k12-fs-micro: 12px;',
    testFile: 'tests/design-tokens.test.ts',
    expect: '旧字号名只许作为别名保留'
  },
  {
    name: '75 间距网格：把 sp-5 改回 20px（8 点网格破裂）',
    file: 'src/renderer/src/assets/base.css',
    find: '  --k12-sp-5: 24px;',
    replace: '  --k12-sp-5: 20px;',
    testFile: 'tests/spacing-grid.test.ts',
    expect: '间距阶梯严格是'
  },
  {
    name: '76 语义间距：把消息间距改回 36px',
    file: 'src/renderer/src/assets/base.css',
    find: '  --k12-gap-msg: 32px;',
    replace: '  --k12-gap-msg: 36px;',
    testFile: 'tests/spacing-grid.test.ts',
    expect: '语义间距只有四档'
  },
  {
    name: '77 圆角：把控件圆角改回 14px（与卡片同值的旧形态）',
    file: 'src/renderer/src/assets/base.css',
    find: '  --k12-r-control: var(--k12-r-md);',
    replace: '  --k12-r-control: 14px;',
    testFile: 'tests/radius-tokens.test.ts',
    expect: '圆角五档梯度与语义映射'
  },
  {
    name: '78 EP 主题：把 info 改回 Element 默认灰（不再是 k12 青）',
    file: 'src/renderer/src/assets/base.css',
    find: '  --el-color-info: var(--k12-cyan);',
    replace: '  --el-color-info: #909399;',
    testFile: 'tests/ep-theme.test.ts',
    expect: 'EP 语义色与边框'
  },
  {
    name: '79 断点：把最小宽度改回 1120px（1024 档被排除）',
    file: 'src/renderer/src/assets/base.css',
    find: '  min-width: 1024px;',
    replace: '  min-width: 1120px;',
    testFile: 'tests/breakpoints.test.ts',
    expect: '最小宽度降到 1024px'
  },
  {
    name: '80 断点：把聊天气泡网格的 3 列档改回 2 列',
    file: 'src/renderer/src/views/Chat.vue',
    find: '  .chat__entries {\n    grid-template-columns: repeat(3, minmax(0, 1fr));',
    replace: '  .chat__entries {\n    grid-template-columns: repeat(2, minmax(0, 1fr));',
    testFile: 'tests/breakpoints.test.ts',
    expect: '聊天气泡网格'
  },
  {
    name: '81 交互态：把 hover 改回与默认同色（88% → 100%，按下没有反馈）',
    file: 'src/renderer/src/assets/base.css',
    find: '  --k12-accent-hover: color-mix(in srgb, var(--k12-accent-ink) 88%, var(--k12-fg));',
    replace: '  --k12-accent-hover: color-mix(in srgb, var(--k12-accent-ink) 100%, var(--k12-fg));',
    testFile: 'tests/interaction-states.test.ts',
    expect: '交互态派生规则'
  },
  {
    name: '82 骨架屏：会话列表的加载分支退回一句纯文字（组件变死代码）',
    file: 'src/renderer/src/components/SessionList.vue',
    find: '      <Skeleton :rows="4" variant="row" />\n      <p class="sl__loading-text">正在读取…</p>',
    replace: '      <p class="sl__loading-text">正在读取…</p>',
    testFile: 'tests/skeleton.test.ts',
    expect: '至少一处长列表真的用了骨架屏'
  },
  {
    name: '83 卡片结构：卡头不再走 base.css 的类名（自己另起一套皮肤）',
    file: 'src/renderer/src/components/card/CardHeader.vue',
    find: '<header class="k12-card-head" data-testid="card-header">',
    replace: '<header class="my-card-head" data-testid="card-header">',
    testFile: 'tests/card-structure.test.ts',
    expect: '三个卡片子组件存在'
  },
  {
    name: '84 练习卡：题体退回「全铺开」（一次渲染全部题）',
    file: 'src/renderer/src/cards/QuizCard.vue',
    find: 'v-for="row in visibleRows"',
    replace: 'v-for="row in items"',
    testFile: 'tests/card-single-question.test.ts',
    expect: '题体唯一渲染源是 visibleRows'
  },
  {
    // ★ 2026-09-30（D-123）：进度卡**整个搬出对话**之后，这条变异也跟着换了方向 ——
    //   旧写法是「把独立渲染关掉」（锚点 hasLevels，已不存在），
    //   新写法是「再往卡片组里塞一张进度卡」：守卫现在钉的是**不得出现** ProgressCard。
    name: '85 进度卡：把进度卡塞回对话（D-123 之后的禁止项）',
    file: 'src/renderer/src/components/ChatMessage.vue',
    find: '<InlineCard v-for="card in turn.cards" :key="card.id" :card="card" />',
    replace:
      '<InlineCard v-for="card in turn.cards" :key="card.id" :card="card" /><ProgressCard :payload="card.payload" />',
    testFile: 'tests/card-single-question.test.ts',
    expect: '进度卡'
  },
  {
    name: '86 练习卡：把「下一题」的可用条件摘掉（没答对也能往下走）',
    file: 'src/renderer/src/cards/QuizCard.vue',
    find: ':disabled="!currentSettled"',
    replace: ':disabled="false"',
    testFile: 'tests/card-single-question.test.ts',
    expect: '「下一题」只在'
  },
  {
    name: '87 卡片结构：练习卡退回自写皮肤（不给 k12-card，走回旧的自带圆角/白面）',
    file: 'src/renderer/src/cards/QuizCard.vue',
    find: 'class="k12-card quiz"',
    replace: 'class="quiz"',
    testFile: 'tests/card-structure.test.ts',
    expect: '四张卡片迁移到三段结构'
  },
  {
    name: '88 Monaco：把语言注册退回全量清单（~90 种语言全部拉进产物）',
    file: 'src/renderer/src/sandbox/monaco-setup.ts',
    find: "await import('monaco-editor/languages/definitions/python/register')",
    replace: "await import('monaco-editor/basic-languages/monaco.contribution')",
    testFile: 'tests/monaco-bundle.test.ts',
    expect: '只注册 Python 语言'
  },
  {
    name: '89 Monaco：把渲染构建的压缩关掉（chunk 立刻涨回 4.87MB）',
    file: 'electron.vite.config.ts',
    find: "minify: 'esbuild'",
    replace: 'minify: false',
    testFile: 'tests/monaco-bundle.test.ts',
    expect: '渲染构建必须开着压缩'
  },
  {
    name: '90 Monaco：把默认主题改回浅色 vs（报告 §5.1 的主题精简失效）',
    file: 'src/renderer/src/sandbox/monaco-setup.ts',
    find: "export const DEFAULT_EDITOR_THEME: CodeEditorTheme = 'vs-dark'",
    replace: "export const DEFAULT_EDITOR_THEME: CodeEditorTheme = 'vs'",
    testFile: 'tests/monaco-bundle.test.ts',
    expect: '主题精简为 vs-dark'
  },
  {
    name: '91 减少动效：把「关闭」档写成跟随系统（第三档变成假选项）',
    file: 'src/renderer/src/stores/reducedMotion.ts',
    find: "  if (value === 'off') return false",
    replace: "  if (value === 'off') return matchesSystem",
    testFile: 'tests/reduced-motion-mode.test.ts',
    expect: '三档语义'
  },
  {
    name: '92 减少动效：媒体块去掉 `:not(off)`（「关闭」档覆盖不了系统偏好）',
    file: 'src/renderer/src/assets/base.css',
    find: "  :root:not([data-k12-reduced-motion='off']) *,\n  :root:not([data-k12-reduced-motion='off']) *::before,\n  :root:not([data-k12-reduced-motion='off']) *::after {",
    replace: '  *,\n  *::before,\n  *::after {',
    testFile: 'tests/reduced-motion-mode.test.ts',
    expect: 'CSS 两块减动效规则'
  },
  {
    name: '93 减少动效：composable 退回裸系统偏好（三档开关对 JS 侧失效）',
    file: 'src/renderer/src/composables/useReducedMotion.ts',
    find: '  return computed(() => reducedMotionEffective.value)',
    replace: '  return computed(() => false)',
    testFile: 'tests/reduced-motion-mode.test.ts',
    expect: 'useReducedMotion 返回有效值'
  },
  {
    name: '94 组件 API：SurfacePanel.padding 退回任意字符串（枚举约束失效）',
    file: 'src/renderer/src/components/SurfacePanel.vue',
    find: '    padding?: SurfacePadding',
    replace: '    padding?: string',
    testFile: 'tests/component-api.test.ts',
    expect: 'defineProps 一律类型化'
  },
  {
    name: '95 组件 API：BadgeLevel 退回宽 string（枚举词表失效）',
    file: 'src/renderer/src/components/badge-level.ts',
    find: "export type BadgeLevel = 'starter' | 'beginner' | 'skilled' | 'expert' | 'master'",
    replace: 'export type BadgeLevel = string',
    testFile: 'tests/component-api.test.ts',
    expect: '词表'
  },
  {
    name: '96 组件 API：布尔属性改回匈牙利命名（isCompact）',
    file: 'src/renderer/src/components/Badge.vue',
    find: '  compact?: boolean',
    replace: '  isCompact?: boolean',
    testFile: 'tests/component-api.test.ts',
    expect: '布尔属性一律正向命名'
  },
  {
    name: '97 图谱：视口裁剪的余量改成 0（报告要求的 ±100px 消失）',
    file: 'src/renderer/src/study/map/culling.ts',
    find: 'export const CULL_MARGIN_PX = 100',
    replace: 'export const CULL_MARGIN_PX = 0',
    testFile: 'tests/map-performance.test.ts',
    expect: '视口裁剪'
  },
  {
    name: '98 图谱：Canvas 阈值提到 1000（500 节点场景不再切 Canvas）',
    file: 'src/renderer/src/study/map/lod.ts',
    find: 'export const CANVAS_NODE_THRESHOLD = 100',
    replace: 'export const CANVAS_NODE_THRESHOLD = 1000',
    testFile: 'tests/map-performance.test.ts',
    expect: 'Canvas 阈值'
  },
  {
    name: '99 长列表：虚拟化阈值提到 99 万（等于永远不虚拟化）',
    file: 'src/renderer/src/components/VirtualList.vue',
    find: 'virtualizeAt: 60',
    replace: 'virtualizeAt: 999999',
    testFile: 'tests/map-performance.test.ts',
    expect: '长列表虚拟化'
  },
  {
    name: '100 图谱：SVG 的边退回全量渲染（视口裁剪只裁了节点）',
    file: 'src/renderer/src/study/map/GraphMap.vue',
    find: 'v-for="edge in visibleEdges"',
    replace: 'v-for="edge in layout.edges"',
    testFile: 'tests/map-performance.test.ts',
    expect: '渲染层'
  },
  {
    name: '101 探针：题卡摘掉 data-probe-id（结构化锚点腐烂）',
    file: 'src/renderer/src/cards/QuizCard.vue',
    find: '    data-probe-id="quiz-card"\n',
    replace: '',
    testFile: 'tests/probe-structure.test.ts',
    expect: '锚点的选择器必须真的存在于渲染层'
  },
  {
    name: '102 探针：ux-pages-audit 不再跑锚点自检（失配变成静默）',
    file: 'scripts/ux-pages-audit.mjs',
    find: 'const anchors = await cdp.evaluate(VERIFY_ANCHORS_SCRIPT)',
    replace: 'const anchors = { checked: 0, total: 0, missing: [], mismatched: [] }',
    testFile: 'tests/probe-structure.test.ts',
    expect: '隔离与截图'
  },
  {
    name: '103 探针：隔离脚本改成 clear()（会顺手删掉学生的偏好）',
    file: 'scripts/probe-lib.mjs',
    find: '        localStorage.removeItem(key)',
    replace: '        localStorage.clear()',
    testFile: 'tests/probe-structure.test.ts',
    expect: '隔离与截图'
  },
  {
    name: '104 工作流：把 desktop/package.json 放回 nightly 的 push 白名单（脚本改动会白跑一轮打包）',
    file: '../.github/workflows/nightly.yml',
    find: "      - 'desktop/scripts/build-version.mjs'",
    replace: "      - 'desktop/package.json'\n      - 'desktop/scripts/build-version.mjs'",
    testFile: 'tests/installer-config.test.ts',
    expect: '打包相关改动 push 即构建'
  },
  {
    // ★ 2026-09-27 真机事故的原形态：把尺寸 class 挂回异步组件（编辑器塌成 5px）
    name: '105 编辑器：把尺寸 class 挂回异步组件（父级 scoped 规则会被 chunk CSS 覆盖）',
    file: 'src/renderer/src/views/Coding.vue',
    find: '                data-testid="coding-view-editor"',
    replace: '                class="code__editor"\n                data-testid="coding-view-editor"',
    testFile: 'tests/code-editor-mount.test.ts',
    expect: '不挂在异步组件上'
  },
  {
    name: '106 编辑器：对话内编程卡把尺寸 class 挂回异步组件',
    file: 'src/renderer/src/cards/CodingCard.vue',
    find: '            data-testid="coding-editor"',
    replace: '            class="coding__editor"\n            data-testid="coding-editor"',
    testFile: 'tests/code-editor-mount.test.ts',
    expect: '不挂在异步组件上'
  },
  /* ------------------------------------------------------------------ *
   * 视觉边界守卫（2026-09-27，D-105）
   * —— 守卫在 `tests/visual-edges.test.ts`；口径见 check-contrast.mjs 顶部注释。
   * ⚠️ 锚点全部单行（工作区 CRLF）。
   * ------------------------------------------------------------------ */
  {
    // 本次事故的原形态：1.21:1 的"看不见的线"。
    // ⚠️ 变异打在**生成物**上：守卫读的是生效值（tokens.generated.css），
    //    改源 JSON 而没重新生成时界面也不会变 —— 那样变异等于没生效。
    //    源 → 生成物 的一致性由 CI 的 `gen:tokens + git diff --exit-code` 管。
    name: '107 边界：把卡片发丝线改回旧值 #E6EAF2（1.21:1，读不出边界）',
    file: 'src/renderer/src/assets/tokens.generated.css',
    find: '  --k12-border: #D1D5DB;',
    replace: '  --k12-border: #E6EAF2;',
    testFile: 'tests/visual-edges.test.ts',
    expect: '边框两支'
  },
  {
    name: '108 边界：把结构强线改回旧值 #D9DFEC（1.34:1，结构分面又糊在一起）',
    file: 'src/renderer/src/assets/tokens.generated.css',
    find: '  --k12-border-strong: #9CA3AF;',
    replace: '  --k12-border-strong: #D9DFEC;',
    testFile: 'tests/visual-edges.test.ts',
    expect: '边框两支'
  },
  {
    // 最隐蔽的一条：default 档（开机默认）回到纯白 —— 白纸压在白桌面上
    name: '109 层次：把 default 档桌面改回纯白（白底白线的原形态）',
    file: 'src/renderer/src/assets/tokens.generated.css',
    find: '  --k12-page: #EEF2FC;',
    replace: '  --k12-page: #FFFFFF;',
    testFile: 'tests/visual-edges.test.ts',
    expect: '18 组配色'
  },
  {
    name: '110 用法：侧栏去掉右缘强线（回到"飘在空中"）',
    file: 'src/renderer/src/components/AppSidebar.vue',
    find: '  border-right: 1px solid var(--k12-border-strong);',
    replace: '  border-right: none;',
    testFile: 'tests/visual-edges.test.ts',
    expect: '结构分面'
  },
  {
    name: '111 用法：右栏左线降档为发丝线（与内容区又分不开）',
    file: 'src/renderer/src/components/ContextRail.vue',
    find: '  border-left: 1px solid var(--k12-border-strong);',
    replace: '  border-left: 1px solid var(--k12-border);',
    testFile: 'tests/visual-edges.test.ts',
    expect: '结构分面'
  },
  {
    name: '112 用法：嵌入块去掉细线（page 也带色后，浅底压浅底分不开）',
    file: 'src/renderer/src/assets/base.css',
    find: '  border: 1px solid color-mix(in srgb, var(--k12-border) 70%, transparent);',
    replace: '  border: none;',
    testFile: 'tests/visual-edges.test.ts',
    expect: '嵌入块皮肤'
  },
  /* ------------------------------------------------------------------ *
   * 悬浮追问窗（2026-09-27 走查抓到的三个真缺陷）
   * —— 守卫在 `tests/float-panel.test.ts`
   * ------------------------------------------------------------------ */
  {
    // 真机上表现为「X 点不动、最小化没反应」：指针捕获把 click 重定向到标题栏
    name: '113 追问窗：标题栏拖动不再放过可交互子元素（X / 折叠键被指针捕获吃掉）',
    file: 'src/renderer/src/components/FloatPanel.vue',
    find: '  if (isInteractive(e.target)) return',
    replace: '  if (false) return',
    testFile: 'tests/float-panel.test.ts',
    expect: '标题栏拖动必须放过可交互子元素'
  },
  {
    // 真机上表现为「问几句就把窗顶破」：高度由内容决定
    name: '114 追问窗：把显式高度摘掉（窗高重新由内容决定，几轮追问就长到出屏）',
    file: 'src/renderer/src/components/FloatPanel.vue',
    find: '  ...(floatPanel.collapsed ? {} : { height: `${floatPanel.size.h}px` }),',
    replace: '  ...(floatPanel.collapsed ? {} : {}),',
    testFile: 'tests/float-panel.test.ts',
    expect: '窗高必须与内容脱钩'
  },
  {
    name: '115 追问窗：面积上限放到 400%（拖一下就把窗拉到铺满）',
    file: 'src/renderer/src/stores/floatPanel.ts',
    find: 'const MAX_AREA_RATIO = 0.45',
    replace: 'const MAX_AREA_RATIO = 4',
    testFile: 'tests/float-panel.test.ts',
    // ⚠️ `expect` 匹配的是**测试名**（runner 用 --test-name-pattern），
    //    不是断言消息 —— 填成断言消息会 0 个测试跑到底、永远是绿的（这条踩过）。
    expect: '缩放面积按主窗口取比例'
  },
  {
    name: '116 追问窗：入口改回只开不关（按钮看起来是开关，点第二次没有反应）',
    file: 'src/renderer/src/views/Animation.vue',
    find: '  floatPanel.toggleFrom(event.currentTarget as Element | null, {',
    replace: '  floatPanel.openFrom(event.currentTarget as Element | null, {',
    testFile: 'tests/float-panel.test.ts',
    expect: '入口按钮是'
  },
  {
    name: '117 追问窗：位置夹紧退回 `if (pos.value)`（没拖过的窗一拉大就出围栏）',
    file: 'src/renderer/src/stores/floatPanel.ts',
    find: '    const base = pos.value ?? defaultPos()',
    replace: '    const base = pos.value ?? { x: 0, y: 0 }',
    testFile: 'tests/float-panel.test.ts',
    expect: '窗高必须与内容脱钩'
  },
  {
    // 用户裁决：这只窗不许跟着学生跑到对话页
    name: '118 追问窗：离开「动手试试」三页不关窗（切到对话页它还盖在上面）',
    file: 'src/renderer/src/stores/floatPanel.ts',
    find: '    if (!(FLOAT_PANEL_PAGES as readonly string[]).includes(page)) close()',
    replace: '    if (page.length > 0) void page',
    testFile: 'tests/float-panel.test.ts',
    expect: '只在「动手试试」三页存在'
  },
  {
    // 围栏退化成整个视口（窗就能被拖到顶栏的窗口按钮上）
    name: '119 追问窗：围栏退化成整个视口（能拖到顶栏上挡住窗口按钮）',
    file: 'src/renderer/src/stores/floatPanel.ts',
    find: "    const el = document.querySelector('.shell__content')",
    replace: "    const el = document.querySelector('.shell__main')",
    testFile: 'tests/float-panel.test.ts',
    expect: '围栏 = 内容区'
  },
  {
    // 覆盖层在**未激活时**也作答 —— 普通态下它会开始篡改真实数据，
    // 而「未激活 = 严格 no-op」正是这一层唯一的安全性判据。
    name: '120 演示沙箱：覆盖层在未激活时也返回预置载荷',
    file: 'src/main/demo/overlay.ts',
    find: '  if (!isDemoSeeded()) return null',
    replace: '  if (false && !isDemoSeeded()) return null',
    testFile: 'tests/demo-seed.test.ts',
    expect: '覆盖层未激活时严格 no-op'
  },
  {
    // 往脚本正文里塞一句带禁词的话 —— 学生会当场读到「（演示）」。
    name: '121 演示沙箱：脚本正文里出现「演示」字样',
    file: 'src/main/demo/script.ts',
    find: '    studentText: \'老师，列表里的数是怎么排好顺序的？\',',
    replace: '    studentText: \'老师，列表里的数是怎么排好顺序的？（演示）\',',
    testFile: 'tests/demo-seed.test.ts',
    expect: '预置文本不含技术词'
  },
  {
    // 沙箱分支挪到 ensureChatRuntime() 之后 —— 进沙箱会真的拉起 Pi 会话、
    // 往会话 JSONL 里写开场白，「一个字节都不落盘」当场作废。
    name: '122 演示沙箱：学段的沙箱分支挪到 ensureChatRuntime() 之后',
    file: 'src/main/ipc/handlers.ts',
    find: [
      '    if (isDemoSeeded()) {',
      '      return {',
      '        ok: true,',
      '        data: {',
      '          gradeLevel: DEMO_GRADE_LEVEL,',
      "          origin: 'llm',",
      "          source: 'inferred',",
      "          decidedBy: 'llm'",
      '        }',
      '      }',
      '    }',
      '    let instance: ChatRuntime',
      '    try {',
      '      instance = await ensureChatRuntime()'
    ].join('\n'),
    replace: [
      '    let instance: ChatRuntime',
      '    try {',
      '      instance = await ensureChatRuntime()',
      '    } catch (error) {',
      '      return { ok: false, message: `读学段失败：对话运行时尚未就绪（${describeRuntimeFailure(error)}）` }',
      '    }',
      '    if (isDemoSeeded()) {',
      '      return {',
      '        ok: true,',
      '        data: {',
      '          gradeLevel: DEMO_GRADE_LEVEL,',
      "          origin: 'llm',",
      "          source: 'inferred',",
      "          decidedBy: 'llm'",
      '        }',
      '      }',
      '    }'
    ].join('\n'),
    testFile: 'tests/demo-seed.test.ts',
    expect: '沙箱分支都早于 ensureChatRuntime'
  },

  /* ------------------------------------------------------------------ *
   * 正式发版（2026-09-27 / D-062）—— 守卫在 tests/installer-config.test.ts 的 G21-9
   * 这两条守的都是「**包发出去之后**才发现错了」的事：
   * 包内版本与标签对不上、以及正式版退化成 prerelease（不抢 Latest → 等于没发）。
   * ------------------------------------------------------------------ */
  {
    // 忘了把版本号传下去 → 打出来还是 CI 派生的 `<主>.<次>.<run>`，而标签是 `v1.0.0`：
    // 包内版本、安装包文件名、控制面板里显示的版本三处与标签**全不一致**。
    name: '123 正式发版：不把 inputs.version 传给 K12_VERSION',
    testFile: 'tests/installer-config.test.ts',
    file: '../.github/workflows/release.yml',
    find: '      K12_VERSION: ${{ inputs.version }}',
    replace: '      K12_VERSION: ""',
    expect: 'G21-9'
  },
  {
    // 正式版发成 prerelease：不抢 Latest，下载页仍把 nightly 当正式版 —— 等于没发。
    name: '124 正式发版：把 --latest 换成 --prerelease',
    testFile: 'tests/installer-config.test.ts',
    file: '../.github/workflows/release.yml',
    find: '              --latest \\',
    replace: '              --prerelease \\',
    expect: 'G21-9'
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
