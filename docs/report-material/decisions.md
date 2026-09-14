# 技术决策记录（Decisions）

> 每条格式：**决策 → 理由 → 被否决的方案**。答辩时"为什么这么做"的答案直接从这里取。

## D-001 · 后端改用 Python sidecar（而非原研判的 Node/LangGraph JS）

- **决策**：Electron 仅作 UI 壳 + 进程管理；LangGraph 跑在 Python sidecar（FastAPI）里，经 `127.0.0.1` HTTP + SSE 通信。
- **理由**：
  1. LangGraph 的**参考实现与文档在 Python 侧**，示例密度远高于 JS 版；
  2. **原生模块风险归零**——Electron 侧不再需要 `better-sqlite3` / `sqlite-vec`，`electron-rebuild` 不再是关键路径；
  3. **白送持久化**：`SqliteSaver` 直接满足"跨 Session 记忆"这条硬要求；
  4. **白送流转图**：`draw_mermaid()` 产出报告所需的状态流转图（直接服务 25% 设计分）；
  5. 可脱离 UI 用 `uv run` + curl 调试全部 Agent/RAG 逻辑，单人开发并行度显著提升。
- **被否决**：① 原判研的 Node 内跑 LangGraph JS（生态不成熟，且要自己解决原生 SQLite 打包）；② 手写状态机替代 LangGraph（用户明确授权可用 Python 版 LangGraph，该顾虑不成立）。
- **代价（已接受）**：多一个运行时，安装包体积增大；需管理 sidecar 生命周期；Windows 中文编码须在 spawn 时强制 UTF-8。

## D-002 · 嵌入模型改 `bge-small-zh-v1.5`（fastembed/ONNX）

- **决策**：512 维、约 90MB、ONNX Runtime、纯 CPU。
- **理由**：**彻底移除 Ollama 与 torch 依赖**——原方案"需用户另装 Ollama"是演示现场头号翻车点。安装包体积相比 BGE-M3 方案减少约 2GB。
- **被否决**：BGE-M3（1024 维，2.24GB，需 Ollama + torch）。
- **升级路径**：若实测检索质量不足 → `bge-base-zh-v1.5`（768 维）。**必须同步改 `vec0` 维度并重建索引**，故维度已写成配置常量。

## D-003 · 双库设计（`kb.sqlite` + `student-<id>.sqlite`）

- **决策**：知识库全局一份且只读；每个学生一个私有库（画像/掌握度/历史/进度/checkpoint）。
- **理由**：原研判"每个学生独立数据库"直接照做会把**知识库与向量索引复制 N 份**，浪费且慢。双库保留"一人一库、互不影响"的合规结论，同时知识库只存一份。
- **被否决**：单库 + `student_id` 列过滤（合规叙事弱，答辩容易被问穿）。

## D-004 · 动画「模板优先 + 生成补充」

- **决策**：内置 6–8 个高质量模板；LLM 只负责"选模板 + 填参数 + 生成文案"；自由生成 HTML 仅作补充路径。失败重试 ≤3 次后降级为文字 + 静态图。
- **理由**：原研判自认"LLM 一次性生成完整 HTML 失败率高"是**头号风险**。模板优先把不确定的生成问题转为确定的参数填充问题。
- **被否决**：纯自由生成（演示翻车概率不可接受）。

## D-005 · 时间线从 11–12 周收敛为 15 天

- **决策**：单人 15 天极限冲刺；核心只做 4 种交互，**砍掉绘本生成与多模态资源推荐**。
- **理由**：赛题要求"至少三种多模态"，交付 4 种已超标有余量；评委更认可聚焦而非功能堆砌。砍单顺序已写进执行文档第 4 节作为硬性预案。
- **被否决**：把语音 ASR/TTS 列为核心（降为 P2，因 Python 下 `sherpa-onnx` 有 pip 包，成本大降，保留回捡余地）。

## D-006 · 端口握手用「stdout 单行 JSON」而非 HTTP 回调或固定端口（S01 落地）

- **决策**：sidecar 以 `--port 0` 启动让 OS 分配端口；绑定成功后向 **stdout 打一行 JSON**
  `{"event":"ready","port":N,"pid":...,"version":...}`，Electron 逐行读取解析。
  失败也走同一通道回 `{"event":"error","message":"..."}`。
- **理由**：
  1. **消除端口竞态**：自己「先扫空闲端口再启动」在并发/杀软场景下会撞车；让 OS 分配是原子的。
  2. **stdout 是天然的单向控制通道**，无需 sidecar 反向连 Electron（那会引入第二个端口与额外鉴权面）。
  3. **失败原因可读**：把启动期异常（数据目录不可写、拒绝绑定非回环地址）统一转成一行 JSON，
     Electron 直接拿到中文原因 —— 这是「不许白屏」这条硬要求的前提。
- **被否决**：① 固定端口（演示现场端口占用即翻车）；② sidecar 起 HTTP 后回调 Electron
  （多一个通信方向与鉴权面，复杂度不划算）；③ 写临时文件传端口（有残留与清理问题）。
- **配套约束**：**stdout 只许输出这行 JSON**，uvicorn 日志全部走 stderr；
  Electron 侧对非 JSON 行只记日志、绝不当错误（防第三方库直接 print 打死启动流程）。

## D-007 · 开发期用 `K12_SIDECAR_MODE=packaged` 提前验打包路径（S01 落地）

- **决策**：sidecar 的启动模式由 `K12_SIDECAR_MODE` 覆盖 `app.isPackaged`；
  开发期即可让 Electron 拉起 `server/dist/` 里的真实 exe。
- **理由**：关卡 A 的实质要求是「Electron 指向**打包产物**也能握手」。
  若每次都跑完整的 `electron-builder`（数分钟）才能验一次，改一行 sidecar 逻辑都要等；
  有了这个开关，验证 loop 缩到「打后端（~27s）+ 起 dev」。
  **注意**：这不能替代最终的整包验收 —— 我们仍然跑了 `electron-builder --dir`
  并在 `win-unpacked/` 里双击真实 `.exe` 复验通过（`extraResources` 的路径映射只有整包才能验到）。
- **被否决**：只跑开发态就宣称关卡 A 通过（那样验不到 `extraResources` 与 `resources/server/` 的实际布局）。
