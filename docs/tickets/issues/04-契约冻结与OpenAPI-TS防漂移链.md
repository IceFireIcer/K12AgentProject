# 04 — 契约冻结 + OpenAPI→TS 防漂移链

**What to build:** 把 `server/app/contracts.py` 立成**pydantic 唯一契约来源**，跑通「pydantic → `/openapi.json` → `openapi-typescript` → `desktop/src/shared/api-types.ts`」这条生成链，并把 `--check` 字节比对与首批架构守卫断言钉住。为什么在这个顺序：05（IPC 事件通道）、10（教材入库）、11（RAG 检索）都要用它的类型；契约先冻结，各模块才能并行实现而不会互相返工。**只依赖 01**，因此可与关卡 A/B₁ 并行推进。

**Blocked by:** 01 双端脚手架与依赖基线

**Status:** ready-for-human

- [x] `server/app/contracts.py` 成为唯一手写契约处（**旧名 `models.py` 已废弃，不要新建同名文件**）：`GradeLevel = Literal["primary_low","primary_high","junior","senior"]`、`LlmConfig`（providerName / baseUrl / apiKey / modelId）、`EmbeddingConfig`（mode 三选一 `local_fastembed | cloud_api | none`）、`Citation`、`SettingsResponse`、`Student`、`StudentProfile`、`GradeSignals`、`DepNode`，以及 §6.5 的 payload：`AnimationPayload` / `CodeTemplate` / `CodingHint` / `CodeEvaluation` / `QuizQuestion` / `QuizPayload` / `QuizResult`
- [x] **不定义 `Intent` 字面量**（路由由 LLM 选 Tool 自然产生，不是代码级字段）；**不引入 `ModuleResult<T>` / `ModuleError`** 那套 `{success, error}` 包装（失败统一走 `error` 事件带 `degraded`，否则前端要处理两套失败形态）
- [x] 6 事件词表冻结为 `delta | citation | payload | blocked | done | error`（含 `requestId` 贯穿全部事件），在 `contracts.py` 里作为常量声明并注释「冻结，改动词表需同步前端与守卫」
- [x] `QuizQuestion` 有独立的「发给前端」出参形态（`QuizQuestionOut`，见 §6.3）：序列化结果里**不含 `answer` 字段**（答案泄漏是硬伤，判分只走后端）；写一个单测断言 `model_dump()` 输出无 `answer` 键
- [x] 字段命名只做一次约定：Python 侧 `snake_case`，pydantic 配 `alias_generator=to_camel` 出参 camelCase，前端统一 camelCase
- [x] `server/scripts/export_openapi.py` 导出 → 落 `desktop/src/shared/openapi.json`；`--check` 做**字节比对**，不一致时非零退出（供守卫与 CI 使用）
- [x] `desktop/scripts/gen-api-types.mjs` 用 openapi-typescript `^7.13` 生成 `desktop/src/shared/api-types.ts`（文件头写「生成物，不手改」）；`desktop/package.json` 增加 `gen:api` 脚本指向它
- [x] 漂移实验（留证）：故意给 `Citation` 加一个必填字段 → 重跑生成 → **`npm run typecheck` 必须报错**；随后回滚并确认 `export_openapi.py --check` 重新变绿（这是「第一道防线」的可演示证据）
- [x] `desktop/tests/architecture-guards.test.ts` 落地并接入 `node --test`（npm script `test`），首批断言：① 聊天事件流**必须**经 `ipcMain` / `webContents.send` 与 preload 白名单通道送达（**正向断言**——本项目从零实现，不写「禁止 `EventSource`」式反向断言，见执行文档 §6.4）；② `desktop/src/**` 不出现原生数据库模块（`better-sqlite3`、`sqlite3`）；③ 渲染进程不出现 Node 内置模块导入；④ `desktop/src/shared/ipc-events.ts` 的事件名与 `contracts.py` 的词表常量**逐字一致**（6 个，不多不少）
- [x] 跑 `node --test` 时**禁用 TS parameter property**（`constructor(private readonly x)`）——Node 的类型擦除模式会抛 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`，写成显式字段 + 赋值
- [x] 提交一次，并在报告素材里记一条：为什么坚持 pydantic 唯一来源（手写 TS 接口会让整套防漂移机制作废）

## 进度

### ✅ 完成

- 契约扩到 **35 个模型**全部登记进 `CONTRACT_MODELS`（含 `INTERNAL_MODELS` 一侧的内部模型）
- `export_openapi.py --check` 与 `gen-api-types.mjs --check` 均**逐字节一致**
- ★ **答案泄漏防护**做成两个模型（内部 `QuizQuestion` 含 answer 且**不导出**；
  对外 `QuizQuestionOut` 无 answer），**刻意不用 `exclude=True`**（文档明确否掉）。
  7 项断言覆盖，含哨兵串递归扫描 + 「OpenAPI 里除白名单外不得出现 answer 属性」。
- **漂移实验**（跑完复原，探针在仓库外）：给 `Citation` 加必填字段 →
  ① `openapi --check` exit 1（首个差异第 124 行）→ ② 重生成后 `gen-api-types --check` exit 1
  → ③ 消费方编译失败 `TS2741` → ④ 复原后两处复绿。**防漂移链真的会拦住，不是摆设。**
- 掩码语义：读只回 `…abcd` + `hasKey`；提交空串/掩码**不擦除**已存 key。
- `main.py` 挂上 rag / graph 路由后 openapi 由 4 条路径增至 6 条，契约已随之重生成。

