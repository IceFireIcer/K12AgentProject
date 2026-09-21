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
  }
]

let failures = 0
for (const mutation of MUTATIONS) {
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
    try {
      copyFileSync(`${path}.mutation-backup`, path)
      unlinkSync(`${path}.mutation-backup`)
      restored = true
    } catch {
      // 恢复失败要在下面报出来（比静默留着变异更危险）
    }
    if (!restored) {
      console.log(`‼️  ${mutation.name}：原文件恢复失败，请手查 ${path}`)
      failures += 1
    }
  }
}

console.log(
  failures === 0
    ? `\n全部 ${MUTATIONS.length} 条变异都被守卫抓到 ✅（并已逐条恢复原文件）`
    : `\n有 ${failures} 条变异**没被抓到**或未生效 —— 那些断言等于没有 ⚠️`
)
process.exit(failures === 0 ? 0 : 1)
