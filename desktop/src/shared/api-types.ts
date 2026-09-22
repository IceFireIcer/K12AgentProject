/**
 * ⚠️ 生成物，**不要手改**（generated, do not edit）。
 *
 * 来源：`server/app/contracts.py`（唯一手写契约处）
 *   → `server/scripts/export_openapi.py` → `src/shared/openapi.json`
 *   → `desktop/scripts/gen-api-types.mjs` → 本文件。
 *
 * 重新生成：`cd desktop && npm run gen:api`；校验是否漂移：`npm run check:api`。
 * 手改本文件会在下一次 `--check` 时被判定为漂移（并让 typecheck 失去意义）。
 *
 * ★ 6 事件词表（冻结，见 `contracts.py` 的 `IPC_EVENT_NAMES` 与 `shared/ipc-events.ts`）：
 *   delta | citation | payload | blocked | done | error
 *
 * ⚠️ 本文件**不含**带标准答案的内部模型 `QuizQuestion`（§6.3 答案泄漏防护）：对外的题目
 * 一律是 `QuizQuestionOut`。本文件里唯一带 `answer` 的是 `QuizGradeRequest` —— 那是
 * **学生提交的作答**（请求方向），不是标准答案；导出脚本会断言它不被任何 response 引用。
 */

export interface paths {
    "/api/code/hint/{kp_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 取某知识点的一条分级提示（手动求助按钮用）
         * @description 取一条提示（供 ``get_coding_hint`` Tool 调用：学生点「求助」时）。
         *
         *     ★ **级别由调用方决定、由本端点封顶**：
         *       - 调用方（``coding.ts``）维护「该 kp 上已经给过第几级」，据此要**下一级** ——
         *         它在有状态的那一侧强制「一次只升一级」，这是「不跳级」的落点；
         *       - 本端点只保证**不越界**：``level`` 超过模板实际写了几级时，退到模板的最高级
         *         （宁可给最高级的提示，也不要因为越界而让学生的「求助」按钮点了没反应）。
         *
         *     没有该 kp 的模板（= 没有提示素材）→ **404 + 可读中文**，
         *     由编排层退回「用对话引导」（这是能力受限，不是崩溃）。
         */
        get: operations["get_coding_hint_api_code_hint__kp_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/code/run-hint": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 提交「代码 + 运行结果」，返回中文反馈与下一级提示（不执行代码）
         * @description ★ **本端点不执行代码**：它收到的是渲染进程 Pyodide Worker 已经跑完的结果。
         *
         *     入参 :class:`CodeRunRequest` 里的 ``stdout`` / ``stderr`` 就是 Worker 回传的原文
         *     （``stderr`` 非空 = 运行失败）。本函数只做三件事：
         *
         *     1. **归一化报错** → :class:`CodeError`（中文解释 + 原始 traceback 留档）；
         *     2. **生成反馈** → ``feedback``（面向学生，不说「改成什么」）；
         *     3. **挑下一级提示** → ``next_hint``（按 ``attempt`` 递进，**不跳级**，见 :func:`resolve_hint_level`）。
         *
         *     ``attempt`` 是「同一知识点下的第几次尝试」（契约里 ``ge=1``），
         *     由主进程的 ``evaluate_code`` Tool 按学生维度计数后传入 ——
         *     **服务端不保存这个计数**（它是单轮临时态，放 Extension 内存 Map 里，执行文档 §6.6）。
         *
         *     取不到模板不算失败：没有模板就没有分级提示，此时 ``next_hint=None``，
         *     反馈本身照给（报错翻译与模板无关）。
         */
        post: operations["run_hint_api_code_run_hint_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/code/templates/{kp_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 按知识点取代码模板（含 TODO 脚手架，剔除 solution）
         * @description 取模板（供 ``get_code_template`` Tool 调用）。
         *
         *     - **纯本地文件读取**，不经 LLM、不联网 —— 断网可用（票 19 验收项）；
         *     - 返回体是 :class:`CodeTemplate`，**结构上没有 ``solution``**（投影而非裁剪）；
         *     - 取不到 → **404 + 可读中文**（空对象会让前端渲染一张没有脚手架的卡片）；
         *     - 坏模板只跳过、不抛异常（与题库同口径）。
         */
        get: operations["get_code_template_api_code_templates__kp_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/grade/history/{student_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 学段变化轨迹
         * @description ``grade_history`` 全量轨迹（含冷启动基线那行：``from_level`` 为空）。
         */
        get: operations["grade_history_api_grade_history__student_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/grade/override/{student_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 学生手动设定学段（写 grade_history(source=explicit)，之后进入更长冷却）
         * @description ★ **唯一的人工写路径**：学生选定学段 → 立即生效 + 进入 :data:`MANUAL_COOLDOWN_TURNS` 冷却。
         *
         *     与 ``POST /grade/turns`` 的分工：那条路径收的是**证据**（可能改变学段，也可能不），
         *     这条路径收的是**决定**（一定按学生的意思生效）。两者写的是同一张 ``grade_history``，
         *     区别只有 ``source`` 与冷却窗口长度 —— 冷却期一过，自动推断照常接管。
         *
         *     ★ 冷却锚点（``signal_mark``）**由服务端自己取**：它是「写这一行时 ``grade_signals``
         *     的最大 id」，全局单调、跨会话可比 —— 所以请求体里不需要会话参数，
         *     而「手动后 10 轮内不再自动调整」这条验收仍在字面上成立（跨会话照数）。
         */
        post: operations["override_grade_api_grade_override__student_id__post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/grade/signals/{student_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 学段信号与待生效的推断建议
         * @description 当前学段 + 最近信号 + （够格但被挡住时的）待生效建议。
         *
         *     ``source`` 现在有**两种**取值：默认是 ``inferred``（系统自动推断），
         *     学生手动设定过则是 ``explicit``（见 ``POST /grade/override/{student_id}``）。
         *     ``suggested_level`` 的含义不变：「证据已够、但被冷却期或置信度挡住的下一个学段」，
         *     供前端显示「将在下一轮生效」。
         */
        get: operations["grade_signals_api_grade_signals__student_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/grade/state/{student_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 当前学段状态（轻量）
         * @description 桌面端每轮取「当前学段」的入口（不含信号列表，载荷最小）。
         *
         *     当前学段可能是**推断引擎自动写入**的，也可能是**学生手动设定**的
         *     （后者 ``source="explicit"``、``cooldownRemainingTurns`` 更长）。
         *
         *     ★ 冷却不需要会话参数：锚点记的是 ``grade_signals`` 的**信号位标**（全局单调、
         *     跨会话可比），所以「还剩几轮」在任何会话里读都是同一个真实轮数
         *     —— 与 ``POST /grade/turns`` 报出的值也必然一致（P-094 的形态不会重现）。
         *
         *     学生还没建库时**冷启动**：建默认学段（小学高年级）并写一条基线轨迹，
         *     而不是 404 —— 学段推断从第一轮就要开始工作。
         */
        get: operations["grade_state_api_grade_state__student_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/grade/turns/{student_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 上交一批轮次证据，由服务端提取信号并判定学段
         * @description ★ **学段推断的主入口**：一批轮次证据 → 信号 → 判定 → （必要时）改学段。
         *
         *     依次处理 ``turns``（按给定顺序 = 轮次升序），**逐轮判定**，
         *     返回最后一轮的结论 + 每一轮的轨迹。信号逐轮落库：即使中途失败，
         *     已写入的信号也不会丢，下一次调用照样能算出正确的连续轮次。
         */
        post: operations["submit_grade_turns_api_grade_turns__student_id__post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/graph/deps/{kp_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Graph Deps
         * @description 查一个知识点的前置/后继。
         *
         *     - 知识点不存在 → **404**（不返回空数组：空数组看起来像「这个点没有邻居」，
         *       而实际上可能是 kp_id 拼错了，两者必须区分开）；
         *     - 深度上限由 :data:`app.knowledge.deps.MAX_DEPTH_LIMIT` 卡死（元数据笔误成环也不会挂）。
         *
         *     ★ 返回结构里带 ``depth`` 与 ``direction``：前端画邻域图与排序都要用，
         *     调用方也就不必自己再走一遍图。
         */
        get: operations["graph_deps_api_graph_deps__kp_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/graph/overview/{grade_level}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 某学段依赖图全览（学习地图用）
         * @description 把某学段的知识点与**两端都在本学段内**的依赖边整张吐出来。
         *
         *     ★ 为什么按学段切片而不是给全图：学习地图是要**看**的，一次画 33 个节点还行，
         *       跨学段全画（含边）会变成一团糊。跨学段的边在这里被**刻意丢掉** ——
         *       它们在单学段视图里没有落点，传出去只会画出悬空的线。
         *
         *     ★ ``layer``（分层）由服务端算：前端拿到的是一张已排好层次的图，
         *       不必自己再做一次拓扑排序（两处各算一遍必然不一致）。算法见 ``_assign_layers``。
         *
         *     - 学段名非法 → **422**；知识库缺失 → **503**（与章节接口同一口径）。
         */
        get: operations["graph_overview_api_graph_overview__grade_level__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/knowledge/chapters/{grade_level}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 列出某学段的全部章节（可选带该学生的掌握进度）
         * @description 按学段列出章节，顺序**就是教材顺序**（见 ``kb.chapters_by_grade`` 的排序注释）。
         *
         *     - 学段名非法 → **422**（不回空清单：空清单看起来像「这个学段没编教材」）；
         *     - 知识库缺失 → **503**（可读中文：先跑 ``scripts/build_kb.py``）；
         *     - 带 ``student_id`` 但该生还没有进度行 → 计数为 0，**不报错**（新学生是正常状态）。
         */
        get: operations["list_chapters_api_knowledge_chapters__grade_level__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/knowledge/import": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 导入一份教材 Markdown（严格校验 → 落盘 → 可选重建）
         * @description 导入一份教材 Markdown。
         *
         *     **校验只有一处**（``library.parse_document``）：格式、必需字段、``content_type`` 白名单、
         *     「文件名 = kp_id.md」，全都走建库时那一份实现 —— 若这里另写一份，
         *     迟早出现「导入时通过、建库时失败」这种最难查的不一致。
         *
         *     之后再过 **学段错位自检**（``checker.audit_library``）：超纲术语 / 语气错位 / 跨学段搬运。
         *     它不通过时**拒收**并逐条回报原因 —— 把初中的语气搬到高中是最典型的静默质量事故。
         *
         *     ★ 校验/审计失败回 **200 + ``ok=false``**（而不是 4xx）：失败原因是**内容问题**，
         *       界面要在同一张卡片里逐条列出它们，不是「请求本身非法」。
         *       这与「学段名拼错 → 422」是两回事（那是调用方写错了参数）。
         *
         *     ★ 导入**不覆盖**同名文件以外的任何东西；重建是**整库重建**（``build()`` 先清表再写），
         *       所以导入后看到的是「随包教材 + 用户导入」的合并结果，而不是只剩导入的那一份。
         */
        post: operations["import_knowledge_api_knowledge_import_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/knowledge/points": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 知识点清单（教材知识库页的表格；可按学段过滤）
         * @description 列出知识点（每个点一行：学段 / 章节 / 类型 / chunk 数 / 是否有向量）。
         *
         *     - 学段名非法 → **422**（与 ``list_chapters`` 同口径：不回空表假装没编教材）；
         *     - 知识库缺失 → **503**。
         */
        get: operations["list_points_api_knowledge_points_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/knowledge/rebuild": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 重建索引（分块 + 嵌入 + FTS + 依赖图）
         * @description 重建整库索引（幂等：``build()`` 先清表再写）。
         *
         *     - 嵌入模型缺失 → ``ok=false`` + 可读中文（**不是 500**）：界面有失败横幅要显示它；
         *     - 教材格式错 → 同样 ``ok=false`` + 原因；
         *     - 成功 → 写**标记文件**（让用户库优先于随包库）+ 清理依赖图缓存 + 回统计数字。
         *
         *     ★ 重建是同步重活（分块 + ONNX 嵌入），跑在**线程池**里：直接 await 会阻塞事件循环，
         *       把整台 sidecar 卡住（连 ``/health`` 都不响应，Electron 会以为它挂了）。
         */
        post: operations["rebuild_knowledge_api_knowledge_rebuild_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/knowledge/stats": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 知识库体检数字（统计卡 / 版本信息 / 向量可用性）
         * @description 知识库规模与状态。
         *
         *     - 知识库缺失 → **503**（与其它两个读接口同口径：这页本来就是来看库的，
         *       回一份全 0 的统计会让人以为「库是空的」，而实际是「库不在」）。
         */
        get: operations["knowledge_stats_api_knowledge_stats_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/profile/{student_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 画像与掌握度
         * @description 读某学生的画像：基本身份 + 掌握度 + 偏好 + **依赖图推荐**（票 20 填充）。
         *
         *     - 学生不存在 → **404**（空画像会让学生以为「我没学过任何东西」，两者必须区分）；
         *     - ``studentId`` 非法 → **422**（它会被拼进文件系统路径）；
         *     - 库读写失败 → **503**（可读中文；上层 Tool 会把它转成 `error` 事件而不是崩）。
         *
         *     ★ ``recommended_kp_ids`` 自票 20 起**不再是空的**：它由 :func:`build_recommendation`
         *       算出（依赖图 + 掌握度 + 冷启动兜底）。**不要**在别处再算一份 ——
         *       两套推荐算法会给出两个不同的「下一步」，而学生只会看到其中一个。
         */
        get: operations["student_profile_api_profile__student_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/profile/{student_id}/chapter": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 当前教材章节
         * @description 读学生当前在学的章节（``chapterTitle`` 为空串 = 未选择）。
         *
         *     - ``studentId`` 非法 → 422（它会被拼进文件系统路径）；
         *     - 学生行不存在 → **自动建行**（冷启动，见 :func:`_ensure_student_level`），
         *       **不 404**：章节指示器在全新机器上要能显示「未选择章节」。
         *       因此本端点对**全新学生**是「建行 + 读」，对已存在的学生才是纯读。
         *     - 读库失败 → 503（可读中文）。
         */
        get: operations["read_chapter_api_profile__student_id__chapter_get"];
        /**
         * 设定或清除当前教材章节
         * @description 设定/清除当前章节（**学生显式选择的唯一落点**）。
         *
         *     规则：
         *
         *     - ``chapterTitle`` 为空串 → **清除**（写 NULL，回到「不限章节，自由问答」）；
         *       清除**不需要 kb**（清掉一个值不需要先查清单）。
         *     - 非空 → 必须命中该生**当前学段**的章标题（清单来自 ``kb.sqlite``），
         *       不在清单里 → **422**（否则 Prompt 里会出现一本不存在的教材）；
         *     - kb 不可用且要设非空标题 → **503**（提示 ``build_kb``，**不猜、不静默接受**）。
         *
         *     ★ **不做 SQL 硬过滤**：章节是软偏好，检索契约（``RagSearchRequest``）一个字没改，
         *       学生选了第 4 章之后再问第 9 章的内容，``rag_search`` 照常检索。
         *     ★ 学段一变，章节由 ``app/grade/rules.py`` 清空（那本教材已经不存在了）——
         *       本端点**不负责**这件事，也不要在读的时候「顺手修正」。
         */
        put: operations["write_chapter_api_profile__student_id__chapter_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/profile/{student_id}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 学习记录写入（答题/代码/动画观看/答疑）
         * @description 把一条结构化学习记录写进该学生的 ``learning.db``。
         *
         *     冷启动兜底：学生行不存在时按请求里的学段（缺省 ``junior``）建一条 ——
         *     「学生还没登录就先产生了学习记录」不该丢数据，也不该 500。
         */
        post: operations["record_learning_event_api_profile__student_id__events_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/profile/{student_id}/opening": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 新会话开场引导（主动发起对话）
         * @description ★ 「主动发起对话引导」的**唯一出口**（需求明文要求，此前零实现）。
         *
         *     形态：**新会话建立后**调一次，把结果作为 AI 的第一条消息送进对话。
         *     不是「每轮打招呼」—— 它只在**会话内还没有任何消息**时才有意义。
         *
         *     ★★ 不要重写推荐逻辑：本端点与 ``/recommendation`` 共用 :func:`build_recommendation`
         *        （它再往下走 :func:`app.knowledge.deps.recommend_next`，那是依赖图推荐的唯一实现）。
         *        「开场语该说什么」这件事的全部信息都在那个返回值里，本端点只做拼接。
         *
         *     **没有可推荐的内容时返回空串**（而不是一句放之四海皆准的寒暄）：
         *     知识库缺失、学生已全部掌握、依赖图为空 —— 这三种情况都推不出该学什么，
         *     此时**不发开场**才是诚实的；前端据 ``text == ""`` 直接跳过。
         *
         *     与 ``/recommendation`` 一样，**学生不存在时自动建立**（冷启动的第一屏就是它的用例）。
         */
        get: operations["student_opening_api_profile__student_id__opening_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/profile/{student_id}/preferences": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * 写入学习偏好（兴趣 / 讲解方式 / 节奏）
         * @description 写一条学习偏好（``profile_pref`` 的**唯一生产写入口**）。
         *
         *     需求要求「根据答题表现**和兴趣偏好**动态调整后续推荐」：「答题表现」那条链路
         *     （判分 → 掌握度 → 推荐）本就是通的，而「兴趣偏好」此前是条断头路 ——
         *     ``profile_pref`` 表建好了、``GET /profile`` 也读它，但**生产代码从不写**。
         *     本端点补上这一半：写入的偏好会经 ``GET /profile`` 进入画像，
         *     再由 ``get_student_profile`` Tool 拼进每轮 Prompt。
         *
         *     ★ **为什么是 PUT 而不是 POST**：单键 upsert 是**幂等**操作 —— 同一个 key 提交两次，
         *       库里的状态完全相同（``key`` 是主键，第二次是覆盖）。POST 会暗示「追加一条记录」，
         *       与实际语义正好相反，调用方会以为「多写几条偏好更完整」而反复 POST。
         *
         *     ★ **为什么键是封闭词表**（``contracts.PreferenceKey``：``interest | explain_style |
         *       pace | note``）：见该 Literal 的注释 —— 关键是「写掌握度」在**类型层面**就不可能。
         *       掌握度是判分规则算出来的客观量，一旦模型能通过偏好通道写它，
         *       就会出现「模型觉得学生懂了就改分」。这类多写路径的教训见 D-020。
         *
         *     ★ **为什么不改 ``StudentProfile`` 的形状**：偏好已经在该模型的 ``preferences`` 里，
         *       本端点只写不读；出参复用 :class:`LearningEventAck`（``{ok: true}``）。
         *
         *     冷启动兜底与 ``POST /events`` **完全一致**（学生行不存在时建一条）——
         *     两条写路径必须同口径，否则学生会遇到「写记录能用、写偏好 404」这类无谓差异。
         */
        put: operations["update_preference_api_profile__student_id__preferences_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/profile/{student_id}/recommendation": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 下一步学什么（依赖图 + 掌握度 + 冷启动）
         * @description ★ 个性化推荐的**专用出口**（票 20 的「可演示数据流」）。
         *
         *     与 ``GET /profile`` 的差别只有一层：这里会返回**为什么这么推荐**
         *     （``source`` + 每条的 ``reason`` + 掌握度），前端能显示一句可照念的引导语，
         *     验收时也能一眼断言「是重练、是依赖图、还是冷启动」。
         *
         *     **学生不存在时自动建立**（冷启动兜底）：全新学生 id 直接问「学什么」是正常用法，
         *     回 404 会让前端显示一个空白页 —— 而冷启动必须能用是票 15/20 的明确验收项。
         */
        get: operations["student_recommendation_api_profile__student_id__recommendation_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/profile/{student_id}/report": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 学习报告（周窗口活动量 + 掌握度 + 闯关 + 章节 + 学段轨迹）
         * @description 「这一周学得怎么样」的**唯一出口**（学生与家长看的是同一份）。
         *
         *     ★ 四张表在这里汇合：``mastery``（会什么）、``learning_history``（做了多少）、
         *       ``progress``（闯到哪关了）、``grade_history``（学段怎么变的）。
         *       此前它们各有零散出口，但没有一个「合起来看」的地方 ——
         *       而 ``grade_history`` 的表注释里本来就写着「家长报告」，这是补上那处设计意图。
         *
         *     ★ **连续天数在服务端算**（``_streak_days``）：它跨「整段历史」而不是时间窗，
         *       前端拿到的是已经算好的结论；同时前端也拿到 ``daily`` 明细，可以自己铺满整周。
         *
         *     - 学生不存在 → **404**；``days`` 越界 → **422**；库异常 → **503**。
         */
        get: operations["learning_report_api_profile__student_id__report_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/quiz/bank/{kp_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 按知识点 + 学段取题（剔除 answer）
         * @description 取题（供练习 Extension 的 ``generate_quiz`` Tool 调用）。
         *
         *     - 本题库**按学段分文件**，因此学段是必填参数；只允许取**不高于**学生学段的题；
         *     - 返回体是 :class:`QuizPayload`，``questions`` 全是 :class:`QuizQuestionOut`
         *       （**结构上没有 ``answer``**，不是靠 ``exclude`` 临时裁的）；
         *     - 取不到题 → **404** + 可读中文（``questions: []`` 看起来像「这个知识点没题」，
         *       与「kpId 拼错了」分不开，所以不用空数组表达失败）；
         *     - 题库目录不存在/坏题多 → 不算错误：返回 404，由编排层决定改用 LLM 生成（票 15）。
         */
        get: operations["get_quiz_bank_api_quiz_bank__kp_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/quiz/grade": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 提交答案并批改（客观题规则判分）
         * @description 按 ``qid`` 查库判分，并把结果写进该学生的 ``learning.db``。
         *
         *     写入三处（都是结构化数据，**不写对话正文**）：
         *       - ``mastery``：``score`` / ``attempts`` / ``correct`` / ``last_seen_at``；
         *       - ``learning_history``：一条 ``activity="quiz"`` 记录（票 20 的个性化闭环要吃它）；
         *       - ``progress``：闯关状态机（**票 15**，见 :func:`apply_level_progress`）。
         *
         *     ★★ **判分幂等：首次作答决定**（``store.question_attempt(qid)`` 判首次，与主观路径同源）。
         *       第一次提交这道题 → 照常判分 + 计掌握度 + 推进闯关 + 计徽章；
         *       **之后的重复提交** → **照常判分、照常给反馈**（学生要看到这次对没对），
         *       但**不再改掌握度、不重复计数、不重复推进/解锁**，反馈里附一句
         *       :data:`REPEAT_ATTEMPT_SUFFIX` 把「不计分」说明白（**不说谎**）。
         *
         *       为什么「答错后再答」不改变掌握度：掌握度是**能力信号**（推荐/画像要吃它），
         *       连点 4 次同一道题就能把 0.15 刷到 0.6 并解锁后继 —— 那不是能力，是点击次数。
         *       学习需要的是**即时反馈**，那一条一个字没少（判分与反馈照旧）。
         *
         *     题目来源有两处，**按此顺序**查（票 15 起）：
         *       ① 该学生库里的 LLM 生成题（``generated_question``）—— 变式题走这条；
         *       ② 随包分发的题库。
         *     两处都要求「这条库里有这道题」，否则 404（**不猜、不新建**）。
         *
         *     ``mastery_delta`` 回传的是**实际生效**的变化量（``新值 - 旧值``）：已经满分时再答对就是 0，
         *     而不是回一个没发生的 ``+0.15``（否则前端进度条会虚涨）；重复作答时它**恒为 0**
         *     （掌握度没动，回传任何非零值都是谎报）。
         */
        post: operations["grade_quiz_api_quiz_grade_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/quiz/grade-subjective": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 落库主观题判分结论（LLM 调用在 TS 侧，本端点只落库）
         * @description 把 **TS 侧模型判分**的结论落进 ``learning.db``（票 15 的混合批改）。
         *
         *     ★★ 为什么判分结论要从外面送进来、判分逻辑却仍在服务端：
         *
         *     - **LLM 调用归 Ts 独占**（Pi 是编排层，Python 不装任何 LLM 客户端）——
         *       所以模型给出的 ``score`` / ``feedback`` 只能从 TS 侧来；
         *     - **但「多少分算过」必须由服务端定**（:data:`SUBJECTIVE_PASS_RATIO`）：
         *       TS 只送分数，不送 ``correct``。若让 TS 送对错，等于把判分规则复制一份到前端进程，
         *       两边迟早漂移，而漂移的表现是「同样的答案，有时算对有时算错」；
         *     - **只有登记过评分细则的主观题**走得通（客观题一律 **409**），
         *       这样 ``scored_by="llm"`` 不会被用来绕开规则判分。
         *
         *     写库与 ``/quiz/grade`` **共用** :func:`_record_attempt`（同一个事务边界、
         *     同一套进度推进），所以两条判分路径在数据侧不可能出现两套语义。
         *
         *     ★★ **判分幂等同样成立**（与 ``/quiz/grade`` 一条口径，判据也是
         *       ``store.question_attempt(qid)``）：这道主观题第二次提交时**照常落一条
         *       ``learning_history`` 流水**，但**不再改掌握度、不再推进闯关/解锁**，
         *       反馈里附一句 :data:`REPEAT_ATTEMPT_SUFFIX`。
         *
         *       ⚠️ 主观题**尤其**需要这一条：LLM 判分不是确定性的（同一份答案可能这次 0.8、
         *       下次 1.0），同一道开放题反复提交就能靠分数抖动把掌握度一路推上去 ——
         *       而 ``SUBJECTIVE_PASS_RATIO`` 的「多少分算过」在服务端，学生只要反复点就够了。
         *       幂等判据落在**服务端**（不是靠 TS 侧记得别重复提交）。
         */
        post: operations["grade_subjective_api_quiz_grade_subjective_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/quiz/mistakes/{student_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 错题本（按知识点聚合，含题干前 120 字）
         * @description 把 ``is_correct = 0`` 的学习记录按知识点聚合成错题。
         *
         *     - 学生不存在 → **404**（没有学习记录与「从没错过」是两件事，前端要能分开显示）；
         *     - 学生 id 非法 → **422**；库读写失败 → **503**。
         *
         *     ★ ``without_stem`` 显式告诉前端「还有几条错题没有题干记录」：
         *       QA / 编程轨答错时 ``question`` 是空串（那一轨不写题干），
         *       静默丢掉的话，学生会觉得「我明明错过它，这里怎么没有」。
         *
         *     ★★ ``limit`` **只截断列表**，两个汇总（``total_wrong`` / ``without_stem``）**恒为全量**：
         *       它们回答的是「累计答错多少次」，与学生这次翻到第几条知识点无关。
         *       界面上「累计答错 N 次」与页脚「已计入上面的错次统计」都按全量口径写死 ——
         *       截断后求和会让错得多的学生看到一个**偏小且不再增长**的数字。
         */
        get: operations["list_mistakes_api_quiz_mistakes__student_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/quiz/progress/{student_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 读闯关进度（learning.db 的 progress 表是唯一权威）
         * @description 读某学生的闯关进度。
         *
         *     ★ **冷启动兜底**（票 15/20 的验收项）：新学生 ``progress`` 表是空的，
         *       这里按**依赖图的拓扑序**自动初始化默认路径（只插不覆盖），
         *       再返回 —— 前端不会拿到空数组，也不会因为没数据而报错。
         *     ``kpIds`` 用于「本次答题影响到的关卡」这种小范围回读。
         */
        get: operations["read_progress_api_quiz_progress__student_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/quiz/variants": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 登记 LLM 生成的变式题（含标准答案；返回体不含答案）
         * @description 把 TS 侧生成的变式题**登记到该学生的 ``learning.db``**，并返回对外载荷。
         *
         *     ★ 两道闸门把「答案泄漏」挡在本端点之外：
         *
         *     ① **入参方向**：``reference_answer`` 是模型产出的**标准答案**，只进库、绝不回显；
         *     ② **出参方向**：返回体是 :class:`QuizPayload`，``questions`` 全是
         *        :class:`QuizQuestionOut`（结构上没有 ``answer``）——
         *        转换只走 ``QuizPayload.from_internal``，不存在第二条投影路径。
         *
         *     ★ ``qid`` 由 TS 侧生成（带随机段，见 ``quiz.ts`` 的 ``variantQid``）：
         *       Python 侧只做**形状校验**（长度/字符集/``gen-`` 前缀），不重新编号 ——
         *       重新编号会让「学生卡片上的 qid」与「后端登记的 qid」对不上，判分必 404。
         *
         *     ★★ **撞名防护（两道，见 :data:`GENERATED_QID_PREFIX` 的说明）**：
         *       ① 形状：``qid`` 必须带 ``gen-`` 前缀（在 :func:`_validate_variant` 里逐题拒）；
         *       ② 硬检查：与**题库真题的 qid** 撞名 → **整批拒**（与「同批 qid 重复」同一处置）。
         *
         *       为什么②必须是整批拒、而不是"只丢撞名那一道"：走到这一步说明生成侧给出了一个
         *       **与真题同名**的题，那不是「一道题没写好」，而是「这道题的去向搞错了」——
         *       它的答案会被写进 ``generated_question``，而 ``_locate_question`` **先生成题后题库**
         *       → 那道真题从此在这个学生这里判的是模型的答案（学生做的是真题，得分却是别人的答案）；
         *       同时批里其余的题也来自同一个有问题的生成调用，收下它们只是把问题藏起来。
         */
        post: operations["register_variants_api_quiz_variants_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/rag/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Rag Search
         * @description 按学段检索教材片段。
         *
         *     :param body: ``{query, gradeLevel, topK?, allowCompat?, includeExpansion?}``
         *         - ``gradeLevel``：学生**当前生效**的学段（由服务端推断，见 ``app/grade/rules.py``；
         *           学生端只读、**没有人工选择入口**），学段隔离在 SQL 层按它执行；
         *         - ``allowCompat``：是否允许取用更低学段的内容（命中标 ``compat=true``）；
         *         - ``includeExpansion``：是否把依赖图里的前置知识点补进上下文（有数量上限）。
         *
         *     响应里的 ``hits`` 带父块正文（注入 LLM 的上下文），``context`` 是拼好的可直接投喂文本，
         *     ``degraded`` 说明本次落在降级链的哪一级（vector → cloud → fts → outline）。
         */
        post: operations["rag_search_api_rag_search_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 读设置（Key 只回掩码） */
        get: operations["read_settings_api_settings_get"];
        /**
         * 存设置
         * @description 保存设置。
         *
         *     ``apiKey`` 提交空串或掩码（``…abcd``）**不会**抹掉已存 Key —— 用户没动这一栏时
         *     前端会把读回来的掩码原样提交；只有 ``clearApiKey=true`` 才删除。
         *     两栏都可省略（= 不动那一栏），但至少要提交一栏。
         *
         *     ★ **栏内也是「省略即保留」**：`PUT {"llm": {"baseUrl": "…"}}` 只改地址，
         *     不会顺手重置 provider / 模型 / Key（见 `apply_llm` / `apply_embedding`）。
         */
        put: operations["update_settings_api_settings_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/settings/models": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 拉取某个地址可见的模型清单（设置页的「拉取模型」）
         * @description 拉取 ``GET {baseUrl}/models`` 的模型 id 清单（**设置页填 ModelID 的辅助**）。
         *
         *     与 ``/settings/probe`` 的分工：
         *       - ``probe``  回答「这组配置**能不能用**」（成功/失败 + 可读原因）；
         *       - ``models`` 回答「这个地址**有哪些模型可选**」（清单）。
         *     两者共用同一套外呼实现（``ProbeTransport`` 注入点也相同），**不新增任何依赖**。
         *
         *     ``ok=False``（连不上 / 鉴权失败 / 端点没有模型清单）**不是致命错误**：
         *     调用方（主进程）会把 Pi 内置预设清单与这里的实时结果合并后交给设置页，
         *     所以这里失败时只需要给一句可读原因，界面照样能选到内置模型的候选。
         *
         *     ★ 与探测**共用同一条凭据边界**（`_resolve_probe_credentials`）：换了地址就不复用已存 Key。
         */
        post: operations["list_provider_models_api_settings_models_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/settings/probe": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 探测 LLM 连通性（票 07 实现）
         * @description 真实连通性探测（票 07 落地）：``GET {baseUrl}/models``，必要时补一条 1-token 对话请求。
         *
         *     ★ **BaseURL 的 `/v1` 陷阱**：默认值历史上是 ``https://api.deepseek.com/v1``（OpenAI 兼容习惯），
         *     而 Pi 内置 DeepSeek provider 用的是 ``https://api.deepseek.com``（**无 `/v1`**）。
         *     两者都可能连通、也都可能只有一种能连通，所以这里**不自动改写**用户填的值：
         *     先原样探测（探测的就是「保存后会用的那个地址」），只有在**路径不存在**（404/405）时才拿
         *     另一种写法做一次诊断，并在失败原因里明确告诉用户该改成哪一个。
         *
         *     探测的是**提交的候选配置**（先探测、满意再保存）：未提交的字段回落到已存值
         *     （与 `PUT /api/settings` 同一条「省略即保留」规则）。
         *
         *     ★★ **已存的明文 Key 只允许用于保存它的那个地址**（见 `_resolve_probe_credentials`）：
         *     Key 提交掩码/空串时**不是无条件复用**，只在提交的地址与已存地址一致时才复用；
         *     换了地址又没有提交新 Key，直接回一句可读中文而**不发出任何请求**。
         *     **探测失败不阻塞保存**（断网/离线演示仍要能存配置），失败原因一律是可读中文。
         */
        post: operations["probe_settings_api_settings_probe_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/settings/runtime": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * ★ 主进程专用：真正生效的那份 LLM 配置（**含明文 Key**）
         * @description ★★ **只给主进程用**：Pi 建会话 / 热切换时需要**明文 Key**。
         *
         *     ⚠️ 为什么必须有这条接口：Pi 在进程外无法读 ``config.json`` 的语义
         *     （原子写、损坏备份、snake/camel 双写容忍都在本模块），而设置页的读接口
         *     恒回掩码。没有它，「设置页改了配置 → Pi 用新配置」这条链路就断了
         *     （实测：改完设置重启，Pi 仍用旧的 ``models.json``）。
         *
         *     ⚠️ **安全边界**（三条一起才成立，缺一不可）：
         *       1. 与其它 ``/api/*`` 一样需要 ``X-Auth-Token``（token 只在主进程内存里）；
         *       2. 渲染进程**没有**对应 IPC 通道、preload **没有**对应方法（架构守卫断言）；
         *       3. 主进程拿到后只经 ``setRuntimeApiKey`` 放进内存，**不落盘、不进日志**。
         */
        get: operations["read_runtime_config_api_settings_runtime_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/students": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 学生列表 */
        get: operations["list_students_api_students_get"];
        put?: never;
        /**
         * 新建学生（含学段）
         * @description 新建学生。请求体校验（含四学段字面量）由契约模型完成，非法学段直接 422。
         *
         *     落盘位置：``<userData>/students/<id>/learning.db``（一人一库，§8.2）。
         */
        post: operations["create_student_api_students_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Health
         * @description 存活探针。
         *
         *     ``embedder_ready`` 为假**不代表 sidecar 不健康** —— 模型缺失时应用仍应能起来，
         *     只是检索会走降级链（FTS5 → 大纲）。所以这里不因缺模型而报错。
         */
        get: operations["health_health_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /**
         * AnimationPayload
         * @description 动画讲解载荷（§11.2：**模板优先**，自由生成只是补充路径）。
         */
        AnimationPayload: {
            /** Concept */
            concept: string;
            /** Durationms */
            durationMs: number;
            /**
             * Fallbackimage
             * @default null
             */
            fallbackImage: string | null;
            /** Fallbacktext */
            fallbackText: string;
            /** Html */
            html: string;
            /**
             * Source
             * @enum {string}
             */
            source: "template" | "generated";
        };
        /**
         * ChapterInfo
         * @description 一章教材（四学段共 24 章，来自知识点 front-matter 的 ``chapter_title``）。
         */
        ChapterInfo: {
            /** Chaptertitle */
            chapterTitle: string;
            /**
             * Kpcount
             * @default 0
             */
            kpCount: number;
            /** Kpids */
            kpIds?: string[];
            /**
             * Masteredcount
             * @default 0
             */
            masteredCount: number;
        };
        /**
         * ChapterListResponse
         * @description ``GET /api/knowledge/chapters/{grade_level}``：某学段的章节清单。
         */
        ChapterListResponse: {
            /** Chapters */
            chapters?: components["schemas"]["ChapterInfo"][];
            /**
             * Gradelevel
             * @enum {string}
             */
            gradeLevel: "primary_low" | "primary_high" | "junior" | "senior";
            /**
             * Withprogress
             * @default false
             */
            withProgress: boolean;
        };
        /**
         * ChapterProgress
         * @description 一章的闯关进度（把 ``progress`` 按 ``chapter_title`` 聚合）。
         */
        ChapterProgress: {
            /** Chaptertitle */
            chapterTitle: string;
            /**
             * Kpcount
             * @default 0
             */
            kpCount: number;
            /**
             * Masteredcount
             * @default 0
             */
            masteredCount: number;
            /**
             * Quizzedcount
             * @default 0
             */
            quizzedCount: number;
        };
        /**
         * ChapterStateOut
         * @description ``GET`` / ``PUT /api/profile/{student_id}/chapter``：当前章节状态（**读写同形**）。
         *
         *     ``chapter_title`` 的语义统一为「**空串 = 未选择**」（不是 ``None``）——
         *     前端只需要处理一种空值形态，少一个「空串还是 null」的分支。
         */
        ChapterStateOut: {
            /**
             * Chaptertitle
             * @default
             */
            chapterTitle: string;
            /**
             * Gradelevel
             * @enum {string}
             */
            gradeLevel: "primary_low" | "primary_high" | "junior" | "senior";
        };
        /**
         * ChapterUpdateRequest
         * @description ``PUT /api/profile/{student_id}/chapter``：设定/清除当前章节。
         *
         *     ★ **章节是软偏好，不是过滤条件**：它只会出现在画像 Prompt 里（「优先围绕本章」），
         *       **不改 ``RagSearchRequest``、不做 SQL 硬过滤** —— 学生问别的章节照常回答。
         *     ★ **为什么是学生显式选择而不是模型写**：与 ``PreferenceKey`` 同一条纪律 ——
         *       把「学生在学哪一章」交给模型猜，会同时污染 Prompt 与学习地图；
         *       而且模型写是**第二处真相**（学生自己点的那一下才是最权威的）。
         */
        ChapterUpdateRequest: {
            /**
             * Chaptertitle
             * @default
             */
            chapterTitle: string;
        };
        /**
         * ChatRequest
         * @description 一轮对话请求（**渲染进程 → 主进程 IPC**，不是 HTTP 端点）。
         *
         *     §6.3 v2 变更：``POST /api/chat/stream`` 已从 Python 侧移除，对话改由主进程的
         *     Pi Agent 处理；这里冻结的是 IPC 入参形状，供票 05/06 的主进程处理器与前端共用。
         *     ``requestId`` 由**主进程**生成并贯穿一轮（§9.4），所以不在请求体里。
         *
         *     ★★ **只有 ``text`` 一个字段，且与 ``desktop/src/main/ipc/channels.ts`` 的
         *       ``ChatSendRequest`` 逐字段同形**（守卫 G6c 把那一侧钉死为 ``['text']``）。
         *       这里曾经多出 ``student_id`` / ``session_id`` —— 那是**第二形状**，也是漂移温床：
         *
         *       - **学生身份只能由主进程决定**（``resolveActiveStudentId()`` / ``currentAgentSession()``）。
         *         契约里放一个 ``student_id``，等于给「读渲染进程递来的身份」留了一个合法入口 ——
         *         而那条路一旦走通，就是读别人的画像与学习记录。身份不进对话请求。
         *       - **会话同理**：Pi 会话由主进程持有，渲染进程连会话 id 都不该知道。
         *
         *       所以修法不是「把 TS 侧改成带上这两个字段」（那会把上面两条一起做废），
         *       而是**把契约收敛到真实形状**：``{text}``。测试 ``TestChatRequestContract``
         *       同时钉住字段集合恰好是这一个。
         *
         *     ⚠️ **没有学段/章节字段**（AGENTS §5.1 / D-037 / D-038）：学段与章节都**不由每轮对话携带**
         *     —— 学段自动推断、自动生效（学生手动指定走 ``grade:set``），章节走 ``chapter:set``。
         *     把它们放回请求里会让「发一条消息」变成「顺带改一次学段/章节」的副作用。
         *     历史上这里有过 ``grade_level: GradeLevel``（必填），与它自己的注释正好相反 —— 已删除，
         *     且测试钉住「不许再加回来」。
         */
        ChatRequest: {
            /** Text */
            text: string;
        };
        /**
         * Citation
         * @description 检索命中的引用条目（§6.4 的 `citation` 事件载荷，**字段与顺序冻结**）。
         *
         *     ``compat``：是否为「向上兼容」取用的更高学段内容 —— 跨学段时必须显式标注，
         *     前端要据此显示标记（执行文档 §6.3 / 业务陷阱清单 §2）。
         *
         *     ⚠️ **只有这 5 个字段**：事件载荷「一字不改」是票 13 的验收口径。
         *     检索内部还需要父块正文、相关性、知识点 id 等 —— 那些在 :class:`RagHit` 里，
         *     发射 `citation` 事件时**从 hit 投影出这 5 个字段**，不要把 hit 直接塞进事件。
         */
        Citation: {
            /** Chaptertitle */
            chapterTitle: string;
            /** Chunkid */
            chunkId: string;
            /** Compat */
            compat: boolean;
            /**
             * Gradelevel
             * @enum {string}
             */
            gradeLevel: "primary_low" | "primary_high" | "junior" | "senior";
            /** Sectiontitle */
            sectionTitle: string;
        };
        /**
         * CodeError
         * @description 归一化后的代码错误（面向学生）。原始 traceback 保留供家长/教师导出与排查。
         */
        CodeError: {
            /** Line */
            line?: number | null;
            /** Message */
            message: string;
            /**
             * Rawtraceback
             * @default
             */
            rawTraceback: string;
            /** Type */
            type: string;
        };
        /**
         * CodeEvaluation
         * @description ``POST /api/code/run-hint`` 的响应：运行结果 + 评估 + 下一级提示（§6.3）。
         */
        CodeEvaluation: {
            error?: components["schemas"]["CodeError"] | null;
            /** Feedback */
            feedback: string;
            nextHint?: components["schemas"]["CodingHint"] | null;
            /** Ok */
            ok: boolean;
            /** Stdout */
            stdout: string;
        };
        /**
         * CodeRunRequest
         * @description ``POST /api/code/run-hint`` 的请求体：把「提交的代码 + 报错」交给后端评估。
         *
         *     ⚠️ 学生代码**绝不在主进程（Pi Extension）执行**：它在渲染进程的 Pyodide Worker 里跑，
         *     这里收到的只是运行结果与 traceback（AGENTS §5.7）。
         */
        CodeRunRequest: {
            /**
             * Attempt
             * @default 1
             */
            attempt: number;
            /** Code */
            code: string;
            /** Kpid */
            kpId: string;
            /**
             * Language
             * @default python
             * @constant
             */
            language: "python";
            /**
             * Stderr
             * @default
             */
            stderr: string;
            /**
             * Stdout
             * @default
             */
            stdout: string;
            /** Studentid */
            studentId: string;
        };
        /**
         * CodeTemplate
         * @description 编程模板载荷（§11.3 / 票 19）。``scaffold`` 必须含明确的 TODO 标记。
         */
        CodeTemplate: {
            /** Expectedbehavior */
            expectedBehavior: string;
            /** Kpid */
            kpId: string;
            /**
             * Language
             * @default python
             * @constant
             */
            language: "python";
            /** Scaffold */
            scaffold: string;
        };
        /**
         * CodingHint
         * @description 分级提示（票 19：**不许直接给答案**，level 1 指方向 → level 3 才贴近骨架）。
         */
        CodingHint: {
            /** Hint */
            hint: string;
            /**
             * Level
             * @enum {integer}
             */
            level: 1 | 2 | 3;
        };
        /**
         * DailyActivity
         * @description 某一天的活动量（按**本地日期**聚合，不是 UTC —— 跨零点学习不该被算到前一天）。
         */
        DailyActivity: {
            /**
             * Correctcount
             * @default 0
             */
            correctCount: number;
            /**
             * Count
             * @default 0
             */
            count: number;
            /** Day */
            day: string;
            /**
             * Quizcount
             * @default 0
             */
            quizCount: number;
        };
        /**
         * Degraded
         * @enum {string}
         */
        Degraded: "vector" | "cloud" | "fts" | "outline";
        /**
         * DepDirection
         * @enum {string}
         */
        DepDirection: "successor" | "prerequisite";
        /**
         * DepNode
         * @description 依赖图查询结果条目（``GET /api/graph/deps/{kp_id}``）。
         *
         *     **`from → to` 语义全项目一致：`from` 是前置、`to` 是后继。**
         *     ``direction`` 显式标明这条边相对被查询知识点是哪一侧，双用途据此分流：
         *     ``successor`` 用于推荐路径，``prereq`` 用于检索上下文扩展。
         */
        DepNode: {
            /**
             * Depth
             * @default 1
             */
            depth: number;
            /**
             * Direction
             * @enum {string}
             */
            direction: "successor" | "prerequisite";
            /**
             * Gradelevel
             * @enum {string}
             */
            gradeLevel: "primary_low" | "primary_high" | "junior" | "senior";
            /** Kpid */
            kpId: string;
            /** Name */
            name: string;
            /**
             * Relation
             * @default prerequisite
             * @enum {string}
             */
            relation: "prerequisite" | "related";
            /**
             * Weight
             * @default 1
             */
            weight: number;
        };
        /**
         * DepRelation
         * @enum {string}
         */
        DepRelation: "prerequisite" | "related";
        /**
         * EmbeddingConfig
         * @description 嵌入配置的**出参形态**（§6.2）。``mode="none"`` 表示不用嵌入（检索走 FTS5 兜底）。
         */
        EmbeddingConfig: {
            /**
             * Apikey
             * @default
             */
            apiKey: string;
            /** Baseurl */
            baseUrl?: string | null;
            /**
             * Haskey
             * @default false
             */
            hasKey: boolean;
            /**
             * Mode
             * @default local_fastembed
             * @enum {string}
             */
            mode: "local_fastembed" | "cloud_api" | "none";
            /** Modelid */
            modelId?: string | null;
        };
        /**
         * EmbeddingConfigIn
         * @description 嵌入配置的**入参形态**（``mode="cloud_api"`` 时才有 base_url/api_key/model_id）。
         *
         *     ★ **四个字段都是「省略即保留」**（与 :class:`LlmConfigIn` 同一条规则）：
         *     只提交某一个字段（例如只换 API Key）不会顺手把 ``mode`` 退回 ``local_fastembed``，
         *     也不会清掉云端地址与模型 ID。
         */
        EmbeddingConfigIn: {
            /**
             * Apikey
             * @default
             */
            apiKey: string;
            /** Baseurl */
            baseUrl?: string | null;
            /**
             * Clearapikey
             * @default false
             */
            clearApiKey: boolean;
            /** Haskey */
            hasKey?: boolean | null;
            /** Mode */
            mode?: ("local_fastembed" | "cloud_api" | "none") | null;
            /** Modelid */
            modelId?: string | null;
        };
        /**
         * EmbeddingMode
         * @enum {string}
         */
        EmbeddingMode: "local_fastembed" | "cloud_api" | "none";
        /**
         * GradeEvaluationOut
         * @description 一轮的判定结论（演示脚本与报告直接用它叙述「第 N 轮为什么没改」）。
         */
        GradeEvaluationOut: {
            /** Changed */
            changed: boolean;
            /** Confidence */
            confidence: number;
            /** Direction */
            direction: number;
            /**
             * Grade
             * @enum {string}
             */
            grade: "primary_low" | "primary_high" | "junior" | "senior";
            /** Reason */
            reason: string;
            /** Streak */
            streak: number;
            /** Turn */
            turn: number;
        };
        /**
         * GradeHistoryEntry
         * @description ``grade_history`` 的一行（学段变化轨迹）。
         *
         *     ★ **为什么它在 ``contracts.py`` 而不在 ``routes/grade.py``**：学习报告的
         *       ``GET /api/profile/{id}/report`` 要**复用同一份**轨迹模型。留在路由文件里的话，
         *       报告轨只能「再定义一个同形模型」——那就违背了「pydantic 是唯一契约来源」，
         *       两边的字段迟早分叉（``routes/grade.py`` 的模块注释原本就把这条列为待补项）。
         *     ★ 冷启动基线那行 ``from_level`` 为空（学生还没有「上一段」，不是从一个学段变过来的）。
         *     ★ **手动覆盖重复选同一学段时也会写一行**（``from_level == to_level``，
         *       ``source="explicit"``）：那一行不改变学段，但它是「学生确认过」的留痕与冷却锚点。
         */
        GradeHistoryEntry: {
            /**
             * Confidence
             * @default 0
             */
            confidence: number;
            /** Decidedby */
            decidedBy?: string | null;
            /** Fromlevel */
            fromLevel?: ("primary_low" | "primary_high" | "junior" | "senior") | null;
            /** Source */
            source: string;
            /**
             * Tolevel
             * @enum {string}
             */
            toLevel: "primary_low" | "primary_high" | "junior" | "senior";
            /** Ts */
            ts: number;
            /** Turn */
            turn: number;
        };
        /**
         * GradeHistoryResponse
         * @description ``grade_history`` 轨迹（报告叙事：「第 3 轮调为小学低年级（0.75）」）。
         *
         *     ★ ``entries`` 用契约里的 :class:`app.contracts.GradeHistoryEntry`：学习报告的
         *       ``/api/profile/{id}/report`` 要给出**同一份**轨迹，两处各定义一个同形模型迟早分叉
         *       （这原是本文件模块头「需要 contracts.py 补的模型」第 2 条，现已兑现）。
         */
        GradeHistoryResponse: {
            /**
             * Currentlevel
             * @enum {string}
             */
            currentLevel: "primary_low" | "primary_high" | "junior" | "senior";
            /** Entries */
            entries?: components["schemas"]["GradeHistoryEntry"][];
            /** Studentid */
            studentId: string;
        };
        /**
         * GradeLevel
         * @enum {string}
         */
        GradeLevel: "primary_low" | "primary_high" | "junior" | "senior";
        /**
         * GradeOverrideRequest
         * @description ``POST /api/grade/override/{student_id}`` 的请求体。
         *
         *     ★★ **刻意不提供 ``note``（留痕说明）字段** —— 这是取舍，不是省事：
         *     ``grade_history`` 只存结构化字段，没有放**任意文本**的列；多出来的说明
         *     **没有地方落盘**；退而求其次写进日志又违反「日志里不出现学生文本」的合规要求。
         *     收下一个**写不进去**的字段等于让接口撒谎：调用方以为自己留了痕，其实内容被静默丢弃，
         *     之后排查时还会以为「日志里没有是因为没填」。宁可不提供。
         *
         *     ★ 请求体里**也不需要会话 id**：冷却锚点记的是 ``grade_signals`` 的**信号位标**
         *     （全局单调、跨会话可比），不是某个会话里的轮次号 —— 服务端写这一行时自己就能取到。
         *     详见 ``app/grade/rules.py`` 的 ``_cooldown_remaining``。
         */
        GradeOverrideRequest: {
            /**
             * Gradelevel
             * @enum {string}
             */
            gradeLevel: "primary_low" | "primary_high" | "junior" | "senior";
        };
        /**
         * GradeOverrideResponse
         * @description 学生手动设定学段的结果（**立即生效**，不依赖任何信号）。
         */
        GradeOverrideResponse: {
            /** Changed */
            changed: boolean;
            /** Cooldownremainingturns */
            cooldownRemainingTurns: number;
            /**
             * Gradelevel
             * @enum {string}
             */
            gradeLevel: "primary_low" | "primary_high" | "junior" | "senior";
            /**
             * Previouslevel
             * @enum {string}
             */
            previousLevel: "primary_low" | "primary_high" | "junior" | "senior";
            /**
             * Source
             * @default explicit
             * @constant
             */
            source: "explicit";
            /** Studentid */
            studentId: string;
            /** Turn */
            turn: number;
        };
        /**
         * GradeProposalInput
         * @description 第二层 LLM 的**提议**（``{suggestedGrade, confidence}``）。
         *
         *     ★ 它只是提议：规则引擎可以采纳（同向时抬高置信度）、可以无视，也可以否决（反向）。
         */
        GradeProposalInput: {
            /** Confidence */
            confidence: number;
            /**
             * Note
             * @default
             */
            note: string;
            /**
             * Suggestedgrade
             * @enum {string}
             */
            suggestedGrade: "primary_low" | "primary_high" | "junior" | "senior";
        };
        /**
         * GradeSignal
         * @description 一条学段判定信号（§8.3 `grade_signals`）。
         */
        GradeSignal: {
            /** Raw */
            raw?: string | null;
            /**
             * Signaltype
             * @enum {string}
             */
            signalType: "vocab" | "depth" | "quiz_perf" | "meta_cognition";
            /** Ts */
            ts?: number | null;
            /** Value */
            value: number;
        };
        /**
         * GradeSignalType
         * @enum {string}
         */
        GradeSignalType: "vocab" | "depth" | "quiz_perf" | "meta_cognition";
        /**
         * GradeSignals
         * @description ``GET /api/grade/signals/{student_id}``：学段信号与推断检视面。
         *
         *     ⚠️ 学段**默认由系统自动推断、自动生效**，学生也可以**手动覆盖**：
         *     规则引擎（``app/grade/rules.py``）达到阈值时会直接改写 ``student.grade_level``
         *     并写 ``grade_history(source="inferred")``；学生手动切换则写 ``source="explicit"``
         *     并进入更长的冷却（``MANUAL_COOLDOWN_TURNS``）。``suggested_level`` 只是
         *     **本轮检视用的建议值**（置信度 < 0.6 时 ``None``），**不是**等待确认的动作入口。
         */
        GradeSignals: {
            /**
             * Confidence
             * @default 0
             */
            confidence: number;
            /**
             * Currentlevel
             * @enum {string}
             */
            currentLevel: "primary_low" | "primary_high" | "junior" | "senior";
            /** Signals */
            signals?: components["schemas"]["GradeSignal"][];
            /**
             * Source
             * @default inferred
             * @enum {string}
             */
            source: "inferred" | "explicit";
            /** Studentid */
            studentId: string;
            /** Suggestedlevel */
            suggestedLevel?: ("primary_low" | "primary_high" | "junior" | "senior") | null;
        };
        /**
         * GradeStateOut
         * @description 轻量状态（桌面端每轮取「当前学段」；不含信号列表）。
         */
        GradeStateOut: {
            /**
             * Confidence
             * @default 0
             */
            confidence: number;
            /**
             * Cooldownremainingturns
             * @default 0
             */
            cooldownRemainingTurns: number;
            /**
             * Cumulativeturns
             * @default 0
             */
            cumulativeTurns: number;
            /** Decidedby */
            decidedBy?: string | null;
            /**
             * Direction
             * @default 0
             */
            direction: number;
            /**
             * Grade
             * @enum {string}
             */
            grade: "primary_low" | "primary_high" | "junior" | "senior";
            /** Lastchangeturn */
            lastChangeTurn?: number | null;
            /**
             * Lastturn
             * @default 0
             */
            lastTurn: number;
            /** Source */
            source: string;
            /**
             * Streak
             * @default 0
             */
            streak: number;
            /** Studentid */
            studentId: string;
            /** Suggestedlevel */
            suggestedLevel?: ("primary_low" | "primary_high" | "junior" | "senior") | null;
        };
        /**
         * GradeTurnInput
         * @description **一轮**证据：轮次号 + 学生原话 + （可选）第二层提议与其**通道状态**。
         *
         *     ★ 2026-09-21：原先还有一个 ``quiz``（答题表现）。已随那条信号一起移除 ——
         *     答题表现不该改学段（那是 ``mastery`` 的事），而且它会从原文里捡「太难了」
         *     与元认知重复计数。见 ``app/grade/signals.py`` 的模块 docstring。
         *     ⚠️ 不要再把它加回来：契约收下一个字段，就等于承诺它会参与判定。
         */
        GradeTurnInput: {
            /** Layer2Status */
            layer2Status?: string | null;
            proposal?: components["schemas"]["GradeProposalInput"] | null;
            /** Sessionid */
            sessionId?: string | null;
            /**
             * Text
             * @default
             */
            text: string;
            /** Turn */
            turn: number;
        };
        /**
         * GradeTurnResponse
         * @description 上交证据后的判定结果（**服务端决策**，桌面端只负责按它换下一轮的 prompt）。
         */
        GradeTurnResponse: {
            /** Changed */
            changed: boolean;
            /** Confidence */
            confidence: number;
            /** Cooldownremainingturns */
            cooldownRemainingTurns: number;
            /** Decidedby */
            decidedBy?: string | null;
            /** Degraded */
            degraded?: string | null;
            /** Direction */
            direction: number;
            /** Evaluations */
            evaluations?: components["schemas"]["GradeEvaluationOut"][];
            /**
             * Grade
             * @enum {string}
             */
            grade: "primary_low" | "primary_high" | "junior" | "senior";
            /** Llmconfidence */
            llmConfidence?: number | null;
            /**
             * Previousgrade
             * @enum {string}
             */
            previousGrade: "primary_low" | "primary_high" | "junior" | "senior";
            /** Reason */
            reason: string;
            /** Ruleconfidence */
            ruleConfidence: number;
            /** Signals */
            signals?: components["schemas"]["GradeSignal"][];
            /** Source */
            source: string;
            /** Streak */
            streak: number;
            /** Studentid */
            studentId: string;
            /** Turn */
            turn: number;
        };
        /**
         * GradeTurnsRequest
         * @description ``POST /api/grade/turns/{student_id}`` 的请求体（**一批轮次证据**，按轮次升序）。
         */
        GradeTurnsRequest: {
            /** Turns */
            turns: components["schemas"]["GradeTurnInput"][];
        };
        /**
         * GraphEdge
         * @description 一条依赖边。**``from`` 是前置、``to`` 是后继**（全项目一致，方向搞反是静默错）。
         */
        GraphEdge: {
            /** Fromkpid */
            fromKpId: string;
            /**
             * Relation
             * @default prerequisite
             * @enum {string}
             */
            relation: "prerequisite" | "related";
            /** Tokpid */
            toKpId: string;
            /**
             * Weight
             * @default 1
             */
            weight: number;
        };
        /**
         * GraphNode
         * @description 依赖图里的一个知识点（学习地图的节点）。
         */
        GraphNode: {
            /**
             * Chaptertitle
             * @default
             */
            chapterTitle: string;
            /**
             * Gradelevel
             * @enum {string}
             */
            gradeLevel: "primary_low" | "primary_high" | "junior" | "senior";
            /** Kpid */
            kpId: string;
            /**
             * Layer
             * @default 0
             */
            layer: number;
            /**
             * Mastered
             * @default false
             */
            mastered: boolean;
            /** Name */
            name: string;
        };
        /**
         * GraphOverview
         * @description ``GET /api/graph/overview/{grade_level}``：某学段依赖图的**全览**（学习地图用）。
         *
         *     ★ 与 ``/api/graph/deps/{kp_id}``（单点邻域）的分工：那个接口回答「这个点的前后是什么」，
         *       这个回答「整张图长什么样」。**遍历逻辑仍只有一份**（``app.knowledge.deps``），
         *       本模型只是它的出参形状。
         *
         *     ⚠️ ``edges`` 只包含**两端都在 ``nodes`` 里**的边：跨学段的边在单学段视图里没有落点，
         *       画不出来（传进来只会画出悬空的线）。
         */
        GraphOverview: {
            /** Edges */
            edges?: components["schemas"]["GraphEdge"][];
            /**
             * Gradelevel
             * @enum {string}
             */
            gradeLevel: "primary_low" | "primary_high" | "junior" | "senior";
            /** Nodes */
            nodes?: components["schemas"]["GraphNode"][];
        };
        /** HTTPValidationError */
        HTTPValidationError: {
            /** Detail */
            detail?: components["schemas"]["ValidationError"][];
        };
        /**
         * HealthResponse
         * @description ``GET /health`` 响应（执行文档 §6.3）。
         *
         *     免鉴权，Electron 启动期轮询它判断 sidecar 是否可用。
         *     ``embedder_ready`` 为假**不代表 sidecar 不健康** —— 模型缺失时应用仍应能起来，
         *     只是检索会走降级链。
         */
        HealthResponse: {
            /** Embedderready */
            embedderReady: boolean;
            /** Status */
            status: string;
            /** Version */
            version: string;
        };
        /**
         * IpcEventName
         * @enum {string}
         */
        IpcEventName: "delta" | "citation" | "payload" | "blocked" | "done" | "error";
        /**
         * KnowledgeImportRequest
         * @description ``POST /api/knowledge/import``：导入一份教材 Markdown。
         *
         *     ★ 为什么是**正文 JSON**而不是 multipart 文件上传：内容只有一份 Markdown 文本，
         *       走 multipart 要给 sidecar 加 ``python-multipart`` 依赖、还要让主进程处理二进制，
         *       换来的只是「省一次字符串传递」。渲染进程已经用 ``file.text()`` 读到了正文。
         */
        KnowledgeImportRequest: {
            /** Filename */
            fileName: string;
            /** Gradelevel */
            gradeLevel?: ("primary_low" | "primary_high" | "junior" | "senior") | null;
            /** Markdown */
            markdown: string;
            /**
             * Rebuild
             * @default true
             */
            rebuild: boolean;
        };
        /**
         * KnowledgeImportResponse
         * @description 导入回执。
         *
         *     ``ok=false`` 时 ``problems`` **逐条**列出未通过的原因（格式错 / 超纲术语 /
         *     语气错位 / 跨学段搬运）—— 这类错误必须能定位到具体是哪一条，
         *     只回一句「导入失败」等于让学生自己猜。
         */
        KnowledgeImportResponse: {
            /** Kpid */
            kpId?: string | null;
            /**
             * Message
             * @default
             */
            message: string;
            /**
             * Ok
             * @default false
             */
            ok: boolean;
            /** Problems */
            problems?: string[];
            /** Savedas */
            savedAs?: string | null;
            stats?: components["schemas"]["KnowledgeStats"] | null;
        };
        /**
         * KnowledgePointItem
         * @description 教材里**一个知识点**的一行（教材知识库页的表格）。
         *
         *     ★ 与 :class:`ChapterInfo` 的关系：那个是「一章 = 多个知识点」，这个是「一个知识点 = 一行」。
         *     表格要按知识点列，所以单开一个模型，而不是让后端把 ``ChapterInfo.kp_ids`` 展开成
         *     「前端需要的样子」—— 拆解属于展示逻辑，不该由数据层代劳。
         */
        KnowledgePointItem: {
            /**
             * Chaptertitle
             * @default
             */
            chapterTitle: string;
            /**
             * Chunkcount
             * @default 0
             */
            chunkCount: number;
            /**
             * Contenttype
             * @default
             */
            contentType: string;
            /**
             * Embedded
             * @default false
             */
            embedded: boolean;
            /**
             * Gradelevel
             * @enum {string}
             */
            gradeLevel: "primary_low" | "primary_high" | "junior" | "senior";
            /** Kpid */
            kpId: string;
            /** Name */
            name: string;
        };
        /**
         * KnowledgePointListResponse
         * @description ``GET /api/knowledge/points``：知识点清单（可按学段过滤）。
         */
        KnowledgePointListResponse: {
            /** Gradelevel */
            gradeLevel?: ("primary_low" | "primary_high" | "junior" | "senior") | null;
            /** Points */
            points?: components["schemas"]["KnowledgePointItem"][];
        };
        /**
         * KnowledgeRebuildResponse
         * @description ``POST /api/knowledge/rebuild``：重建索引的回执。
         *
         *     ★ 重建是**重活**（分块 + ONNX 嵌入整份教材，秒级到十几秒），所以：
         *       ① 端点用线程池跑，不阻塞事件循环；
         *       ② 回执带 ``elapsed_ms``（界面要显示「用时 3.2s」，否则看起来像卡死）；
         *       ③ 失败必须给出**可读中文原因**（模型缺失 / 维度不符 / 教材格式错），而不是一个 500
         *          —— 界面有专门的失败横幅要显示它。
         */
        KnowledgeRebuildResponse: {
            /**
             * Dependencies
             * @default 0
             */
            dependencies: number;
            /**
             * Documents
             * @default 0
             */
            documents: number;
            /**
             * Elapsedms
             * @default 0
             */
            elapsedMs: number;
            /**
             * Message
             * @default
             */
            message: string;
            /**
             * Ok
             * @default false
             */
            ok: boolean;
            stats?: components["schemas"]["KnowledgeStats"] | null;
        };
        /**
         * KnowledgeStats
         * @description ``GET /api/knowledge/stats``：知识库体检数字（统计卡 + 版本信息）。
         *
         *     ★ 这些数字**必须由后端算**：它们来自 ``kb.sqlite`` 的表行数，
         *       前端既读不到 SQLite（架构硬边界：数据域只在 Python），也不该自己数一遍已知的行。
         */
        KnowledgeStats: {
            /** Counts */
            counts?: {
                [key: string]: number;
            };
            /**
             * Embeddingdim
             * @default 512
             */
            embeddingDim: number;
            /**
             * Embeddingmodel
             * @default
             */
            embeddingModel: string;
            /** Gradelevels */
            gradeLevels?: ("primary_low" | "primary_high" | "junior" | "senior")[];
            /**
             * Kbpath
             * @default
             */
            kbPath: string;
            /**
             * Userrebuilt
             * @default false
             */
            userRebuilt: boolean;
            /**
             * Vecready
             * @default false
             */
            vecReady: boolean;
        };
        /**
         * LearningActivity
         * @enum {string}
         */
        LearningActivity: "qa" | "animation" | "coding" | "quiz";
        /**
         * LearningEventAck
         * @description 写入类端点的回执（§6.3：``{ok}``）：学习记录回流与学习偏好写入**共用同一形状**。
         *
         *     ★ 偏好写入**复用**本模型而不是再造一个等价的 ``PreferenceAck``：两者的出参形状
         *       一字不差（``{ok: true}``），同形状两个模型名只会让 OpenAPI/TS 多一个语义重复的
         *       类型、让前端多写一个分支去认同一个 ``{ok}``。**新增写入型端点时也复用它。**
         */
        LearningEventAck: {
            /**
             * Ok
             * @default true
             */
            ok: boolean;
        };
        /**
         * LearningEventRequest
         * @description ``POST /api/profile/{student_id}/events`` 的请求体（学习记录写入）。
         *
         *     由 ``learning-log`` Extension 构造，字段全部是**从对话里提取出来的结构化信息**：
         *     没有任何一个字段用于承载对话正文（这是有意的，见模块头）。
         */
        LearningEventRequest: {
            /**
             * Activity
             * @enum {string}
             */
            activity: "qa" | "animation" | "coding" | "quiz";
            /**
             * Detail
             * @default
             */
            detail: string;
            /** Gradelevel */
            gradeLevel?: ("primary_low" | "primary_high" | "junior" | "senior") | null;
            /** Iscorrect */
            isCorrect?: boolean | null;
            /**
             * Kpid
             * @default
             */
            kpId: string;
            /** Sessionid */
            sessionId?: string | null;
        };
        /**
         * LearningReport
         * @description ``GET /api/profile/{student_id}/report``：学习报告（学生 / 家长）。
         *
         *     ★ **四张表都在里面**（``mastery`` / ``learning_history`` / ``progress`` / ``grade_history``），
         *       此前它们各自只有零散出口，没有一个「这一周学得怎么样」的汇合点。
         *     ★ ``grade_history`` 直接复用 :class:`GradeHistoryEntry`（见该模型的注释）。
         */
        LearningReport: {
            /** Badges */
            badges?: string[];
            /** Chapters */
            chapters?: components["schemas"]["ChapterProgress"][];
            /** Daily */
            daily?: components["schemas"]["DailyActivity"][];
            /**
             * Days
             * @default 7
             */
            days: number;
            /**
             * Generatedat
             * @default 0
             */
            generatedAt: number;
            /** Gradehistory */
            gradeHistory?: components["schemas"]["GradeHistoryEntry"][];
            /**
             * Gradelevel
             * @enum {string}
             */
            gradeLevel: "primary_low" | "primary_high" | "junior" | "senior";
            /** Mastery */
            mastery?: components["schemas"]["Mastery"][];
            /**
             * Nickname
             * @default
             */
            nickname: string;
            /**
             * Quizcorrect
             * @default 0
             */
            quizCorrect: number;
            /**
             * Quiztotal
             * @default 0
             */
            quizTotal: number;
            /** Stagecounts */
            stageCounts?: {
                [key: string]: number;
            };
            /**
             * Streakdays
             * @default 0
             */
            streakDays: number;
            /** Studentid */
            studentId: string;
            /**
             * Todaystudied
             * @default false
             */
            todayStudied: boolean;
            /**
             * Totalactivities
             * @default 0
             */
            totalActivities: number;
        };
        /**
         * LlmConfig
         * @description LLM 配置的**出参形态**（发给渲染进程 / 与磁盘一致的只读视图）。
         *
         *     ⚠️ ``api_key`` 在这里**恒为掩码**（``…abcd``）或空串，绝不会是明文；
         *     需要明文的地方只有存储层，用 {@link LlmConfigIn} 提交。
         *     **请一律经 :meth:`from_plain` 构造**，别手拼 ``api_key=`` 把明文漏出去。
         */
        LlmConfig: {
            /**
             * Apikey
             * @default
             */
            apiKey: string;
            /**
             * Baseurl
             * @default https://api.deepseek.com
             */
            baseUrl: string;
            /**
             * Haskey
             * @default false
             */
            hasKey: boolean;
            /**
             * Modelid
             * @default deepseek-v4-flash
             */
            modelId: string;
            /**
             * Providerid
             * @default deepseek
             */
            providerId: string;
            /**
             * Providername
             * @default DeepSeek
             */
            providerName: string;
        };
        /**
         * LlmConfigIn
         * @description LLM 配置的**入参形态**（``PUT /api/settings``）。
         *
         *     ★ **字段级「省略即保留」**：除 ``api_key`` 外每个字段都是 ``X | None = None``，
         *     **没提交**（或提交空白）就保留已存值，只有真提交了非空值才覆盖。
         *     ⚠️ 这里**不许再出现出厂默认值**：`PUT {"llm": {"apiKey": "…"}}` 这种字段级局部提交
         *     （设置页分栏保存 / 只换 Key）若被当成「未提交字段取默认值」，就会把用户自填的
         *     校内网关静默换回 DeepSeek 默认值 —— 改一次 Key 丢一次配置。
         *
         *     ``api_key`` 语义见模块头的「API Key 掩码语义」：
         *     空串/掩码/纯符号 = 保留已存值；明文 = 覆盖；``clear_api_key=true`` = 显式删除。
         */
        LlmConfigIn: {
            /**
             * Apikey
             * @default
             */
            apiKey: string;
            /** Baseurl */
            baseUrl?: string | null;
            /**
             * Clearapikey
             * @default false
             */
            clearApiKey: boolean;
            /** Haskey */
            hasKey?: boolean | null;
            /** Modelid */
            modelId?: string | null;
            /** Providerid */
            providerId?: string | null;
            /** Providername */
            providerName?: string | null;
        };
        /**
         * LlmRuntimeConfig
         * @description ★★ **主进程专用**：真正生效的那份 LLM 配置（**含明文 Key**）。
         *
         *     ⚠️⚠️ 与 :class:`LlmConfig` 的关键差异：``api_key`` 在这里**是明文**。
         *     它是「设置 → Pi」这条链路的唯一载体（Pi 需要明文 Key 才能发请求），
         *     因此**只允许主进程取用**：
         *
         *     - 路由只有 ``GET /api/settings/runtime``，与其它 ``/api/*`` 一样需要 ``X-Auth-Token``；
         *     - **渲染进程没有对应 IPC 通道、preload 也没有对应方法**（架构守卫会断言这一点）；
         *     - 主进程拿到后**只经 ``setRuntimeApiKey`` 放进内存**，不落盘、不进日志。
         *
         *     ``repr=False`` 兜住「异常里打印 dataclass/model」这类常见事故。
         */
        LlmRuntimeConfig: {
            /**
             * Apikey
             * @default
             */
            apiKey: string;
            /**
             * Baseurl
             * @default https://api.deepseek.com
             */
            baseUrl: string;
            /**
             * Haskey
             * @default false
             */
            hasKey: boolean;
            /**
             * Modelid
             * @default deepseek-v4-flash
             */
            modelId: string;
            /**
             * Providerid
             * @default deepseek
             */
            providerId: string;
            /**
             * Providername
             * @default DeepSeek
             */
            providerName: string;
        };
        /**
         * Mastery
         * @description 单知识点掌握度（§8.3 `mastery`）。``score`` 0..1。
         */
        Mastery: {
            /**
             * Attempts
             * @default 0
             */
            attempts: number;
            /**
             * Correct
             * @default 0
             */
            correct: number;
            /** Kpid */
            kpId: string;
            /** Lastseenat */
            lastSeenAt?: number | null;
            /**
             * Score
             * @default 0
             */
            score: number;
        };
        /**
         * MistakeItem
         * @description 一条错题（按知识点聚合后的一条）。
         *
         *     ★★ **合规口径（两条，都是刻意的）**：
         *       ① ``stem`` 来自 ``learning_history.question``，库里存的是**题干前 120 字**
         *          （``routes/quiz.py`` 的 ``_record_attempt`` 写入 ``stem[:120]``）——题干是题目本身，
         *          **不是学生原话**；学生作答与模型回答一律不入库（§8.1 合规红线），
         *          所以这个模型**结构上就没有**「你的答案」字段，不是忘了加。
         *       ② **绝不 join ``generated_question`` 取完整题干**：那张表带 ``reference_answer``（标准答案），
         *          把它读进对外响应会直接踩答案泄漏红线（``INTERNAL_MODELS`` / 答案属性白名单都在守这条）。
         *          120 字足够让学生认出「是这道题」，而认出之后要的是「再练一遍」而不是看答案。
         */
        MistakeItem: {
            /**
             * Chaptertitle
             * @default
             */
            chapterTitle: string;
            /** Kpid */
            kpId: string;
            /**
             * Kpname
             * @default
             */
            kpName: string;
            /**
             * Lastqid
             * @default
             */
            lastQid: string;
            /**
             * Lastwrongat
             * @default 0
             */
            lastWrongAt: number;
            /**
             * Stem
             * @default
             */
            stem: string;
            /**
             * Wrongcount
             * @default 0
             */
            wrongCount: number;
        };
        /**
         * MistakeListResponse
         * @description ``GET /api/quiz/mistakes/{student_id}``：错题本（按知识点聚合）。
         */
        MistakeListResponse: {
            /**
             * Gradelevel
             * @enum {string}
             */
            gradeLevel: "primary_low" | "primary_high" | "junior" | "senior";
            /** Items */
            items?: components["schemas"]["MistakeItem"][];
            /** Studentid */
            studentId: string;
            /**
             * Totalwrong
             * @default 0
             */
            totalWrong: number;
            /**
             * Withoutstem
             * @default 0
             */
            withoutStem: number;
        };
        /**
         * OpeningGuidance
         * @description ``GET /api/profile/{student_id}/opening``：新会话的**开场引导**。
         *
         *     需求原文：「学生可主动提问对话，**智能体也能主动发起对话引导学习章节内容**。」
         *     这是全项目**唯一一处「AI 先开口」**的机制 —— 其余所有交互都是「学生问 → AI 答」。
         *
         *     ★★ 为什么它必须是一个**契约模型**而不是一句硬编码的欢迎语：开场语的内容来自
         *       「依赖图 + 掌握度 + 冷启动」的推荐结论（``routes/profile.py`` 的
         *       :func:`build_recommendation`，那是推荐路径的**唯一实现**）。写死的欢迎语
         *       对谁都成立，等于没有引导 —— 而「针对性引导到合适的内容」才是这项功能的价值。
         *
         *     ★ ``source == "empty"`` 时 ``text`` **必须是空串**：前端据此**不发**开场，
         *       而不是弹一句「今天想学什么？」这种对谁都成立的废话（没有依据的开场白
         *       与随机挑一个知识点没有区别）。
         *
         *     ★ 它**不参与 6 事件词表**：开场语不是「一轮对话的流式事件」，而是
         *       「会话建立」这一步的产物 —— 主进程在新建会话时取一次，作为一条独立消息
         *       推给界面（与 `trace:changed` 同一性质：独立通道，不是第 7 个事件）。
         */
        OpeningGuidance: {
            /** Kpid */
            kpId?: string | null;
            /**
             * Source
             * @default empty
             * @enum {string}
             */
            source: "review" | "graph" | "cold_start" | "empty";
            /**
             * Text
             * @default
             */
            text: string;
        };
        /**
         * PayloadKind
         * @enum {string}
         */
        PayloadKind: "animation" | "coding" | "quiz";
        /**
         * PreferenceKey
         * @enum {string}
         */
        PreferenceKey: "interest" | "explain_style" | "pace" | "note";
        /**
         * PreferenceUpdateRequest
         * @description ``PUT /api/profile/{student_id}/preferences``：写一条学习偏好。
         *
         *     值只承载**学习方式**（喜好领域 / 讲解方式 / 节奏 / 一句备注），不承载任何个人信息。
         *
         *     ★ **为什么是 PUT 而不是 POST**：单键 upsert 是**幂等**操作 —— 同一个 key 提交两次，
         *       库里的状态完全相同（``profile_pref.key`` 是主键，第二次是覆盖而不是追加）。
         *       POST 会暗示「新增一条记录」，与实际的覆盖语义正好相反。
         *
         *     ★ **为什么 key 是封闭词表**：见 :data:`PreferenceKey` —— 写掌握度/学段这类
         *       由规则引擎算出来的客观量，在**类型层面**就不可能（不是靠调用方自觉）。
         */
        PreferenceUpdateRequest: {
            /**
             * Key
             * @enum {string}
             */
            key: "interest" | "explain_style" | "pace" | "note";
            /** Value */
            value: string;
        };
        /**
         * ProbeRequest
         * @description ``POST /api/settings/probe`` 的请求体（**票 07 实现探测**）。
         *
         *     探测的是**提交的候选配置**而非已存配置，这样「先探测、满意再保存」才成立。
         *     ``api_key`` 允许是占位（== 用已存 Key）——实现方用 :func:`resolve_api_key` 解析。
         */
        ProbeRequest: {
            llm: components["schemas"]["LlmConfigIn"];
        };
        /**
         * ProbeResult
         * @description ``POST /api/settings/probe`` 的响应（§6.3）。
         *
         *     ``message`` 必须**可读**：401 / 超时 / DNS / 404 要说清是哪一种（票 07）。
         */
        ProbeResult: {
            /** Message */
            message: string;
            /** Ok */
            ok: boolean;
        };
        /**
         * ProgressStage
         * @enum {string}
         */
        ProgressStage: "locked" | "learning" | "quizzed" | "mastered";
        /**
         * ProviderModelsRequest
         * @description ``POST /api/settings/models`` 的请求体：**拉取某个地址可见的模型清单**。
         *
         *     与探测同一条设计：提交的是**候选配置**（先看模型清单、满意再保存），
         *     ``api_key`` 允许是占位（== 用已存 Key），实现方用 :func:`resolve_api_key` 解析。
         */
        ProviderModelsRequest: {
            llm: components["schemas"]["LlmConfigIn"];
        };
        /**
         * ProviderModelsResult
         * @description ``POST /api/settings/models`` 的响应。
         *
         *     ``ok=False`` 时 ``message`` 必须**可读**（与 ``ProbeResult`` 同一条口径）；
         *     ``ok=True`` 时 ``models`` 是端点 ``/models`` 报出来的模型 id（可能为空列表 ——
         *     有些兼容服务实现了端点但不返回清单，那不是错误）。
         */
        ProviderModelsResult: {
            /** Message */
            message: string;
            /** Models */
            models?: string[];
            /** Ok */
            ok: boolean;
        };
        /**
         * QuizGradeRequest
         * @description ``POST /api/quiz/grade`` 的请求体：提交答案并批改（判分只走后端）。
         */
        QuizGradeRequest: {
            /** Answer */
            answer: string | string[];
            /** Qid */
            qid: string;
            /** Sessionid */
            sessionId?: string | null;
            /** Studentid */
            studentId: string;
        };
        /**
         * QuizPayload
         * @description 出题载荷。``questions`` **一律是对外形态**，内部模型塞不进来（会被类型校验挡住）。
         */
        QuizPayload: {
            /** Kpid */
            kpId: string;
            /** Questions */
            questions?: components["schemas"]["QuizQuestionOut"][];
            /**
             * Source
             * @enum {string}
             */
            source: "bank" | "generated";
        };
        /**
         * QuizQuestionOut
         * @description ★ **对外模型**：没有 ``answer``、也**没有** ``explanation``，发给 TS 与前端。
         *
         *     判分所需的标准答案只留在 Python 侧：``POST /api/quiz/grade`` 按 ``qid`` 查库判分，
         *     前端与 TS 都不需要答案。
         *
         *     ★★ **为什么连 ``explanation`` 也不下发**（2026-09-19 定案，它本来是契约字段）：
         *       ``explanation`` 是**解析**，而它的话术经常把答案直接写进去 ——
         *       实测 **295/684 道真题（约 43%）** 的解析含标准答案原文
         *       （形如「选 B。因为 range 是含头不含尾的……」）。发出去就等于把题做废：
         *       学生（或模型）只要读题面载荷就能白拿答案，``mastery`` 随之失去意义。
         *
         *       ⚠️ 这个比例**有可复现的出处**：``tests/test_quizbank_coverage.py`` 的
         *       ``test_explanation_usually_contains_the_answer`` 每次运行都会打印它
         *       （不是从别处抄来的数字，题库改了它会跟着变）。
         *
         *       而这与闯关页界面上的白纸黑字一致 —— ``views/Quiz.vue`` 写着
         *       「答案与解析都不下发到界面」。此前是契约与承诺不符：界面不渲染，
         *       但载荷一直带着它走完了 HTTP。
         *
         *     ★ **解析的教学价值一个字没丢**：它仍然在 ``feedback_for()`` 里，
         *       只在**判分之后**经 ``QuizResult.feedback`` 回传给学生 ——
         *       「答完再讲为什么」正是有教育意义的那一步，而「答前先看到为什么」只是送答案。
         *
         *     ⚠️ 不要为「前端想提前显示解析」把它加回来：那需要先答过一次，
         *       也就是说要先有一条判分记录（``store.question_attempt``），
         *       而那件事的完整形态是「判分后从 ``feedback`` 取」—— 不是第二条下发通道。
         */
        QuizQuestionOut: {
            /** Kpid */
            kpId: string;
            /** Options */
            options?: string[] | null;
            /** Qid */
            qid: string;
            /** Stem */
            stem: string;
            /**
             * Type
             * @enum {string}
             */
            type: "choice" | "blank" | "code_blank";
        };
        /**
         * QuizQuestionType
         * @enum {string}
         */
        QuizQuestionType: "choice" | "blank" | "code_blank";
        /**
         * QuizResult
         * @description 批改结果（§6.5）。``scored_by`` 区分客观题规则判分与主观题 LLM 判分。
         */
        QuizResult: {
            /** Correct */
            correct: boolean;
            /** Feedback */
            feedback: string;
            /** Masterydelta */
            masteryDelta: number;
            /** Qid */
            qid: string;
            /**
             * Scoredby
             * @enum {string}
             */
            scoredBy: "rule" | "llm";
        };
        /**
         * RagHit
         * @description 检索命中的**完整记录**（HTTP 层，供 `rag_search` Tool 注入上下文与轨迹图）。
         *
         *     在 :class:`Citation` 的 5 个冻结字段之上补齐内部字段。父块正文在这里
         *     （父子 chunk：小子块检索、命中回父块作上下文，§8.3），不要塞进 `Citation`。
         */
        RagHit: {
            /** Chaptertitle */
            chapterTitle: string;
            /** Chunkid */
            chunkId: string;
            /** Compat */
            compat: boolean;
            /**
             * Degraded
             * @default vector
             * @enum {string}
             */
            degraded: "vector" | "cloud" | "fts" | "outline";
            /**
             * Expanded
             * @default false
             */
            expanded: boolean;
            /**
             * Gradelevel
             * @enum {string}
             */
            gradeLevel: "primary_low" | "primary_high" | "junior" | "senior";
            /**
             * Knowledgepoint
             * @default
             */
            knowledgePoint: string;
            /**
             * Kpid
             * @default
             */
            kpId: string;
            /** Parentchunkid */
            parentChunkId?: string | null;
            /**
             * Score
             * @default 0
             */
            score: number;
            /** Sectiontitle */
            sectionTitle: string;
            /**
             * Text
             * @default
             */
            text: string;
        };
        /**
         * RagSearchRequest
         * @description ``POST /api/rag/search`` 的请求体（供 Pi 的 `rag_search` Tool 调用）。
         *
         *     ``grade_level`` 是**必填**：学段过滤写在 SQL 层，模型改不了 WHERE（AGENTS §5.2）。
         */
        RagSearchRequest: {
            /**
             * Allowcompat
             * @default true
             */
            allowCompat: boolean;
            /**
             * Gradelevel
             * @enum {string}
             */
            gradeLevel: "primary_low" | "primary_high" | "junior" | "senior";
            /**
             * Includeexpansion
             * @default true
             */
            includeExpansion: boolean;
            /** Query */
            query: string;
            /**
             * Topk
             * @default 5
             */
            topK: number;
        };
        /**
         * RagSearchResult
         * @description ``POST /api/rag/search`` 的响应。
         *
         *     降级链整条在 Python 侧一次调用内完成（§8.5）：调用方只读 ``degraded``，
         *     **不要**在编排层再实现一遍降级逻辑。
         */
        RagSearchResult: {
            /**
             * Context
             * @default
             */
            context: string;
            /**
             * Degraded
             * @default vector
             * @enum {string}
             */
            degraded: "vector" | "cloud" | "fts" | "outline";
            /** Hits */
            hits?: components["schemas"]["RagHit"][];
        };
        /**
         * RecommendationItem
         * @description 一条推荐（**下一步学什么**）。
         *
         *     字段全部是**可展示**的：``kp_id`` 是机器口径，``name`` 是给学生看的名字
         *     （由依赖图的 ``kp`` 表解析出来）；``reason`` 是一句可直接照念的中文。
         */
        RecommendationItem: {
            /**
             * Depth
             * @default 1
             */
            depth: number;
            /** Gradelevel */
            gradeLevel?: ("primary_low" | "primary_high" | "junior" | "senior") | null;
            /** Kpid */
            kpId: string;
            /**
             * Mastery
             * @default 0
             */
            mastery: number;
            /**
             * Name
             * @default
             */
            name: string;
            /**
             * Reason
             * @default
             */
            reason: string;
        };
        /**
         * RecommendationResponse
         * @description ``GET /api/profile/{student_id}/recommendation`` 的响应（票 20）。
         *
         *     ``source`` 说明这一批推荐是怎么来的 —— 前端据此决定提示语，
         *     也是验收时「冷启动 / 依赖图 / 待重练」三种形态的**可断言标志**：
         *
         *     | source | 含义 |
         *     | --- | --- |
         *     | ``review`` | 优先重练（掌握度不足且练过） |
         *     | ``graph`` | 依赖图后继（掌握某知识点后往前推） |
         *     | ``cold_start`` | 全新学生：给图里的入口知识点 |
         *     | ``empty`` | 依赖图不可用且无任何学习记录（前端按空态展示，**不是错误**） |
         */
        RecommendationResponse: {
            /** Items */
            items?: components["schemas"]["RecommendationItem"][];
            /**
             * Source
             * @enum {string}
             */
            source: "review" | "graph" | "cold_start" | "empty";
            /** Studentid */
            studentId: string;
            /**
             * Summary
             * @default
             */
            summary: string;
        };
        /**
         * RecommendationSource
         * @enum {string}
         */
        RecommendationSource: "review" | "graph" | "cold_start" | "empty";
        /**
         * RegisterVariantsRequest
         * @description ``POST /api/quiz/variants`` 的请求体：把 LLM 生成的题登记到该学生的库里。
         *
         *     ``student_id`` 在 query 里（与 ``/api/quiz/bank`` 的取题口径一致）；
         *     这里只放题目本身。**至少要有一道题**（空数组等于一次毫无意义的写入）。
         */
        RegisterVariantsRequest: {
            /**
             * Gradelevel
             * @enum {string}
             */
            gradeLevel: "primary_low" | "primary_high" | "junior" | "senior";
            /** Questions */
            questions: components["schemas"]["VariantQuestionIn"][];
        };
        /**
         * SettingsResponse
         * @description ``GET`` / ``PUT /api/settings`` 的响应（§6.3）。**任何情况下都不含明文 Key。**
         */
        SettingsResponse: {
            embedding: components["schemas"]["EmbeddingConfig"];
            llm: components["schemas"]["LlmConfig"];
        };
        /**
         * SettingsUpdateRequest
         * @description ``PUT /api/settings`` 的请求体。
         *
         *     两栏都可省略（``null`` = 不动那一栏）—— 设置页可以分栏保存；
         *     但**不能两栏都不给**（那样这次请求没有任何意义）。
         */
        SettingsUpdateRequest: {
            embedding?: components["schemas"]["EmbeddingConfigIn"] | null;
            llm?: components["schemas"]["LlmConfigIn"] | null;
        };
        /**
         * Student
         * @description 一名学生。**一人一库**（``students/<student_id>/learning.db``），不跨学生复用连接。
         */
        Student: {
            /** Createdat */
            createdAt: number;
            /**
             * Currentchapter
             * @default
             */
            currentChapter: string;
            /**
             * Gradelevel
             * @enum {string}
             */
            gradeLevel: "primary_low" | "primary_high" | "junior" | "senior";
            /** Lastactiveat */
            lastActiveAt: number;
            /** Nickname */
            nickname: string;
            /** Studentid */
            studentId: string;
        };
        /**
         * StudentCreateRequest
         * @description ``POST /api/students``：新建学生（含学段，学段也可后改）。``student_id`` 由服务端生成。
         */
        StudentCreateRequest: {
            /**
             * Gradelevel
             * @enum {string}
             */
            gradeLevel: "primary_low" | "primary_high" | "junior" | "senior";
            /** Nickname */
            nickname: string;
        };
        /**
         * StudentProfile
         * @description ``GET /api/profile/{student_id}``：画像与掌握度（§6.3）。
         *
         *     ``recommended_kp_ids`` 由依赖图 + 掌握度算出（§8.6 用途一，票 12/20 填充）——
         *     **推荐必须来自依赖图**，不是随机取或按顺序取下一个。
         */
        StudentProfile: {
            /** Mastery */
            mastery?: components["schemas"]["Mastery"][];
            /** Preferences */
            preferences?: {
                [key: string]: string;
            };
            /** Recommendedkpids */
            recommendedKpIds?: string[];
            student: components["schemas"]["Student"];
        };
        /**
         * SubjectiveGradeRequest
         * @description ``POST /api/quiz/grade-subjective`` 的请求体：**TS 侧判完分，交服务端落库**。
         *
         *     ★ LLM 调用在 TS 侧（Pi 独占），Python 不装任何 LLM 客户端。本端点只做三件事：
         *     校验（这道题真的是主观题吗）→ 按 ``score`` 定对错（**规则在服务端**）→ 写掌握度与进度。
         */
        SubjectiveGradeRequest: {
            /**
             * Feedback
             * @default
             */
            feedback: string;
            /** Qid */
            qid: string;
            /** Score */
            score: number;
            /** Sessionid */
            sessionId?: string | null;
            /** Studentid */
            studentId: string;
        };
        /** ValidationError */
        ValidationError: {
            /** Context */
            ctx?: Record<string, never>;
            /** Input */
            input?: unknown;
            /** Location */
            loc: (string | number)[];
            /** Message */
            msg: string;
            /** Error Type */
            type: string;
        };
        /**
         * VariantQuestionIn
         * @description 登记一道 LLM 生成的变式题（**必须带标准答案**，否则后端判不了分）。
         *
         *     ``reference_answer`` 就是**标准答案**：它进 ``learning.db``，绝不出现在任何出参里。
         *     方向与 :class:`app.contracts.QuizGradeRequest.answer`（学生作答）**相反**，别混。
         *
         *     ★ ``qid`` 必须带 :data:`GENERATED_QID_PREFIX` 前缀（``gen-``，与
         *       ``desktop/src/main/agent/extensions/quiz.ts`` 的 ``variantQid()`` 同源）——
         *       见 :func:`register_variants` 的说明：不带前缀的 qid 能**伪装成题库真题**。
         */
        VariantQuestionIn: {
            /**
             * Explanation
             * @default
             */
            explanation: string;
            /**
             * Kpid
             * @default
             */
            kpId: string;
            /** Options */
            options?: string[] | null;
            /** Qid */
            qid: string;
            /** Referenceanswer */
            referenceAnswer: string | string[];
            /** Rubric */
            rubric?: string | null;
            /** Stem */
            stem: string;
            /**
             * Type
             * @enum {string}
             */
            type: "choice" | "blank" | "code_blank";
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    get_coding_hint_api_code_hint__kp_id__get: {
        parameters: {
            query?: {
                /** @description 要第几级提示（1 指方向 / 2 结构 / 3 骨架） */
                level?: number;
            };
            header?: never;
            path: {
                kp_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CodingHint"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    run_hint_api_code_run_hint_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CodeRunRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CodeEvaluation"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_code_template_api_code_templates__kp_id__get: {
        parameters: {
            query?: {
                /** @description 学生学段（可选；传了就按兼容链卡，不传不过滤） */
                grade_level?: string | null;
            };
            header?: never;
            path: {
                kp_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CodeTemplate"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    grade_history_api_grade_history__student_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                student_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GradeHistoryResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    override_grade_api_grade_override__student_id__post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                student_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["GradeOverrideRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GradeOverrideResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    grade_signals_api_grade_signals__student_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                student_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GradeSignals"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    grade_state_api_grade_state__student_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                student_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GradeStateOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    submit_grade_turns_api_grade_turns__student_id__post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                student_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["GradeTurnsRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GradeTurnResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    graph_deps_api_graph_deps__kp_id__get: {
        parameters: {
            query?: {
                /** @description successor=后继（推荐路径）/ prerequisite=前置（检索扩展）/ both */
                direction?: "successor" | "prerequisite" | "both";
                /** @description 递归深度上限（防环死循环） */
                max_depth?: number;
            };
            header?: never;
            path: {
                kp_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DepNode"][];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    graph_overview_api_graph_overview__grade_level__get: {
        parameters: {
            query?: {
                /** @description 带上就标注每个知识点是否已掌握（读该学生的 progress） */
                student_id?: string | null;
            };
            header?: never;
            path: {
                grade_level: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GraphOverview"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_chapters_api_knowledge_chapters__grade_level__get: {
        parameters: {
            query?: {
                /** @description 带上就补每章的已掌握数（读该学生的 learning.db）；不带给纯教材清单 */
                student_id?: string | null;
            };
            header?: never;
            path: {
                grade_level: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ChapterListResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    import_knowledge_api_knowledge_import_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["KnowledgeImportRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["KnowledgeImportResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_points_api_knowledge_points_get: {
        parameters: {
            query?: {
                /** @description 按学段过滤；不带给全部四个学段 */
                grade_level?: string | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["KnowledgePointListResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    rebuild_knowledge_api_knowledge_rebuild_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["KnowledgeRebuildResponse"];
                };
            };
        };
    };
    knowledge_stats_api_knowledge_stats_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["KnowledgeStats"];
                };
            };
        };
    };
    student_profile_api_profile__student_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                student_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StudentProfile"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    read_chapter_api_profile__student_id__chapter_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                student_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ChapterStateOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    write_chapter_api_profile__student_id__chapter_put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                student_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ChapterUpdateRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ChapterStateOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    record_learning_event_api_profile__student_id__events_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                student_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LearningEventRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LearningEventAck"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    student_opening_api_profile__student_id__opening_get: {
        parameters: {
            query?: {
                /** @description 覆盖学段（默认用画像里的当前学段） */
                grade_level?: string | null;
            };
            header?: never;
            path: {
                student_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OpeningGuidance"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    update_preference_api_profile__student_id__preferences_put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                student_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PreferenceUpdateRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LearningEventAck"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    student_recommendation_api_profile__student_id__recommendation_get: {
        parameters: {
            query?: {
                /** @description 覆盖学段（默认用画像里的当前学段） */
                grade_level?: string | null;
            };
            header?: never;
            path: {
                student_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RecommendationResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    learning_report_api_profile__student_id__report_get: {
        parameters: {
            query?: {
                /** @description 时间窗天数（按本地日期切天） */
                days?: number;
            };
            header?: never;
            path: {
                student_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LearningReport"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_quiz_bank_api_quiz_bank__kp_id__get: {
        parameters: {
            query?: {
                /** @description 学生学段（四学段之一，必填） */
                grade_level?: string | null;
                /** @description 取几道题 */
                count?: number;
                /** @description 题目不足时是否允许取用更低学段的题 */
                allow_compat?: boolean;
            };
            header?: never;
            path: {
                kp_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["QuizPayload"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    grade_quiz_api_quiz_grade_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["QuizGradeRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["QuizResult"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    grade_subjective_api_quiz_grade_subjective_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SubjectiveGradeRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["QuizResult"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_mistakes_api_quiz_mistakes__student_id__get: {
        parameters: {
            query?: {
                /** @description 返回的知识点数上限 */
                limit?: number;
            };
            header?: never;
            path: {
                student_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MistakeListResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    read_progress_api_quiz_progress__student_id__get: {
        parameters: {
            query?: {
                /** @description 只看这几关，逗号分隔（可选） */
                kpIds?: string | null;
            };
            header?: never;
            path: {
                student_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    register_variants_api_quiz_variants_post: {
        parameters: {
            query: {
                /** @description 学生 id（生成题落在这个学生自己的库里） */
                student_id: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RegisterVariantsRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["QuizPayload"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    rag_search_api_rag_search_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RagSearchRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RagSearchResult"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    read_settings_api_settings_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SettingsResponse"];
                };
            };
        };
    };
    update_settings_api_settings_put: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SettingsUpdateRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SettingsResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_provider_models_api_settings_models_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["ProviderModelsRequest"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProviderModelsResult"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    probe_settings_api_settings_probe_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["ProbeRequest"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProbeResult"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    read_runtime_config_api_settings_runtime_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LlmRuntimeConfig"];
                };
            };
        };
    };
    list_students_api_students_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Student"][];
                };
            };
        };
    };
    create_student_api_students_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["StudentCreateRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Student"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    health_health_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HealthResponse"];
                };
            };
        };
    };
}
