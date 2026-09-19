---
kp_id: hardware-accelerator-jr
grade_level: junior
chapter_title: 第2章 人工智能三大底层支柱(AI的构造地基)
knowledge_point: 硬件载体：GPU / CPU / TPU
content_type: principle
summary: 算力要有实体来承担——图形处理器擅长同时做大量重复计算，通用处理器擅长处理各种杂事，专用芯片则为机器学习量身定制。
---

## 原理与辨析

硬件载体是算力的物理承担者，主流有三类：GPU（图形处理器，Graphics Processing Unit）、CPU（中央处理器，Central Processing Unit）和 TPU（张量处理器，Tensor Processing Unit）。

三者的设计思路不同。**CPU** 核心少但每个核心很强，擅长逻辑判断、分支跳转等复杂串行任务，是计算机的总调度者。**GPU** 拥有成百上千个较简单的核心，擅长并行处理大量同类运算，而人工智能的核心计算正是大规模矩阵乘法，因此 GPU 成为训练大模型最主要的硬件。**TPU** 是专为机器学习设计的定制芯片，在特定张量运算上能效更高。

辨析：CPU 与 GPU 不是替代关系，而是分工关系——CPU 负责调度与串行逻辑，GPU 负责并行计算。教育场景中，学校用图形处理器集群训练教育智能体，用通用处理器处理系统调度与数据管理，二者配合完成从训练到在线答疑的全流程。
