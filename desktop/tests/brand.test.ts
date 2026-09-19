/**
 * 品牌与存储目录的守卫（票 07 品牌化）。
 *
 * 这一组断言守护两件容易「看起来改对了、其实埋了雷」的事：
 *
 *   G19-1  **品牌名单点定义**：显示名只在 `src/shared/brand.ts` 里写一次，
 *          主进程与渲染进程都从那里取，不各写一份字面量（两份必然漂移）。
 *   G19-2  **存储目录与品牌名解耦**：`userData` 的目录名必须钉在固定 slug 上。
 *          这条是硬约束 —— Electron 默认用 `productName` 当目录名，
 *          品牌名一改，学生的 config.json / learning.db / Pi 会话 JSONL
 *          就整体留在旧目录里「凭空消失」，而应用看起来像新装的一样。
 *
 * 跑法：`npm test`。
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { BRAND_NAME, BRAND_TAGLINE } from '../src/shared/brand.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function read(...segments: string[]): string {
  return readFileSync(join(desktopRoot, ...segments), 'utf8')
}

/** 去掉注释，避免「注释里举了反例」把守卫自己绊倒（照抄 architecture-guards 的做法）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/* ------------------------------------------------------------------ *
 * G19-1 品牌名单点定义
 * ------------------------------------------------------------------ */

test('G19-1a 品牌名非空且是中文', () => {
  assert.equal(BRAND_NAME, '智团团')
  assert.ok(/\S/.test(BRAND_TAGLINE), '定位语不能为空')
})

test('G19-1b 主进程与渲染进程都不再写死旧显示名', () => {
  const stale = ['K12 AI 教学助手', 'K12AI教学助手', 'K12 教学助手']
  for (const file of [
    ['src', 'main', 'index.ts'],
    ['src', 'renderer', 'src', 'App.vue'],
    ['src', 'shared', 'ipc-events.ts']
  ]) {
    const source = stripComments(read(...file))
    for (const name of stale) {
      assert.ok(
        !source.includes(name),
        `${file.join('/')} 里仍有写死的旧显示名「${name}」——显示名应从 @shared/brand 取`
      )
    }
  }
})

test('G19-1c 主进程窗口标题取自 brand.ts，而不是字面量', () => {
  const source = stripComments(read('src', 'main', 'index.ts'))
  assert.ok(source.includes("from '@shared/brand'"), '主进程必须从 @shared/brand 引入品牌名')
  assert.ok(/title:\s*BRAND_NAME/.test(source), '窗口标题必须是 BRAND_NAME')
})

test('G19-1d 渲染进程品牌区取自 brand.ts', () => {
  const source = stripComments(read('src', 'renderer', 'src', 'App.vue'))
  assert.ok(source.includes('BRAND_NAME'), '顶栏品牌名必须来自 brand.ts')
  assert.ok(source.includes('BRAND_TAGLINE'), '定位语必须来自 brand.ts')
})

test('G19-1e ★ 两处「无法 import」的静态配置必须与 brand.ts 同步（防改一半）', () => {
  // 这两处是纯静态文件（HTML / YAML），拿不到 TS 常量，只能手工同步 —— 所以要有守卫盯着。
  const html = read('src', 'renderer', 'index.html')
  const titleMatch = /<title>([^<]*)<\/title>/.exec(html)
  assert.ok(titleMatch, 'index.html 必须有 <title>')
  assert.equal(
    titleMatch[1].trim(),
    BRAND_NAME,
    `index.html 的 <title>（${titleMatch[1].trim()}）与 brand.ts 的 BRAND_NAME（${BRAND_NAME}）不一致`
  )

  const builder = read('electron-builder.yml')
  const productMatch = /^productName:\s*(.+)$/m.exec(builder)
  assert.ok(productMatch, 'electron-builder.yml 必须有 productName')
  assert.equal(
    productMatch[1].trim(),
    BRAND_NAME,
    `electron-builder.yml 的 productName（${productMatch[1].trim()}）与 BRAND_NAME（${BRAND_NAME}）不一致`
  )
})

/* ------------------------------------------------------------------ *
 * G19-2 存储目录与品牌名解耦（合规硬约束）
 * ------------------------------------------------------------------ */

test('G19-2a ★ userData 目录名被显式钉死，不随品牌名走', () => {
  const source = stripComments(read('src', 'main', 'index.ts'))
  assert.ok(
    /STABLE_USER_DATA_SLUG\s*=\s*'[a-z0-9-]+'/.test(source),
    '必须有一个固定的 userData slug 常量（小写 ASCII，不用中文品牌名）'
  )
  assert.ok(
    source.includes("app.setPath('userData'"),
    '必须显式 setPath userData —— 否则品牌名一改就换目录'
  )
  assert.ok(
    source.includes('applyStableUserDataSlug()'),
    '固定 slug 的函数必须真的被调用（只定义不调用等于没做）'
  )
})

test('G19-2b userData slug 不得是品牌名（中文或与 BRAND_NAME 相同）', () => {
  const source = read('src', 'main', 'index.ts')
  const match = /STABLE_USER_DATA_SLUG\s*=\s*'([^']+)'/.exec(source)
  assert.ok(match, '找不到 STABLE_USER_DATA_SLUG 的字面量')
  const slug = match[1]
  assert.notEqual(slug, BRAND_NAME, 'slug 不能等于品牌显示名（改名即搬家）')
  assert.ok(
    /^[A-Za-z0-9._-]+$/.test(slug),
    `slug 只允许 ASCII 安全字符（跨平台目录名），实际为「${slug}」`
  )
})

test('G19-2c 便携模式仍然把 userData 指到 exe 同级 data/（两套改道不互相覆盖）', () => {
  const source = stripComments(read('src', 'main', 'index.ts'))
  assert.ok(source.includes('portableDataDirApplied'), '必须用便携模式的结果判断要不要再钉 slug')
  assert.ok(
    /if\s*\(portableDataDirApplied\)\s*return/.test(source),
    '便携模式已显式改道时必须早退，不能把 data/ 覆盖回 %APPDATA%'
  )
})

/* ------------------------------------------------------------------ *
 * G19-3 品牌素材（图标与学段 logo）
 * ------------------------------------------------------------------ */

test('G19-3a 打包图标存在且是多尺寸 .ico', () => {
  const ico = readFileSync(join(desktopRoot, 'build', 'icon.ico'))
  // ICO 头：reserved(2)=0, type(2)=1, count(2)=N
  assert.equal(ico.readUInt16LE(0), 0, 'ICO reserved 字段应为 0')
  assert.equal(ico.readUInt16LE(2), 1, '应为 ICO 格式（type=1）')
  const count = ico.readUInt16LE(4)
  assert.ok(count >= 5, `ICO 应含多个尺寸档，实际 ${count} 个`)
})

test('G19-3b 四学段各有一张运行时 logo，且主 logo 在位', () => {
  const brandDir = join(desktopRoot, 'resources', 'brand')
  for (const name of ['main', 'primary_low', 'primary_high', 'junior', 'senior']) {
    const bytes = readFileSync(join(brandDir, `${name}.png`))
    // PNG 魔数，防「文件名对但内容是空/坏文件」
    assert.equal(
      bytes.subarray(0, 8).toString('hex'),
      '89504e470d0a1a0a',
      `${name}.png 不是合法 PNG`
    )
    assert.ok(bytes.length > 1024, `${name}.png 体积异常小（${bytes.length} B），可能是空图`)
  }
})

test('G19-3c 学段素材文件名与四学段枚举一致（防改名不同步）', () => {
  // 这四个字面量就是契约里的四学段；改枚举必须同步素材名，否则界面切换会加载不到图
  const grades = ['primary_low', 'primary_high', 'junior', 'senior']
  for (const grade of grades) {
    readFileSync(join(desktopRoot, 'resources', 'brand', `${grade}.png`))
  }
})

test('G19-3d 原始 logos/ 不随包分发（只发缩小后的 brand/）', () => {
  // 12MB 原图留在仓库根供重新生成，不进 desktop/resources —— 后者会被打进安装包
  const brandDir = join(desktopRoot, 'resources', 'brand')
  const total = readdirSync(brandDir).reduce((sum, f) => sum + statSync(join(brandDir, f)).size, 0)
  assert.ok(
    total < 2 * 1024 * 1024,
    `brand/ 合计 ${(total / 1024 / 1024).toFixed(1)}MB，超过 2MB —— 很可能把原图放进来了`
  )
})

test('★★ G19-3e 代码里的 logo URL 必须真的指向存在的素材（改名不同步就裂图）', () => {
  /*
   * 为什么单独立一条：上面三条查的是**素材文件**在不在，这一条查的是
   * **代码里的 URL 能不能解析到它们** —— 两件事会各自跑偏，而第二种**完全静默**：
   *   把 `primary_low.png` 改名（或把 `brand-logo.ts` 的路径写错），
   *   typecheck、单测、构建**全都照过**，只在界面上留一个裂图。
   */
  const source = readFileSync(join(desktopRoot, 'src', 'renderer', 'src', 'brand-logo.ts'), 'utf8')

  // 抓出源码里所有 './brand/xxx.png' 字面量
  const urls = [...source.matchAll(/'\.\/brand\/([A-Za-z0-9_.-]+\.png)'/g)].map((m) => m[1])
  assert.ok(urls.length >= 5, `brand-logo.ts 里只找到 ${urls.length} 个 logo 路径，至少应有 5 个`)

  const brandDir = join(desktopRoot, 'resources', 'brand')
  for (const file of urls) {
    assert.doesNotThrow(
      () => readFileSync(join(brandDir, file)),
      `brand-logo.ts 引用了 ./brand/${file}，但 resources/brand/ 里没有它 —— 界面上会裂图`
    )
  }

  // ★ 反向：素材目录里每一张图都该被引用到（新增素材却没人用 = 白打进安装包）
  const onDisk = readdirSync(brandDir).filter((f) => f.endsWith('.png'))
  const unused = onDisk.filter((f) => !urls.includes(f))
  assert.deepEqual(
    unused,
    [],
    `resources/brand/ 里有没被 brand-logo.ts 引用的图：${unused.join('、')}（要么接上，要么别打包）`
  )

  // ★ URL 必须**相对页面**（不能以 / 开头）：打包态页面是 file://，/brand/x.png
  //   会解析到文件系统根。这条 grep 一次就能钉住，不必等实跑。
  const absolute = [...source.matchAll(/['"]\/brand\/[^'"]+['"]/g)].map((m) => m[0])
  assert.deepEqual(
    absolute,
    [],
    `brand-logo.ts 里出现以 / 开头的 logo 路径：${absolute.join('、')} —— 打包态（file://）会裂图`
  )
})
