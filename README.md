# Batch File Manager

一个强大的 Obsidian 批量文件管理插件，支持批量选择、删除、移动文件，以及迁移未完成任务。

## 功能特性

- ✅ 批量选择文件（全选/取消全选）
- ✅ 批量删除文件
- ✅ 批量移动文件到指定文件夹
- ✅ 迁移未完成任务到今日日记
- ✅ 显示选中文件数量统计
- ✅ 右键菜单快速操作
- ✅ 点击文件名快速打开
- ✅ 文件列表按路径排序

## 安装方法

### 方式一：从 GitHub Release 安装（推荐）

1. 前往 [Releases](../../releases) 页面下载最新版本
2. 下载以下文件：
   - `main.js`
   - `manifest.json`
   - `styles.css`
3. 在你的 Obsidian 库中创建插件目录：`.obsidian/plugins/obsidian-batch-file-manager/`
4. 将下载的文件复制到该目录
5. 重启 Obsidian 或刷新插件列表
6. 在设置中启用"Batch File Manager"插件

### 方式二：手动安装

```bash
cd /path/to/your/vault/.obsidian/plugins
git clone https://github.com/你的用户名/obsidian-batch-file-manager.git
cd obsidian-batch-file-manager
npm install
npm run build
```

## 使用方法

### 批量文件管理

1. 点击左侧边栏的文件图标，或使用命令面板搜索 "打开批量文件管理器"
2. 在右侧面板中会显示所有 Markdown 文件
3. 勾选要操作的文件
4. 使用工具栏按钮进行批量操作：
   - **全选**: 选中所有文件
   - **取消全选**: 取消所有选中
   - **删除选中**: 批量删除选中的文件（不可撤销）
   - **移动选中**: 批量移动文件到指定文件夹
   - **刷新**: 重新加载文件列表

### 任务迁移

使用命令面板搜索"迁移未完成任务到今日"，插件会：
- 扫描 `journals` 文件夹中的所有日记文件
- 提取未完成的任务（支持 `- TODO`、`- [ ]`、`TODO::`、`LATER::`、`NOW::` 格式）
- 将任务迁移到今天的日记文件
- 从原文件中删除已迁移的任务

## 快捷操作

- 点击文件名：打开文件
- 右键文件：显示快捷菜单（打开、删除）

## 开发

```bash
# 开发模式
npm run dev

# 构建
npm run build

# 部署到本地vault
npm run deploy

# 发布到GitHub
npm run release
```

## License

MIT
- 勾选复选框：选择/取消选择文件

## 注意事项

- 删除操作不可撤销，请谨慎使用
- 移动文件时会自动创建目标文件夹
- 如果目标位置已存在同名文件，移动操作会失败

## 技术栈

- TypeScript
- Obsidian API
- esbuild

## 许可证

MIT
