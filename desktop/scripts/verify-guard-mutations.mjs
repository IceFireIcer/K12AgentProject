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
const TEST = 'tests/student-view-discipline.test.ts'

/** 每条变异：改哪个文件、把什么改成什么、期望哪条用例变红。 */
const MUTATIONS = [
  {
    name: '① 术语扫描：把运维话塞回学生可见文案',
    file: 'src/renderer/src/components/ContextRail.vue',
    find: `        : \`团团这次只用了「\${label}」和更低学段的教材，不会超纲。\`,`,
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
    expect: '教材知识库是教师专属页'
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
    let output = ''
    let threw = false
    try {
      output = execFileSync('node', ['--test', '--test-name-pattern', mutation.expect, TEST], {
        cwd: desktopRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      threw = true
      output = String(error.stdout ?? '') + String(error.stderr ?? '')
    }
    const red = threw || /fail [1-9]/.test(output)
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
