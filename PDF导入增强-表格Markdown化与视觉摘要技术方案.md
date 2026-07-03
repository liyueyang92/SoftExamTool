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

## 15. 实施计划

### Phase 1：表格 Markdown 化

- 新增 `tables.py`，使用 `pdfplumber.extract_tables()`。
- 解析结果支持 `chunk_type='table'`。
- 数据库迁移扩展 `doc_chunks`。
- 前端文档库渲染 Markdown 表格。
- 完成 Redis 表格样本验收。

### Phase 2：图片资产与图示检测

- 新增 `doc_assets` 表和资产保存目录。
- 页面/区域截图保存为 PNG。
- 基于规则检测疑似图示页。
- `/pdf/preview` 展示检测到的表格和图示数量。
- 删除文档时清理资产目录。

### Phase 3：视觉摘要

- 新增 `VisionProvider` 抽象。
- 支持 OpenAI-compatible 多模态接口。
- 支持视觉摘要缓存。
- 图示摘要写入 `doc_chunks`，类型为 `figure`。
- 完成 SysML、电子政务关系图样本验收。

### Phase 4：RAG 检索增强

- AI 问答检索时按 `chunk_type` 补充召回。
- `/ai/chat` prompt 适配表格和图示摘要。
- 来源引用显示“页码 + 内容类型”。
- 增加页面级综合摘要作为召回兜底。

### Phase 5：人工校正与补跑

- 文档详情页支持编辑表格 Markdown/图示摘要。
- 支持单页重新 OCR、重新生成视觉摘要。
- 校正后刷新 FTS/向量索引。
- 低置信度块进入“待校对”筛选。

## 16. 风险与取舍

- 视觉模型成本和耗时不可忽略，因此必须默认可关闭、可补跑、可缓存。
- 流程图理解依赖模型能力，不能承诺 100% 正确，需要显示置信度和原图入口。
- 表格提取在扫描件中不稳定，第一阶段优先覆盖规则表格，扫描表格放到第二阶段或视觉兜底。
- 本地多模态模型部署门槛较高，应作为可选增强，不能成为 PDF 导入的硬依赖。
- Markdown 表格比结构化 JSON 更适合当前 RAG，但若后续要做表格计算/筛选，需要保留 `raw_payload` 或 `doc_parse_blocks`。

## 17. 推荐结论

建议按“表格优先、资产留存、视觉可选、RAG 渐进增强”的路线实施。

第一期先完成表格 Markdown 化和 `chunk_type` 扩展，立即提升知识库问答质量；第二期补齐图片资产和图示检测；第三期接入视觉模型生成流程图/结构图摘要。这样即使视觉模型不可用，PDF 导入仍保持稳定，且每一步都能独立验收。
