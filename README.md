# SoftExamTool

软考系统架构设计师考试辅助桌面工具。项目以 Electron + Vue 作为桌面端界面，内置本地 SQLite 数据库，并通过 Python FastAPI 服务处理 PDF 导入、OCR、爬虫等较重的后台能力。

## 功能概览

- 题库管理：题目增删改查、收藏、分组、全文检索。
- 刷题练习：随机、顺序、错题、收藏练习，记录答题结果。
- PDF 导入：预览裁剪、文本抽取、OCR 辅助导入资料。
- AI 辅助：AI 生成题目、论文评分、资料问答。
- 学习计划：考试日期驱动的计划任务、日历统计、番茄钟学习记录。
- 论文素材：论文草稿、版本保存、素材库和 AI 建议。
- 爬虫导入：规则配置、登录态维护、采集预览、人工审核后入库。
- 备份恢复：本地数据库备份、恢复和数据目录迁移。

## 技术栈

- 桌面端：Electron、electron-vite、Vue 3、Pinia、TypeScript
- 本地数据库：better-sqlite3-multiple-ciphers、SQLCipher
- Python 服务：FastAPI、Uvicorn、pdfplumber、RapidOCR、Playwright
- 测试：Playwright E2E、TypeScript typecheck
- 构建：PyInstaller、electron-builder

## 目录结构

```text
.
├─ electron-app/          # Electron 主进程、preload、Vue 渲染层和 E2E 测试
├─ python-service/        # FastAPI 后台服务和 PDF/爬虫/AI 相关模块
├─ resources/             # 打包资源
├─ scripts/               # 开发、构建、验证脚本
├─ release/               # 构建产物输出目录
└─ *.md                   # 需求、技术方案、实施计划文档
```

## 环境要求

- Windows + PowerShell
- Node.js 20 或更高版本
- Python 3.11 或更高版本
- npm

Python 爬虫能力需要浏览器运行时。依赖安装后可按需执行：

```powershell
python-service\.venv\Scripts\python -m playwright install chromium
```

## 初始化

在仓库根目录执行：

```powershell
cd electron-app
npm install
cd ..

python -m venv python-service\.venv
python-service\.venv\Scripts\python -m pip install -r python-service\requirements.txt
```

## 开发启动

推荐从仓库根目录一键启动 Python 服务和 Electron 开发环境：

```powershell
.\scripts\dev-start.ps1
```

也可以通过 npm 脚本启动：

```powershell
cd electron-app
npm run dev:all
```

开发脚本会使用固定本地配置：

```text
INTERNAL_PORT=8765
INTERNAL_TOKEN=dev-token-local
```

## 常用命令

```powershell
# TypeScript 类型检查
cd electron-app
npm run typecheck

# Electron 开发模式，仅启动前端和 Electron
npm run dev

# E2E 测试
npm run test:e2e

# 完整构建
cd ..
.\scripts\build-all.ps1

# 跳过 Python 构建和 E2E，仅构建 Electron
.\scripts\build-all.ps1 -SkipPython -SkipE2E
```

## 构建产物

完整构建会依次执行：

1. 使用 PyInstaller 构建 `python-service`
2. 使用 electron-builder 构建桌面应用
3. 可选执行 Playwright E2E 测试

构建结果输出到：

```text
release/
```

可选目标：

```powershell
.\scripts\build-all.ps1 -Target nsis
.\scripts\build-all.ps1 -Target portable
.\scripts\build-all.ps1 -Target dir
```

## 数据与配置

应用会在用户数据目录下维护：

- 加密 SQLite 数据库
- 数据库密钥
- AI 配置
- 应用设置
- 文档库
- 备份文件

具体路径可以在应用的“设置”页查看和迁移。

## 常见问题

### Python 服务启动失败

确认虚拟环境和依赖已安装：

```powershell
python-service\.venv\Scripts\python -m pip install -r python-service\requirements.txt
```

如果端口被占用，`scripts/dev-start.ps1` 会尝试结束占用 `8765` 的旧进程。

### PDF 或爬虫功能缺少浏览器运行时

安装 Chromium：

```powershell
python-service\.venv\Scripts\python -m playwright install chromium
```

### 数据库打不开

项目使用 SQLCipher 加密数据库。若密钥丢失，已有数据库可能无法恢复。开发环境中可以备份后删除数据库文件，让应用重新初始化。

## 相关文档

- `软考系统架构设计师考试辅助桌面工具-需求方案.md`
- `软考架构师桌面工具-技术方案.md`
- `软考架构师桌面工具-开发实施计划.md`
- `软考架构师桌面工具-爬虫模块开发实施计划.md`
