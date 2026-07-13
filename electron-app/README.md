# electron-app

An Electron application with Vue and TypeScript

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode) + [Volar](https://marketplace.visualstudio.com/items?itemName=Vue.volar)

## Project Setup

### Install

```bash
$ npm install
```

### Development

```bash
$ npm run dev
```

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```

## Developer Tools Console

Open DevTools with `F12` or `Ctrl+Shift+I`, then execute the following commands in the Console tab:

### 清空题库

> ⚠️ 此操作不可逆，会删除所有题目及关联数据。

```js
await window.electronAPI.clearAllData()
```

**删除范围：**

| 表 / 资源 | 操作 |
|-----------|------|
| `questions` | 删除所有题目 |
| `answer_records` | 删除所有答题记录 |
| `practice_sessions` | 删除所有练习会话 |
| `question_images` | 删除题目图片元数据及图片文件 |
| `crawler_review_items` | 删除待确认爬虫结果 |
| `crawler_runs` | 已入库计数归零 |
| `crawler_rules` | 总爬取计数归零 |
| FTS 索引 | 重建全文索引 |

**保留数据：**

| 数据 | 说明 |
|------|------|
| `question_groups` | 题库分组保留 |
| `crawler_rules` | 爬虫规则保留 |
| `documents` | 文档库保留 |
| 系统配置 | AI 配置、存储路径等不变 |

### 清理孤立图片

```js
await window.electronAPI.cleanupOrphanImages()
```
