/**
 * ★ 本文件由 `scripts/gen-api-types.mjs` 从 `shared/openapi.json` 生成，**请勿手改**。
 *
 * 契约链路：server/app/models.py → export_openapi.py → openapi.json → 本文件 → npm run typecheck
 * 改契约的正确姿势：改 `server/app/models.py` → `uv run python scripts/export_openapi.py` → `npm run gen:api`
 */

export interface paths {
    "/api/chat/stream/echo": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Chat Stream Echo
         * @description **S02 临时端点**：回放一段假的 SSE 数据流。
         *
         *     ⚠️ 为什么用 POST：真实链路（S03）是 POST + JSON body，前端解析器必须按
         *     POST + `fetch` 写，不能因为"反正是 echo"就退回 GET。
         */
        post: operations["chat_stream_echo_api_chat_stream_echo_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/meta": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Meta
         * @description 给前端展示的后端元信息（不含任何凭据）。
         */
        get: operations["meta_api_meta_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ping": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Ping
         * @description 受保护端点：能返回 200 说明 token 校验通过。
         */
        get: operations["ping_api_ping_get"];
        put?: never;
        post?: never;
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
        /**
         * Get Settings
         * @description 读取设置（**脱敏**）。
         */
        get: operations["get_settings_api_settings_get"];
        /**
         * Put Settings
         * @description 保存设置。
         *
         *     ⚠️ 日志只记"改了哪些字段"，**绝不记值**（值里可能有 key）。
         */
        put: operations["put_settings_api_settings_put"];
        post?: never;
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
         * @description 免鉴权健康检查。
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
         * @description 动画讲解产物。**必须带降级文本**：生成失败也要能讲课（执行文档 11.2）。
         */
        AnimationPayload: {
            /** Concept */
            concept: string;
            /**
             * Html
             * @description 完整自包含 HTML（内联 Anime.js v3 调用），在 sandboxed iframe 内运行
             * @default
             */
            html: string;
            /**
             * Durationms
             * @default 6000
             */
            durationMs: number;
            /**
             * Fallbacktext
             * @description 降级为文字讲解（生成失败/沙箱不可用时使用）
             */
            fallbackText: string;
            /**
             * Fallbackimage
             * @description 静态兜底图（SVG dataURL），无网络依赖
             * @default null
             */
            fallbackImage: string | null;
            /**
             * Source
             * @default template
             * @enum {string}
             */
            source: "template" | "generated";
        };
        /**
         * AnswerKind
         * @description `event: payload` 里承载的是哪种 SubAgent 产物。
         * @enum {string}
         */
        AnswerKind: "animation" | "coding" | "quiz";
        /**
         * ChatRequest
         * @description `POST /api/chat/stream` 请求体（执行文档 6.3）。
         *
         *     - `grade` 由前端按钮决定，**不让模型推断**。
         *     - `session_id` 为空时后端生成；S04 起作为 LangGraph `thread_id`（跨会话记忆 / 断点续跑）。
         */
        ChatRequest: {
            /** Studentid */
            studentId: string;
            grade: components["schemas"]["GradeLevel"];
            /** Message */
            message: string;
            /** Sessionid */
            sessionId?: string | null;
        };
        /**
         * Citation
         * @description 检索命中的引用。
         *
         *     `compat=True` 表示「允许向上兼容命中了更高学段的内容」——
         *     **必须显式标注**，前端会展示「已为你补充高年级内容」提示（AGENTS §5.4）。
         */
        Citation: {
            /** Chunkid */
            chunkId: string;
            /**
             * Chaptertitle
             * @default
             */
            chapterTitle: string;
            /**
             * Sectiontitle
             * @default
             */
            sectionTitle: string;
            gradeLevel: components["schemas"]["GradeLevel"];
            /**
             * Compat
             * @default false
             */
            compat: boolean;
        };
        /**
         * CodeError
         * @description 代码运行错误（执行文档 6.5 引用但未展开，此处冻结）。
         */
        CodeError: {
            /**
             * Type
             * @description 异常类型，如 ZeroDivisionError
             */
            type: string;
            /** Message */
            message: string;
            /**
             * Line
             * @default null
             */
            line: number | null;
        };
        /**
         * CodeEvaluation
         * @description `POST /api/code/run-hint` 响应：评估 + 下一级提示。
         */
        CodeEvaluation: {
            /** Ok */
            ok: boolean;
            /**
             * Stdout
             * @default
             */
            stdout: string;
            /** @default null */
            error: components["schemas"]["CodeError"] | null;
            /**
             * Feedback
             * @description 面向学生的中文反馈
             */
            feedback: string;
            /** @default null */
            nextHint: components["schemas"]["CodingHint"] | null;
        };
        /**
         * CodeRunRequest
         * @description 学生提交的代码与报错。
         *
         *     ⚠️ 代码**在渲染进程的 Pyodide Worker 里执行**（沙箱要求，AGENTS §5.7）；
         *     这里只接收执行结果，后端不执行学生代码。
         */
        CodeRunRequest: {
            /** Studentid */
            studentId: string;
            /** Kpid */
            kpId: string;
            /** Code */
            code: string;
            /**
             * Stdout
             * @default
             */
            stdout: string;
            /**
             * Stderr
             * @default
             */
            stderr: string;
        };
        /**
         * CodeTemplate
         * @description 编程题脚手架。
         */
        CodeTemplate: {
            /** Kpid */
            kpId: string;
            /**
             * Language
             * @default python
             * @constant
             */
            language: "python";
            /**
             * Scaffold
             * @description 预置代码框架，含 TODO 标记
             */
            scaffold: string;
            /** Expectedbehavior */
            expectedBehavior: string;
        };
        /**
         * CodingHint
         * @description 分级提示（1 最弱、3 最强）。提示要「引导」而不是「给答案」。
         */
        CodingHint: {
            /**
             * Level
             * @enum {integer}
             */
            level: 1 | 2 | 3;
            /** Hint */
            hint: string;
        };
        /**
         * DepNode
         * @description 依赖图节点（`GET /api/graph/deps/{kp_id}`）。
         *
         *     **双用途**（执行文档 8.5，创新点）：
         *     ① 推荐路径规划（`relation=prerequisite` 反向找前置 / 正向找下一步）；
         *     ② 检索上下文扩展（把相邻知识点纳入检索范围）。
         */
        DepNode: {
            /** Kpid */
            kpId: string;
            /**
             * Name
             * @default
             */
            name: string;
            /** @default null */
            gradeLevel: components["schemas"]["GradeLevel"] | null;
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
            /**
             * Distance
             * @description 相对查询节点的跳数
             * @default 1
             */
            distance: number;
        };
        /**
         * EmbeddingConfig
         * @description 嵌入配置。默认本地 fastembed（离线可用）；云端为可选降级路径（执行文档 8.4 [2]）。
         */
        EmbeddingConfig: {
            /**
             * Mode
             * @default local_fastembed
             * @enum {string}
             */
            mode: "local_fastembed" | "cloud_api" | "none";
            /** Baseurl */
            baseUrl?: string | null;
            /** Apikey */
            apiKey?: string | null;
            /** Modelid */
            modelId?: string | null;
        };
        /**
         * GradeLevel
         * @description 学段。**由前端按钮切换并随请求传入**；SubAgent 不得自行推断（AGENTS §5.1）。
         * @enum {string}
         */
        GradeLevel: "primary_low" | "primary_high" | "junior" | "senior";
        /** HTTPValidationError */
        HTTPValidationError: {
            /** Detail */
            detail?: components["schemas"]["ValidationError"][];
        };
        /**
         * HealthResponse
         * @description `/health` 响应。Electron 轮询它来判断 sidecar 是否就绪。
         */
        HealthResponse: {
            /**
             * Status
             * @description 固定为 ok；不可用时该接口本身就不会响应
             */
            status: string;
            /** Version */
            version: string;
            /**
             * Embedder Ready
             * @description 嵌入模型「可用」的快速探测结果。S01 阶段只检查模型文件是否随包分发到位，不做真实加载（加载 90MB ONNX 会显著拖慢冷启动）；S06 接入 RAG 后改为懒加载后的真实就绪态。
             */
            embedder_ready: boolean;
            /**
             * Frozen
             * @description 是否运行在 PyInstaller 打包产物中
             */
            frozen: boolean;
            /** Data Dir */
            data_dir: string;
        };
        /**
         * Intent
         * @description 主 Agent 的意图路由结果。四个值对应四种核心交互，无第五种。
         * @enum {string}
         */
        Intent: "qa" | "animation" | "coding" | "quiz";
        /**
         * LlmConfig
         * @description 主模型配置（OpenAI 兼容）。
         *
         *     `base_url` / `model_id` 必须可改：**不得把任何供应商硬编码进代码**
         *     （执行文档 5.1；答辩时会被问「换供应商要不要改代码」）。
         */
        LlmConfig: {
            /**
             * Providername
             * @description 供应商名称，仅用于界面展示，不参与调用
             * @default DeepSeek
             */
            providerName: string;
            /**
             * Baseurl
             * @description OpenAI 兼容 BaseURL（含 /v1 之类路径前缀）
             * @default https://api.deepseek.com/v1
             */
            baseUrl: string;
            /**
             * Apikey
             * @description 本地存储；不上传、不入日志
             * @default
             */
            apiKey: string;
            /**
             * Modelid
             * @description 模型 ID，如 deepseek-chat
             * @default deepseek-chat
             */
            modelId: string;
        };
        /**
         * MasteryItem
         * @description 单知识点掌握度（对应 `mastery` 表）。
         */
        MasteryItem: {
            /** Kpid */
            kpId: string;
            /**
             * Kpname
             * @description 知识点中文名，便于界面直出
             * @default null
             */
            kpName: string | null;
            /**
             * Score
             * @description 0..1 掌握度
             * @default 0
             */
            score: number;
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
            /**
             * Lastseenat
             * @default null
             */
            lastSeenAt: number | null;
        };
        /**
         * PingResponse
         * @description 受保护端点，用于验证 `X-Auth-Token` 中间件确实生效。
         */
        PingResponse: {
            /**
             * Status
             * @default ok
             */
            status: string;
            /**
             * Auth
             * @default ok
             */
            auth: string;
        };
        /**
         * ProgressItem
         * @description 闯关进度（对应 `progress` 表），S09 使用。
         */
        ProgressItem: {
            /** Kpid */
            kpId: string;
            /**
             * Stage
             * @enum {string}
             */
            stage: "locked" | "learning" | "quizzed" | "mastered";
            /**
             * Badge
             * @default null
             */
            badge: string | null;
            /**
             * Updatedat
             * @default null
             */
            updatedAt: number | null;
        };
        /**
         * QuizAnswer
         * @description 单题作答。
         */
        QuizAnswer: {
            /** Qid */
            qid: string;
            /** Answer */
            answer: string | string[];
        };
        /**
         * QuizGradeRequest
         * @description `POST /api/quiz/grade` 请求（混合批改：客观题规则、主观题大模型）。
         */
        QuizGradeRequest: {
            /** Studentid */
            studentId: string;
            /** Kpid */
            kpId: string;
            /** Answers */
            answers: components["schemas"]["QuizAnswer"][];
        };
        /**
         * QuizGradeResponse
         * @description `POST /api/quiz/grade` 响应：逐题结果 + 整体掌握度变化。
         */
        QuizGradeResponse: {
            /** Kpid */
            kpId: string;
            /** Results */
            results: components["schemas"]["QuizResult"][];
            /**
             * Masterydelta
             * @default 0
             */
            masteryDelta: number;
            /**
             * Feedback
             * @default
             */
            feedback: string;
        };
        /**
         * QuizPayload
         * @description 出题产物（`event: payload`，kind=quiz）。
         */
        QuizPayload: {
            /** Kpid */
            kpId: string;
            /** Questions */
            questions: components["schemas"]["QuizQuestion"][];
            /**
             * Source
             * @default bank
             * @enum {string}
             */
            source: "bank" | "generated";
        };
        /**
         * QuizQuestion
         * @description 练习题。
         */
        QuizQuestion: {
            /** Qid */
            qid: string;
            /** Kpid */
            kpId: string;
            /**
             * Type
             * @enum {string}
             */
            type: "choice" | "blank" | "code_blank";
            /** Stem */
            stem: string;
            /**
             * Options
             * @default null
             */
            options: string[] | null;
            /** Answer */
            answer: string | string[];
            /** Explanation */
            explanation: string;
        };
        /**
         * QuizResult
         * @description 单题批改结果。
         */
        QuizResult: {
            /** Qid */
            qid: string;
            /** Correct */
            correct: boolean;
            /**
             * Scoredby
             * @enum {string}
             */
            scoredBy: "rule" | "llm";
            /** Feedback */
            feedback: string;
            /**
             * Masterydelta
             * @description 对掌握度的增量，可正可负
             */
            masteryDelta: number;
        };
        /**
         * SettingsResponse
         * @description `GET /api/settings` 响应。
         *
         *     ⚠️ **绝不回传明文 API Key**：返回 `has_key` 与掩码，前端只用来回显「已配置」。
         *     保存时若 `apiKey` 为掩码原样或为空串，视为「不修改」（见 `app/settings.py`）。
         */
        SettingsResponse: {
            llm: components["schemas"]["LlmConfig"];
            embedding: components["schemas"]["EmbeddingConfig"];
            /**
             * Haskey
             * @description 是否已配置 API Key（不含明文）
             * @default false
             */
            hasKey: boolean;
            /**
             * Apikeymasked
             * @description 掩码，如 sk-…abcd；从不含完整明文
             * @default
             */
            apiKeyMasked: string;
            /**
             * Configpath
             * @default
             */
            configPath: string;
            /**
             * Embeddingmodelid
             * @default
             */
            embeddingModelId: string;
        };
        /**
         * SettingsUpdateRequest
         * @description `PUT /api/settings` 请求。
         *
         *     API Key 三态语义（**避免「点保存把 key 清空」**）：
         *     - 传空串或掩码（`…abcd`）→ 保留原值；
         *     - 传新值 → 覆盖；
         *     - `clearApiKey=true` → 显式清空（前端「清除密钥」按钮才用）。
         */
        SettingsUpdateRequest: {
            llm: components["schemas"]["LlmConfig"];
            embedding?: components["schemas"]["EmbeddingConfig"];
            /**
             * Clearapikey
             * @description 显式清除 API Key
             * @default false
             */
            clearApiKey: boolean;
        };
        /**
         * SseBlockedData
         * @description 内容安全拦截（执行文档 12：流式输出 + 生成结束后整段终审，违规撤回替换）。
         */
        SseBlockedData: {
            /** Requestid */
            requestId: string;
            /** Reason */
            reason: string;
            /** Safetext */
            safeText: string;
        };
        /** SseCitationData */
        SseCitationData: {
            /** Requestid */
            requestId: string;
            /** Citations */
            citations: components["schemas"]["Citation"][];
        };
        /** SseDeltaData */
        SseDeltaData: {
            /** Requestid */
            requestId: string;
            /** Delta */
            delta: string;
        };
        /** SseDoneData */
        SseDoneData: {
            /** Requestid */
            requestId: string;
            /** Messageid */
            messageId: string;
        };
        /**
         * SseErrorData
         * @description 降级/异常收尾。**已在流中途，不能改成 HTTP 500**（响应头已发出）。
         */
        SseErrorData: {
            /** Requestid */
            requestId: string;
            /** Message */
            message: string;
            /**
             * Degraded
             * @default false
             */
            degraded: boolean;
        };
        /** SsePayloadData */
        SsePayloadData: {
            /** Requestid */
            requestId: string;
            kind: components["schemas"]["AnswerKind"];
            /**
             * Payload
             * @description 具体结构由 kind 决定，见 AnimationPayload 等
             */
            payload: {
                [key: string]: unknown;
            };
        };
        /**
         * Student
         * @description 学生档案（对应 `student` 表）。
         */
        Student: {
            /** Studentid */
            studentId: string;
            /** Nickname */
            nickname: string;
            gradeLevel: components["schemas"]["GradeLevel"];
            /**
             * Createdat
             * @description Unix 秒
             */
            createdAt: number;
            /**
             * Lastactiveat
             * @description Unix 秒
             */
            lastActiveAt: number;
        };
        /**
         * StudentCreateRequest
         * @description `POST /api/students` 请求。**最小化采集**：只要昵称与学段。
         */
        StudentCreateRequest: {
            /**
             * Nickname
             * @description 昵称，不采集真实姓名
             */
            nickname: string;
            gradeLevel: components["schemas"]["GradeLevel"];
        };
        /** StudentListResponse */
        StudentListResponse: {
            /** Students */
            students: components["schemas"]["Student"][];
        };
        /**
         * StudentProfile
         * @description `GET /api/profile/{student_id}` 响应：画像 + 掌握度。
         */
        StudentProfile: {
            /** Studentid */
            studentId: string;
            /**
             * Nickname
             * @default
             */
            nickname: string;
            /** @default null */
            gradeLevel: components["schemas"]["GradeLevel"] | null;
            /** Mastery */
            mastery?: components["schemas"]["MasteryItem"][];
            /**
             * Weakpoints
             * @description 薄弱知识点 kp_id，供主 Agent 注入上下文
             */
            weakPoints?: string[];
            /** Progress */
            progress?: components["schemas"]["ProgressItem"][];
            /**
             * Updatedat
             * @default null
             */
            updatedAt: number | null;
        };
        /** ValidationError */
        ValidationError: {
            /** Location */
            loc: (string | number)[];
            /** Message */
            msg: string;
            /** Error Type */
            type: string;
            /** Input */
            input?: unknown;
            /** Context */
            ctx?: Record<string, never>;
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
    chat_stream_echo_api_chat_stream_echo_post: {
        parameters: {
            query?: {
                /** @description 事件间隔，便于肉眼看逐条到达 */
                interval_ms?: number;
                /** @description 是否补发 blocked/error 以覆盖全部 6 种事件 */
                all_events?: boolean;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ChatRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
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
    meta_api_meta_get: {
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
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    ping_api_ping_get: {
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
                    "application/json": components["schemas"]["PingResponse"];
                };
            };
        };
    };
    get_settings_api_settings_get: {
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
    put_settings_api_settings_put: {
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

// ---------------------------------------------------------------------------
// SSE 事件（契约 6.4）——事件名来自后端的 `x-sse-events`，不要在这里手抄
// ---------------------------------------------------------------------------

/** 6 种 SSE 事件名。 */
export type SseEventName = 'delta' | 'citation' | 'payload' | 'blocked' | 'done' | 'error'

/** 事件名 → data 载荷类型的映射（前端解析器据此收窄类型）。 */
export interface SseEventPayloadMap {
  delta: components['schemas']['SseDeltaData']
  citation: components['schemas']['SseCitationData']
  payload: components['schemas']['SsePayloadData']
  blocked: components['schemas']['SseBlockedData']
  done: components['schemas']['SseDoneData']
  error: components['schemas']['SseErrorData']
}

/** 解析后的单个 SSE 事件（判别联合，`event` 一收窄就能拿到对应 data 类型）。 */
export type SseEvent = {
  [K in SseEventName]: { event: K; data: SseEventPayloadMap[K] }
}[SseEventName]

/** 便捷别名：SSE `payload` 事件里 `kind` 对应的三种 SubAgent 产物。 */
export type SubagentPayload =
  | components['schemas']['AnimationPayload']
  | components['schemas']['QuizPayload']
  | components['schemas']['CodeTemplate']
