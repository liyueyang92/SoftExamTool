# PDF 导入增强：表格 Markdown 化与图片/流程图视觉摘要技术方案

## 1. 背景与目标

当前文档库已支持 PDF 导入、文本抽取、扫描页 OCR，并将解析结果写入 `documents` 与 `doc_chunks`，AI 问答通过 `doc_chunks.content` 做全文检索后作为 RAG 上下文。该能力适合纯文本资料，但对软考资料中高频出现的表格、流程图、架构图、UML/SysML 图、截图型讲义支持不足。

本方案目标是让导入后的资料可稳定用于 AI 问答/知识库：

- 表格内容转成 Markdown 表格，保留行列语义，进入全文检索和 RAG 上下文。
- 图片、流程图、结构图、UML/SysML 图生成可检索的视觉摘要，必要时附带元素关系描述。
- 扫描版 PDF 继续 OCR，OCR 文本与视觉摘要合并为页面级知识内容。
- 保留原 PDF 与页面截图/图片资产，便于后续查看来源和人工校正。
- 对 AI 视觉能力做可选增强：无视觉模型时仍可导入，有视觉模型时产出更高质量摘要。

## 2. 现状与问题

现有实现边界：

- Python PDF 解析入口在 `python-service/modules/pdf/router.py`。
- 文本提取优先 `pdfplumber`，CID 乱码时回退 `pypdfium2`，页面文本稀疏时回退 RapidOCR。
- 解析结果最终只返回 `chunks: [{ doc_id, page_num, content, knowledge_tags }]`。
- Electron 主进程写入 `doc_chunks.content`，AI 问答只从该字段检索。
- 当前 AI Provider 的 `chat()` 接口主要面向纯文本消息，尚未抽象图片输入。

主要缺口：

- 表格被拍平成普通行文本，无法稳定回答“某方案的核心特点是什么”这类依赖行列关系的问题。
- 流程图/结构图只能识别框内文字，不能表达箭头方向、父子层级、模块关系。
- 纯图片页面即使 OCR 为空，也可能包含有价值信息，但当前会被跳过。
- 解析结果没有资产层，无法记录图片裁剪区域、摘要来源、置信度和人工校正状态。

## 3. 总体方案

新增“多模态解析层”，将每页 PDF 解析为三类内容：

1. 文本块：来自 PDF 原生文本或 OCR。
2. 表格块：来自 `pdfplumber.extract_tables()` 或后续表格 OCR/视觉模型修复，输出 Markdown 表格。
3. 视觉块：来自页面截图、嵌入图片或图形区域，经视觉模型生成摘要，输出结构化描述文本。

导入后的 `doc_chunks.content` 不再只保存原始段落，而是保存面向 RAG 的 Markdown 内容。例如：

```markdown
## 第 14 页 表格：Redis 分布式存储方案

| 分布式存储方案 | 核心特点 |
| --- | --- |
| 主从（Master/Slave）模式 | 一主多从，故障时手动切换。 |
| 哨兵（Sentinel）模式 | 有哨兵的一主多从，主节点故障自动选择新主节点。 |
| 集群（Cluster）模式 | 分节点对等集群，分 slots，不同 slots 的信息存储到不同节点。 |

## 第 15 页 图示摘要：电子政务交互关系

图中包含企业 B、政府 G、公民 C、公务员 E 四类主体。企业与政府之间存在 B2G 与 G2B 双向服务关系；公民与政府之间存在 C2G 与 G2C 双向服务关系；政府内部存在 G2G 协同；政府与公务员之间存在 G2E 服务关系。
```

RAG 检索仍可先复用 `doc_chunks`，但新增 `chunk_type`、`asset_id`、`confidence` 等元数据，后续可按类型加权。

## 4. 目标架构

```text
PDF 文件
  |
  v
页面渲染与裁剪
  |
  +-- 原生文本提取：pdfplumber / pypdfium2
  |
  +-- OCR：RapidOCR，处理扫描页和图片文字
  |
  +-- 表格提取：pdfplumber table finder -> Markdown 表格
  |
  +-- 图像/图形检测：页面截图、嵌入图片、非文本区域
        |
        +-- 视觉摘要：本地/远程多模态模型
        +-- 兜底摘要：OCR 文本 + 区域类型提示
  |
  v
页面内容融合与去重
  |
  v
doc_chunks + doc_assets + doc_parse_blocks
  |
  v
FTS / 向量索引 / AI 问答 RAG
```

新增 Python 模块建议：

- `python-service/modules/pdf/extractors/text.py`：原生文本与 OCR。
- `python-service/modules/pdf/extractors/tables.py`：表格检测、清洗、Markdown 化。
- `python-service/modules/pdf/extractors/visual.py`：图片/图形区域渲染、视觉摘要。
- `python-service/modules/pdf/pipeline.py`：页面级调度、融合、进度上报。
- `python-service/modules/pdf/schemas.py`：解析结果契约。

保留现有 `/pdf/parse` 与 `/pdf/preview`，内部逐步切换到新 pipeline，降低前端改造风险。

## 5. 数据模型设计

### 5.1 扩展 `doc_chunks`

新增字段：

```sql
ALTER TABLE doc_chunks ADD COLUMN chunk_type TEXT NOT NULL DEFAULT 'text'
  CHECK(chunk_type IN ('text','table','figure','page_summary'));
ALTER TABLE doc_chunks ADD COLUMN asset_id TEXT;
ALTER TABLE doc_chunks ADD COLUMN confidence REAL;
ALTER TABLE doc_chunks ADD COLUMN source_engine TEXT NOT NULL DEFAULT '';
ALTER TABLE doc_chunks ADD COLUMN block_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE doc_chunks ADD COLUMN bbox TEXT;
```

字段说明：

- `chunk_type`：内容类型。表格、图示摘要在检索时可单独加权。
- `asset_id`：关联页面截图、图像裁剪或表格资产。
- `confidence`：OCR 或视觉摘要置信度，低置信度内容可提示人工校正。
- `source_engine`：如 `pdfplumber`、`rapidocr`、`vision-openai-compatible`。
- `block_order`：页面内阅读顺序。
- `bbox`：JSON，记录 `{x0, top, x1, bottom}`，用于来源定位。

### 5.2 新增 `doc_assets`

```sql
CREATE TABLE IF NOT EXISTS doc_assets (
  id             TEXT PRIMARY KEY,
  doc_id         TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_num       INTEGER NOT NULL,
  asset_type     TEXT NOT NULL CHECK(asset_type IN ('page_image','embedded_image','figure_crop','table_crop')),
  file_path      TEXT NOT NULL,
  width          INTEGER NOT NULL DEFAULT 0,
  height         INTEGER NOT NULL DEFAULT 0,
  bbox           TEXT NOT NULL DEFAULT '{}',
  content_hash   TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_doc_assets_doc_page ON doc_assets(doc_id, page_num);
CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_assets_hash ON doc_assets(doc_id, content_hash);
```

图片文件存储在文档库目录下：

```text
documents/
  {doc_id}/
    original.pdf
    assets/
      page-0001.png
      page-0001-figure-01.png
      page-0001-table-01.png
```

### 5.3 可选新增 `doc_parse_blocks`

如果需要保留更完整的结构化中间结果，新增该表；第一阶段也可以只写 `doc_chunks` 与 `doc_assets`。

```sql
CREATE TABLE IF NOT EXISTS doc_parse_blocks (
  id             TEXT PRIMARY KEY,
  doc_id         TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_num       INTEGER NOT NULL,
  block_type     TEXT NOT NULL,
  block_order    INTEGER NOT NULL DEFAULT 0,
  raw_payload    TEXT NOT NULL DEFAULT '{}',
  normalized_md  TEXT NOT NULL DEFAULT '',
  asset_id       TEXT,
  confidence     REAL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

### 5.4 补齐 `doc_chunks_fts`

当前 AI 问答链路已经按 `doc_chunks_fts` 查询文档块，因此数据库迁移必须确认 FTS 表和触发器存在。若现有数据库尚未创建，应在同一次迁移中补齐：

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunks_fts USING fts5(
  content,
  tokenize='unicode61',
  content='doc_chunks',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS doc_chunks_ai AFTER INSERT ON doc_chunks BEGIN
  INSERT INTO doc_chunks_fts(rowid, content)
  VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS doc_chunks_ad AFTER DELETE ON doc_chunks BEGIN
  INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS doc_chunks_au AFTER UPDATE ON doc_chunks BEGIN
  INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
  INSERT INTO doc_chunks_fts(rowid, content)
  VALUES (new.rowid, new.content);
END;
```

对历史数据需要执行一次回填：

```sql
INSERT INTO doc_chunks_fts(rowid, content)
SELECT rowid, content FROM doc_chunks
WHERE rowid NOT IN (SELECT rowid FROM doc_chunks_fts);
```

## 6. 表格 Markdown 化方案

### 6.1 提取策略

优先级：

1. `pdfplumber.extract_tables()` 处理有明确表格线的 PDF。
2. `pdfplumber.find_tables()` 获取 bbox，裁剪表格图片作为资产。
3. 对扫描表格区域使用 OCR 结果按坐标聚类恢复单元格。
4. 当规则提取失败但页面疑似表格时，调用视觉模型输出 Markdown 表格。

表格检测条件：

- 页面存在明显横线/竖线或矩形网格。
- OCR 文本呈多列排列，且多行 x 坐标稳定。
- 关键词命中：`方案`、`核心特点`、`类型`、`优缺点`、`阶段`、`说明` 等。

### 6.2 Markdown 规范

输出要求：

- 第一行必须是语义标题：`## 第 N 页 表格：{标题}`。
- 表格统一 Markdown pipe 格式。
- 空单元格保留为空字符串，不用猜测。
- 跨行/跨列合并内容尽量展开到相邻单元格，不能展开时在单元格内用 `<br>`。
- 表格后可追加一句“表格说明”，但不得重复整张表。

示例：

```markdown
## 第 14 页 表格：Redis 分布式存储方案

| 分布式存储方案 | 核心特点 |
| --- | --- |
| 主从（Master/Slave）模式 | 一主多从，故障时手动切换。 |
| 哨兵（Sentinel）模式 | 有哨兵的一主多从，主节点故障自动选择新主节点。 |
| 集群（Cluster）模式 | 分节点对等集群，分 slots，不同 slots 的信息存储到不同节点。 |
```

### 6.3 清洗规则

- 去除页眉、页脚、水印、页码。
- 合并被换行拆开的中文句子。
- 修正常见 OCR 空格问题，如 `s lots` -> `slots`。
- 对表头为空或重复的表格，生成 `列1`、`列2` 兜底表头，并将 `confidence` 降低。
- 对单列表格不强行转表格，按普通文本块保存。

## 7. 图片/流程图视觉摘要方案

### 7.1 图像来源

图片和图形摘要来源包括：

- 整页截图：用于扫描页、PPT 转 PDF、全页流程图。
- PDF 嵌入图片：用于教材截图、照片、插图。
- 图形区域裁剪：用于流程图、UML/SysML、架构图、网络拓扑、电子政务关系图。
- 表格裁剪：用于表格规则提取失败时的视觉兜底。

### 7.2 图形区域检测

第一阶段采用保守规则，降低误检：

- 页面原生文本较少，但渲染图像中存在大量线条、矩形或箭头。
- OCR 识别到多个短文本标签，且标签在页面空间上分散。
- PDF 页面包含多个 `rect/line/curve/image` 对象，文本对象占比低。
- 用户预览时可看到“该页包含图示，建议生成视觉摘要”的提示。

第二阶段可引入 OpenCV：

- Canny/霍夫线检测识别表格线、箭头线、连接线。
- 轮廓检测识别框图节点。
- 根据 OCR 文本框与图形框的重叠关系生成候选图块。

### 7.3 视觉摘要输出格式

统一输出为可检索 Markdown：

```markdown
## 第 8 页 图示摘要：SysML 图分类

图中展示 SysML 图的分类关系。顶层为“SysML 图”，向下分为“行为图”“需求图”“结构图”三类。

结构关系：
- 行为图包含活动图、序列图、状态机图、用例图。
- 结构图包含模块定义图、内部模块图、包图。
- 参数图归属于内部模块图。
- 需求图作为 SysML 图的一类，与行为图、结构图并列。

可用于回答的问题：
- SysML 图有哪些大类？
- 行为图包含哪些图？
- 参数图属于哪类结构图？
```

流程图/架构图摘要必须包含：

- 图的主题。
- 主要元素。
- 元素之间的方向、层级或依赖关系。
- 对软考知识点的简短归类。
- 不确定内容明确标注“图中未明确”。

### 7.4 视觉模型接入

新增 `VisionProvider` 抽象，不直接耦合现有纯文本 `AIProvider`。

```python
class VisionProvider(Protocol):
    async def describe_image(
        self,
        image_path: str,
        prompt: str,
        *,
        temperature: float = 0.2,
    ) -> str: ...
```

支持三类后端：

- OpenAI-compatible 多模态接口：适配支持图片输入的远程模型或本地兼容服务。
- Anthropic 多模态接口：复用现有 Anthropic 配置，但消息格式需要支持图片块。
- Ollama 多模态模型：适合离线场景，但质量和速度取决于用户本地模型。

配置建议：

- 默认关闭视觉摘要，首次导入含图文档时提示用户开启。
- 支持“仅本地 OCR/表格规则”“远程视觉增强”“本地视觉增强”三种模式。
- 对同一图片按 `content_hash + prompt_version + model` 缓存摘要，避免重复调用。

## 8. 页面内容融合策略

页面内按以下顺序合并：

1. 标题/章节文本。
2. 正文段落。
3. 表格 Markdown。
4. 图示视觉摘要。
5. 页面级综合摘要。

去重规则：

- 表格区域内的 OCR 行不再重复作为普通文本块写入。
- 图示区域内 OCR 到的短标签保留在视觉摘要中，不重复写入为散乱段落。
- 原生文本和 OCR 文本相似度高时保留原生文本。
- 视觉摘要必须引用图片资产 `asset_id`，便于人工追溯。

页面级综合摘要可选生成，用于大页检索召回：

```markdown
## 第 12 页 页面摘要

本页主要介绍系统规划阶段的逻辑维、时间维和知识维。逻辑维包括明确问题、确定目标、系统综合、系统分析、优化、系统决策、实施计划；时间维包括规划、拟定方案、研制、生产、安装、运行、更新阶段；知识维覆盖工程、医药、建筑、商业、法律、管理等领域。
```

## 9. 接口契约

### 9.1 `/pdf/parse`

请求新增选项：

```json
{
  "file_path": "D:/xxx.pdf",
  "doc_id": "uuid",
  "task_id": "uuid",
  "top_margin_ratio": 0.07,
  "bottom_margin_ratio": 0.07,
  "start_page": 1,
  "end_page": null,
  "extract_tables": true,
  "extract_figures": true,
  "generate_visual_summary": false,
  "save_page_images": true,
  "vision_mode": "disabled"
}
```

`vision_mode` 可选值：

- `disabled`：不调用视觉模型，只做文本/OCR/表格。
- `remote`：使用远程多模态模型。
- `local`：使用本地多模态模型。

响应结果新增：

```json
{
  "doc_id": "uuid",
  "page_count": 120,
  "parsed_page_count": 10,
  "engines_used": ["pdfplumber", "rapidocr", "table-extractor"],
  "assets": [
    {
      "id": "asset-id",
      "page_num": 8,
      "asset_type": "figure_crop",
      "file_path": "D:/.../assets/page-0008-figure-01.png",
      "bbox": {"x0": 10, "top": 20, "x1": 700, "bottom": 500},
      "content_hash": "sha256..."
    }
  ],
  "chunks": [
    {
      "doc_id": "uuid",
      "page_num": 8,
      "content": "## 第 8 页 图示摘要...",
      "knowledge_tags": ["软件设计"],
      "chunk_type": "figure",
      "asset_id": "asset-id",
      "confidence": 0.82,
      "source_engine": "vision-openai-compatible",
      "block_order": 3,
      "bbox": {"x0": 10, "top": 20, "x1": 700, "bottom": 500}
    }
  ]
}
```

### 9.2 `/pdf/preview`

预览接口新增返回：

- `detected_tables_count`
- `detected_figures_count`
- `preview_blocks`
- `assets_preview`
- `engine`

前端预览从单一 `text` 改为“文本/表格/图示摘要”分块列表。第一阶段可先把分块结果拼接回 `text`，保持兼容。

## 10. RAG 检索与问答改造

### 10.1 FTS 检索

现有 AI 问答使用 `doc_chunks_fts MATCH ?` 检索。扩展后应确保 `doc_chunks_fts` 包含新增 Markdown 内容。

建议加权策略：

- `table`：对“对比、区别、优缺点、核心特点、阶段”等问题提高权重。
- `figure`：对“流程、关系、结构、包含、属于、方向、分类”等问题提高权重。
- `page_summary`：作为召回兜底，权重低于精确块。

SQLite FTS 不直接支持复杂加权时，可先多路查询：

1. 普通全文查询取 Top 5。
2. 根据问题关键词追加 `chunk_type IN ('table','figure')` 的查询。
3. 合并去重后按简单分数排序。

### 10.2 AI 上下文格式

传给 `/ai/chat` 的 `doc_chunks` 增加类型和来源：

```json
{
  "content": "## 第 14 页 表格...",
  "page_num": 14,
  "doc_title": "Redis 资料",
  "chunk_type": "table",
  "asset_id": "asset-id"
}
```

Prompt 中明确说明：

- Markdown 表格应按行列关系理解。
- 图示摘要代表图片/流程图内容，可用于回答结构、分类、关系类问题。
- 回答时引用页码和内容类型，例如“参考：第 14 页表格”。

## 11. 前端交互设计

PDF 导入弹窗新增：

- 复选框：提取表格为 Markdown。
- 复选框：保存页面图片/图示资产。
- 复选框：生成图片/流程图视觉摘要。
- 下拉项：视觉摘要模式，`关闭 / 远程模型 / 本地模型`。
- 提示：视觉摘要可能增加导入耗时和模型调用成本。

文档库内容查看新增：

- 内容块类型标签：文本、表格、图示、页面摘要。
- 表格块以 Markdown 渲染为表格。
- 图示块显示摘要，并提供“查看原图”按钮。
- 低置信度块显示“建议校对”标识。

后续可增加人工校正：

- 编辑 OCR 文本。
- 编辑表格 Markdown。
- 重新生成图示摘要。
- 将校正后的内容重新写入 FTS/向量索引。

## 12. 性能与成本控制

- 页面图片默认 150-200 DPI，视觉摘要裁剪图不超过模型输入限制。
- 大 PDF 分批处理，每批 5-10 页，进度通过 WebSocket 推送。
- OCR 与表格提取可并发，视觉模型调用限流，默认并发 1。
- 视觉摘要只对疑似图示页/图示区域执行，不对每页无差别调用。
- 摘要缓存键：`asset_hash + prompt_version + model + language`。
- 导入任务支持跳过视觉摘要，后续在文档详情页补跑。
- 远程视觉模型失败不导致 PDF 导入失败，只将视觉块标记为 `failed/skipped` 并继续导入文本和表格。

## 13. 错误处理

标准错误码建议：

- `PDF_TABLE_EXTRACT_FAILED`：表格规则提取失败，已降级为普通文本或视觉兜底。
- `PDF_VISION_DISABLED`：检测到图示但用户未开启视觉摘要。
- `PDF_VISION_PROVIDER_UNAVAILABLE`：视觉模型不可用。
- `PDF_ASSET_SAVE_FAILED`：图片资产保存失败。
- `PDF_PARSE_PARTIAL_SUCCESS`：部分页面失败，但整体导入完成。

导入结果应包含 `warnings`：

```json
{
  "warnings": [
    {
      "page_num": 8,
      "code": "PDF_VISION_DISABLED",
      "message": "检测到疑似流程图，未生成视觉摘要。"
    }
  ]
}
```

## 14. 测试方案

### 14.1 样本集

准备以下 PDF 样本：

- 原生文本教材页。
- 扫描版纯文本页。
- Redis 分布式方案表格页。
- SysML 分类图页。
- 系统规划三维模型图页。
- 电子政务 B/G/C/E 关系图页。
- 纯图片无文字页。
- 混合页：正文 + 表格 + 图。

### 14.2 单元测试

- 表格二维数组转 Markdown。
- OCR 文本按坐标聚类为行。
- 资产 hash、路径生成、去重。
- `chunk_type` 与 `source_engine` 写入。
- 视觉摘要 prompt 生成。

### 14.3 集成测试

- `/pdf/preview` 返回表格/图示数量。
- `/pdf/parse` 可写入 text/table/figure 多类型 chunks。
- 远程视觉模型失败时导入仍完成。
- 重复导入同一 PDF 命中 MD5 缓存，不重复生成资产。
- 删除文档时级联删除 `doc_chunks`、`doc_assets`，并清理资产文件。

### 14.4 问答验收

用导入后的文档库提问：

- “Redis 主从、哨兵、集群模式有什么区别？”
- “SysML 行为图包含哪些图？”
- “参数图属于哪一类图？”
- “电子政务中的 B2G、G2C、G2E 分别表示什么关系？”
- “系统规划的时间维包含哪些阶段？”

验收标准：

- 表格类问题能按行列准确回答。
- 图示类问题能回答元素关系和层级。
- 回答末尾能引用正确页码。
- 未开启视觉摘要时，系统能明确提示图示理解能力受限。

## 15. 开发计划（共 5 个 Phase，预计 18 人天）

---

### 总体规划与依赖关系

```
Phase 1: 表格 Markdown 化 (5天)
  ├── 1.1 DB 迁移 (0.5天) ─────────────────────┐
  ├── 1.2 Python 表格提取 (2天)                  │
  ├── 1.3 Electron 层适配 (1天)                  │
  ├── 1.4 前端表格渲染 (1天)                     │
  └── 1.5 验收测试 (0.5天)                       │
                                                  │
Phase 2: 图片资产与图示检测 (3天)                  │
  ├── 2.1 doc_assets 表 + 存储 (1天)             │
  ├── 2.2 Python 资产生成 (1天)                   │
  ├── 2.3 前端资产展示 (0.5天)                    │
  └── 2.4 删除级联清理 (0.5天)                    │
                                                  │
Phase 3: 视觉摘要 (5天)  ← 依赖 Phase 2           │
  ├── 3.1 VisionProvider 抽象 (1.5天)            │
  ├── 3.2 图形检测 + 摘要生成 (2天)               │
  ├── 3.3 缓存与容错 (1天)                        │
  └── 3.4 验收测试 (0.5天)                        │
                                                  │
Phase 4: RAG 检索增强 (3天)  ← 依赖 Phase 1,3     │
  ├── 4.1 FTS 索引 + 加权检索 (1.5天)            │
  ├── 4.2 AI prompt 适配 (1天)                    │
  └── 4.3 验收测试 (0.5天)                        │
                                                  │
Phase 5: 人工校正与补跑 (2天)  ← 依赖 Phase 1-4   │
  ├── 5.1 编辑校正功能 (1天)                      │
  ├── 5.2 单页补跑 (0.5天)                        │
  └── 5.3 验收测试 (0.5天)                        │
```

---

### Phase 1：表格 Markdown 化（5 人天）

#### 1.1 DB 迁移 → `migration v11`（0.5 天）

> **重要前置发现**：当前代码库中 `index.ts` 的 AI_CHAT handler（line ~2873）已经查询 `doc_chunks_fts`，但 `schema.ts` 的 migration v1-v10 从**未创建过该 FTS 虚拟表**。这意味着现有 FTS 全文检索查询在多数数据库上静默失败。本次迁移除了新增字段外，还**必须补齐 FTS 表和触发器**。

**文件**：`electron-app/src/main/db/schema.ts`（当前最新 migration version: 10）

**新增 migration v11**：

```typescript
{
  version: 11,
  sql: `
    -- 扩展 doc_chunks 表
    ALTER TABLE doc_chunks ADD COLUMN chunk_type TEXT NOT NULL DEFAULT 'text'
      CHECK(chunk_type IN ('text','table','figure','page_summary'));
    ALTER TABLE doc_chunks ADD COLUMN asset_id TEXT;
    ALTER TABLE doc_chunks ADD COLUMN confidence REAL;
    ALTER TABLE doc_chunks ADD COLUMN source_engine TEXT NOT NULL DEFAULT '';
    ALTER TABLE doc_chunks ADD COLUMN block_order INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE doc_chunks ADD COLUMN bbox TEXT;

    -- doc_chunks 全文索引（FTS5）
    CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunks_fts USING fts5(
      content,
      tokenize='unicode61',
      content='doc_chunks',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS doc_chunks_ai AFTER INSERT ON doc_chunks BEGIN
      INSERT INTO doc_chunks_fts(rowid, content)
      VALUES (new.rowid, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS doc_chunks_ad AFTER DELETE ON doc_chunks BEGIN
      INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, content)
      VALUES ('delete', old.rowid, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS doc_chunks_au AFTER UPDATE ON doc_chunks BEGIN
      INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, content)
      VALUES ('delete', old.rowid, old.content);
      INSERT INTO doc_chunks_fts(rowid, content)
      VALUES (new.rowid, new.content);
    END;

    -- 历史数据回填 FTS
    INSERT INTO doc_chunks_fts(rowid, content)
    SELECT rowid, content FROM doc_chunks
    WHERE rowid NOT IN (SELECT rowid FROM doc_chunks_fts);

    -- 新增 doc_assets 表（Phase 2 使用，提前建表避免后续迁移）
    CREATE TABLE IF NOT EXISTS doc_assets (
      id             TEXT PRIMARY KEY,
      doc_id         TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      page_num       INTEGER NOT NULL,
      asset_type     TEXT NOT NULL CHECK(asset_type IN ('page_image','embedded_image','figure_crop','table_crop')),
      file_path      TEXT NOT NULL,
      width          INTEGER NOT NULL DEFAULT 0,
      height         INTEGER NOT NULL DEFAULT 0,
      bbox           TEXT NOT NULL DEFAULT '{}',
      content_hash   TEXT NOT NULL,
      created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_doc_assets_doc_page ON doc_assets(doc_id, page_num);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_assets_hash ON doc_assets(doc_id, content_hash);
  `,
}
```

**文件**：`electron-app/src/main/db/documents.ts`

**修改 `insertChunks`**：新增 `chunk_type`、`asset_id`、`confidence`、`source_engine`、`block_order`、`bbox` 字段。

```typescript
// 函数签名变更
export function insertChunks(
  db: Database.Database,
  chunks: Array<{
    doc_id: string
    page_num: number
    content: string
    knowledge_tags: string[]
    chunk_type?: string        // 新增
    asset_id?: string | null   // 新增
    confidence?: number        // 新增
    source_engine?: string     // 新增
    block_order?: number       // 新增
    bbox?: string | null       // 新增
  }>
): number {
  const stmt = db.prepare(`
    INSERT INTO doc_chunks (id, doc_id, page_num, content, knowledge_tags,
      chunk_type, asset_id, confidence, source_engine, block_order, bbox)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertAll = db.transaction(() => {
    for (const c of chunks) {
      stmt.run(
        randomUUID(), c.doc_id, c.page_num, c.content,
        JSON.stringify(c.knowledge_tags),
        c.chunk_type ?? 'text',
        c.asset_id ?? null,
        c.confidence ?? null,
        c.source_engine ?? '',
        c.block_order ?? 0,
        c.bbox ?? null,
      )
    }
  })
  insertAll()
  return chunks.length
}
```

**修改 `DocChunk` 接口**：新增对应字段。

**修改 `getChunks`**：查询结果映射新增字段。

---

#### 1.2 Python 表格提取层（2 天）

**新增文件**：`python-service/modules/pdf/extractors/__init__.py`（空文件）
**新增文件**：`python-service/modules/pdf/extractors/tables.py`

**核心实现**：

```python
“””PDF 表格提取：使用 pdfplumber 检测表格并输出 Markdown。”””

import re
from typing import Optional

from loguru import logger


def extract_tables_from_page(page, page_num: int) -> list[dict]:
    “””
    从单页 PDF 提取所有表格，返回结构化列表。
    每条结果包含：
      - page_num: int
      - chunk_type: 'table'
      - content: str (Markdown table)
      - bbox: dict
      - confidence: float
      - source_engine: 'pdfplumber-table'
      - block_order: int
    “””
    tables = []
    try:
        found = page.find_tables()
    except Exception as exc:
        logger.warning(“Page {} table detection failed: {}”, page_num, exc)
        return tables

    for idx, table in enumerate(found):
        try:
            raw = table.extract()
        except Exception as exc:
            logger.warning(“Page {} table {} extraction failed: {}”, page_num, idx, exc)
            continue

        if not raw or len(raw) < 2:
            continue

        # 清理单元格
        cleaned = _clean_table(raw)
        if not cleaned or len(cleaned) < 2:
            continue

        md = _to_markdown(cleaned, page_num, idx + 1)
        if not md:
            continue

        bbox = _table_bbox(table)
        tables.append({
            “page_num”: page_num,
            “chunk_type”: “table”,
            “content”: md,
            “bbox”: bbox,
            “confidence”: 0.85,
            “source_engine”: “pdfplumber-table”,
            “block_order”: idx,
            “asset_type”: “table_crop”,
            “asset_bbox”: bbox,
        })

    return tables


def _clean_table(raw: list[list[Optional[str]]]) -> list[list[str]]:
    “””清洗表格单元格：去 None、去换行、合并多余空白。”””
    result = []
    for row in raw:
        cleaned_row = [
            re.sub(r”\s+”, “ “, (cell or “”).replace(“\n”, “ “)).strip()
            for cell in row
        ]
        if any(cleaned_row):
            result.append(cleaned_row)
    return result


def _to_markdown(rows: list[list[str]], page_num: int, table_index: int) -> str:
    “””将二维数组转为 Markdown pipe 表格。”””
    if not rows:
        return “”

    # 生成标题
    header_cells = rows[0]
    title_text = “、”.join(h for h in header_cells if h)[:30] or f”表格 {table_index}”
    title = f”## 第 {page_num} 页 表格：{title_text}\n\n”

    # 确定列数
    max_cols = max(len(row) for row in rows)
    if max_cols < 2:
        return “”  # 单列表格不转 Markdown 表格

    # 补齐列
    padded = []
    for row in rows:
        padded.append(row + [“”] * (max_cols - len(row)))

    # 表头
    header = “| “ + “ | “.join(padded[0]) + “ |\n”
    separator = “| “ + “ | “.join([“---”] * max_cols) + “ |\n”

    # 数据行
    body = “”
    for row in padded[1:]:
        body += “| “ + “ | “.join(row) + “ |\n”

    return title + header + separator + body


def _table_bbox(table) -> dict:
    “””提取表格的边界框坐标。”””
    try:
        return {
            “x0”: round(float(table.bbox[0]), 1),
            “top”: round(float(table.bbox[1]), 1),
            “x1”: round(float(table.bbox[2]), 1),
            “bottom”: round(float(table.bbox[3]), 1),
        }
    except Exception:
        return {}
```

**修改文件**：`python-service/modules/pdf/router.py`

**修改 `parse_pdf_pages`**：在文本提取后调用表格提取。

```python
# 在 parse_pdf_pages 的页面循环中，文本提取之后新增：
from modules.pdf.extractors.tables import extract_tables_from_page

# ... 文本提取逻辑 (line 370-375) 之后 ...
table_blocks = extract_tables_from_page(pdf.pages[page_index], page_num)

# 表格区域内的 OCR 文本不再作为普通文本块写入
# 将表格区域的文本从 text 中移除（简化版：用表格 bbox 标记）
for tb in table_blocks:
    all_chunks.append({
        “doc_id”: doc_id,
        “page_num”: page_num,
        “content”: tb[“content”],
        “knowledge_tags”: classify_knowledge_tags(tb[“content”]),
        “chunk_type”: tb[“chunk_type”],
        “source_engine”: tb[“source_engine”],
        “confidence”: tb[“confidence”],
        “block_order”: tb[“block_order”],
        “bbox”: tb[“bbox”],
    })
```

**修改 `/pdf/preview`**：返回新增 `detected_tables_count`。

**修改 `/pdf/parse` 请求模型**：新增 `extract_tables` 参数。

---

#### 1.3 Electron 层适配（1 天）

**文件**：`electron-app/src/main/index.ts`（~3117 行）

**修改 `DOC_IMPORT` handler**（当前位于 ~line 2275-2378）：

1. **`wsClient.onComplete` 回调**（~line 2314-2327）：扩展结果类型以接收新增字段（`chunk_type`、`asset_id`、`confidence`、`source_engine`、`block_order`、`bbox`）。
2. **`/pdf/parse` 请求体**：新增 `extract_tables: true`。
3. **`insertChunks` 调用**：传入新增字段。

```typescript
wsClient.onComplete(taskId, (_, result) => {
  const { page_count, chunks, assets } = result as {
    page_count: number
    chunks: Array<{
      doc_id: string; page_num: number; content: string
      knowledge_tags: string[]
      chunk_type?: string; asset_id?: string | null
      confidence?: number; source_engine?: string
      block_order?: number; bbox?: string | null
    }>
    assets?: Array<{
      id: string; doc_id: string; page_num: number
      asset_type: string; file_path: string
      width: number; height: number; bbox: string; content_hash: string
    }>
  }
  try {
    updateDocumentPageCount(db, doc.id, page_count)
    deleteDocChunks(db, doc.id)
    insertChunks(db, chunks)
    // Phase 2: 保存资产记录
    if (assets?.length) {
      insertAssets(db, assets)
    }
    taskManager!.updateTask(taskId, 'completed', {
      chunkCount: chunks.length,
      assetCount: assets?.length ?? 0,
    })
  } catch (e) {
    console.error('[DocImport] Failed to store chunks:', e)
  }
})
```

**修改 `DOC_IMPORT` 的 `/pdf/parse` 请求体**：新增 `extract_tables: true`。

---

#### 1.4 前端表格渲染与类型标签（1 天）

**文件**：`electron-app/src/renderer/src/stores/document.ts`

**修改 `DocChunk` 接口**：

```typescript
export interface DocChunk {
  id: string
  doc_id: string
  page_num: number
  content: string
  knowledge_tags: string[]
  chunk_type: 'text' | 'table' | 'figure' | 'page_summary'  // 新增
  asset_id: string | null        // 新增
  confidence: number | null      // 新增
  source_engine: string          // 新增
}
```

**文件**：`electron-app/src/renderer/src/views/DocumentsView.vue`

**修改内容块渲染**：

1. 新增类型标签：在 `chunk-topline` 中显示 `文本/表格/图示/摘要` 标签。
2. 表格类型块：使用简单的 HTML table 渲染 Markdown 表格（或解析 `|...|` 格式）。
3. 低置信度块显示”建议校对”标识。

```vue
<!-- 在 chunk-topline 中新增类型标签 -->
<div class=”chunk-topline”>
  <div class=”chunk-page”>
    第 {{ chunk.page_num }} 页
    <span class=”chunk-type-tag” :class=”`tag-${chunk.chunk_type}`”>
      {{ typeLabel(chunk.chunk_type) }}
    </span>
    <span v-if=”chunk.confidence != null && chunk.confidence < 0.7”
          class=”chunk-low-conf” title=”建议校对”>
      ⚠️
    </span>
  </div>
  <div class=”chunk-toggle”>{{ isChunkExpanded(chunk.id) ? '收起' : '展开' }}</div>
</div>
```

**新增函数**：

```typescript
function typeLabel(type: string) {
  const map: Record<string, string> = {
    text: '文本', table: '表格', figure: '图示', page_summary: '摘要'
  }
  return map[type] ?? '文本'
}

function renderMarkdownTable(content: string): string {
  // 简单解析 |...| 格式，转为 HTML table
  const lines = content.split('\n').filter(l => l.trim().startsWith('|'))
  if (lines.length < 2) return escapeHtml(content)
  // 构建 HTML table...
}
```

**文件**：`electron-app/src/renderer/src/views/DocumentsView.vue`（PDF 导入弹窗）

**新增选项**：复选框”提取表格为 Markdown”（默认勾选）。

---

#### 1.5 验收测试（0.5 天）

**Python 层**：编写 `test_table_extraction.py`：
- 测试 `_clean_table` 清洗逻辑
- 测试 `_to_markdown` 输出格式
- 测试 `extract_tables_from_page` 整体流程
- 使用 Redis 表格样本 PDF 验证端到端

**验收标准**：
- Redis 表格样本能正确提取为 Markdown 表格
- `chunk_type='table'` 正确写入数据库
- 前端正确显示表格类型标签
- 表格内容在 Markdown 渲染中行列对齐

---

### Phase 2：图片资产与图示检测（3 人天）

#### 2.1 doc_assets 表 + 存储（1 天）

> 注意：`doc_assets` 表已在 Phase 1.1 的 migration v11 中创建，此阶段只需实现存储逻辑。

**文件**：`electron-app/src/main/db/documents.ts`

**新增函数**：

```typescript
export interface DocAsset {
  id: string
  doc_id: string
  page_num: number
  asset_type: 'page_image' | 'embedded_image' | 'figure_crop' | 'table_crop'
  file_path: string
  width: number
  height: number
  bbox: string
  content_hash: string
  created_at: string
}

export function insertAssets(
  db: Database.Database,
  assets: Array<Omit<DocAsset, 'created_at'>>
): number {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO doc_assets (id, doc_id, page_num, asset_type, file_path, width, height, bbox, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertAll = db.transaction(() => {
    for (const a of assets) {
      stmt.run(a.id, a.doc_id, a.page_num, a.asset_type, a.file_path, a.width, a.height, a.bbox, a.content_hash)
    }
  })
  insertAll()
  return assets.length
}

export function deleteDocAssets(db: Database.Database, docId: string): void {
  db.prepare('DELETE FROM doc_assets WHERE doc_id = ?').run(docId)
}

export function getDocAssets(db: Database.Database, docId: string): DocAsset[] {
  return db.prepare('SELECT * FROM doc_assets WHERE doc_id = ? ORDER BY page_num').all(docId) as DocAsset[]
}
```

**文件**：`electron-app/src/main/index.ts`

**修改 `DOC_DELETE` handler**：级联删除资产文件和 `doc_assets` 记录。

```typescript
registerHandler(IPC.DOC_DELETE, async (id) => {
  const doc = getDocumentById(db, id as string)
  deleteDocument(db, id as string)
  // 清理资产文件目录
  if (doc) {
    const assetsDir = join(getStoragePaths().documentLibraryDir, doc.id, 'assets')
    if (existsSync(assetsDir)) {
      try { rmSync(assetsDir, { recursive: true, force: true }) } catch { /* non-critical */ }
    }
    // 清理原 PDF 文件
    if (isPathInsideDirectory(doc.file_path, getStoragePaths().documentLibraryDir) && existsSync(doc.file_path)) {
      try { unlinkSync(doc.file_path) } catch { /* non-critical */ }
    }
  }
})
```

---

#### 2.2 Python 资产生成（1 天）

**新增文件**：`python-service/modules/pdf/extractors/assets.py`

```python
“””PDF 页面/区域图片资产生成。”””

import hashlib
import uuid
from pathlib import Path
from typing import Optional

from loguru import logger


def generate_page_screenshot(
    pdfium_page,
    page_num: int,
    doc_id: str,
    output_dir: str,
    scale: float = 2.0,
) -> Optional[dict]:
    “””
    生成页面截图并保存为 PNG，返回资产元数据。
    “””
    try:
        from PIL import Image
    except ImportError:
        logger.warning(“Pillow not installed, cannot generate page screenshots”)
        return None

    try:
        bitmap = pdfium_page.render(scale=scale)
        image = bitmap.to_pil()
        assets_dir = Path(output_dir) / doc_id / “assets”
        assets_dir.mkdir(parents=True, exist_ok=True)

        filename = f”page-{page_num:04d}.png”
        filepath = assets_dir / filename
        image.save(str(filepath), “PNG”)

        content_hash = _hash_file(str(filepath))
        return {
            “id”: str(uuid.uuid4()),
            “doc_id”: doc_id,
            “page_num”: page_num,
            “asset_type”: “page_image”,
            “file_path”: str(filepath),
            “width”: image.width,
            “height”: image.height,
            “bbox”: “{}”,
            “content_hash”: content_hash,
        }
    except Exception as exc:
        logger.warning(“Failed to generate page screenshot for page {}: {}”, page_num, exc)
        return None


def generate_table_crop(
    pdfium_page,
    page_num: int,
    doc_id: str,
    output_dir: str,
    bbox: dict,
    scale: float = 2.0,
) -> Optional[dict]:
    “””裁剪表格区域并保存为 PNG。”””
    try:
        from PIL import Image
    except ImportError:
        return None

    try:
        bitmap = pdfium_page.render(scale=scale)
        image = bitmap.to_pil()
        x0 = int(bbox[“x0”] * scale)
        top = int(bbox[“top”] * scale)
        x1 = int(bbox[“x1”] * scale)
        bottom = int(bbox[“bottom”] * scale)
        cropped = image.crop((x0, top, x1, bottom))

        assets_dir = Path(output_dir) / doc_id / “assets”
        assets_dir.mkdir(parents=True, exist_ok=True)

        filename = f”page-{page_num:04d}-table-{_hash_bbox(bbox)}.png”
        filepath = assets_dir / filename
        cropped.save(str(filepath), “PNG”)

        content_hash = _hash_file(str(filepath))
        return {
            “id”: str(uuid.uuid4()),
            “doc_id”: doc_id,
            “page_num”: page_num,
            “asset_type”: “table_crop”,
            “file_path”: str(filepath),
            “width”: cropped.width,
            “height”: cropped.height,
            “bbox”: str(bbox),
            “content_hash”: content_hash,
        }
    except Exception as exc:
        logger.warning(“Failed to generate table crop for page {}: {}”, page_num, exc)
        return None


def _hash_file(filepath: str) -> str:
    “””计算文件的 SHA256。”””
    sha = hashlib.sha256()
    with open(filepath, “rb”) as f:
        for chunk in iter(lambda: f.read(8192), b””):
            sha.update(chunk)
    return sha.hexdigest()


def _hash_bbox(bbox: dict) -> str:
    return hashlib.md5(str(bbox).encode()).hexdigest()[:8]
```

**修改**：`python-service/modules/pdf/router.py` 的 `parse_pdf_pages`，在表格提取后调用资产生成。

**新增请求参数**：`save_page_images: bool = True`。

---

#### 2.3 前端资产展示（0.5 天）

**文件**：`electron-app/src/renderer/src/views/DocumentsView.vue`

**修改**：图表块和表格块展开时显示”查看原图”按钮，点击后使用系统图片查看器打开。

---

#### 2.4 删除级联清理（0.5 天）

**文件**：`electron-app/src/main/index.ts`

**修改 `DOC_DELETE` handler**：确保删除文档时：
1. 删除 `documents` 记录（CASCADE 删除 `doc_chunks`、`doc_assets`）
2. 清理 `documents/{doc_id}/` 目录下的所有资产文件
3. 清理托管 PDF 文件

---

### Phase 3：视觉摘要（5 人天）

#### 3.1 VisionProvider 抽象（1.5 天）

**新增文件**：`python-service/modules/pdf/vision.py`

```python
“””视觉模型抽象层：支持 OpenAI-compatible / Anthropic / Ollama 多模态。”””

import hashlib
import json
from pathlib import Path
from typing import Optional, Protocol, runtime_checkable

import httpx
from loguru import logger


@runtime_checkable
class VisionProvider(Protocol):
    async def describe_image(
        self, image_path: str, prompt: str, *, temperature: float = 0.2
    ) -> str: ...


class OpenAICompatVisionProvider:
    “””OpenAI-compatible 多模态接口（GPT-4V / 兼容服务）。”””

    def __init__(self, base_url: str, api_key: str, model: str):
        self.base_url = base_url.rstrip(“/”)
        self.model = model
        self.headers = {“Content-Type”: “application/json”}
        if api_key.strip():
            self.headers[“Authorization”] = f”Bearer {api_key.strip()}”

    async def describe_image(self, image_path: str, prompt: str, *, temperature: float = 0.2) -> str:
        import base64
        with open(image_path, “rb”) as f:
            b64 = base64.b64encode(f.read()).decode()

        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                f”{self.base_url}/chat/completions”,
                headers=self.headers,
                json={
                    “model”: self.model,
                    “messages”: [{
                        “role”: “user”,
                        “content”: [
                            {“type”: “text”, “text”: prompt},
                            {“type”: “image_url”, “image_url”: {“url”: f”data:image/png;base64,{b64}”}},
                        ],
                    }],
                    “temperature”: temperature,
                },
            )
            resp.raise_for_status()
            return resp.json()[“choices”][0][“message”][“content”]


class AnthropicVisionProvider:
    “””Anthropic 多模态接口（Claude 3+）。”””

    def __init__(self, api_key: str, model: str):
        self.model = model
        self.headers = {
            “x-api-key”: api_key,
            “anthropic-version”: “2023-06-01”,
            “Content-Type”: “application/json”,
        }

    async def describe_image(self, image_path: str, prompt: str, *, temperature: float = 0.2) -> str:
        import base64
        with open(image_path, “rb”) as f:
            b64 = base64.b64encode(f.read()).decode()

        # 检测图片类型
        ext = Path(image_path).suffix.lower()
        media_type = {“png”: “image/png”, “jpg”: “image/jpeg”, “jpeg”: “image/jpeg”}.get(ext, “image/png”)

        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                “https://api.anthropic.com/v1/messages”,
                headers=self.headers,
                json={
                    “model”: self.model,
                    “max_tokens”: 2048,
                    “messages”: [{
                        “role”: “user”,
                        “content”: [
                            {“type”: “image”, “source”: {“type”: “base64”, “media_type”: media_type, “data”: b64}},
                            {“type”: “text”, “text”: prompt},
                        ],
                    }],
                    “temperature”: temperature,
                },
            )
            resp.raise_for_status()
            return resp.json()[“content”][0][“text”]


class OllamaVisionProvider:
    “””Ollama 多模态（需要支持 vision 的模型，如 llava）。”””

    def __init__(self, base_url: str, model: str):
        self.base_url = base_url.rstrip(“/”)
        self.model = model

    async def describe_image(self, image_path: str, prompt: str, *, temperature: float = 0.2) -> str:
        import base64
        with open(image_path, “rb”) as f:
            b64 = base64.b64encode(f.read()).decode()

        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                f”{self.base_url}/api/generate”,
                json={
                    “model”: self.model,
                    “prompt”: prompt,
                    “images”: [b64],
                    “stream”: False,
                    “options”: {“temperature”: temperature},
                },
            )
            resp.raise_for_status()
            return resp.json()[“response”]


def build_vision_provider(config: dict) -> VisionProvider:
    “””根据 AI 配置构建视觉模型提供者。”””
    mode = config.get(“mode”, “openai”)
    if mode == “ollama”:
        ollama = config.get(“ollama”, {})
        return OllamaVisionProvider(
            base_url=ollama.get(“baseUrl”, “http://localhost:11434”),
            model=ollama.get(“visionModel”, ollama.get(“model”, “llava”)),
        )
    elif mode == “anthropic”:
        anthropic = config.get(“anthropic”, {})
        return AnthropicVisionProvider(
            api_key=anthropic.get(“apiKey”, “”),
            model=anthropic.get(“model”, “claude-sonnet-4-6”),
        )
    else:
        openai = config.get(“openai”, {})
        return OpenAICompatVisionProvider(
            base_url=openai.get(“baseUrl”, “https://api.openai.com/v1”),
            api_key=openai.get(“apiKey”, “”),
            model=openai.get(“visionModel”, openai.get(“model”, “gpt-4o-mini”)),
        )
```

**文件**：`python-service/modules/pdf/vision.py`（续）

**视觉摘要缓存**：

```python
# 缓存目录：{output_dir}/vision_cache/{hash}.json
def _cache_key(image_path: str, prompt: str, model: str) -> str:
    content = f”{image_path}:{prompt}:{model}”
    return hashlib.sha256(content.encode()).hexdigest()


def _load_cached_summary(cache_dir: str, cache_key: str) -> Optional[str]:
    cache_file = Path(cache_dir) / f”{cache_key}.json”
    if cache_file.exists():
        try:
            return json.loads(cache_file.read_text(encoding=”utf-8”))[“summary”]
        except Exception:
            return None
    return None


def _save_cached_summary(cache_dir: str, cache_key: str, summary: str) -> None:
    cache_dir_path = Path(cache_dir)
    cache_dir_path.mkdir(parents=True, exist_ok=True)
    (cache_dir_path / f”{cache_key}.json”).write_text(
        json.dumps({“summary”: summary, “cached_at”: “...”}, ensure_ascii=False),
        encoding=”utf-8”,
    )
```

---

#### 3.2 图形检测 + 摘要生成（2 天）

**新增文件**：`python-service/modules/pdf/extractors/visual.py`

```python
“””图示检测与视觉摘要生成。”””

from typing import Optional

from loguru import logger


# 视觉摘要 prompt 模板
FIGURE_SUMMARY_PROMPT = “””你是软考系统架构设计师考试辅导专家。请仔细分析这张图片。

如果图片是流程图、架构图、UML图、关系图等结构化图形，请描述：
1. 图的主题（一句话概括）
2. 图中包含的主要元素/节点/角色
3. 元素之间的方向、层级或依赖关系
4. 对软考知识点的简短归类

如果图片是普通截图、照片或文本页面，请简要描述图片内容。

要求：
- 用简洁的中文，控制在 200 字以内
- 不确定的内容标注”图中未明确”
- 不要猜测图中没有的内容”””

TABLE_VISION_PROMPT = “””请将这张图片中的表格转换为 Markdown 表格格式。
如果图片中不包含表格，请回复”图中无表格”。
要求：保持行列结构，空单元格保留为空，不要猜测内容。”””


def detect_figure_page(page_text: str, page_bbox: dict) -> bool:
    “””
    规则检测：判断页面是否疑似包含图示/流程图。
    检测条件：
    - 文本量较少但页面有实质内容
    - OCR 到多个短标签（节点名称）
    “””
    text_len = len(page_text.replace(“\n”, “”).replace(“ “, “”))
    if text_len == 0:
        return True  # 纯图片页
    # 短文本行比例高 → 可能包含图示标签
    lines = [l.strip() for l in page_text.split(“\n”) if l.strip()]
    short_lines = [l for l in lines if len(l) < 20]
    if lines and len(short_lines) / len(lines) > 0.7:
        return True
    return False


def generate_figure_summary(
    vision_provider,
    image_path: str,
    cache_dir: str,
    model_name: str,
) -> Optional[dict]:
    “””
    调用视觉模型生成图片摘要，返回结构化结果。
    返回 None 表示失败 / 跳过。
    “””
    from modules.pdf.vision import _cache_key, _load_cached_summary, _save_cached_summary

    cache_key = _cache_key(image_path, FIGURE_SUMMARY_PROMPT, model_name)
    cached = _load_cached_summary(cache_dir, cache_key)
    if cached:
        logger.info(“Vision summary cache hit for {}”, image_path)
        return {“content”: cached, “confidence”: 0.7, “source_engine”: “vision-cached”}

    try:
        import asyncio
        summary = asyncio.get_event_loop().run_until_complete(
            vision_provider.describe_image(image_path, FIGURE_SUMMARY_PROMPT)
        )
        _save_cached_summary(cache_dir, cache_key, summary)
        return {“content”: summary, “confidence”: 0.6, “source_engine”: “vision-remote”}
    except Exception as exc:
        logger.warning(“Vision summary failed for {}: {}”, image_path, exc)
        return None
```

**修改**：`python-service/modules/pdf/router.py` 的 `parse_pdf_pages`

**新增流程**：

```python
# vision_mode 参数：'disabled' | 'remote' | 'local'
# 当 vision_mode != 'disabled' 且有视觉模型配置时：
#   1. 对 detect_figure_page() 返回 True 的页面
#   2. 调用 generate_figure_summary()
#   3. 将摘要作为 chunk_type='figure' 的块写入
```

---

#### 3.3 缓存与容错（1 天）

**容错策略**：

1. 视觉模型调用失败 → 不导致 PDF 导入失败，只跳过该页视觉摘要
2. 超时保护：视觉模型调用默认 60s 超时
3. 并发控制：默认并发 1，防止 API 限流
4. 缓存命中 → 直接使用，不重复调用

**文件**：`python-service/modules/pdf/router.py`

**修改 `ParseRequest`**：

```python
class ParseRequest(PdfExtractOptions):
    file_path: str
    doc_id: str
    task_id: str
    extract_tables: bool = Field(default=True)
    extract_figures: bool = Field(default=True)
    generate_visual_summary: bool = Field(default=False)
    save_page_images: bool = Field(default=True)
    vision_mode: str = Field(default=”disabled”)
    ai_config: Optional[dict] = Field(default=None)  # 视觉模型配置
```

**修改 `process_pdf`**：接收新参数并传递给 `parse_pdf_pages`。

---

#### 3.4 验收测试（0.5 天）

**样本**：
- SysML 分类图 PDF
- 电子政务 B/G/C/E 关系图 PDF
- 系统规划三维模型图 PDF

**验收标准**：
- 视觉模型开启时，图示页产生 `chunk_type='figure'` 的摘要
- 视觉模型关闭时，图示页仍可导入（文本+OCR）
- 摘要缓存重复命中
- 视觉模型调用失败不阻塞导入

---

### Phase 4：RAG 检索增强（3 人天）

#### 4.1 FTS 索引 + 加权检索（1.5 天）

**背景**：当前 `index.ts` 的 AI_CHAT handler（~line 2847-2896）中，FTS 检索仅为简单的 `MATCH ?` 查询，且 FTS 表本身可能不存在（见 24.1 节）。Phase 1 的 migration v11 补齐 FTS 表后，需要在本阶段实现加权检索。

**文件**：`electron-app/src/main/index.ts` → 修改 AI_CHAT handler（~line 2847-2896）

**文件**：`electron-app/src/main/db/documents.ts` → 新增 `searchDocChunks` 和 `detectPreferredTypes`

```typescript
/**
 * 多路加权检索 doc_chunks。
 * 1. 普通全文查询取 Top 5
 * 2. 根据问题关键词追加 chunk_type='table'/'figure' 查询
 * 3. 合并去重，按简单分数排序
 */
export function searchDocChunks(
  db: Database.Database,
  query: string,
  options?: {
    limit?: number
    docId?: string
    preferTypes?: ('table' | 'figure')[]
  }
): DocChunk[] {
  const limit = options?.limit ?? 5
  const preferTypes = options?.preferTypes ?? detectPreferredTypes(query)

  const results: Map<string, DocChunk & { _score: number }> = new Map()

  // 查询 1：全文检索
  const ftsRows = db.prepare(`
    SELECT c.*, rank
    FROM doc_chunks_fts f
    JOIN doc_chunks c ON c.rowid = f.rowid
    WHERE doc_chunks_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(query, limit) as Array<DocChunk & { rank: number }>

  for (const row of ftsRows) {
    results.set(row.id, { ...row, _score: 1 / (1 + row.rank) })
  }

  // 查询 2：按类型加权补充
  if (preferTypes.length > 0) {
    const typePlaceholders = preferTypes.map(() => '?').join(',')
    const typeRows = db.prepare(`
      SELECT c.*, 0.5 as rank
      FROM doc_chunks_fts f
      JOIN doc_chunks c ON c.rowid = f.rowid
      WHERE doc_chunks_fts MATCH ? AND c.chunk_type IN (${typePlaceholders})
      LIMIT ?
    `).all(query, ...preferTypes, limit * 2) as Array<DocChunk & { rank: number }>

    for (const row of typeRows) {
      if (!results.has(row.id)) {
        results.set(row.id, { ...row, _score: 0.3 })
      } else {
        // 已有结果，加权
        const existing = results.get(row.id)!
        existing._score += 0.2
      }
    }
  }

  return Array.from(results.values())
    .sort((a, b) => b._score - a._score)
    .slice(0, limit)
}

/**
 * 根据问题关键词检测偏好类型。
 */
function detectPreferredTypes(query: string): ('table' | 'figure')[] {
  const lower = query.toLowerCase()
  const types: ('table' | 'figure')[] = []

  const tableKeywords = ['对比', '区别', '优缺点', '核心特点', '阶段', '分类', '类型', '方案', '特点']
  const figureKeywords = ['流程', '关系', '结构', '包含', '属于', '方向', '图', '架构', '层次']

  if (tableKeywords.some(k => lower.includes(k))) types.push('table')
  if (figureKeywords.some(k => lower.includes(k))) types.push('figure')

  return types
}
```

**文件**：`electron-app/src/main/index.ts`

**修改 AI Chat 流程**：使用 `searchDocChunks` 替代当前的 `getChunks` 全文查询。

**新增 IPC channel**：`DOC_SEARCH_CHUNKS`

**文件**：`electron-app/src/main/ipc-channels.ts`（新增 channel 定义）

```typescript
DOC_SEARCH_CHUNKS: 'doc:searchChunks',
DOC_UPDATE_CHUNK:   'doc:updateChunk',
DOC_REPARSE_PAGE:   'doc:reparsePage',
```

**文件**：`electron-app/src/main/index.ts`（注册新 handler）

```typescript
// DOC_SEARCH_CHUNKS — 多路加权检索
registerHandler(IPC.DOC_SEARCH_CHUNKS, async (args) => {
  const { query, limit, docId } = args as { query: string; limit?: number; docId?: string }
  return searchDocChunks(db, query, { limit, docId })
})

// DOC_UPDATE_CHUNK — 人工校正后更新
registerHandler(IPC.DOC_UPDATE_CHUNK, async (args) => {
  const { chunkId, content } = args as { chunkId: string; content: string }
  updateChunkContent(db, chunkId, content)
})
```

**修改 AI Chat 流程**：将 `index.ts` 中 AI_CHAT handler（~line 2873）的简单 FTS 查询替换为 `searchDocChunks` 加权检索。

---

#### 4.2 AI prompt 适配（1 天）

**文件**：`python-service/modules/ai/router.py`

**修改 `ChatRequest`**：

```python
class ChatRequest(BaseModel):
    ai_config: dict
    question: str
    history: list[dict] = []
    doc_chunks: list[dict] = []   # 新增 chunk_type, asset_id
```

**修改 `ai_chat` 函数**：

```python
# 上下文格式化时增加 chunk_type 信息
if req.doc_chunks:
    parts = []
    for c in req.doc_chunks[:5]:
        chunk_type = c.get(“chunk_type”, “text”)
        type_hint = {
            “table”: “（以下为Markdown表格，请按行列关系理解）”,
            “figure”: “（以下为图片/流程图描述，可用于回答结构、分类、关系类问题）”,
            “page_summary”: “（以下为页面摘要）”,
        }.get(chunk_type, “”)

        parts.append(
            f'【第{c.get(“page_num”, “?”)}页 · {c.get(“doc_title”, “文档”)} · {chunk_type}】{type_hint}\n'
            f'{c[“content”][:800]}'
        )
    context_text = '\n\n---\n\n'.join(parts)
```

**修改 `RAG_SYSTEM_PROMPT`**：

```python
RAG_SYSTEM_PROMPT = “””你是软考系统架构设计师备考助手，擅长软件架构、系统设计相关知识。
请根据提供的参考资料回答用户问题。如果参考资料与问题相关，优先使用参考资料的内容；
如果参考资料不相关或不足，可以补充你自己的专业知识。

注意：
- Markdown 表格应按行列关系理解，可用于回答对比、分类、特点类问题
- 图示摘要代表图片/流程图的内容，可用于回答结构、关系、层级类问题
- 回答时引用页码和内容类型，例如”参考：第14页表格”
- 如果参考资料不足以回答问题，请明确说明

回答时请用简洁清晰的中文。”””
```

**修改 `sources` 返回**：增加 `chunk_type` 字段。

```python
sources = [
    {
        'page_num': c.get('page_num'),
        'doc_title': c.get('doc_title', '文档'),
        'chunk_type': c.get('chunk_type', 'text'),
    }
    for c in req.doc_chunks[:5]
] if req.doc_chunks else []
```

---

#### 4.3 验收测试（0.5 天）

**问答测试用例**：

| 问题 | 预期行为 |
|------|----------|
| “Redis 主从、哨兵、集群模式有什么区别？” | 命中表格类型块，按行列回答 |
| “SysML 行为图包含哪些图？” | 命中图示摘要块，列出子图 |
| “参数图属于哪一类图？” | 命中图示摘要块，回答归属 |
| “电子政务中的 B2G、G2C、G2E 分别表示什么关系？” | 命中图示摘要块，回答关系 |
| “系统规划的时间维包含哪些阶段？” | 命中文本/表格块，列出阶段 |

**验收标准**：
- 回答末尾能引用正确页码和内容类型
- 表格类问题按行列准确回答
- 图示类问题能回答元素关系和层级
- 未开启视觉摘要时，系统能明确提示图示理解能力受限

---

### Phase 5：人工校正与补跑（2 人天）

#### 5.1 编辑校正功能（1 天）

**文件**：`electron-app/src/renderer/src/views/DocumentsView.vue`

**新增功能**：
- 表格块：双击进入编辑模式，可修改 Markdown 表格内容
- 图示摘要块：双击进入编辑模式，可修改摘要文本
- 低置信度块（`confidence < 0.7`）显示”⚠️ 建议校对”标识
- 保存按钮：将编辑后的内容写回 `doc_chunks` 表

**新增 IPC channel**：`DOC_UPDATE_CHUNK`

**文件**：`electron-app/src/main/db/documents.ts`

```typescript
export function updateChunkContent(
  db: Database.Database,
  chunkId: string,
  content: string,
): void {
  db.prepare('UPDATE doc_chunks SET content = ? WHERE id = ?').run(content, chunkId)
}
```

---

#### 5.2 单页补跑（0.5 天）

**文件**：`electron-app/src/renderer/src/views/DocumentsView.vue`

**新增功能**：
- 每个内容块/页面新增”重新生成”按钮
- 点击后发送单页解析请求到 Python 服务
- 支持：重新 OCR、重新提取表格、重新生成视觉摘要

**文件**：`python-service/modules/pdf/router.py`

**新增接口**：`POST /pdf/reparse-page`

```python
@router.post(“/reparse-page”)
async def reparse_page(req: ReparsePageRequest):
    “””单页重新解析，支持 OCR / 表格 / 视觉摘要。”””
    ...
```

---

#### 5.3 验收测试（0.5 天）

**验收标准**：
- 编辑表格 Markdown 后保存成功
- 编辑后 FTS 索引自动更新
- 单页补跑不重复生成已有资产
- 低置信度块正确显示在”待校对”筛选结果中

---

## 16. 文件变更清单（汇总）

### Python 服务（python-service/）

| 文件 | 操作 | Phase |
|------|------|-------|
| `modules/pdf/__init__.py` | 不变 | - |
| `modules/pdf/router.py` | **修改**：新增表格提取、资产生成、视觉摘要流程 | 1-3 |
| `modules/pdf/extractors/__init__.py` | **新增** | 1 |
| `modules/pdf/extractors/tables.py` | **新增**：表格提取与 Markdown 化 | 1 |
| `modules/pdf/extractors/assets.py` | **新增**：页面截图与资产文件生成 | 2 |
| `modules/pdf/extractors/visual.py` | **新增**：图示检测与视觉摘要 | 3 |
| `modules/pdf/vision.py` | **新增**：VisionProvider 抽象与多后端实现 | 3 |
| `modules/ai/router.py` | **修改**：RAG prompt 适配表格/图示摘要 | 4 |
| `requirements.txt` | **修改**：新增 `Pillow` 依赖 | 2 |

### Electron 主进程（electron-app/src/main/）

| 文件 | 操作 | Phase |
|------|------|-------|
| `db/schema.ts` | **修改**：新增 migration v11（doc_chunks 扩展 + FTS + doc_assets） | 1 |
| `db/documents.ts` | **修改**：扩展 insertChunks、新增 insertAssets/deleteDocAssets/searchDocChunks/updateChunkContent | 1-5 |
| `index.ts` | **修改**：DOC_IMPORT 适配新字段、DOC_DELETE 级联清理、AI_CHAT 使用加权检索 | 1-4 |
| `ipc-channels.ts` | **修改**：新增 DOC_SEARCH_CHUNKS、DOC_UPDATE_CHUNK 等 channel | 4-5 |

### 前端（electron-app/src/renderer/src/）

| 文件 | 操作 | Phase |
|------|------|-------|
| `stores/document.ts` | **修改**：DocChunk 接口扩展、新增资产相关方法 | 1-5 |
| `views/DocumentsView.vue` | **修改**：类型标签、表格渲染、编辑模式、补跑按钮、导入选项 | 1-5 |

---

## 17. 测试策略

### 17.1 单元测试

| 测试对象 | 文件 | Phase |
|----------|------|-------|
| `_clean_table()` | `test_table_extraction.py` | 1 |
| `_to_markdown()` | `test_table_extraction.py` | 1 |
| `detect_figure_page()` | `test_visual.py` | 3 |
| `_cache_key()` / 缓存读写 | `test_vision_cache.py` | 3 |
| `detectPreferredTypes()` | `test_search.test.ts` | 4 |
| `searchDocChunks()` | `test_search.test.ts` | 4 |

### 17.2 集成测试

| 场景 | Phase |
|------|-------|
| `/pdf/preview` 返回 `detected_tables_count` | 1 |
| `/pdf/parse` 写入 text/table/figure 多类型 chunks | 1-3 |
| 远程视觉模型失败时导入仍完成 | 3 |
| 重复导入同一 PDF 命中缓存 | 3 |
| 删除文档时级联清理 `doc_chunks`、`doc_assets` 和资产文件 | 2 |
| FTS 检索结果包含新增 Markdown 内容 | 4 |

### 17.3 端到端验收

详细验收用例见各 Phase 的验收测试小节。

---

## 18. 风险与取舍

| 风险 | 缓解措施 | 
|------|----------|
| 视觉模型成本和耗时 | 默认关闭、可补跑、可缓存、图示检测过滤 |
| 扫描件表格提取不稳定 | 第一阶段优先规则表格，扫描表格放第二阶段或视觉兜底 |
| 流程图理解依赖模型能力 | 显示置信度和原图入口，不承诺 100% 正确 |
| 本地多模态模型部署门槛高 | 作为可选增强，不成为 PDF 导入的硬依赖 |
| DB 迁移回滚 | 每个 migration 独立，使用 `user_version` 机制，向前兼容 |

---

## 19. 推荐执行顺序

建议按”**表格优先、资产留存、视觉可选、RAG 渐进增强**”的路线实施：

1. **Phase 1 先跑**：表格 Markdown 化 + `chunk_type` 扩展 + FTS 补齐，立即提升知识库问答质量
2. **Phase 2 紧随**：图片资产和图示检测，为视觉摘要奠定基础
3. **Phase 3 可选增强**：接入视觉模型，即使不可用 PDF 导入仍稳定
4. **Phase 4 串联**：RAG 检索增强，让前端展示和 AI 问答充分利用新数据
5. **Phase 5 闭环**：人工校正确保数据质量持续提升

> **配套文档**：
> - 第 20 节：开发工作流与协作规范（分支策略、提交规范、PR 审查、测试门禁）
> - 第 21 节：代码审查清单（按 Phase 分列的具体检查项）
> - 第 22 节：部署与回滚策略（部署步骤、回滚方式、兼容性矩阵、渐进式发布）
> - 第 23 节：里程碑与进度跟踪（里程碑表、任务看板、人天汇总）
> - 第 24 节：已发现的现有代码库问题（FTS 缺失等需在 Phase 1 一并修复）

## 20. 开发工作流与协作规范

### 20.1 分支策略

```
main
  └── feat/pdf-table-markdown        (Phase 1)
  └── feat/pdf-assets-detection      (Phase 2, 基于 Phase 1 分支)
  └── feat/pdf-visual-summary        (Phase 3, 基于 Phase 2 分支)
  └── feat/pdf-rag-enhancement       (Phase 4, 基于 Phase 1+3 分支)
  └── feat/pdf-manual-correction     (Phase 5, 基于 Phase 4 分支)
```

- 每个 Phase 独立分支，基于前一 Phase 分支创建。
- Phase 完成后合并回 `main`，打 tag（如 `v1.6.0-table-markdown`）。
- 跨 Phase 并行开发时（如 Phase 4 可与 Phase 2-3 部分并行），需提前协调冲突文件。

### 20.2 提交规范

采用 Conventional Commits：

| 类型 | 示例 |
|------|------|
| `feat(pdf):` | `feat(pdf): add table extraction and markdown conversion` |
| `feat(db):` | `feat(db): add migration v11 for doc_chunks extension` |
| `feat(ui):` | `feat(ui): add chunk type tags and table rendering` |
| `fix(pdf):` | `fix(pdf): handle empty table cells in markdown output` |
| `refactor(pdf):` | `refactor(pdf): extract table logic to extractors/tables.py` |
| `test(pdf):` | `test(pdf): add unit tests for table extraction` |

### 20.3 PR 审查流程

1. 开发者提交 PR，附带测试结果截图或日志。
2. 审查者检查：
   - 代码是否符合现有模式（类型定义、错误处理、日志风格）。
   - 是否覆盖了 Code Review Checklist（见第 21 节）。
   - DB 迁移是否正确设置 `user_version` 且可回滚。
3. 通过后 squash merge 到目标分支。

### 20.4 测试门禁

每个 Phase 提交前必须通过：

- Python 单元测试：`pytest tests/ -k “pdf”`（Phase 1-3）
- TypeScript 类型检查：`npx tsc --noEmit`（Phase 1-5）
- 端到端验收：使用样本 PDF 走完整”导入→浏览→问答”流程（每个 Phase 至少 2 个场景）

---

## 21. 代码审查清单

### Phase 1（表格 Markdown 化）

- [ ] `migration v11` 的 `user_version` 正确递增
- [ ] `ALTER TABLE` 新增字段有正确的 `DEFAULT` 值
- [ ] FTS 触发器正确覆盖 INSERT / DELETE / UPDATE
- [ ] `insertChunks` 新字段使用 `??` 提供默认值，向后兼容旧调用
- [ ] `getChunks` 查询结果映射了新字段
- [ ] Python 表格提取在 `pdfplumber` 不可用时不崩溃
- [ ] Markdown 表格输出列数正确对齐
- [ ] 前端 `DocChunk` 接口与 Electron 主进程返回类型一致
- [ ] 前端类型标签映射覆盖所有 `chunk_type` 值
- [ ] PDF 导入弹窗新增复选框不影响现有默认行为

### Phase 2（图片资产与图示检测）

- [ ] `doc_assets` 表的 `ON DELETE CASCADE` 正确生效
- [ ] 资产文件路径使用 `path.join()` 而非字符串拼接
- [ ] `content_hash` 唯一索引在重复导入时不抛异常（使用 `INSERT OR IGNORE`）
- [ ] `DOC_DELETE` 清理资产目录前检查路径在文档库内（防止误删）
- [ ] Pillow 依赖添加到 `requirements.txt`
- [ ] 前端”查看原图”按钮调用 `shell.openPath()` 且处理文件不存在情况

### Phase 3（视觉摘要）

- [ ] `VisionProvider` 协议定义清晰，各实现错误处理一致
- [ ] API Key 不记录到日志
- [ ] 视觉模型调用有超时保护（默认 120s）
- [ ] 缓存 key 基于 `content_hash + prompt_version + model`，换模型不命中旧缓存
- [ ] `vision_mode='disabled'` 时完全不加载视觉模型依赖
- [ ] 视觉模型调用失败不阻塞其他 chunk 写入
- [ ] warn 日志包含足够上下文（页码、错误类型）便于排查

### Phase 4（RAG 检索增强）

- [ ] `searchDocChunks` 在 FTS 表不存在时不抛异常（向后兼容旧数据库）
- [ ] `detectPreferredTypes` 关键词列表可通过配置扩展
- [ ] AI prompt 新增说明在无视觉摘要时不产生幻觉
- [ ] `sources` 返回新增 `chunk_type` 字段后前端兼容

### Phase 5（人工校正与补跑）

- [ ] 编辑内容通过 `UPDATE` 写回后 FTS 索引自动更新（触发器保证）
- [ ] 单页补跑不重复生成已存在的资产文件（hash 去重）
- [ ] 编辑后的 `confidence` 标记为 `1.0`（人工确认）

---

## 22. 部署与回滚策略

### 22.1 部署步骤

```
1. 备份当前数据库文件（documents.db）
2. 停止应用
3. 更新 Python 依赖：pip install -r requirements.txt
4. 部署新版本 Electron 应用 + Python 服务
5. 启动应用，确认 migration v11 自动执行
6. 验证：导入一份含表格 PDF，确认 chunk_type='table' 写入成功
7. 验证：已有文档的问答功能正常
```

### 22.2 回滚策略

| 场景 | 回滚方式 |
|------|----------|
| migration 执行失败 | SQLite `user_version` 未递增，旧版代码直接可用 |
| migration 执行成功但功能异常 | 1) 恢复 `documents.db` 备份；2) 部署旧版本应用 |
| 部分 Phase 需回滚 | 因每个 Phase 独立分支，可只回滚问题 Phase（但 DB schema 需评估兼容性） |

### 22.3 数据库兼容性

| Phase | Schema 变更 | 旧版代码兼容 |
|-------|------------|-------------|
| Phase 1 | `doc_chunks` 新增 6 列 + FTS 表 + `doc_assets` 表 | ✅ 新列为 `NOT NULL DEFAULT`，旧版 `insertChunks` 调用需同步更新 |
| Phase 2 | 无新增 schema（`doc_assets` 已在 Phase 1 创建） | ✅ |
| Phase 3-5 | 无 schema 变更 | ✅ |

### 22.4 渐进式发布建议

1. **内部测试**（Phase 1 完成后）：在开发者环境导入 5 份不同类型 PDF，验证表格提取和问答质量。
2. **Beta 发布**（Phase 1-2 完成后）：邀请 2-3 名用户试用，收集反馈。
3. **正式发布**（Phase 1-4 完成后）：全量发布，保留视觉摘要为可选功能。
4. **持续改进**（Phase 5 完成后）：根据用户人工校正数据优化默认参数和 prompt。

---

## 23. 里程碑与进度跟踪

### 23.1 里程碑

| 里程碑 | 预计日期 | 交付物 | 验收标准 |
|--------|---------|--------|---------|
| M1: 表格提取可用 | Phase 1 启动后第 5 天 | `feat/pdf-table-markdown` 分支合并 | Redis 表格样本正确提取为 Markdown，`chunk_type='table'` 写入 DB |
| M2: 资产体系就绪 | Phase 2 启动后第 3 天 | `feat/pdf-assets-detection` 分支合并 | 页面截图和表格裁剪自动保存，删除文档级联清理 |
| M3: 视觉摘要可用 | Phase 3 启动后第 5 天 | `feat/pdf-visual-summary` 分支合并 | 图示页产生 `chunk_type='figure'` 摘要，缓存命中，失败不阻塞 |
| M4: RAG 增强上线 | Phase 4 启动后第 3 天 | `feat/pdf-rag-enhancement` 分支合并 | 表格类问题按行列回答，图示类问题回答元素关系 |
| M5: 质量闭环 | Phase 5 启动后第 2 天 | `feat/pdf-manual-correction` 分支合并 | 编辑保存后 FTS 自动更新，单页补跑不重复生成 |

### 23.2 进度看板

建议使用 GitHub Project 或本地 TODO 跟踪，每个文件变更对应一个子任务：

```
Phase 1: 表格 Markdown 化 [5天]
├── □ 1.1a schema.ts: 新增 migration v11
├── □ 1.1b documents.ts: 扩展 insertChunks / getChunks / DocChunk 接口
├── □ 1.2a 新增 extractors/tables.py
├── □ 1.2b router.py: 集成表格提取到 parse_pdf_pages
├── □ 1.2c router.py: 扩展 /pdf/preview 和 /pdf/parse 请求模型
├── □ 1.3a index.ts: DOC_IMPORT 适配新字段
├── □ 1.4a document.ts (store): 扩展 DocChunk 接口
├── □ 1.4b DocumentsView.vue: 类型标签 + 表格渲染 + 导入选项
├── □ 1.5a test_table_extraction.py: 单元测试
└── □ 1.5b 端到端验收测试

Phase 2: 图片资产与图示检测 [3天]
├── □ 2.1a documents.ts: 新增 insertAssets / deleteDocAssets / getDocAssets
├── □ 2.1b index.ts: DOC_DELETE 级联清理 + DOC_IMPORT 保存资产
├── □ 2.2a 新增 extractors/assets.py
├── □ 2.2b router.py: 集成资产生成
├── □ 2.3 DocumentsView.vue: “查看原图”按钮
└── □ 2.4 删除级联清理验证

Phase 3: 视觉摘要 [5天]
├── □ 3.1a 新增 vision.py: VisionProvider 协议 + 三个实现
├── □ 3.1b vision.py: 缓存读写
├── □ 3.2a 新增 extractors/visual.py: 图示检测 + prompt + 摘要生成
├── □ 3.2b router.py: 集成视觉摘要流程
├── □ 3.3 容错处理（超时、限流、失败降级）
└── □ 3.4 验收测试

Phase 4: RAG 检索增强 [3天]
├── □ 4.1a documents.ts: searchDocChunks + detectPreferredTypes
├── □ 4.1b index.ts: AI_CHAT 使用加权检索
├── □ 4.2a ai/router.py: RAG prompt 适配
├── □ 4.2b ai/router.py: sources 增加 chunk_type
└── □ 4.3 问答验收测试

Phase 5: 人工校正与补跑 [2天]
├── □ 5.1a documents.ts: updateChunkContent
├── □ 5.1b DocumentsView.vue: 编辑模式 + 低置信度标识
├── □ 5.2a router.py: POST /pdf/reparse-page
├── □ 5.2b DocumentsView.vue: 重新生成按钮
└── □ 5.3 验收测试
```

### 23.3 总人天汇总

| Phase | 内容 | 人天 | 累计 |
|-------|------|------|------|
| Phase 1 | 表格 Markdown 化 | 5 | 5 |
| Phase 2 | 图片资产与图示检测 | 3 | 8 |
| Phase 3 | 视觉摘要 | 5 | 13 |
| Phase 4 | RAG 检索增强 | 3 | 16 |
| Phase 5 | 人工校正与补跑 | 2 | **18** |
| **合计** | | **18** | |

---

## 24. 补充说明：当前代码库已发现的问题

基于对现有代码库的审查，以下问题应在 Phase 1 中一并修复：

### 24.1 FTS 表缺失（关键）

**现状**：`electron-app/src/main/index.ts` 的 AI_CHAT handler 中查询 `doc_chunks_fts MATCH ?`，但 `schema.ts` 的 migration v1-v10 中**从未创建过 `doc_chunks_fts` 虚拟表**。这意味着当前 FTS 查询在多数数据库中会静默失败（被 try/catch 吞掉），导致 AI 问答的文档检索实际上未生效或降级为空结果。

**修复**：Phase 1.1 的 migration v11 中新增 `CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunks_fts`，并对历史数据执行回填 `INSERT INTO doc_chunks_fts(rowid, content) SELECT rowid, content FROM doc_chunks`。

### 24.2 `vector_id` 字段未使用

**现状**：`doc_chunks` 表自 migration v1 起就定义了 `vector_id TEXT` 字段，但无任何代码写入该字段。

**建议**：暂不处理，保留为未来向量检索扩展的预留字段。若后续引入 embedding，可直接复用。

### 24.3 知识标签硬编码

**现状**：`classify_knowledge_tags()` 使用硬编码的关键词字典，覆盖 10 个软考知识类别。

**建议**：Phase 1 不做修改，后续可考虑将标签字典外置为配置文件，或使用 AI 自动分类。当前修改不影响主流程。

### 24.4 解析结果无 chunk 去重

**现状**：每次 PDF 导入先 `deleteDocChunks` 再 `insertChunks`，全量替换。

**评估**：此行为在当前设计中是合理的。Phase 1 引入的表格和资产去重在 Python 层完成（通过 `content_hash` 唯一索引），不需要改变 Electron 层的替换策略。
