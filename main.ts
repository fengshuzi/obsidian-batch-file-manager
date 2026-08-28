import { App, Plugin, TFile, TFolder, WorkspaceLeaf, ItemView, Menu, Notice, PluginSettingTab, Setting, Modal, TextComponent, MarkdownView, parseLinktext } from 'obsidian';

const VIEW_TYPE_BATCH_MANAGER = 'file-commander-view';

interface FileItem {
  file: TFile;
  selected: boolean;
}

interface BatchFileManagerSettings {
  defaultTags: string;
  tagPosition: 'start' | 'end' | 'frontmatter';
  scanExternalImages: boolean;
  imageExtensions: string;
  imageFolders: string; // 图片文件夹列表，用逗号分隔
  journalsFolder: string; // 日记文件夹路径，用于一键归档/还原
  autoMigrateYesterdayTasks: boolean; // 启动时自动迁移昨天任务到今天
  autoMergeIcloudConflictFiles: boolean; // 启动时自动合并 iCloud 冲突文件
}

const DEFAULT_SETTINGS: BatchFileManagerSettings = {
  defaultTags: '#todo #important',
  tagPosition: 'start',
  scanExternalImages: false,
  imageExtensions: 'png,jpg,jpeg,gif,svg,webp,bmp',
  imageFolders: 'assets',
  journalsFolder: 'journals',
  autoMigrateYesterdayTasks: false,
  autoMergeIcloudConflictFiles: false
};

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function pad3(value: number): string {
  if (value < 10) return `00${value}`;
  if (value < 100) return `0${value}`;
  return String(value);
}

function formatJournalDate(d: Date): string {
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  return `${y}-${m}-${day}`;
}

/** iCloud 多设备同步冲突副本，如 `2026-07-02 2.md` */
const ICLOUD_CONFLICT_FILE_PATTERN = /^(.+) (\d+)\.md$/;

// 启动日记任务（合并 iCloud 冲突 / 迁移昨日任务）的延迟：等待 iCloud 与 Git 同步先落盘，
// 避免 vault 刚打开时边写边同步产生新冲突。参考 pay-api git 同步的防抖 DEBOUNCE_S = 15s。
const STARTUP_JOURNAL_TASKS_DELAY_MS = 15_000;

// iCloud 冲突副本自身也要「稳定」够久才能合并：创建或最后编辑不足 15 秒的副本可能仍在
// iCloud 下载中（占位/半成品），合并会误判内容（见 BUG.md 2026-08-19 数据丢失事故）。
const ICLOUD_CONFLICT_STABLE_MS = 15_000;

function mergeLinesWithoutDuplicates(baseContent: string, extraContent: string): { merged: string; addedCount: number } {
  const seen = new Set(baseContent.split('\n'));
  const toAppend: string[] = [];
  for (const line of extraContent.split('\n')) {
    if (seen.has(line)) continue;
    seen.add(line);
    toAppend.push(line);
  }
  if (toAppend.length === 0) {
    return { merged: baseContent, addedCount: 0 };
  }
  let merged = baseContent;
  if (merged.length > 0 && !merged.endsWith('\n')) {
    merged += '\n';
  }
  merged += toAppend.join('\n');
  return { merged, addedCount: toAppend.length };
}

function recordEntries<K extends string, V>(record: Record<K, V>): Array<[K, V]> {
  const entries: Array<[K, V]> = [];
  for (const key of Object.keys(record) as K[]) {
    entries.push([key, record[key]]);
  }
  return entries;
}

/** exec 版 matchAll：String.matchAll 在 Scorecard 类型解析环境下解析为 error 类型，统一走本函数 */
function collectMatches(content: string, pattern: RegExp): RegExpMatchArray[] {
  const matches: RegExpMatchArray[] = [];
  pattern.lastIndex = 0;
  let match = pattern.exec(content);
  while (match !== null) {
    matches.push(match);
    match = pattern.exec(content);
  }
  return matches;
}

/** 合并两个月归档文件内容：按 `## yyyy-MM-dd` 分段后逐行去重合并 */
function mergeMonthFileContents(baseContent: string, extraContent: string): string {
  const sectionHeader = /^(?:- )?## (\d{4}-\d{2}-\d{2})\s*$/gm;
  const parseSections = (content: string): { preamble: string; sections: Record<string, string> } => {
    const parts = content.split(sectionHeader);
    const sections: Record<string, string> = {};
    for (let i = 1; i + 1 < parts.length; i += 2) {
      sections[parts[i].trim()] = parts[i + 1].trim();
    }
    return { preamble: parts[0].trim(), sections };
  };
  const base = parseSections(baseContent);
  const extra = parseSections(extraContent);
  if (recordEntries(extra.sections).length === 0) {
    return mergeLinesWithoutDuplicates(baseContent, extraContent).merged;
  }
  let preamble = base.preamble;
  if (extra.preamble) {
    preamble = preamble ? mergeLinesWithoutDuplicates(preamble, extra.preamble).merged : extra.preamble;
  }
  const sections = base.sections;
  for (const [dateStr, content] of recordEntries(extra.sections)) {
    sections[dateStr] = sections[dateStr]
      ? mergeLinesWithoutDuplicates(sections[dateStr], content).merged
      : content;
  }
  const body = recordEntries(sections)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([d, c]) => `## ${d}\n\n${c}\n\n`)
    .join('\n');
  return preamble ? `${preamble}\n\n${body}` : body;
}

function getImagePathFromMatch(match: RegExpMatchArray): string | undefined {
  const wikiPath = match[1];
  const mdPath = match[3];
  if (wikiPath) return wikiPath;
  if (mdPath) return mdPath;
  return undefined;
}

interface ParsedWikiLink {
  linkPath: string;
  displayText: string;
  subpath: string;
}

interface ParsedMarkdownLink {
  linkPath: string;
  anchor: string;
}

/** 解析 Obsidian wiki 链接 [[path|alias]]，返回路径、显示别名与子路径（锚点/块） */
function parseWikiLink(raw: string): ParsedWikiLink {
  // 必须先剥离别名，parseLinktext 只处理 `#` 子路径，不识别 `|alias`
  const separatorIndex = raw.indexOf('|');
  const target = separatorIndex >= 0 ? raw.substring(0, separatorIndex) : raw;
  const displayText = separatorIndex >= 0 ? raw.substring(separatorIndex + 1).trim() : '';
  const linktext = parseLinktext(target);
  return {
    linkPath: linktext.path,
    displayText,
    subpath: linktext.subpath || ''
  };
}

/** 解析标准 Markdown 链接中的路径与锚点，path#heading */
function parseMarkdownLink(raw: string): ParsedMarkdownLink {
  const linktext = parseLinktext(raw);
  const subpath = linktext.subpath || '';
  return {
    linkPath: linktext.path,
    anchor: subpath.startsWith('#') ? subpath.substring(1) : subpath
  };
}

/** 判断一个链接字符串是否为需要检查的内部文件链接 */
function isInternalFileLink(url: string): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return false;
  if (trimmed.startsWith('mailto:')) return false;
  if (trimmed.startsWith('file://')) return false;
  if (trimmed.startsWith('data:')) return false;
  if (trimmed.startsWith('#')) return false;
  return true;
}

interface BrokenFileLink {
  sourceFile: TFile;
  originalText: string;
  linkType: 'wiki' | 'markdown';
  linkPath: string;
  displayText: string;
  anchor: string;
  subpath: string;
  suggestedPath: string | null;
}

interface BrokenImageLink {
  sourceFile: TFile;
  originalText: string;
  linkType: 'wiki' | 'markdown';
  imagePath: string;
  suffix: string; // wiki 图片链接 | 后的尺寸/别名参数（含 |），修正时保留
  suggestedPath: string | null;
}

type MarkdownIssueType = 'task-list-space' | 'heading-space' | 'missing-code-language' | 'unclosed-code-block' | 'mixed-indent';

interface MarkdownFormatIssue {
  sourceFile: TFile;
  line: number;
  originalText: string;
  types: MarkdownIssueType[];
  fixable: boolean;
  suggestedText: string | null;
}

const MARKDOWN_ISSUE_LABELS: Record<MarkdownIssueType, string> = {
  'task-list-space': '任务列表格式',
  'heading-space': '标题缺空格',
  'missing-code-language': '代码块缺少 language',
  'unclosed-code-block': '代码块未闭合',
  'mixed-indent': '列表缩进应为Tab',
};

interface MermaidApi {
  initialize: (config: { startOnLoad?: boolean; securityLevel?: string }) => void;
  render: (id: string, code: string) => Promise<{ svg: string }>;
}

class FolderSelectModal extends Modal {
  folders: TFolder[];
  onSubmit: (folder: TFolder | null) => void;

  constructor(app: App, onSubmit: (folder: TFolder | null) => void) {
    super(app);
    this.onSubmit = onSubmit;
    this.folders = this.getAllFolders();
  }

  getAllFolders(): TFolder[] {
    const folders: TFolder[] = [];
    const rootFolder = this.app.vault.getRoot();
    
    const collectFolders = (folder: TFolder) => {
      folders.push(folder);
      for (const child of folder.children) {
        if (child instanceof TFolder) {
          collectFolders(child);
        }
      }
    };
    
    collectFolders(rootFolder);
    return folders;
  }

  onOpen() {
    const { contentEl } = this;

    contentEl.createEl('h2', { text: '选择文件夹' });

    contentEl.createEl('p', { 
      text: '选择一个文件夹来查看其中的笔记',
      cls: 'modal-description fc-mb-15'
    });

    // 搜索框
    const searchContainer = contentEl.createDiv({ cls: 'folder-search-container' });
    const searchInput = new TextComponent(searchContainer);
    searchInput.setPlaceholder('搜索文件夹...');
    searchInput.inputEl.addClass('fc-search-input');

    // 文件夹列表容器
    const folderListContainer = contentEl.createDiv({ cls: 'folder-list-container fc-list-container' });

    const renderFolderList = (filter: string = '') => {
      folderListContainer.empty();
      
      const filteredFolders = filter 
        ? this.folders.filter(folder => folder.path.toLowerCase().includes(filter.toLowerCase()))
        : this.folders;

      if (filteredFolders.length === 0) {
        folderListContainer.createEl('p', { text: '未找到匹配的文件夹', cls: 'modal-description' });
        return;
      }

      filteredFolders.forEach(folder => {
        const folderItem = folderListContainer.createDiv({ cls: 'folder-filter-item fc-list-item' });

        folderItem.createSpan({ text: '📁 ', cls: 'fc-icon-mr' });
        folderItem.createSpan({ text: folder.path || '/', cls: 'fc-flex-1' });

        folderItem.onclick = () => {
          this.onSubmit(folder);
          this.close();
        };
      });
    };

    renderFolderList();

    searchInput.onChange((value) => {
      renderFolderList(value);
    });

    // 按钮容器
    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container fc-btn-spread' });

    const showAllBtn = buttonContainer.createEl('button', { text: '显示所有笔记' });
    showAllBtn.onclick = () => {
      this.onSubmit(null);
      this.close();
    };

    const cancelBtn = buttonContainer.createEl('button', { text: '取消' });
    cancelBtn.onclick = () => {
      this.close();
    };
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

class TagFilterModal extends Modal {
  availableTags: string[];
  selectedTags: Set<string>;
  onSubmit: (selectedTags: Set<string>) => void;
  tempSelectedTags: Set<string>;

  constructor(app: App, availableTags: string[], selectedTags: Set<string>, onSubmit: (selectedTags: Set<string>) => void) {
    super(app);
    this.availableTags = availableTags.sort();
    this.selectedTags = selectedTags;
    this.tempSelectedTags = new Set(selectedTags);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;

    contentEl.createEl('h2', { text: '按标签筛选' });

    if (this.availableTags.length === 0) {
      contentEl.createEl('p', { text: '未找到任何标签', cls: 'modal-description' });
      return;
    }

    contentEl.createEl('p', { 
      text: '选择一个或多个标签来筛选文件（显示包含任意选中标签的文件）',
      cls: 'modal-description fc-mb-15'
    });

    // 搜索框
    const searchContainer = contentEl.createDiv({ cls: 'tag-search-container' });
    const searchInput = new TextComponent(searchContainer);
    searchInput.setPlaceholder('搜索标签...');
    searchInput.inputEl.addClass('fc-search-input');

    // 标签列表容器
    const tagListContainer = contentEl.createDiv({ cls: 'tag-list-container fc-list-container' });

    const renderTagList = (filter: string = '') => {
      tagListContainer.empty();
      
      const filteredTags = filter 
        ? this.availableTags.filter(tag => tag.toLowerCase().includes(filter.toLowerCase()))
        : this.availableTags;

      if (filteredTags.length === 0) {
        tagListContainer.createEl('p', { text: '未找到匹配的标签', cls: 'modal-description' });
        return;
      }

      filteredTags.forEach(tag => {
        const tagItem = tagListContainer.createDiv({ cls: 'tag-filter-item fc-list-item' });

        const checkbox = tagItem.createEl('input', { type: 'checkbox', cls: 'fc-checkbox-mr' });
        checkbox.checked = this.tempSelectedTags.has(tag);
        checkbox.onclick = (e) => {
          e.stopPropagation();
          if (checkbox.checked) {
            this.tempSelectedTags.add(tag);
          } else {
            this.tempSelectedTags.delete(tag);
          }
        };

        tagItem.createSpan({ text: tag, cls: 'fc-flex-1' });

        tagItem.onclick = () => {
          checkbox.checked = !checkbox.checked;
          if (checkbox.checked) {
            this.tempSelectedTags.add(tag);
          } else {
            this.tempSelectedTags.delete(tag);
          }
        };
      });
    };

    renderTagList();

    searchInput.onChange((value) => {
      renderTagList(value);
    });

    // 按钮容器
    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container fc-btn-spread' });

    const clearBtn = buttonContainer.createEl('button', { text: '清除所有' });
    clearBtn.onclick = () => {
      this.tempSelectedTags.clear();
      renderTagList(searchInput.getValue());
    };

    const rightButtons = buttonContainer.createDiv({ cls: 'fc-btn-group' });

    const cancelBtn = rightButtons.createEl('button', { text: '取消' });
    cancelBtn.onclick = () => {
      this.close();
    };

    const submitBtn = rightButtons.createEl('button', { text: '确定', cls: 'mod-cta' });
    submitBtn.onclick = () => {
      this.onSubmit(this.tempSelectedTags);
      this.close();
    };
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

class TagInputModal extends Modal {
  result: string;
  onSubmit: (result: string) => void;
  defaultValue: string;

  constructor(app: App, defaultValue: string, onSubmit: (result: string) => void) {
    super(app);
    this.defaultValue = defaultValue;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;

    contentEl.createEl('h2', { text: '批量打标签' });

    const inputContainer = contentEl.createDiv({ cls: 'modal-input-container' });
    inputContainer.createEl('p', { 
      text: '请输入标签（多个标签用空格分隔，例如: #tag1 #tag2）',
      cls: 'modal-description'
    });

    const input = new TextComponent(inputContainer);
    input.inputEl.addClass('fc-input-full');
    input.setValue(this.defaultValue);
    input.onChange((value) => {
      this.result = value;
    });

    // 按回车提交
    input.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.submit();
      }
    });

    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

    const cancelBtn = buttonContainer.createEl('button', { text: '取消' });
    cancelBtn.onclick = () => {
      this.close();
    };

    const submitBtn = buttonContainer.createEl('button', { text: '确定', cls: 'mod-cta' });
    submitBtn.onclick = () => {
      this.submit();
    };

    // 自动聚焦输入框
    window.setTimeout(() => {
      input.inputEl.focus();
      input.inputEl.select();
    }, 10);
  }

  submit() {
    if (this.result !== undefined) {
      this.onSubmit(this.result);
    }
    this.close();
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

class FolderInputModal extends Modal {
  result: string;
  onSubmit: (result: string) => void;

  constructor(app: App, onSubmit: (result: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;

    contentEl.createEl('h2', { text: '移动文件' });

    const inputContainer = contentEl.createDiv({ cls: 'modal-input-container' });
    inputContainer.createEl('p', { 
      text: '请输入目标文件夹路径（例如: folder/subfolder）',
      cls: 'modal-description'
    });

    const input = new TextComponent(inputContainer);
    input.inputEl.addClass('fc-input-full');
    input.setPlaceholder('Folder/subfolder');
    input.onChange((value) => {
      this.result = value;
    });

    // 按回车提交
    input.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.submit();
      }
    });

    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

    const cancelBtn = buttonContainer.createEl('button', { text: '取消' });
    cancelBtn.onclick = () => {
      this.close();
    };

    const submitBtn = buttonContainer.createEl('button', { text: '确定', cls: 'mod-cta' });
    submitBtn.onclick = () => {
      this.submit();
    };

    // 自动聚焦输入框
    window.setTimeout(() => {
      input.inputEl.focus();
    }, 10);
  }

  submit() {
    if (this.result !== undefined && this.result.trim()) {
      this.onSubmit(this.result);
    }
    this.close();
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

class ReplaceTagModal extends Modal {
  oldTag: string;
  newTag: string;
  onSubmit: (oldTag: string, newTag: string) => void;

  constructor(app: App, onSubmit: (oldTag: string, newTag: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;

    contentEl.createEl('h2', { text: '批量替换标签' });

    contentEl.createEl('p', { 
      text: '将旧标签替换为新标签（标签可以带或不带 # 符号）',
      cls: 'modal-description fc-mb-15'
    });

    // 旧标签输入
    const oldTagContainer = contentEl.createDiv({ cls: 'modal-input-container' });
    oldTagContainer.createEl('label', { text: '旧标签:' });
    const oldTagInput = new TextComponent(oldTagContainer);
    oldTagInput.inputEl.addClass('fc-input-full');
    oldTagInput.setPlaceholder('例如: cy 或 #cy');
    oldTagInput.onChange((value) => {
      this.oldTag = value;
    });

    // 新标签输入
    const newTagContainer = contentEl.createDiv({ cls: 'modal-input-container fc-mt-15' });
    newTagContainer.createEl('label', { text: '新标签:' });
    const newTagInput = new TextComponent(newTagContainer);
    newTagInput.inputEl.addClass('fc-input-full');
    newTagInput.setPlaceholder('例如: 餐饮 或 #餐饮');
    newTagInput.onChange((value) => {
      this.newTag = value;
    });

    // 按回车提交
    const handleEnter = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.submit();
      }
    };
    oldTagInput.inputEl.addEventListener('keydown', handleEnter);
    newTagInput.inputEl.addEventListener('keydown', handleEnter);

    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

    const cancelBtn = buttonContainer.createEl('button', { text: '取消' });
    cancelBtn.onclick = () => {
      this.close();
    };

    const submitBtn = buttonContainer.createEl('button', { text: '确定', cls: 'mod-cta' });
    submitBtn.onclick = () => {
      this.submit();
    };

    // 自动聚焦第一个输入框
    window.setTimeout(() => {
      oldTagInput.inputEl.focus();
    }, 10);
  }

  submit() {
    if (!this.oldTag || !this.oldTag.trim()) {
      new Notice('请输入旧标签');
      return;
    }
    if (!this.newTag || !this.newTag.trim()) {
      new Notice('请输入新标签');
      return;
    }
    this.onSubmit(this.oldTag.trim(), this.newTag.trim());
    this.close();
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

class RenameFrontmatterPropertyModal extends Modal {
  oldProperty: string;
  newProperty: string;
  onSubmit: (oldProperty: string, newProperty: string) => void;

  constructor(app: App, onSubmit: (oldProperty: string, newProperty: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;

    contentEl.createEl('h2', { text: '批量重命名元数据属性' });

    contentEl.createEl('p', { 
      text: '将 frontmatter 中的旧属性名重命名为新属性名',
      cls: 'modal-description fc-mb-15'
    });

    // 旧属性名输入
    const oldPropertyContainer = contentEl.createDiv({ cls: 'modal-input-container' });
    oldPropertyContainer.createEl('label', { text: '旧属性名:' });
    const oldPropertyInput = new TextComponent(oldPropertyContainer);
    oldPropertyInput.inputEl.addClass('fc-input-full');
    oldPropertyInput.setPlaceholder('例如: category 或 是否锻炼');
    oldPropertyInput.onChange((value) => {
      this.oldProperty = value;
    });

    // 新属性名输入
    const newPropertyContainer = contentEl.createDiv({ cls: 'modal-input-container fc-mt-15' });
    newPropertyContainer.createEl('label', { text: '新属性名:' });
    const newPropertyInput = new TextComponent(newPropertyContainer);
    newPropertyInput.inputEl.addClass('fc-input-full');
    newPropertyInput.setPlaceholder('例如: type 或 运动打卡');
    newPropertyInput.onChange((value) => {
      this.newProperty = value;
    });

    // 按回车提交
    const handleEnter = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.submit();
      }
    };
    oldPropertyInput.inputEl.addEventListener('keydown', handleEnter);
    newPropertyInput.inputEl.addEventListener('keydown', handleEnter);

    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

    const cancelBtn = buttonContainer.createEl('button', { text: '取消' });
    cancelBtn.onclick = () => {
      this.close();
    };

    const submitBtn = buttonContainer.createEl('button', { text: '确定', cls: 'mod-cta' });
    submitBtn.onclick = () => {
      this.submit();
    };

    // 自动聚焦第一个输入框
    window.setTimeout(() => {
      oldPropertyInput.inputEl.focus();
    }, 10);
  }

  submit() {
    if (!this.oldProperty || !this.oldProperty.trim()) {
      new Notice('请输入旧属性名');
      return;
    }
    if (!this.newProperty || !this.newProperty.trim()) {
      new Notice('请输入新属性名');
      return;
    }
    this.onSubmit(this.oldProperty.trim(), this.newProperty.trim());
    this.close();
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

/** 单文件重命名输入弹窗（预填当前 basename） */
class RenameInputModal extends Modal {
  private currentName: string;
  private onSubmit: (newName: string) => void;

  constructor(app: App, currentName: string, onSubmit: (newName: string) => void) {
    super(app);
    this.currentName = currentName;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: '重命名笔记' });
    contentEl.createEl('p', {
      text: '重命名后会自动更新其他笔记中指向该文件的 Markdown 链接',
      cls: 'modal-description'
    });

    const input = new TextComponent(contentEl);
    input.setValue(this.currentName);
    input.inputEl.addClass('fc-input-full', 'fc-mt-10');
    input.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.submit(input.getValue());
      }
    });

    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
    const cancelBtn = buttonContainer.createEl('button', { text: '取消' });
    cancelBtn.onclick = () => this.close();
    const submitBtn = buttonContainer.createEl('button', { text: '确定', cls: 'mod-cta' });
    submitBtn.onclick = () => this.submit(input.getValue());

    input.inputEl.focus();
    input.inputEl.select();
  }

  private submit(value: string) {
    this.close();
    this.onSubmit(value);
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** 批量重命名参数输入弹窗（查找/替换/是否正则） */
class BatchRenameModal extends Modal {
  private onSubmit: (find: string, replace: string, useRegex: boolean) => void;

  constructor(app: App, onSubmit: (find: string, replace: string, useRegex: boolean) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: '批量重命名' });
    contentEl.createEl('p', {
      text: '对选中文件的文件名（不含扩展名）做查找替换，重命名后自动更新指向它们的 Markdown 链接',
      cls: 'modal-description'
    });

    const findContainer = contentEl.createDiv({ cls: 'fc-mt-10' });
    findContainer.createEl('label', { text: '查找: ' });
    const findInput = new TextComponent(findContainer);
    findInput.setPlaceholder('如 旧前缀 或正则 (\\d{4})-(\\d{2})');
    findInput.inputEl.addClass('fc-input-full');

    const replaceContainer = contentEl.createDiv({ cls: 'fc-mt-10' });
    replaceContainer.createEl('label', { text: '替换为: ' });
    const replaceInput = new TextComponent(replaceContainer);
    replaceInput.setPlaceholder('如 新前缀 或 $2-$1');
    replaceInput.inputEl.addClass('fc-input-full');

    const regexContainer = contentEl.createDiv({ cls: 'fc-mt-10' });
    const regexCheckbox = regexContainer.createEl('input', { type: 'checkbox' });
    regexContainer.createEl('label', { text: ' 使用正则表达式' });

    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
    const cancelBtn = buttonContainer.createEl('button', { text: '取消' });
    cancelBtn.onclick = () => this.close();
    const submitBtn = buttonContainer.createEl('button', { text: '预览', cls: 'mod-cta' });
    submitBtn.onclick = () => {
      const find = findInput.getValue();
      if (!find) {
        new Notice('请输入要查找的内容');
        return;
      }
      this.close();
      this.onSubmit(find, replaceInput.getValue(), regexCheckbox.checked);
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** 批量重命名预览确认弹窗 */
class BatchRenamePreviewModal extends Modal {
  private plans: Array<{ file: TFile; newPath: string }>;
  private onConfirm: () => void;

  constructor(app: App, plans: Array<{ file: TFile; newPath: string }>, onConfirm: () => void) {
    super(app);
    this.plans = plans;
    this.onConfirm = onConfirm;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('fc-broken-links-modal');
    contentEl.createEl('h2', { text: '批量重命名预览' });
    contentEl.createEl('p', {
      text: `将重命名 ${this.plans.length} 个文件，并同步更新指向它们的 Markdown 链接：`,
      cls: 'modal-description fc-mb-15'
    });

    const scrollContainer = contentEl.createDiv({ cls: 'fc-broken-links-list' });
    for (const plan of this.plans) {
      const item = scrollContainer.createDiv({ cls: 'fc-broken-link-item' });
      const body = item.createDiv({ cls: 'fc-broken-link-body' });
      const origLine = body.createDiv({ cls: 'fc-broken-link-path' });
      origLine.createEl('code', { text: plan.file.path });
      const newLine = body.createDiv({ cls: 'fc-broken-link-suggest' });
      newLine.createSpan({ text: '→ ', cls: 'fc-broken-link-label' });
      newLine.createEl('code', { text: plan.newPath });
    }

    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container fc-btn-spread' });
    const cancelBtn = buttonContainer.createEl('button', { text: '取消' });
    cancelBtn.onclick = () => this.close();
    const confirmBtn = buttonContainer.createEl('button', { text: `确认重命名 ${this.plans.length} 个文件`, cls: 'mod-cta' });
    confirmBtn.onclick = () => {
      this.close();
      this.onConfirm();
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ConfirmModal extends Modal {
  message: string;
  onConfirm: () => void;

  constructor(app: App, message: string, onConfirm: () => void) {
    super(app);
    this.message = message;
    this.onConfirm = onConfirm;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('p', { text: this.message });
    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
    const cancelBtn = buttonContainer.createEl('button', { text: '取消' });
    cancelBtn.onclick = () => this.close();
    const confirmBtn = buttonContainer.createEl('button', { text: '确定', cls: 'mod-warning' });
    confirmBtn.onclick = () => {
      this.close();
      this.onConfirm();
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** 判断失效链接使用的路径类型，用于预览时标注 */
function describeLinkPathKind(link: BrokenFileLink): string {
  if (link.linkType === 'wiki') return 'wiki';
  const p = link.linkPath;
  if (p.startsWith('./') || p.startsWith('../')) return '相对路径';
  if (!p.includes('/')) return '最简路径';
  return '完整路径';
}

/**
 * 一键修正失效文件链接的「预览 → 确认」弹窗。
 * 列出全部失效链接：可自动匹配到新路径的会被修正，未匹配到的仅作提示，不会改动。
 */
class BrokenFileLinksModal extends Modal {
  private links: BrokenFileLink[];
  private onConfirm: (links: BrokenFileLink[]) => void;
  private onClearLink: (link: BrokenFileLink) => Promise<boolean>;
  private onClearAll: (links: BrokenFileLink[]) => Promise<number>;

  constructor(
    app: App,
    links: BrokenFileLink[],
    onConfirm: (links: BrokenFileLink[]) => void,
    onClearLink: (link: BrokenFileLink) => Promise<boolean>,
    onClearAll: (links: BrokenFileLink[]) => Promise<number>
  ) {
    super(app);
    this.links = links;
    this.onConfirm = onConfirm;
    this.onClearLink = onClearLink;
    this.onClearAll = onClearAll;
  }

  onOpen() {
    this.contentEl.addClass('fc-broken-links-modal');
    this.render();
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();

    const fixable = this.links.filter(link => link.suggestedPath);
    const unfixable = this.links.filter(link => !link.suggestedPath);

    contentEl.createEl('h2', { text: '一键修正失效文件链接' });

    const description = contentEl.createEl('p', { cls: 'modal-description fc-mb-15' });
    description.setText(
      `共发现 ${this.links.length} 个失效链接，其中 ${fixable.length} 个可按完整文件名匹配到新路径。` +
      `请确认下列修正预览后再执行，未匹配到的 ${unfixable.length} 个不会改动。可点击「清除链接」直接去除失效引用。`
    );

    if (this.links.length === 0) {
      contentEl.createEl('p', { text: '没有需要处理的失效链接', cls: 'modal-description' });
      const closeContainer = contentEl.createDiv({ cls: 'modal-button-container' });
      const closeBtn = closeContainer.createEl('button', { text: '关闭', cls: 'mod-cta' });
      closeBtn.onclick = () => this.close();
      return;
    }

    const scrollContainer = contentEl.createDiv({ cls: 'fc-broken-links-list' });

    // 先展示可修正的链接（含建议新路径），再展示无法自动匹配的链接
    for (const link of [...fixable, ...unfixable]) {
      const item = scrollContainer.createDiv({ cls: 'fc-broken-link-item' });

      const header = item.createDiv({ cls: 'fc-broken-link-header' });
      const fileSpan = header.createSpan({ cls: 'fc-broken-link-file fc-broken-link-jump', text: link.sourceFile.path });
      fileSpan.setAttr('title', '点击跳转到原文');
      fileSpan.onclick = () => { void this.jumpToSource(link); };
      header.createSpan({ cls: 'fc-broken-link-type', text: describeLinkPathKind(link) });

      const body = item.createDiv({ cls: 'fc-broken-link-body' });
      const origLine = body.createDiv({ cls: 'fc-broken-link-orig fc-broken-link-jump', text: `原文: ${link.originalText}` });
      origLine.setAttr('title', '点击跳转到原文');
      origLine.onclick = () => { void this.jumpToSource(link); };

      const pathLine = body.createDiv({ cls: 'fc-broken-link-path' });
      pathLine.createSpan({ text: '失效路径: ', cls: 'fc-broken-link-label' });
      pathLine.createEl('code', { text: link.linkPath });

      const suggestLine = body.createDiv({ cls: 'fc-broken-link-suggest' });
      if (link.suggestedPath) {
        suggestLine.createSpan({ text: '建议路径: ', cls: 'fc-broken-link-label' });
        suggestLine.createEl('code', { text: link.suggestedPath });
      } else {
        suggestLine.createSpan({ text: '未匹配到同名文件，跳过', cls: 'fc-broken-link-skip' });
      }

      const actions = item.createDiv({ cls: 'fc-broken-link-actions' });
      const clearBtn = actions.createEl('button', { text: '清除链接', cls: 'fc-broken-link-btn' });
      clearBtn.setAttr('title', '去除该失效引用，仅保留可读文本');
      clearBtn.onclick = async () => {
        clearBtn.disabled = true;
        const ok = await this.onClearLink(link);
        if (ok) {
          this.links = this.links.filter(l => l !== link);
          this.render();
        } else {
          clearBtn.disabled = false;
        }
      };
    }

    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container fc-btn-spread' });
    const cancelBtn = buttonContainer.createEl('button', { text: '取消' });
    cancelBtn.onclick = () => this.close();

    const clearAllBtn = buttonContainer.createEl('button', { text: `一键清除全部 (${this.links.length})`, cls: 'mod-warning' });
    clearAllBtn.setAttr('title', '去除列表中所有失效引用，仅保留可读文本');
    clearAllBtn.onclick = async () => {
      clearAllBtn.disabled = true;
      await this.onClearAll([...this.links]);
      this.close();
    };

    const confirmBtn = buttonContainer.createEl('button', {
      text: fixable.length > 0 ? `确认修正 ${fixable.length} 个链接` : '无可修正链接',
      cls: 'mod-cta'
    });
    confirmBtn.disabled = fixable.length === 0;
    confirmBtn.onclick = () => {
      this.close();
      this.onConfirm(fixable);
    };
  }

  /** 打开源文件并定位到失效链接所在位置 */
  private async jumpToSource(link: BrokenFileLink) {
    this.close();
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(link.sourceFile);

    const view = leaf.view;
    if (view instanceof MarkdownView) {
      const editor = view.editor;
      const idx = editor.getValue().indexOf(link.originalText);
      if (idx >= 0) {
        const from = editor.offsetToPos(idx);
        const to = editor.offsetToPos(idx + link.originalText.length);
        editor.setSelection(from, to);
        editor.scrollIntoView({ from, to }, true);
      }
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** 一键修正失效图片链接的「预览 -> 确认」弹窗，复用失效文件链接弹窗样式 */
class BrokenImageLinksModal extends Modal {
  private links: BrokenImageLink[];
  private onConfirm: (links: BrokenImageLink[]) => void;

  constructor(app: App, links: BrokenImageLink[], onConfirm: (links: BrokenImageLink[]) => void) {
    super(app);
    this.links = links;
    this.onConfirm = onConfirm;
  }

  onOpen() {
    this.contentEl.addClass('fc-broken-links-modal');
    this.render();
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();

    const fixable = this.links.filter(link => link.suggestedPath);
    const unfixable = this.links.filter(link => !link.suggestedPath);

    contentEl.createEl('h2', { text: '一键修正失效图片链接' });

    const description = contentEl.createEl('p', { cls: 'modal-description fc-mb-15' });
    description.setText(
      `共发现 ${this.links.length} 个失效图片链接，其中 ${fixable.length} 个可按完整文件名匹配到新路径。` +
      `请确认下列修正预览后再执行，未匹配到的 ${unfixable.length} 个不会改动。`
    );

    const scrollContainer = contentEl.createDiv({ cls: 'fc-broken-links-list' });

    for (const link of [...fixable, ...unfixable]) {
      const item = scrollContainer.createDiv({ cls: 'fc-broken-link-item' });

      const header = item.createDiv({ cls: 'fc-broken-link-header' });
      header.createSpan({ cls: 'fc-broken-link-file', text: link.sourceFile.path });
      header.createSpan({ cls: 'fc-broken-link-type', text: link.linkType === 'wiki' ? 'wiki 图片' : 'Markdown 图片' });

      const body = item.createDiv({ cls: 'fc-broken-link-body' });
      body.createDiv({ cls: 'fc-broken-link-orig', text: `原文: ${link.originalText}` });

      const pathLine = body.createDiv({ cls: 'fc-broken-link-path' });
      pathLine.createSpan({ text: '失效路径: ', cls: 'fc-broken-link-label' });
      pathLine.createEl('code', { text: link.imagePath });

      const suggestLine = body.createDiv({ cls: 'fc-broken-link-suggest' });
      if (link.suggestedPath) {
        suggestLine.createSpan({ text: '建议路径: ', cls: 'fc-broken-link-label' });
        suggestLine.createEl('code', { text: link.suggestedPath });
      } else {
        suggestLine.createSpan({ text: '未匹配到同名图片，跳过', cls: 'fc-broken-link-skip' });
      }
    }

    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container fc-btn-spread' });
    const cancelBtn = buttonContainer.createEl('button', { text: '取消' });
    cancelBtn.onclick = () => this.close();

    const confirmBtn = buttonContainer.createEl('button', {
      text: fixable.length > 0 ? `确认修正 ${fixable.length} 个链接` : '无可修正链接',
      cls: 'mod-cta'
    });
    confirmBtn.disabled = fixable.length === 0;
    confirmBtn.onclick = () => {
      this.close();
      this.onConfirm(fixable);
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}

/**
 * Markdown 格式检测的「预览 -> 确认」弹窗。
 * 按文档分组，每个文档可单独修复，底部提供全部修复。
 */
class MarkdownFormatIssuesModal extends Modal {
  private issues: MarkdownFormatIssue[];
  private onFix: (issues: MarkdownFormatIssue[]) => Promise<number>;
  private onCloseCallback: () => void;

  constructor(
    app: App,
    issues: MarkdownFormatIssue[],
    onFix: (issues: MarkdownFormatIssue[]) => Promise<number>,
    onCloseCallback: () => void
  ) {
    super(app);
    this.issues = issues;
    this.onFix = onFix;
    this.onCloseCallback = onCloseCallback;
  }

  onOpen() {
    this.contentEl.addClass('fc-broken-links-modal');
    this.render();
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();

    const fixable = this.issues.filter(i => i.fixable);

    contentEl.createEl('h2', { text: 'Markdown 格式检测' });

    // 按文件分组
    const byFile = new Map<string, { file: TFile; issues: MarkdownFormatIssue[] }>();
    for (const issue of this.issues) {
      let group = byFile.get(issue.sourceFile.path);
      if (!group) {
        group = { file: issue.sourceFile, issues: [] };
        byFile.set(issue.sourceFile.path, group);
      }
      group.issues.push(issue);
    }

    const description = contentEl.createEl('p', { cls: 'modal-description fc-mb-15' });
    description.setText(
      `共 ${byFile.size} 个文档，${this.issues.length} 处问题，其中 ${fixable.length} 处可修复。`
    );

    if (this.issues.length === 0) {
      contentEl.createEl('p', { text: '未发现 Markdown 格式问题', cls: 'modal-description' });
      const closeContainer = contentEl.createDiv({ cls: 'modal-button-container' });
      const closeBtn = closeContainer.createEl('button', { text: '关闭', cls: 'mod-cta' });
      closeBtn.onclick = () => this.close();
      return;
    }

    const scrollContainer = contentEl.createDiv({ cls: 'fc-broken-links-list' });

    for (const { file, issues: fileIssues } of byFile.values()) {
      const fileFixable = fileIssues.filter(i => i.fixable);
      const item = scrollContainer.createDiv({ cls: 'fc-broken-link-item' });

      // 文件头：路径 + 问题数 + 修复按钮
      const header = item.createDiv({ cls: 'fc-broken-link-header' });
      const fileSpan = header.createSpan({
        cls: 'fc-broken-link-file fc-broken-link-jump',
        text: file.path
      });
      fileSpan.setAttr('title', '点击跳转到文件');
      fileSpan.onclick = () => { void this.jumpToSource(fileIssues[0]); };

      header.createSpan({ cls: 'fc-broken-link-type', text: `${fileIssues.length} 处` });

      if (fileFixable.length > 0) {
        const fixBtn = header.createEl('button', {
          text: `修复 (${fileFixable.length})`,
          cls: 'fc-broken-link-btn mod-cta'
        });
        fixBtn.onclick = async () => {
          fixBtn.disabled = true;
          const count = await this.onFix(fileFixable);
          if (count > 0) {
            const fixedSet = new Set(fileFixable);
            this.issues = this.issues.filter(i => !fixedSet.has(i));
            this.render();
          } else {
            fixBtn.disabled = false;
          }
        };
      }

      // 该文件的问题列表
      const body = item.createDiv({ cls: 'fc-broken-link-body' });
      for (const issue of fileIssues) {
        const typeLabel = issue.types.map(t => MARKDOWN_ISSUE_LABELS[t]).join('、');
        const issueLine = body.createDiv({
          cls: 'fc-broken-link-orig fc-broken-link-jump',
          text: `L${issue.line} [${typeLabel}] ${issue.originalText}`
        });
        issueLine.setAttr('title', '点击跳转到原文');
        issueLine.onclick = () => { void this.jumpToSource(issue); };

        if (issue.fixable && issue.suggestedText !== null) {
          const suggestLine = body.createDiv({ cls: 'fc-broken-link-suggest' });
          suggestLine.createSpan({ text: '建议: ', cls: 'fc-broken-link-label' });
          suggestLine.createEl('code', { text: issue.suggestedText });
        } else {
          const skipLine = body.createDiv({ cls: 'fc-broken-link-suggest' });
          skipLine.createSpan({ text: '需手动处理，无法自动修复', cls: 'fc-broken-link-skip' });
        }
      }
    }

    // 底部按钮
    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container fc-btn-spread' });
    const closeBtn = buttonContainer.createEl('button', { text: '关闭' });
    closeBtn.onclick = () => this.close();

    const fixAllBtn = buttonContainer.createEl('button', {
      text: `全部修复 (${fixable.length})`,
      cls: 'mod-cta'
    });
    fixAllBtn.disabled = fixable.length === 0;
    fixAllBtn.onclick = async () => {
      fixAllBtn.disabled = true;
      const count = await this.onFix(fixable);
      if (count > 0) {
        this.issues = this.issues.filter(i => !i.fixable);
        this.render();
      } else {
        fixAllBtn.disabled = false;
      }
    };
  }

  /** 打开源文件并定位到问题所在行 */
  private async jumpToSource(issue: MarkdownFormatIssue) {
    this.close();
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(issue.sourceFile);

    const view = leaf.view;
    if (view instanceof MarkdownView) {
      const editor = view.editor;
      const line = Math.max(0, issue.line - 1);
      const lineText = editor.getLine(line);
      const from = { line, ch: 0 };
      const to = { line, ch: lineText.length };
      editor.setSelection(from, to);
      editor.scrollIntoView({ from, to }, true);
    }
  }

  onClose() {
    this.contentEl.empty();
    this.onCloseCallback();
  }
}

class BatchFileManagerView extends ItemView {
  private files: FileItem[] = [];
  private allFiles: FileItem[] = []; // 保存所有文件
  private currentFolder: TFolder | null = null;
  private selectedFolder: TFolder | null = null; // 当前选中的文件夹
  private plugin: BatchFileManagerPlugin;
  private availableTags: Set<string> = new Set();
  private selectedTags: Set<string> = new Set();
  private searchQuery: string = '';
  private viewMode: 'list' | 'table' = 'list';
  private fileListEl: HTMLElement | null = null; // 文件列表容器，搜索时只刷新它
  private countEl: HTMLElement | null = null;     // 工具栏计数
  private searchDebounce = 0;                      // 搜索防抖计时器
  private isComposing = false;                     // 中文输入法组合状态

  constructor(leaf: WorkspaceLeaf, plugin: BatchFileManagerPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_BATCH_MANAGER;
  }

  getDisplayText(): string {
    return '批量文件管理';
  }

  getIcon(): string {
    return 'files';
  }

  onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('file-commander-view');

    // 先显示加载提示
    const loadingDiv = container.createDiv({ cls: 'batch-manager-empty' });
    loadingDiv.setText('正在加载文件...');

    // 异步加载文件
    this.loadFiles();
    return Promise.resolve();
  }

  onClose(): Promise<void> {
    // 清理
    return Promise.resolve();
  }

  private renderView() {
    const container = this.containerEl.children[1];
    container.empty();

    // 统计条
    const stats = container.createDiv({ cls: 'fc-stats' });
    stats.createSpan({ text: '📄', cls: 'fc-stats-icon' });
    stats.createSpan({ text: '笔记 ', cls: 'fc-stats-label' });
    stats.createSpan({ text: String(this.allFiles.length), cls: 'fc-stats-value' });
    stats.createSpan({ text: ' · 🏷 标签 ', cls: 'fc-stats-label' });
    stats.createSpan({ text: String(this.availableTags.size), cls: 'fc-stats-value' });
    stats.createSpan({ text: ' · 已选 ', cls: 'fc-stats-label' });
    stats.createSpan({ text: String(this.getSelectedCount()), cls: 'fc-stats-value fc-stats-selected' });
    stats.createSpan({ text: ' / ' + String(this.files.length), cls: 'fc-stats-label' });
    const refreshStatsBtn = stats.createEl('button', { text: '刷新', cls: 'fc-stats-refresh' });
    refreshStatsBtn.onclick = () => this.loadFiles();

    // 搜索栏
    const searchRow = container.createDiv({ cls: 'fc-search-row' });
    const searchInput = searchRow.createEl('input', {
      type: 'text',
      cls: 'fc-search-input',
      attr: { placeholder: '搜索文件名、标签、frontmatter…' }
    });
    searchInput.value = this.searchQuery;

    // 清除按钮：始终存在，按有无输入切换显隐，避免搜索时重建整个视图
    const clearBtn = searchRow.createEl('button', { text: '×', cls: 'fc-search-clear', attr: { 'aria-label': '清除搜索' } });
    clearBtn.toggle(this.searchQuery.length > 0);
    clearBtn.onclick = () => {
      window.clearTimeout(this.searchDebounce);
      searchInput.value = '';
      this.searchQuery = '';
      clearBtn.toggle(false);
      this.applyFilters();
      this.refreshFileListOnly();
      searchInput.focus();
    };

    // 中文输入法组合期间不触发搜索，组合结束后再触发
    searchInput.addEventListener('compositionstart', () => { this.isComposing = true; });
    searchInput.addEventListener('compositionend', () => {
      this.isComposing = false;
      this.scheduleSearch(searchInput.value, clearBtn);
    });
    searchInput.addEventListener('input', () => {
      if (this.isComposing) return;
      this.scheduleSearch(searchInput.value, clearBtn);
    });

    // 浮动批量操作条（仅在有选中时显示）
    const bulkBar = container.createDiv({
      cls: `fc-bulk-bar ${this.getSelectedCount() > 0 ? 'is-visible' : ''}`
    });
    bulkBar.createSpan({ text: `已选 ${this.getSelectedCount()} 项`, cls: 'fc-bulk-count' });
    const bulkActions = bulkBar.createDiv({ cls: 'fc-bulk-actions' });
    const bulkTagBtn = bulkActions.createEl('button', { text: '🏷 标签', cls: 'fc-bulk-btn' });
    bulkTagBtn.onclick = () => this.addTagsToSelected();
    const bulkMoveBtn = bulkActions.createEl('button', { text: '📂 移动', cls: 'fc-bulk-btn' });
    bulkMoveBtn.onclick = () => this.moveSelected();
    const bulkPropBtn = bulkActions.createEl('button', { text: '✎ 属性', cls: 'fc-bulk-btn' });
    bulkPropBtn.onclick = () => this.renameFrontmatterProperty();
    const bulkMoreBtn = bulkActions.createEl('button', { text: '⋯ 更多', cls: 'fc-bulk-btn fc-bulk-more' });
    bulkMoreBtn.onclick = () => {
      const menu = new Menu();
      menu.addItem(item => item.setTitle('替换标签').setIcon('replace').onClick(() => this.replaceTagsInSelected()));
      menu.addItem(item => item.setTitle('图片重命名（文件名-001）').setIcon('image-file').onClick(() => { void this.renameImagesToNoteName(); }));
      menu.addItem(item => item.setTitle('图片转相对路径').setIcon('image-gif').onClick(() => { void this.convertImageLinksToRelativePath(); }));
      menu.addItem(item => item.setTitle('图片转最简路径').setIcon('image').onClick(() => { void this.convertImageLinksToSimplePath(); }));
      menu.addItem(item => item.setTitle('一键归档日志').setIcon('archive').onClick(() => { void this.mergeJournalsToMonth(); }));
      menu.addItem(item => item.setTitle('一键还原日志').setIcon('switch').onClick(() => { void this.monthToDaily(); }));
      menu.addItem(item => item.setTitle('隐藏归档日志').setIcon('eye-off').onClick(() => { void this.hideArchivedJournals(); }));
      menu.addItem(item => item.setTitle('展示归档日志').setIcon('eye').onClick(() => { void this.showArchivedJournals(); }));
      menu.addItem(item => item.setTitle('流程图转导出版').setIcon('git-branch').onClick(() => { void this.mermaidToExportMd(); }));
      menu.addSeparator();
      menu.addItem(item => item.setTitle('删除选中').setIcon('trash').onClick(() => this.deleteSelected()));
      const btnRect: DOMRect = bulkMoreBtn.getBoundingClientRect();
      menu.showAtPosition({ x: btnRect.left, y: btnRect.bottom });
    };
    const bulkClearBtn = bulkActions.createEl('button', { text: '取消选择', cls: 'fc-bulk-btn fc-bulk-clear' });
    bulkClearBtn.onclick = () => this.deselectAll();

    // 命令栏：用下拉菜单容纳持续增加的功能
    const toolbar = container.createDiv({ cls: 'batch-manager-toolbar' });

    const selectAllBtn = toolbar.createEl('button', { text: '全选', cls: 'fc-cmd-btn' });
    selectAllBtn.onclick = () => this.selectAll();

    const bulkMenuBtn = toolbar.createEl('button', { text: '批量操作 ▾', cls: 'fc-cmd-btn fc-cmd-menu' });
    bulkMenuBtn.onclick = () => {
      const menu = new Menu();
      menu.addItem(item => item.setTitle('打标签').setIcon('tag').onClick(() => this.addTagsToSelected()));
      menu.addItem(item => item.setTitle('替换标签').setIcon('replace').onClick(() => this.replaceTagsInSelected()));
      menu.addItem(item => item.setTitle('重命名属性').setIcon('pencil').onClick(() => this.renameFrontmatterProperty()));
      menu.addItem(item => item.setTitle('批量重命名').setIcon('file-pen').onClick(() => this.batchRenameSelected()));
      menu.addItem(item => item.setTitle('移动选中').setIcon('folder').onClick(() => this.moveSelected()));
      menu.addSeparator();
      menu.addItem(item => item.setTitle('删除选中').setIcon('trash').onClick(() => this.deleteSelected()));
      const btnRect: DOMRect = bulkMenuBtn.getBoundingClientRect();
      menu.showAtPosition({ x: btnRect.left, y: btnRect.bottom });
    };

    const findMenuBtn = toolbar.createEl('button', { text: '查找与筛选 ▾', cls: 'fc-cmd-btn fc-cmd-menu' });
    findMenuBtn.onclick = () => {
      const menu = new Menu();
      menu.addItem(item => item.setTitle('按标签筛选').setIcon('tag').onClick(() => this.showTagFilterModal()));
      menu.addItem(item => item.setTitle('按文件夹筛选').setIcon('folder').onClick(() => this.showFolderSelectModal()));
      menu.addSeparator();
      menu.addItem(item => item.setTitle('失效图片').setIcon('image').onClick(() => this.findBrokenImages()));
      menu.addItem(item => item.setTitle('修复失效图片').setIcon('image-plus').onClick(() => { void this.fixBrokenImageLinks(); }));
      menu.addItem(item => item.setTitle('失效文件链接').setIcon('link').onClick(() => { void this.fixBrokenFileLinks(); }));
      menu.addItem(item => item.setTitle('未引用图片').setIcon('image-off').onClick(() => this.findUnreferencedImages()));
      menu.addItem(item => item.setTitle('无标签笔记').setIcon('tag-off').onClick(() => this.findUntaggedNotes()));
      menu.addItem(item => item.setTitle('孤立笔记').setIcon('unlink').onClick(() => this.findOrphanNotes()));
      menu.addItem(item => item.setTitle('空文件').setIcon('file-minimal').onClick(() => this.findEmptyFiles()));
      menu.addItem(item => item.setTitle('重复笔记').setIcon('copy').onClick(() => { void this.findDuplicateNotes(); }));
      menu.addItem(item => item.setTitle('Markdown 格式检测').setIcon('scan-search').onClick(() => { void this.checkMarkdownFormat(); }));
      const btnRect: DOMRect = findMenuBtn.getBoundingClientRect();
      menu.showAtPosition({ x: btnRect.left, y: btnRect.bottom });
    };

    const convertMenuBtn = toolbar.createEl('button', { text: '转换导出 ▾', cls: 'fc-cmd-btn fc-cmd-menu' });
    convertMenuBtn.onclick = () => {
      const menu = new Menu();
      menu.addItem(item => item.setTitle('图片重命名（文件名-001）').setIcon('image-file').onClick(() => { void this.renameImagesToNoteName(); }));
      menu.addItem(item => item.setTitle('图片转相对路径').setIcon('image-gif').onClick(() => { void this.convertImageLinksToRelativePath(); }));
      menu.addItem(item => item.setTitle('图片转最简路径').setIcon('image').onClick(() => { void this.convertImageLinksToSimplePath(); }));
      menu.addSeparator();
      menu.addItem(item => item.setTitle('一键归档日志').setIcon('archive').onClick(() => { void this.mergeJournalsToMonth(); }));
      menu.addItem(item => item.setTitle('一键还原日志').setIcon('switch').onClick(() => { void this.monthToDaily(); }));
      menu.addItem(item => item.setTitle('隐藏归档日志').setIcon('eye-off').onClick(() => { void this.hideArchivedJournals(); }));
      menu.addItem(item => item.setTitle('展示归档日志').setIcon('eye').onClick(() => { void this.showArchivedJournals(); }));
      menu.addItem(item => item.setTitle('合并 iCloud 冲突文件').setIcon('merge').onClick(() => { void this.plugin.mergeIcloudConflictFiles(true); }));
      menu.addItem(item => item.setTitle('迁移昨日任务到今天').setIcon('calendar').onClick(() => { void this.plugin.migrateYesterdayTasks(); }));
      menu.addItem(item => item.setTitle('迁移所有任务到今天').setIcon('calendar-clock').onClick(() => { void this.plugin.migrateAllTasksToToday(); }));
      menu.addItem(item => item.setTitle('流程图转导出版').setIcon('git-branch').onClick(() => { void this.mermaidToExportMd(); }));
      const btnRect: DOMRect = convertMenuBtn.getBoundingClientRect();
      menu.showAtPosition({ x: btnRect.left, y: btnRect.bottom });
    };

    const listViewBtn = toolbar.createEl('button', {
      text: '☰ 列表',
      cls: `fc-cmd-btn ${this.viewMode === 'list' ? 'is-active' : ''}`
    });
    listViewBtn.onclick = () => { this.viewMode = 'list'; this.renderView(); };
    const tableViewBtn = toolbar.createEl('button', {
      text: '▦ 表格',
      cls: `fc-cmd-btn ${this.viewMode === 'table' ? 'is-active' : ''}`
    });
    tableViewBtn.onclick = () => { this.viewMode = 'table'; this.renderView(); };

    // 选中计数
    const countDiv = toolbar.createDiv({ cls: 'batch-manager-count' });
    this.countEl = countDiv;
    countDiv.setText(`已选中: ${this.getSelectedCount()} / ${this.files.length}`);

    // 标签筛选显示区域
    if (this.selectedTags.size > 0) {
      const tagFilterDiv = container.createDiv({ cls: 'batch-manager-tag-filter' });
      tagFilterDiv.createSpan({ text: '当前筛选: ', cls: 'tag-filter-label' });

      this.selectedTags.forEach(tag => {
        const tagBadge = tagFilterDiv.createSpan({ cls: 'tag-badge' });
        tagBadge.setText(tag);

        const removeBtn = tagBadge.createSpan({ text: '×', cls: 'tag-remove' });
        removeBtn.onclick = () => {
          this.selectedTags.delete(tag);
          this.filterFilesByTags();
          this.renderView();
        };
      });

      const clearAllBtn = tagFilterDiv.createEl('button', { text: '清除筛选', cls: 'clear-filter-btn' });
      clearAllBtn.onclick = () => {
        this.selectedTags.clear();
        this.filterFilesByTags();
        this.renderView();
      };
    }

    // 文件夹筛选显示区域
    if (this.selectedFolder) {
      const folderFilterDiv = container.createDiv({ cls: 'batch-manager-folder-filter fc-folder-filter-bar' });
      
      folderFilterDiv.createSpan({ text: '📁 当前文件夹: ', cls: 'folder-filter-label' });

      const folderPath = folderFilterDiv.createSpan({ cls: 'folder-path fc-folder-path' });
      folderPath.setText(this.selectedFolder.path || '/');
      
      const clearFolderBtn = folderFilterDiv.createEl('button', { text: '清除', cls: 'clear-filter-btn' });
      clearFolderBtn.onclick = () => {
        this.selectedFolder = null;
        this.applyFilters();
        this.renderView();
      };
    }

    // 文件列表
    const fileList = container.createDiv({ cls: 'batch-manager-file-list' });
    this.fileListEl = fileList;
    this.renderFileList(fileList);
  }

  /** 搜索防抖：延迟触发，避免每敲一个字符就搜索 */
  private scheduleSearch(rawValue: string, clearBtn: HTMLElement) {
    clearBtn.toggle(rawValue.length > 0);
    window.clearTimeout(this.searchDebounce);
    this.searchDebounce = window.setTimeout(() => {
      this.searchQuery = rawValue.trim().toLowerCase();
      this.applyFilters();
      this.refreshFileListOnly();
    }, 250);
  }

  /** 只刷新文件列表与计数，不重建搜索框（避免焦点丢失与中文输入中断） */
  private refreshFileListOnly() {
    if (this.fileListEl) this.renderFileList(this.fileListEl);
    if (this.countEl) this.countEl.setText(`已选中: ${this.getSelectedCount()} / ${this.files.length}`);
  }

  private renderFileList(container: HTMLElement) {
    container.empty();
    if (this.viewMode === 'table') {
      this.renderFileListTable(container);
    } else {
      this.renderFileListFlat(container);
    }
  }

  private renderFileListFlat(container: HTMLElement) {
    if (this.files.length === 0) {
      container.createDiv({ text: '没有找到文件', cls: 'batch-manager-empty' });
      return;
    }

    for (const item of this.files) {
      const fileItem = container.createDiv({ cls: 'batch-manager-file-item' });
      
      // 复选框
      const checkbox = fileItem.createEl('input', { type: 'checkbox' });
      checkbox.checked = item.selected;
      checkbox.onchange = (e) => {
        e.stopPropagation(); // 阻止事件冒泡
        item.selected = checkbox.checked;
        this.updateCount();
      };
      checkbox.onclick = (e) => {
        e.stopPropagation(); // 阻止点击复选框时触发文件打开
      };

      // 文件名
      const fileName = fileItem.createDiv({ cls: 'batch-manager-file-name' });
      fileName.setText(item.file.path);

      // 整个文件项都可以点击打开文件
      fileItem.onclick = () => {
        void this.app.workspace.getLeaf().openFile(item.file);
      };

      // 右键菜单
      fileItem.oncontextmenu = (e) => {
        e.preventDefault();
        const menu = new Menu();
        
        menu.addItem((menuItem) => {
          menuItem.setTitle('打开')
            .setIcon('file')
            .onClick(() => {
              void this.app.workspace.getLeaf().openFile(item.file);
            });
        });

        menu.addItem((menuItem) => {
          menuItem.setTitle('重命名')
            .setIcon('pencil')
            .onClick(() => {
              this.renameSingleFile(item.file);
            });
        });

        menu.addItem((menuItem) => {
          menuItem.setTitle('删除')
            .setIcon('trash')
            .onClick(() => {
              void this.deleteFile(item.file);
            });
        });

        menu.showAtMouseEvent(e);
      };
    }
  }

  private renderFileListTable(container: HTMLElement) {
    if (this.files.length === 0) {
      container.createDiv({ text: '没有找到文件', cls: 'batch-manager-empty' });
      return;
    }
    const tableWrap = container.createDiv({ cls: 'fc-table-wrap' });
    const table = tableWrap.createEl('table', { cls: 'fc-table' });
    const thead = table.createEl('thead');
    const headRow = thead.createEl('tr');
    headRow.createEl('th', { text: '' });
    headRow.createEl('th', { text: '文件' });
    headRow.createEl('th', { text: '标签' });
    headRow.createEl('th', { text: '文件夹' });
    headRow.createEl('th', { text: '大小' });
    headRow.createEl('th', { text: '修改时间' });
    const tbody = table.createEl('tbody');
    for (const item of this.files) {
      const file = item.file;
      const tr = tbody.createEl('tr', { cls: 'fc-table-row' });
      const checkTd = tr.createEl('td', { cls: 'fc-table-cell-check' });
      const checkbox = checkTd.createEl('input', { type: 'checkbox' });
      checkbox.checked = item.selected;
      checkbox.onchange = (e) => {
        e.stopPropagation();
        item.selected = checkbox.checked;
        this.updateCount();
      };
      checkbox.onclick = (e) => e.stopPropagation();
      const nameTd = tr.createEl('td', { cls: 'fc-table-cell-name' });
      nameTd.setText(file.name);
      nameTd.title = file.path;
      const tagsTd = tr.createEl('td', { cls: 'fc-table-cell-tags' });
      const cache = this.app.metadataCache.getFileCache(file);
      const fmTags: unknown = cache?.frontmatter?.tags;
      const inlineTags: string[] = [];
      if (Array.isArray(fmTags)) inlineTags.push(...fmTags.filter((t): t is string => typeof t === 'string'));
      else if (typeof fmTags === 'string') inlineTags.push(...fmTags.split(/\s+/).filter(Boolean));
      if (cache?.tags) for (const t of cache.tags) inlineTags.push(t.tag.replace(/^#/, ''));
      tagsTd.setText(inlineTags.length ? inlineTags.map(t => t.startsWith('#') ? t : '#' + t).join(' ') : '—');
      const folderTd = tr.createEl('td', { cls: 'fc-table-cell-folder' });
      folderTd.setText(file.parent?.path || '/');
      const sizeTd = tr.createEl('td', { cls: 'fc-table-cell-size' });
      const size = file.stat?.size ?? 0;
      sizeTd.setText(this.formatSize(size));
      const mtimeTd = tr.createEl('td', { cls: 'fc-table-cell-mtime' });
      mtimeTd.setText(this.formatMtime(file.stat?.mtime));
      tr.onclick = () => { void this.app.workspace.getLeaf().openFile(file); };
      tr.oncontextmenu = (e) => {
        e.preventDefault();
        const menu = new Menu();
        menu.addItem(m => m.setTitle('打开').setIcon('file').onClick(() => { void this.app.workspace.getLeaf().openFile(file); }));
        menu.addItem(m => m.setTitle('重命名').setIcon('pencil').onClick(() => this.renameSingleFile(file)));
        menu.addItem(m => m.setTitle('删除').setIcon('trash').onClick(() => { void this.deleteFile(file); }));
        menu.showAtMouseEvent(e);
      };
    }
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  private formatMtime(ms: number | undefined): string {
    if (!ms) return '—';
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = pad2(d.getMonth() + 1);
    const day = pad2(d.getDate());
    return `${y}-${m}-${day}`;
  }

  refreshFileList(): void {
    this.loadFiles();
  }

  private loadFiles() {
    const allMarkdownFiles = this.app.vault.getMarkdownFiles();
    this.allFiles = allMarkdownFiles.map(file => ({
      file,
      selected: false
    }));
    
    // 按路径排序
    this.allFiles.sort((a, b) => a.file.path.localeCompare(b.file.path));
    
    // 提取所有标签
    this.extractAllTags();
    
    // 应用所有筛选条件
    this.applyFilters();
    
    this.renderView();
  }

  private extractAllTags() {
    this.availableTags.clear();
    
    for (const item of this.allFiles) {
      try {
        const cache = this.app.metadataCache.getFileCache(item.file);
        
        // 从 frontmatter 提取标签
        if (cache?.frontmatter?.tags) {
          const fmTags: unknown = cache.frontmatter.tags;
          if (Array.isArray(fmTags)) {
            fmTags.forEach((tag: unknown) => {
              if (typeof tag !== 'string') return;
              const cleanTag = tag.startsWith('#') ? tag : `#${tag}`;
              this.availableTags.add(cleanTag);
            });
          } else if (typeof fmTags === 'string') {
            fmTags.split(/\s+/).forEach(tag => {
              if (tag.trim()) {
                const cleanTag = tag.startsWith('#') ? tag : `#${tag}`;
                this.availableTags.add(cleanTag);
              }
            });
          }
        }
        
        // 从 tags 字段提取
        if (cache?.tags) {
          cache.tags.forEach(tagCache => {
            this.availableTags.add(tagCache.tag);
          });
        }
      } catch (error) {
        console.error(`提取标签失败: ${item.file.path}`, error);
      }
    }
  }

  private filterFilesByTags() {
    // 这个方法已被 applyFilters 替代，但保留以兼容旧代码
    this.applyFilters();
  }

  private applyFilters() {
    let filteredFiles = [...this.allFiles];

    // 应用文件夹筛选
    if (this.selectedFolder instanceof TFolder) {
      const folder = this.selectedFolder;
      filteredFiles = filteredFiles.filter(item => {
        return this.isFileInFolder(item.file, folder);
      });
    }

    // 应用标签筛选
    if (this.selectedTags.size > 0) {
      filteredFiles = filteredFiles.filter(item => {
        return this.fileHasAnyTag(item.file, this.selectedTags);
      });
    }

    // 应用搜索筛选
    if (this.searchQuery) {
      const query = this.searchQuery;
      filteredFiles = filteredFiles.filter(item => {
        const file = item.file;
        if (file.path.toLowerCase().includes(query)) return true;
        if (file.name.toLowerCase().includes(query)) return true;
        const cache = this.app.metadataCache.getFileCache(file);
        if (cache?.frontmatter) {
          for (const key of Object.keys(cache.frontmatter)) {
            const value: unknown = cache.frontmatter[key];
            if (typeof value === 'string' && value.toLowerCase().includes(query)) return true;
            if (Array.isArray(value) && value.some(v => String(v).toLowerCase().includes(query))) return true;
          }
        }
        return false;
      });
    }

    this.files = filteredFiles;
  }

  private isFileInFolder(file: TFile, folder: TFolder): boolean {
    // 检查文件是否在指定文件夹或其子文件夹中
    let parent = file.parent;
    while (parent) {
      if (parent.path === folder.path) {
        return true;
      }
      parent = parent.parent;
    }
    return false;
  }

  private fileHasAnyTag(file: TFile, requiredTags: Set<string>): boolean {
    const cache = this.app.metadataCache.getFileCache(file);
    const fileTags = new Set<string>();
    
    // 从 frontmatter 获取标签
    if (cache?.frontmatter?.tags) {
      const fmTags: unknown = cache.frontmatter.tags;
      if (Array.isArray(fmTags)) {
        fmTags.forEach((tag: unknown) => {
          if (typeof tag !== 'string') return;
          const cleanTag = tag.startsWith('#') ? tag : `#${tag}`;
          fileTags.add(cleanTag);
        });
      } else if (typeof fmTags === 'string') {
        fmTags.split(/\s+/).forEach(tag => {
          if (tag.trim()) {
            const cleanTag = tag.startsWith('#') ? tag : `#${tag}`;
            fileTags.add(cleanTag);
          }
        });
      }
    }
    
    // 从 tags 字段获取
    if (cache?.tags) {
      cache.tags.forEach(tagCache => {
        fileTags.add(tagCache.tag);
      });
    }
    
    // 检查是否包含任意一个选中的标签（OR 关系）
    for (const requiredTag of requiredTags) {
      // 检查完全匹配
      if (fileTags.has(requiredTag)) {
        return true;
      }
      
      // 检查不带 # 的匹配
      const tagWithoutHash = requiredTag.startsWith('#') ? requiredTag.substring(1) : requiredTag;
      const tagWithHash = requiredTag.startsWith('#') ? requiredTag : `#${requiredTag}`;
      
      if (fileTags.has(tagWithoutHash) || fileTags.has(tagWithHash)) {
        return true;
      }
    }
    
    return false;
  }

  private showTagFilterModal() {
    new TagFilterModal(this.app, Array.from(this.availableTags), this.selectedTags, (selectedTags) => {
      this.selectedTags = selectedTags;
      this.applyFilters();
      this.renderView();
    }).open();
  }

  private showFolderSelectModal() {
    new FolderSelectModal(this.app, (folder) => {
      this.selectedFolder = folder;
      this.applyFilters();
      this.renderView();
    }).open();
  }

  private selectAll() {
    this.files.forEach(item => item.selected = true);
    this.renderView();
  }

  private deselectAll() {
    this.files.forEach(item => item.selected = false);
    this.renderView();
  }

  private getSelectedCount(): number {
    return this.files.filter(item => item.selected).length;
  }

  private getSelectedFiles(): TFile[] {
    return this.files.filter(item => item.selected).map(item => item.file);
  }

  private updateCount() {
    const countDiv = this.containerEl.querySelector('.batch-manager-count');
    if (countDiv) {
      countDiv.setText(`已选中: ${this.getSelectedCount()} / ${this.files.length}`);
    }
    const selected = this.getSelectedCount();
    const bulkBar = this.containerEl.querySelector('.fc-bulk-bar');
    if (typeof bulkBar?.instanceOf === 'function' ? bulkBar.instanceOf(HTMLElement) : bulkBar instanceof HTMLElement) {
      bulkBar.classList.toggle('is-visible', selected > 0);
    }
    const bulkCount = this.containerEl.querySelector('.fc-bulk-count');
    if (bulkCount) {
      bulkCount.setText(`已选 ${selected} 项`);
    }
    const statsSelected = this.containerEl.querySelector('.fc-stats-selected');
    if (statsSelected) {
      statsSelected.setText(String(selected));
    }
  }

  private deleteSelected() {
    const selected = this.getSelectedFiles();
    if (selected.length === 0) {
      new Notice('请先选择要删除的文件');
      return;
    }

    new ConfirmModal(this.app, `确定要删除 ${selected.length} 个文件吗？文件将移入回收站，可恢复。`, () => {
      void (async () => {
        let successCount = 0;
        let failCount = 0;

        for (const file of selected) {
          try {
            await this.app.fileManager.trashFile(file);
            successCount++;
          } catch (error) {
            console.error(`删除文件失败: ${file.path}`, error);
            failCount++;
          }
        }

        new Notice(`已移入回收站: ${successCount} 个${failCount > 0 ? `，失败 ${failCount} 个` : ''}`);
        this.loadFiles();
      })();
    }).open();
  }

  private deleteFile(file: TFile) {
    new ConfirmModal(this.app, `确定要删除 ${file.path} 吗？文件将移入回收站，可恢复。`, () => {
      void (async () => {
        try {
          await this.app.fileManager.trashFile(file);
          new Notice(`已移入回收站: ${file.path}`);
          this.loadFiles();
        } catch (error) {
          new Notice(`删除失败: ${error instanceof Error ? error.message : String(error)}`);
        }
      })();
    }).open();
  }

  private moveSelected() {
    const selected = this.getSelectedFiles();
    if (selected.length === 0) {
      new Notice('请先选择要移动的文件');
      return;
    }

    // 使用自定义模态框代替 prompt
    new FolderInputModal(this.app, (targetPath) => {
      void (async () => {
      if (!targetPath) return;

      // 确保目标文件夹存在
      const folders = targetPath.split('/').filter(f => f);
      let currentPath = '';
      for (const folder of folders) {
        currentPath = currentPath ? `${currentPath}/${folder}` : folder;
        const existing = this.app.vault.getAbstractFileByPath(currentPath);
        if (!existing) {
          await this.app.vault.createFolder(currentPath);
        }
      }

      let successCount = 0;
      let failCount = 0;

      for (const file of selected) {
        try {
          const newPath = `${targetPath}/${file.name}`;
          await this.app.vault.rename(file, newPath);
          successCount++;
        } catch (error) {
          console.error(`移动文件失败: ${file.path}`, error);
          failCount++;
        }
      }

      new Notice(`移动完成: 成功 ${successCount} 个，失败 ${failCount} 个`);
      this.loadFiles();
      })();
    }).open();
  }

  private addTagsToSelected() {
    const selected = this.getSelectedFiles();
    if (selected.length === 0) {
      new Notice('请先选择要打标签的文件');
      return;
    }

    // 使用自定义模态框代替 prompt
    new TagInputModal(this.app, this.plugin.settings.defaultTags, (tagsInput) => {
      void (async () => {
      if (!tagsInput) return;

      // 解析标签，确保每个标签都以 # 开头
      const tags = tagsInput
        .split(/\s+/)
        .filter(tag => tag.trim())
        .map(tag => tag.startsWith('#') ? tag : `#${tag}`)
        .join(' ');

      if (!tags) {
        new Notice('请输入有效的标签');
        return;
      }

      let successCount = 0;
      let failCount = 0;

      for (const file of selected) {
        try {
          const content = await this.app.vault.read(file);
          let newContent = '';
          
          const position = this.plugin.settings.tagPosition;
          
          if (position === 'frontmatter') {
            // 添加到 frontmatter
            newContent = this.addTagsToFrontmatter(content, tags);
          } else if (position === 'end') {
            // 添加到文件末尾
            newContent = `${content}\n\n${tags}`;
          } else {
            // 添加到文件开头（默认）
            const lines = content.split('\n');
            
            // 如果第一行已经是标签行，追加到该行
            if (lines[0] && lines[0].trim().startsWith('#')) {
              lines[0] = `${lines[0]} ${tags}`;
              newContent = lines.join('\n');
            } else {
              // 否则在文件最前面添加新的标签行
              newContent = `${tags}\n\n${content}`;
            }
          }
          
          await this.app.vault.modify(file, newContent);
          successCount++;
        } catch (error) {
          console.error(`添加标签失败: ${file.path}`, error);
          failCount++;
        }
      }

      new Notice(`打标签完成: 成功 ${successCount} 个，失败 ${failCount} 个`);
      })();
    }).open();
  }

  private addTagsToFrontmatter(content: string, tags: string): string {
    const lines = content.split('\n');
    
    // 检查是否已有 frontmatter
    if (lines[0] === '---') {
      let endIndex = -1;
      for (let i = 1; i < lines.length; i++) {
        if (lines[i] === '---') {
          endIndex = i;
          break;
        }
      }
      
      if (endIndex > 0) {
        // 找到 tags 行
        let tagsLineIndex = -1;
        for (let i = 1; i < endIndex; i++) {
          if (lines[i].trim().startsWith('tags:')) {
            tagsLineIndex = i;
            break;
          }
        }
        
        if (tagsLineIndex > 0) {
          // 追加到现有 tags
          const existingTags = lines[tagsLineIndex].substring(lines[tagsLineIndex].indexOf(':') + 1).trim();
          const allTags = existingTags ? `${existingTags} ${tags}` : tags;
          lines[tagsLineIndex] = `tags: ${allTags}`;
        } else {
          // 添加新的 tags 行
          lines.splice(endIndex, 0, `tags: ${tags}`);
        }
        
        return lines.join('\n');
      }
    }
    
    // 没有 frontmatter，创建新的
    const frontmatter = [
      '---',
      `tags: ${tags}`,
      '---',
      ''
    ];
    
    return frontmatter.join('\n') + content;
  }

  private replaceTagsInSelected() {
    const selected = this.getSelectedFiles();
    if (selected.length === 0) {
      new Notice('请先选择要替换标签的文件');
      return;
    }

    new ReplaceTagModal(this.app, (oldTag, newTag) => {
      void (async () => {
      // 确保标签格式正确
      const oldTagFormatted = oldTag.startsWith('#') ? oldTag : `#${oldTag}`;
      const newTagFormatted = newTag.startsWith('#') ? newTag : `#${newTag}`;

      let successCount = 0;
      let failCount = 0;
      let notFoundCount = 0;

      for (const file of selected) {
        try {
          const content = await this.app.vault.read(file);
          
          // 检查文件中是否包含旧标签
          if (!content.includes(oldTagFormatted)) {
            notFoundCount++;
            continue;
          }

          // 替换所有出现的旧标签
          const newContent = content.replace(new RegExp(oldTagFormatted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), newTagFormatted);
          
          await this.app.vault.modify(file, newContent);
          successCount++;
        } catch (error) {
          console.error(`替换标签失败: ${file.path}`, error);
          failCount++;
        }
      }

      const message = `替换完成: 成功 ${successCount} 个，未找到 ${notFoundCount} 个，失败 ${failCount} 个`;
      new Notice(message);
      
      // 刷新文件列表以更新标签显示
      this.loadFiles();
      })();
    }).open();
  }

  private renameFrontmatterProperty() {
    const selected = this.getSelectedFiles();
    if (selected.length === 0) {
      new Notice('请先选择要修改的文件');
      return;
    }

    new RenameFrontmatterPropertyModal(this.app, (oldProperty, newProperty) => {
      void (async () => {
      let successCount = 0;
      let failCount = 0;
      let notFoundCount = 0;

      for (const file of selected) {
        try {
          const content = await this.app.vault.read(file);
          const lines = content.split('\n');
          
          // 检查是否有 frontmatter
          if (lines[0] !== '---') {
            notFoundCount++;
            continue;
          }

          // 找到 frontmatter 结束位置
          let endIndex = -1;
          for (let i = 1; i < lines.length; i++) {
            if (lines[i] === '---') {
              endIndex = i;
              break;
            }
          }

          if (endIndex === -1) {
            notFoundCount++;
            continue;
          }

          // 查找并替换属性名
          let propertyFound = false;
          for (let i = 1; i < endIndex; i++) {
            const line = lines[i];
            // 匹配属性名（支持中文、英文、数字、下划线、连字符等）
            // 匹配格式: 属性名: 值 或 "属性名": 值
            const propertyMatch = line.match(/^(\s*)(['"]?)([^'":\s]+)\2(\s*):/);
            if (propertyMatch && propertyMatch[3] === oldProperty) {
              // 保留原有的缩进和格式
              const indent = propertyMatch[1];
              const quote = propertyMatch[2];
              const spacing = propertyMatch[4];
              const valueStart = line.indexOf(':', indent.length + quote.length + oldProperty.length + quote.length);
              const value = line.substring(valueStart + 1);
              
              lines[i] = `${indent}${quote}${newProperty}${quote}${spacing}:${value}`;
              propertyFound = true;
            }
          }

          if (!propertyFound) {
            notFoundCount++;
            continue;
          }

          // 保存修改后的内容
          const newContent = lines.join('\n');
          await this.app.vault.modify(file, newContent);
          successCount++;
        } catch (error) {
          console.error(`重命名属性失败: ${file.path}`, error);
          failCount++;
        }
      }

      const message = `重命名完成: 成功 ${successCount} 个，未找到 ${notFoundCount} 个，失败 ${failCount} 个`;
      new Notice(message);
      
      // 刷新文件列表
      this.loadFiles();
      })();
    }).open();
  }

  private async findBrokenImages() {
    new Notice('正在扫描文件中的图片链接...');
  }

  /** 生成内容归一化后的 hash，用于重复笔记检测（屏蔽代码块 + 去空白） */
  private async contentHash(content: string): Promise<string> {
    const normalized = this.maskCodeRegions(content).replace(/\s+/g, '');
    const data = new TextEncoder().encode(normalized);
    const subtle = crypto.subtle as { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> };
    const digest = await subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /** 查找重复笔记：iCloud 冲突命名（a.md / a 1.md / a 2.md）+ 内容完全相同的文件 */
  private async findDuplicateNotes() {
    new Notice('正在扫描重复笔记...');
    const allFiles = this.app.vault.getMarkdownFiles();
    const byPath = new Map(allFiles.map(f => [f.path, f]));
    const duplicatePaths = new Set<string>();
    let groupCount = 0;

    // 1. iCloud 冲突命名：basename 以「空格+数字」结尾，且同目录存在去掉后缀的原文件
    const conflictRegex = /^(.*?) \d+$/;
    const conflictGroups = new Map<string, TFile[]>();
    for (const file of allFiles) {
      const m = conflictRegex.exec(file.basename);
      if (!m) continue;
      const dir = file.parent?.path || '';
      const originalPath = dir ? `${dir}/${m[1]}.md` : `${m[1]}.md`;
      const original = byPath.get(originalPath);
      if (!original) continue;
      const key = originalPath;
      const group = conflictGroups.get(key) ?? [original];
      group.push(file);
      conflictGroups.set(key, group);
    }
    for (const group of conflictGroups.values()) {
      groupCount++;
      for (const f of group) duplicatePaths.add(f.path);
    }

    // 2. 内容重复：归一化 hash 相同的归为一组
    const byHash = new Map<string, TFile[]>();
    for (const file of allFiles) {
      try {
        const hash = await this.contentHash(await this.app.vault.cachedRead(file));
        const group = byHash.get(hash);
        if (group) group.push(file);
        else byHash.set(hash, [file]);
      } catch (error) {
        console.error(`读取文件失败: ${file.path}`, error);
      }
    }
    for (const group of byHash.values()) {
      if (group.length < 2) continue;
      groupCount++;
      for (const f of group) duplicatePaths.add(f.path);
    }

    if (duplicatePaths.size === 0) {
      new Notice('未发现重复笔记');
      return;
    }

    this.allFiles = allFiles
      .filter(f => duplicatePaths.has(f.path))
      .map(file => ({ file, selected: false }));
    this.files = [...this.allFiles];
    this.files.sort((a, b) => a.file.path.localeCompare(b.file.path));
    this.renderView();
    new Notice(`发现 ${groupCount} 组重复笔记，共 ${duplicatePaths.size} 个文件`);
  }

  /** 扫描并收集所有失效的内部图片链接（wiki 与 Markdown 图片语法） */
  private async collectBrokenImageLinks(): Promise<BrokenImageLink[]> {
    const allMarkdownFiles = this.app.vault.getMarkdownFiles();
    const brokenLinks: BrokenImageLink[] = [];

    const wikiImageRegex = /!\[\[([^\]]+)\]\]/g;
    const mdImageRegex = /!\[[^\]]*\]\(([^)]+)\)/g;

    const validExtensions = this.plugin.settings.imageExtensions
      .split(',')
      .map(ext => ext.trim().toLowerCase());
    const imageFolders = this.plugin.settings.imageFolders
      .split(',')
      .map(folder => folder.trim())
      .filter(folder => folder);

    for (const file of allMarkdownFiles) {
      try {
        const rawContent = await this.app.vault.cachedRead(file);
        const content = this.maskCodeRegions(rawContent);

        for (const match of collectMatches(content, wikiImageRegex)) {
          const raw = match[1];
          if (!raw) continue;
          const pipeIndex = raw.indexOf('|');
          const imagePath = (pipeIndex >= 0 ? raw.substring(0, pipeIndex) : raw).trim();
          const suffix = pipeIndex >= 0 ? raw.substring(pipeIndex) : '';
          if (!this.isBrokenImagePath(file, imagePath, validExtensions, imageFolders)) continue;
          brokenLinks.push({
            sourceFile: file,
            originalText: match[0],
            linkType: 'wiki',
            imagePath,
            suffix,
            suggestedPath: this.suggestImagePath(imagePath, file.path)
          });
        }

        for (const match of collectMatches(content, mdImageRegex)) {
          const raw = match[1];
          if (!raw) continue;
          const imagePath = raw.trim();
          if (!this.isBrokenImagePath(file, imagePath, validExtensions, imageFolders)) continue;
          brokenLinks.push({
            sourceFile: file,
            originalText: match[0],
            linkType: 'markdown',
            imagePath,
            suffix: '',
            suggestedPath: this.suggestImagePath(imagePath, file.path)
          });
        }
      } catch (error) {
        console.error(`扫描文件图片链接失败: ${file.path}`, error);
      }
    }

    return brokenLinks;
  }

  /** 判断一个图片链接是否失效（复用查找失效图片的判定规则） */
  private isBrokenImagePath(sourceFile: TFile, imagePath: string, validExtensions: string[], imageFolders: string[]): boolean {
    if (!imagePath) return false;
    const decoded = this.safeDecodeUriPath(imagePath);
    if (decoded.startsWith('http://') || decoded.startsWith('https://')) return false;
    const ext = decoded.split('.').pop()?.toLowerCase();
    if (ext && !validExtensions.includes(ext)) return false;
    return !this.checkImageExists(sourceFile, imagePath, imageFolders);
  }

  /** 为失效图片推荐新路径：按完整文件名在配置的图片文件夹与全库中精确匹配，唯一才返回 */
  private suggestImagePath(imagePath: string, sourcePath: string): string | null {
    const decoded = this.safeDecodeUriPath(imagePath);
    const variants = decoded !== imagePath ? [imagePath, decoded] : [imagePath];

    const exts = new Set(
      this.plugin.settings.imageExtensions
        .split(',')
        .map(ext => ext.trim().toLowerCase())
    );

    for (const p of variants) {
      const fileName = p.split('/').pop() || p;
      if (!fileName) continue;
      const inFolders = this.getAllImageFilesInConfiguredFolders().filter(f => f.name === fileName);
      if (inFolders.length === 1) return inFolders[0].path;
      const inVault = this.app.vault.getFiles().filter(f => f.name === fileName && exts.has(f.extension.toLowerCase()));
      if (inVault.length === 1) return inVault[0].path;
    }
    return null;
  }

  /** 一键修正失效图片链接：扫描 -> 预览确认 -> 执行修正 */
  private async fixBrokenImageLinks() {
    new Notice('正在扫描失效图片链接...');
    const brokenLinks = await this.collectBrokenImageLinks();

    if (brokenLinks.length === 0) {
      new Notice('未发现失效图片链接');
      return;
    }

    const affectedFiles = Array.from(new Map(brokenLinks.map(link => [link.sourceFile.path, link.sourceFile])).values());
    this.allFiles = affectedFiles.map(file => ({ file, selected: false }));
    this.files = [...this.allFiles];
    this.files.sort((a, b) => a.file.path.localeCompare(b.file.path));
    this.renderView();

    new BrokenImageLinksModal(
      this.app,
      brokenLinks,
      (links) => { void this.applyBrokenImageFixes(links); }
    ).open();
  }

  /** 根据建议路径构造新的图片链接文本，wiki 保留 | 尺寸参数 */
  private buildReplacementImageLink(link: BrokenImageLink): string {
    if (!link.suggestedPath) return link.originalText;

    if (link.linkType === 'wiki') {
      return `![[${link.suggestedPath}${link.suffix}]]`;
    }
    const encodedPath = this.encodeMarkdownLinkPath(link.suggestedPath);
    return link.originalText.replace(/\(([^)]+)\)/, `(${encodedPath})`);
  }

  /** 应用图片链接修正：按文件分组，每个文件只读写一次 */
  private async applyBrokenImageFixes(links: BrokenImageLink[]) {
    if (links.length === 0) return;

    const byFile = new Map<TFile, BrokenImageLink[]>();
    for (const link of links) {
      const group = byFile.get(link.sourceFile);
      if (group) group.push(link);
      else byFile.set(link.sourceFile, [link]);
    }

    let successCount = 0;
    let failCount = 0;

    for (const [file, fileLinks] of byFile) {
      try {
        let content = await this.app.vault.read(file);
        for (const link of fileLinks) {
          if (!link.suggestedPath || !content.includes(link.originalText)) continue;
          const newLink = this.buildReplacementImageLink(link);
          if (newLink === link.originalText) continue;
          content = content.split(link.originalText).join(newLink);
          successCount++;
        }
        await this.app.vault.modify(file, content);
      } catch (error) {
        console.error(`修正图片链接失败: ${file.path}`, error);
        failCount += fileLinks.length;
      }
    }

    new Notice(`图片链接修正完成: 成功 ${successCount} 个，失败 ${failCount} 个`);
    if (successCount > 0) {
      this.loadFiles();
    }
  }

  /** 重命名后更新全库指向旧路径的 Markdown 链接 [t](old.md)，wiki 链接交给 Obsidian 自动更新 */
  private async updateMarkdownLinksAfterRename(oldPath: string, newFile: TFile) {
    const mdLinkRegex = /(?<!!)\[(?:[^\]]*)\]\(([^)]+)\)/g;

    for (const source of this.app.vault.getMarkdownFiles()) {
      if (source.path === newFile.path) continue;
      try {
        const rawContent = await this.app.vault.cachedRead(source);
        const masked = this.maskCodeRegions(rawContent);
        const replacements: Array<{ original: string; updated: string }> = [];

        for (const match of collectMatches(masked, mdLinkRegex)) {
          const raw = match[1];
          if (!raw) continue;
          const parsed = parseMarkdownLink(raw);
          if (!isInternalFileLink(parsed.linkPath)) continue;
          // parseLinktext 会把 |alias 并入 path，先剥掉再判定与构造
          const rawPath = parsed.linkPath.split('|')[0];
          // 用重命名前的解析策略判断该链接是否指向旧文件
          const target = this.resolveFileLinkFromDir(rawPath, source.path, oldPath);
          if (!target || target !== oldPath) continue;

          const newLinkPath = this.buildLinkPathForTarget(newFile, source.path, rawPath);
          const encoded = this.encodeMarkdownLinkPath(newLinkPath);
          const updated = match[0].replace(/\(([^)]+)\)/, `(${encoded})`);
          if (updated !== match[0]) {
            replacements.push({ original: match[0], updated });
          }
        }

        if (replacements.length === 0) continue;
        let content = await this.app.vault.read(source);
        for (const r of replacements) {
          content = content.split(r.original).join(r.updated);
        }
        await this.app.vault.modify(source, content);
      } catch (error) {
        console.error(`更新链接失败: ${source.path}`, error);
      }
    }
  }

  /**
   * 用重命名前的路径形态判断链接是否指向 oldPath：
   * 最简路径（a.md）按旧文件名匹配；相对/完整路径解析为 vault 根路径后与 oldPath 比对。
   */
  private resolveFileLinkFromDir(linkPath: string, sourcePath: string, oldPath: string): string | null {
    const decoded = this.safeDecodeUriPath(linkPath);
    const oldFileName = oldPath.split('/').pop() || oldPath;
    const oldBaseName = oldFileName.replace(/\.[^.]+$/, '');

    for (const p of (decoded !== linkPath ? [linkPath, decoded] : [linkPath])) {
      if (!p.includes('/')) {
        // 最简路径：按文件名或 basename 匹配旧文件
        if (p === oldFileName || p === oldBaseName) return oldPath;
        continue;
      }
      // 完整/相对路径：解析为 vault 根路径
      const sourceDir = sourcePath.split('/').slice(0, -1).join('/');
      const resolved = p.startsWith('./') || p.startsWith('../')
        ? this.resolveRelativePath(sourceDir, p)
        : p;
      if (resolved === oldPath) return oldPath;
    }
    return null;
  }

  /** 根据原链接风格构造指向新文件的链接路径（保持最简/相对/完整形态） */
  private buildLinkPathForTarget(newFile: TFile, sourcePath: string, originalLinkPath: string): string {
    if (!originalLinkPath.includes('/')) {
      return newFile.name; // 最简路径：仅文件名
    }
    if (originalLinkPath.startsWith('./') || originalLinkPath.startsWith('../')) {
      const sourceDir = sourcePath.split('/').slice(0, -1).join('/');
      return this.computeRelativePath(sourceDir, newFile.path);
    }
    return newFile.path; // 完整路径
  }

  /** 计算从 sourceDir 到 targetPath 的相对路径（含 ../ 与前缀 ./） */
  private computeRelativePath(sourceDir: string, targetPath: string): string {
    const sourceParts = sourceDir ? sourceDir.split('/').filter(Boolean) : [];
    const targetParts = targetPath.split('/').filter(Boolean);
    let i = 0;
    while (i < sourceParts.length && i < targetParts.length && sourceParts[i] === targetParts[i]) {
      i++;
    }
    const ups = sourceParts.length - i;
    const downs = targetParts.slice(i);
    const prefix = ups > 0 ? '../'.repeat(ups) : './';
    return prefix + downs.join('/');
  }

  /** 单文件重命名：弹输入框，改名后更新全库 Markdown 链接 */
  private renameSingleFile(file: TFile) {
    new RenameInputModal(this.app, file.basename, (newName) => {
      void (async () => {
        const trimmed = newName.trim();
        if (!trimmed || trimmed === file.basename) return;
        if (/[\\/:*?"<>|#^[\]]/.test(trimmed)) {
          new Notice('文件名包含非法字符');
          return;
        }
        const dir = file.parent?.path || '';
        const newPath = dir ? `${dir}/${trimmed}.${file.extension}` : `${trimmed}.${file.extension}`;
        if (this.app.vault.getAbstractFileByPath(newPath)) {
          new Notice('已存在同名文件');
          return;
        }
        const oldPath = file.path;
        try {
          await this.app.fileManager.renameFile(file, newPath);
          new Notice(`已重命名为: ${newPath}`);
          await this.updateMarkdownLinksAfterRename(oldPath, file);
          this.loadFiles();
        } catch (error) {
          console.error(`重命名失败: ${oldPath}`, error);
          new Notice(`重命名失败: ${error instanceof Error ? error.message : String(error)}`);
        }
      })();
    }).open();
  }

  /** 批量重命名：查找替换 basename（可选正则），预览确认后执行并同步更新链接 */
  private batchRenameSelected() {
    const selected = this.getSelectedFiles();
    if (selected.length === 0) {
      new Notice('请先选择要重命名的文件');
      return;
    }
    new BatchRenameModal(this.app, (find, replace, useRegex) => {
      const plans: Array<{ file: TFile; newPath: string }> = [];
      let regex: RegExp | null = null;
      if (useRegex) {
        try {
          regex = new RegExp(find, 'g');
        } catch {
          new Notice('正则表达式无效');
          return;
        }
      }
      for (const file of selected) {
        const newBase = useRegex && regex
          ? file.basename.replace(regex, replace)
          : file.basename.split(find).join(replace);
        if (newBase === file.basename || !newBase.trim()) continue;
        const dir = file.parent?.path || '';
        const newPath = dir ? `${dir}/${newBase}.${file.extension}` : `${newBase}.${file.extension}`;
        plans.push({ file, newPath });
      }
      if (plans.length === 0) {
        new Notice('没有文件名会发生变化');
        return;
      }
      new BatchRenamePreviewModal(this.app, plans, () => {
        void (async () => {
          let successCount = 0;
          let failCount = 0;
          for (const plan of plans) {
            try {
              if (this.app.vault.getAbstractFileByPath(plan.newPath)) {
                failCount++;
                continue;
              }
              const oldPath = plan.file.path;
              await this.app.fileManager.renameFile(plan.file, plan.newPath);
              await this.updateMarkdownLinksAfterRename(oldPath, plan.file);
              successCount++;
            } catch (error) {
              console.error(`批量重命名失败: ${plan.file.path}`, error);
              failCount++;
            }
          }
          new Notice(`批量重命名完成: 成功 ${successCount} 个，失败 ${failCount} 个`);
          this.loadFiles();
        })();
      }).open();
    }).open();
  }

  private async findBrokenImages() {
    new Notice('正在扫描文件中的图片链接...');
    
    const allMarkdownFiles = this.app.vault.getMarkdownFiles();
    const brokenImageFiles: TFile[] = [];
    
    // 图片链接的正则表达式
    // 匹配 ![[image.png]] 和 ![](image.png) 格式
    const imageRegex = /!\[\[([^\]]+)\]\]|!\[([^\]]*)\]\(([^)]+)\)/g;
    
    // 获取配置的图片扩展名
    const validExtensions = this.plugin.settings.imageExtensions
      .split(',')
      .map(ext => ext.trim().toLowerCase());
    
    // 获取配置的图片文件夹
    const imageFolders = this.plugin.settings.imageFolders
      .split(',')
      .map(folder => folder.trim())
      .filter(folder => folder);
    
    for (const file of allMarkdownFiles) {
      try {
        const content = await this.app.vault.read(file);
        let hasBrokenImage = false;
        
        for (const match of collectMatches(content, imageRegex)) {
          const imagePathRaw = getImagePathFromMatch(match);
          if (!imagePathRaw) continue;

          // 移除可能的尺寸参数 (例如: image.png|100)
          let imagePath = imagePathRaw.split('|')[0].trim();
          // 支持 URL 编码的路径（如 %20 -> 空格），避免误判为失效
          const imagePathDecoded = this.safeDecodeUriPath(imagePath);

          // 检查是否是外部链接
          const isExternal = imagePathDecoded.startsWith('http://') || imagePathDecoded.startsWith('https://');

          // 根据配置决定是否扫描外部链接
          if (isExternal && !this.plugin.settings.scanExternalImages) {
            continue;
          }

          // 外部链接跳过文件系统检查
          if (isExternal) {
            continue;
          }

          // 检查文件扩展名（用解码后的路径，避免 %2E 等影响）
          const ext = imagePathDecoded.split('.').pop()?.toLowerCase();
          if (ext && !validExtensions.includes(ext)) {
            continue;
          }

          // 检查图片是否存在（内部会同时尝试编码与解码路径）
          const imageExists = this.checkImageExists(file, imagePath, imageFolders);
          
          if (!imageExists) {
            hasBrokenImage = true;
            break;
          }
        }
        
        if (hasBrokenImage) {
          brokenImageFiles.push(file);
        }
      } catch (error) {
        console.error(`扫描文件失败: ${file.path}`, error);
      }
    }
    
    if (brokenImageFiles.length === 0) {
      new Notice('未发现包含失效图片的笔记');
      return;
    }
    
    // 更新文件列表，只显示包含失效图片的文件
    this.allFiles = brokenImageFiles.map(file => ({
      file,
      selected: false
    }));
    this.files = [...this.allFiles];
    
    this.files.sort((a, b) => a.file.path.localeCompare(b.file.path));
    this.renderView();
    
    new Notice(`发现 ${brokenImageFiles.length} 个笔记包含失效图片`);
  }

  /**
   * 将代码块与行内代码替换为等长空白，使其中的 [[..]]、[](..) 不被当作链接。
   * 保持字符长度不变，从而 match.index 仍与原文对齐。
   */
  private maskCodeRegions(content: string): string {
    const blank = (m: string) => ' '.repeat(m.length);
    return content
      .replace(/```[\s\S]*?```/g, blank)   // ``` 围栏代码块
      .replace(/~~~[\s\S]*?~~~/g, blank)   // ~~~ 围栏代码块
      .replace(/`[^`\n]*`/g, blank);       // `行内代码`
  }

  /** 判断匹配到的链接是否被成对引号包裹（如 "[[..]]" 或 '[[..]]'），这类属于普通文本 */
  private isWrappedInQuotes(content: string, index: number, length: number): boolean {
    if (index < 0) return false;
    const before = index > 0 ? content[index - 1] : '';
    const after = content[index + length] ?? '';
    return (before === '"' && after === '"') || (before === "'" && after === "'");
  }

  /** 扫描并收集所有失效的内部文件链接（wiki link 与标准 Markdown 链接） */
  private async collectBrokenFileLinks(): Promise<BrokenFileLink[]> {
    const allMarkdownFiles = this.app.vault.getMarkdownFiles();
    const brokenLinks: BrokenFileLink[] = [];

    // 非图片 wiki 链接 [[path|alias]] 与 Markdown 链接 [text](path)
    const wikiLinkRegex = /(?<!!)\[\[([^\]]+)\]\]/g;
    const mdLinkRegex = /(?<!!)\[(?:[^\]]*)\]\(([^)]+)\)/g;

    for (const file of allMarkdownFiles) {
      try {
        const rawContent = await this.app.vault.cachedRead(file);
        // 代码块内的链接是示例文本，屏蔽后再扫描（长度保持不变，match.index 仍对齐原文）
        const content = this.maskCodeRegions(rawContent);

        for (const match of collectMatches(content, wikiLinkRegex)) {
          const raw = match[1];
          if (!raw) continue;
          // 被引号包裹的 [[..]] 属于普通文本（如 frontmatter 字符串值），不是真正的链接，跳过
          if (this.isWrappedInQuotes(content, match.index ?? -1, match[0].length)) continue;
          const parsed = parseWikiLink(raw);
          if (!isInternalFileLink(parsed.linkPath)) continue;

          const linkPath = parsed.linkPath;
          const target = this.resolveFileLink(linkPath, file.path);
          if (target) continue;

          const suggested = this.suggestFilePath(linkPath, file.path);
          brokenLinks.push({
            sourceFile: file,
            originalText: match[0],
            linkType: 'wiki',
            linkPath,
            displayText: parsed.displayText,
            anchor: parsed.subpath.startsWith('#') ? parsed.subpath.substring(1) : '',
            subpath: parsed.subpath,
            suggestedPath: suggested
          });
        }

        for (const match of collectMatches(content, mdLinkRegex)) {
          const raw = match[1];
          if (!raw) continue;
          const parsed = parseMarkdownLink(raw);
          if (!isInternalFileLink(parsed.linkPath)) continue;

          const linkPath = parsed.linkPath;
          const target = this.resolveFileLink(linkPath, file.path);
          if (target) continue;

          const suggested = this.suggestFilePath(linkPath, file.path);
          brokenLinks.push({
            sourceFile: file,
            originalText: match[0],
            linkType: 'markdown',
            linkPath,
            displayText: '',
            anchor: parsed.anchor,
            subpath: parsed.anchor ? `#${parsed.anchor}` : '',
            suggestedPath: suggested
          });
        }
      } catch (error) {
        console.error(`扫描文件链接失败: ${file.path}`, error);
      }
    }

    return brokenLinks;
  }

  /** 一键修正失效文件链接：扫描 -> 预览确认 -> 执行修正 */
  private async fixBrokenFileLinks() {
    new Notice('正在扫描失效文件链接...');
    const brokenLinks = await this.collectBrokenFileLinks();

    if (brokenLinks.length === 0) {
      new Notice('未发现失效文件链接');
      return;
    }

    // 将包含失效链接的笔记显示在文件列表中，便于查看
    const affectedFiles = Array.from(new Map(brokenLinks.map(link => [link.sourceFile.path, link.sourceFile])).values());
    this.allFiles = affectedFiles.map(file => ({ file, selected: false }));
    this.files = [...this.allFiles];
    this.files.sort((a, b) => a.file.path.localeCompare(b.file.path));
    this.renderView();

    // 弹出「预览 -> 确认」窗口，确认后才执行修正
    new BrokenFileLinksModal(
      this.app,
      brokenLinks,
      (links) => { void this.applyBrokenLinkFixes(links); },
      (link) => this.clearBrokenLink(link),
      (links) => this.clearAllBrokenLinks(links)
    ).open();
  }

  /** 清除单个失效链接：去除链接语法，仅保留可读文本 */
  private async clearBrokenLink(link: BrokenFileLink): Promise<boolean> {
    try {
      const content = await this.app.vault.read(link.sourceFile);
      if (!content.includes(link.originalText)) {
        new Notice('未找到原文，可能已被修改');
        return false;
      }
      const plainText = this.buildClearedText(link);
      const newContent = content.split(link.originalText).join(plainText);
      await this.app.vault.modify(link.sourceFile, newContent);
      new Notice(`已清除失效链接: ${link.linkPath}`);
      this.loadFiles();
      return true;
    } catch (error) {
      console.error(`清除链接失败: ${link.sourceFile.path} -> ${link.linkPath}`, error);
      new Notice('清除链接失败');
      return false;
    }
  }

  /** 一键清除多个失效链接：按文件分组，每个文件只读写一次 */
  private async clearAllBrokenLinks(links: BrokenFileLink[]): Promise<number> {
    if (links.length === 0) return 0;

    const byFile = new Map<TFile, BrokenFileLink[]>();
    for (const link of links) {
      const group = byFile.get(link.sourceFile);
      if (group) group.push(link);
      else byFile.set(link.sourceFile, [link]);
    }

    let clearedCount = 0;
    for (const [file, fileLinks] of byFile) {
      try {
        let content = await this.app.vault.read(file);
        for (const link of fileLinks) {
          if (!content.includes(link.originalText)) continue;
          content = content.split(link.originalText).join(this.buildClearedText(link));
          clearedCount++;
        }
        await this.app.vault.modify(file, content);
      } catch (error) {
        console.error(`清除链接失败: ${file.path}`, error);
      }
    }

    new Notice(`已清除 ${clearedCount} 个失效链接`);
    this.loadFiles();
    return clearedCount;
  }

  /** 计算清除链接后保留的纯文本：wiki 保留别名或路径名，Markdown 保留链接文本 */
  private buildClearedText(link: BrokenFileLink): string {
    if (link.linkType === 'wiki') {
      if (link.displayText) return link.displayText;
      const name = link.linkPath.split('/').pop() || link.linkPath;
      return name.replace(/\.md$/i, '');
    }
    const labelMatch = link.originalText.match(/^\[([^\]]*)\]/);
    return labelMatch ? labelMatch[1] : link.originalText;
  }

  /** 为失效链接推荐一个可能的新路径；找不到时返回 null */
  private suggestFilePath(linkPath: string, sourcePath: string): string | null {
    const decoded = this.safeDecodeUriPath(linkPath);
    const variants = decoded !== linkPath ? [linkPath, decoded] : [linkPath];

    // 1. 使用 Obsidian 链接解析器，兼容省略 .md 的 wiki 链接与最简路径
    for (const p of variants) {
      const target = this.app.metadataCache.getFirstLinkpathDest(p, sourcePath);
      if (target instanceof TFile) return target.path;
    }

    // 2. 按完整文件名精确匹配（不做模糊/包含匹配，避免误判为无关文件）
    for (const p of variants) {
      const best = this.findFileByExactName(p, sourcePath);
      if (best) return best.path;
    }

    return null;
  }

  /**
   * 仅按「完整文件名」精确匹配来查找文件，找不到或无法确定唯一目标时返回 null。
   * - 带扩展名时按完整文件名匹配，如 `供应商预研任务分解-模板.md`
   * - 省略扩展名时（wiki 链接常见）按完整 basename 匹配，如 `供应商预研任务分解-模板`
   * - 存在多个同名文件时，优先选择与源文件同目录者，否则视为无法确定，返回 null
   */
  private findFileByExactName(linkPath: string, sourcePath: string): TFile | null {
    const rawName = linkPath.split('/').pop() || linkPath;
    if (!rawName) return null;

    const hasExt = /\.[^./]+$/.test(rawName);
    const allFiles = this.app.vault.getFiles();

    // 完整名称匹配：带扩展名比对 file.name，省略扩展名比对 file.basename
    const matches = allFiles.filter(f => (hasExt ? f.name === rawName : f.basename === rawName));

    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];

    // 多个同名文件，优先与源文件同目录，否则无法确定唯一目标
    const sourceDir = sourcePath.split('/').slice(0, -1).join('/');
    const sameDir = matches.find(f => (f.parent?.path || '') === sourceDir);
    return sameDir || null;
  }

  /**
   * 判断文件链接是否仍然有效，解析策略参考「查找失效图片」的实现：
   * 直接路径 -> Obsidian 解析器 -> 相对路径（支持 ./ 与 ../）-> 全局唯一文件名（最简路径）。
   */
  private resolveFileLink(linkPath: string, sourcePath: string): TFile | null {
    const decoded = this.safeDecodeUriPath(linkPath);
    const variants = decoded !== linkPath ? [linkPath, decoded] : [linkPath];

    // 1. 直接路径（相对于 vault 根目录，原始与解码）
    for (const p of variants) {
      const file = this.app.vault.getAbstractFileByPath(p);
      if (file instanceof TFile) return file;
    }

    // 2. Obsidian 链接解析器（自动处理最简路径、省略 .md 等 wiki 链接）
    for (const p of variants) {
      const dest = this.app.metadataCache.getFirstLinkpathDest(p, sourcePath);
      if (dest instanceof TFile) return dest;
    }

    // 3. 相对于源文件的路径，正确解析 ./ 与 ../
    const sourceDir = sourcePath.split('/').slice(0, -1).join('/');
    for (const p of variants) {
      const relativePath = this.resolveRelativePath(sourceDir, p);
      const file = this.app.vault.getAbstractFileByPath(relativePath);
      if (file instanceof TFile) return file;
    }

    // 4. 最简路径：仅按完整文件名全局匹配，且必须唯一，避免误判
    for (const p of variants) {
      const fileName = p.split('/').pop() || p;
      const matches = this.app.vault.getFiles().filter(f => f.name === fileName || f.basename === fileName);
      if (matches.length === 1) return matches[0];
    }

    return null;
  }

  /** 将相对路径（含 ./ 与 ../）解析为相对于 vault 根目录的规范路径 */
  private resolveRelativePath(sourceDir: string, relative: string): string {
    const stack = sourceDir ? sourceDir.split('/').filter(Boolean) : [];
    for (const part of relative.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') stack.pop();
      else stack.push(part);
    }
    return stack.join('/');
  }

  /** 应用链接修正：将原文中的失效路径替换为建议路径 */
  private async applyBrokenLinkFixes(links: BrokenFileLink[]) {
    if (links.length === 0) return;

    let successCount = 0;
    let failCount = 0;
    const modifiedFiles = new Set<TFile>();

    for (const link of links) {
      if (!link.suggestedPath) continue;
      try {
        const content = await this.app.vault.read(link.sourceFile);
        const newLink = this.buildReplacementLink(link);
        if (newLink === link.originalText) continue;

        const newContent = content.split(link.originalText).join(newLink);
        if (newContent === content) {
          failCount++;
          continue;
        }
        await this.app.vault.modify(link.sourceFile, newContent);
        successCount++;
        modifiedFiles.add(link.sourceFile);
      } catch (error) {
        console.error(`修正链接失败: ${link.sourceFile.path} -> ${link.linkPath}`, error);
        failCount++;
      }
    }

    new Notice(`链接修正完成: 成功 ${successCount} 个，失败 ${failCount} 个`);
    if (modifiedFiles.size > 0) {
      this.loadFiles();
    }
  }

  /** 根据建议路径构造新的链接文本，保留别名/锚点 */
  private buildReplacementLink(link: BrokenFileLink): string {
    if (!link.suggestedPath) return link.originalText;

    if (link.linkType === 'wiki') {
      // wiki 链接使用原始路径，Obsidian 自身负责解析
      let result = `[[${link.suggestedPath}`;
      if (link.subpath) result += link.subpath;
      if (link.displayText) result += `|${link.displayText}`;
      result += ']]';
      return result;
    }

    // 标准 Markdown 链接需要对路径中的空格等字符编码，保证在 Obsidian/Typora 中都有效
    const encodedPath = this.encodeMarkdownLinkPath(link.suggestedPath);
    const anchor = link.anchor ? `#${link.anchor}` : '';
    return link.originalText.replace(/\(([^)]+)\)/, `(${encodedPath}${anchor})`);
  }

  /** 对 Markdown 链接路径做 URL 编码，但保留 `/` 分隔符 */
  private encodeMarkdownLinkPath(path: string): string {
    return path
      .split('/')
      .map(segment => encodeURIComponent(segment))
      .join('/');
  }

  /** 递归收集文件夹下所有扩展名在 exts 中的图片文件 */
  private collectImageFilesInFolder(folder: TFolder, exts: Set<string>): TFile[] {
    const result: TFile[] = [];
    for (const child of folder.children) {
      if (child instanceof TFile) {
        if (exts.has(child.extension.toLowerCase())) result.push(child);
      } else if (child instanceof TFolder) {
        result.push(...this.collectImageFilesInFolder(child, exts));
      }
    }
    return result;
  }

  /** 获取配置的图片文件夹下所有图片文件 */
  private getAllImageFilesInConfiguredFolders(): TFile[] {
    const exts = new Set(
      this.plugin.settings.imageExtensions
        .split(',')
        .map(ext => ext.trim().toLowerCase())
    );
    const folderPaths = this.plugin.settings.imageFolders
      .split(',')
      .map(f => f.trim())
      .filter(f => f);
    const seen = new Set<string>();
    const result: TFile[] = [];
    for (const folderPath of folderPaths) {
      const folder = this.app.vault.getAbstractFileByPath(folderPath);
      if (!folder || !(folder instanceof TFolder)) continue;
      for (const file of this.collectImageFilesInFolder(folder, exts)) {
        if (!seen.has(file.path)) {
          seen.add(file.path);
          result.push(file);
        }
      }
    }
    return result;
  }

  /** 查找 assets 等配置文件夹下未被任何笔记引用的图片 */
  private async findUnreferencedImages() {
    new Notice('正在扫描未引用图片...');

    const imageFiles = this.getAllImageFilesInConfiguredFolders();
    if (imageFiles.length === 0) {
      new Notice('配置的图片文件夹下没有找到图片，请检查「图片文件夹」设置');
      return;
    }

    // 构建图片路径集合和文件名到路径的映射
    const imagePathSet = new Set(imageFiles.map(f => f.path));
    const imageNameToPath = new Map<string, string>();
    for (const f of imageFiles) {
      // 同名图片可能在不同文件夹，这里只记录第一个（用于简写链接匹配）
      const name = f.name.toLowerCase();
      if (!imageNameToPath.has(name)) {
        imageNameToPath.set(name, f.path);
      }
    }
    
    const referencedPaths = new Set<string>();

    const allMd = this.app.vault.getMarkdownFiles();
    for (const md of allMd) {
      // 方法1：使用 metadataCache（可能有缓存延迟）
      const cache = this.app.metadataCache.getFileCache(md);
      if (cache) {
        const linksToResolve = [
          ...(cache.embeds || []),
          ...(cache.links || [])
        ];
        for (const link of linksToResolve) {
          const decoded = this.safeDecodeUriPath(link.link);
          const linkVariants = decoded !== link.link ? [link.link, decoded] : [link.link];
          for (const linkPath of linkVariants) {
            const dest = this.app.metadataCache.getFirstLinkpathDest(linkPath, md.path);
            if (dest && dest instanceof TFile && imagePathSet.has(dest.path)) {
              referencedPaths.add(dest.path);
              break;
            }
          }
        }
      }
      
      // 方法2：直接读取文件内容匹配（解决缓存延迟问题）
      try {
        const content = await this.app.vault.cachedRead(md);
        this.collectImageRefsFromContent(content, imagePathSet, imageNameToPath, referencedPaths);
      } catch {
        // 读取失败时忽略
      }
    }

    // 隐藏的归档日志（.md.hide）不在 markdown 索引中，但其中引用的图片仍算被引用
    const hiddenMdFiles = this.app.vault.getFiles().filter(f => f.name.endsWith('.md.hide'));
    for (const hidden of hiddenMdFiles) {
      try {
        const content = await this.app.vault.cachedRead(hidden);
        this.collectImageRefsFromContent(content, imagePathSet, imageNameToPath, referencedPaths);
      } catch {
        // 读取失败时忽略
      }
    }

    const unreferenced = imageFiles.filter(f => !referencedPaths.has(f.path));
    if (unreferenced.length === 0) {
      new Notice('未发现未被引用的图片');
      return;
    }

    this.allFiles = unreferenced.map(file => ({ file, selected: false }));
    this.files = [...this.allFiles];
    this.files.sort((a, b) => a.file.path.localeCompare(b.file.path));
    this.renderView();
    new Notice(`发现 ${unreferenced.length} 张未引用图片`);
  }

  /** 从文本内容中提取图片引用（![x](y) 与 ![[x]] 两种格式），命中则加入 referencedPaths */
  private collectImageRefsFromContent(
    content: string,
    imagePathSet: Set<string>,
    imageNameToPath: Map<string, string>,
    referencedPaths: Set<string>
  ) {
    const addRef = (rawLink: string) => {
      const decoded = this.safeDecodeUriPath(rawLink);
      const variants = decoded !== rawLink ? [rawLink, decoded] : [rawLink];
      for (const variant of variants) {
        // 尝试完整路径
        if (imagePathSet.has(variant)) {
          referencedPaths.add(variant);
          return;
        }
        // 尝试仅文件名匹配（简写链接如 ![](xxx.png)）
        const fileName = variant.split('/').pop()?.toLowerCase();
        if (fileName) {
          const hit = imageNameToPath.get(fileName);
          if (hit) {
            referencedPaths.add(hit);
            return;
          }
        }
      }
    };

    // 匹配 ![xxx](yyy) 格式
    const mdLinkRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
    let match;
    while ((match = mdLinkRegex.exec(content)) !== null) {
      addRef(match[1]);
    }

    // 匹配 ![[xxx]] 格式
    const wikiLinkRegex = /!\[\[([^\]]+)\]\]/g;
    while ((match = wikiLinkRegex.exec(content)) !== null) {
      addRef(match[1].split('|')[0]); // 去除别名
    }
  }

  /** 尝试对 URL 编码的路径解码（如 %20 -> 空格），解码失败则返回原串 */
  private safeDecodeUriPath(path: string): string {
    try {
      return decodeURIComponent(path);
    } catch {
      return path;
    }
  }

  private checkImageExists(sourceFile: TFile, imagePath: string, imageFolders: string[]): boolean {
    const tryPath = (path: string) => this.app.vault.getAbstractFileByPath(path);
    const pathsToTry = [imagePath, this.safeDecodeUriPath(imagePath)];
    if (pathsToTry[0] === pathsToTry[1]) pathsToTry.pop();

    // 1. 尝试直接路径（相对于 vault 根目录），先原始再解码
    for (const p of pathsToTry) {
      if (tryPath(p)) return true;
    }

    const fileDir = sourceFile.parent?.path || '';

    // 2. 尝试相对于当前文件的路径
    if (fileDir) {
      for (const p of pathsToTry) {
        const relativePath = `${fileDir}/${p}`;
        if (tryPath(relativePath)) return true;
      }
    }

    // 3. 尝试在配置的图片文件夹中查找
    for (const folder of imageFolders) {
      for (const p of pathsToTry) {
        const folderPath = `${folder}/${p}`;
        if (tryPath(folderPath)) return true;
        if (fileDir) {
          const relativeFolderPath = `${fileDir}/${folder}/${p}`;
          if (tryPath(relativeFolderPath)) return true;
        }
      }
    }

    // 4. 尝试只用文件名在整个 vault 中查找（解码后的文件名）
    const decodedPath = this.safeDecodeUriPath(imagePath);
    const fileName = decodedPath.split('/').pop();
    if (fileName) {
      const allFiles = this.app.vault.getFiles();
      const found = allFiles.find(f => f.name === fileName);
      if (found) return true;
      const encodedFileName = imagePath.split('/').pop();
      if (encodedFileName && encodedFileName !== fileName) {
        const foundEnc = allFiles.find(f => f.name === encodedFileName);
        if (foundEnc) return true;
      }
    }

    return false;
  }

  private async findUntaggedNotes() {
    new Notice('正在查找无标签笔记...');
    
    // 如果有选中的文件夹，只在该文件夹中查找
    const filesToCheck = this.selectedFolder 
      ? this.app.vault.getMarkdownFiles().filter(file => this.selectedFolder instanceof TFolder && this.isFileInFolder(file, this.selectedFolder))
      : this.app.vault.getMarkdownFiles();
    
    const untaggedFiles: TFile[] = [];
    
    for (const file of filesToCheck) {
      try {
        const cache = this.app.metadataCache.getFileCache(file);
        let hasTags = false;
        
        // 检查 frontmatter 中的标签
        if (cache?.frontmatter?.tags) {
          const fmTags: unknown = cache.frontmatter.tags;
          if (Array.isArray(fmTags) && fmTags.length > 0) {
            hasTags = true;
          } else if (typeof fmTags === 'string' && fmTags.trim()) {
            hasTags = true;
          }
        }
        
        // 检查内容中的标签（通过 metadataCache）
        if (!hasTags && cache?.tags && cache.tags.length > 0) {
          hasTags = true;
        }
        
        // 如果还没找到标签，读取文件内容检查是否有 #标签 格式
        if (!hasTags) {
          const content = await this.app.vault.read(file);
          // 匹配 #标签 格式（标签可以在任何位置，包括列表项末尾）
          // 匹配规则：# 后面跟着非空白字符，直到遇到空白、换行或文件结束
          const tagPattern = /#[^\s#[\](){}]+/g;
          const matches = content.match(tagPattern);
          if (matches && matches.length > 0) {
            // 过滤掉可能的误判（比如 markdown 标题 # 开头的）
            const validTags = matches.filter(match => {
              // 检查这个 # 前面是否是行首，如果是则可能是标题
              const index = content.indexOf(match);
              if (index > 0) {
                const charBefore = content[index - 1];
                // 如果前面是空白字符或标点，则是有效标签
                return /[\s\-()[\]（）【】]/.test(charBefore);
              }
              return false; // 行首的 # 可能是标题
            });
            if (validTags.length > 0) {
              hasTags = true;
            }
          }
        }
        
        // 如果没有任何标签，添加到列表
        if (!hasTags) {
          untaggedFiles.push(file);
        }
      } catch (error) {
        console.error(`检查文件标签失败: ${file.path}`, error);
      }
    }
    
    if (untaggedFiles.length === 0) {
      const scope = this.selectedFolder ? `文件夹 "${this.selectedFolder.path}" 中` : '';
      new Notice(`${scope}未发现无标签笔记`);
      return;
    }
    
    // 更新文件列表，只显示无标签的文件
    this.allFiles = untaggedFiles.map(file => ({
      file,
      selected: false
    }));
    this.files = [...this.allFiles];
    
    this.files.sort((a, b) => a.file.path.localeCompare(b.file.path));
    this.renderView();
    
    const scope = this.selectedFolder ? `文件夹 "${this.selectedFolder.path}" 中` : '';
    new Notice(`${scope}发现 ${untaggedFiles.length} 个无标签笔记`);
  }

  private findOrphanNotes() {
    new Notice('正在查找孤立笔记...');
    
    // 如果有选中的文件夹，只在该文件夹中查找
    const filesToCheck = this.selectedFolder 
      ? this.app.vault.getMarkdownFiles().filter(file => this.selectedFolder instanceof TFolder && this.isFileInFolder(file, this.selectedFolder))
      : this.app.vault.getMarkdownFiles();
    
    const allMarkdownFiles = this.app.vault.getMarkdownFiles();
    const orphanFiles: TFile[] = [];
    
    // 构建所有笔记的链接关系图
    const linkedFiles = new Set<string>();
    const filesWithLinks = new Set<string>();
    
    for (const file of allMarkdownFiles) {
      try {
        const cache = this.app.metadataCache.getFileCache(file);
        
        // 检查该文件是否有出链（链接到其他文件）
        const hasOutgoingLinks = cache?.links && cache.links.length > 0;
        const hasEmbeds = cache?.embeds && cache.embeds.length > 0;
        
        if (hasOutgoingLinks || hasEmbeds) {
          filesWithLinks.add(file.path);
          
          // 记录所有被链接的文件
          if (cache.links) {
            for (const link of cache.links) {
              const linkedFile = this.app.metadataCache.getFirstLinkpathDest(link.link, file.path);
              if (linkedFile) {
                linkedFiles.add(linkedFile.path);
              }
            }
          }
          
          if (cache.embeds) {
            for (const embed of cache.embeds) {
              const linkedFile = this.app.metadataCache.getFirstLinkpathDest(embed.link, file.path);
              if (linkedFile) {
                linkedFiles.add(linkedFile.path);
              }
            }
          }
        }
      } catch (error) {
        console.error(`检查文件链接失败: ${file.path}`, error);
      }
    }
    
    // 查找孤立笔记：既没有出链，也没有入链（只在指定范围内查找）
    for (const file of filesToCheck) {
      const hasOutgoingLinks = filesWithLinks.has(file.path);
      const hasIncomingLinks = linkedFiles.has(file.path);
      
      if (!hasOutgoingLinks && !hasIncomingLinks) {
        orphanFiles.push(file);
      }
    }
    
    if (orphanFiles.length === 0) {
      const scope = this.selectedFolder ? `文件夹 "${this.selectedFolder.path}" 中` : '';
      new Notice(`${scope}未发现孤立笔记`);
      return;
    }
    
    // 更新文件列表，只显示孤立的文件
    this.allFiles = orphanFiles.map(file => ({
      file,
      selected: false
    }));
    this.files = [...this.allFiles];
    
    this.files.sort((a, b) => a.file.path.localeCompare(b.file.path));
    this.renderView();
    
    const scope = this.selectedFolder ? `文件夹 "${this.selectedFolder.path}" 中` : '';
    new Notice(`${scope}发现 ${orphanFiles.length} 个孤立笔记`);
  }

  private async findEmptyFiles() {
    new Notice('正在查找空文件...');
    
    // 如果有选中的文件夹，只在该文件夹中查找
    const filesToCheck = this.selectedFolder 
      ? this.app.vault.getMarkdownFiles().filter(file => this.selectedFolder instanceof TFolder && this.isFileInFolder(file, this.selectedFolder))
      : this.app.vault.getMarkdownFiles();
    
    const emptyFiles: TFile[] = [];
    
    for (const file of filesToCheck) {
      try {
        const content = await this.app.vault.read(file);
        
        // 检查是否为空文件
        if (content.trim() === '') {
          emptyFiles.push(file);
          continue;
        }
        
        // 检查是否只有 frontmatter
        const lines = content.split('\n');
        if (lines[0] === '---') {
          // 找到 frontmatter 结束位置
          let endIndex = -1;
          for (let i = 1; i < lines.length; i++) {
            if (lines[i] === '---') {
              endIndex = i;
              break;
            }
          }
          
          if (endIndex > 0) {
            // 检查 frontmatter 后面是否还有内容
            const contentAfterFrontmatter = lines.slice(endIndex + 1).join('\n').trim();
            if (contentAfterFrontmatter === '') {
              emptyFiles.push(file);
            }
          }
        }
      } catch (error) {
        console.error(`检查文件内容失败: ${file.path}`, error);
      }
    }
    
    if (emptyFiles.length === 0) {
      const scope = this.selectedFolder ? `文件夹 "${this.selectedFolder.path}" 中` : '';
      new Notice(`${scope}未发现空文件`);
      return;
    }
    
    // 更新文件列表，只显示空文件
    this.allFiles = emptyFiles.map(file => ({
      file,
      selected: false
    }));
    this.files = [...this.allFiles];
    
    this.files.sort((a, b) => a.file.path.localeCompare(b.file.path));
    this.renderView();
    
    const scope = this.selectedFolder ? `文件夹 "${this.selectedFolder.path}" 中` : '';
    new Notice(`${scope}发现 ${emptyFiles.length} 个空文件`);
  }

  /** Markdown 格式检测：扫描 -> 预览确认 -> 执行修复 */
  private async checkMarkdownFormat() {
    new Notice('正在扫描 Markdown 格式问题...');
    const issues = await this.collectMarkdownFormatIssues();

    if (issues.length === 0) {
      new Notice('未发现 Markdown 格式问题');
      return;
    }

    // 将包含格式问题的笔记显示在文件列表中
    const affectedFiles = Array.from(new Map(issues.map(i => [i.sourceFile.path, i.sourceFile])).values());
    this.allFiles = affectedFiles.map(file => ({ file, selected: false }));
    this.files = [...this.allFiles];
    this.files.sort((a, b) => a.file.path.localeCompare(b.file.path));
    this.renderView();

    new MarkdownFormatIssuesModal(
      this.app,
      issues,
      (fixable) => this.fixMarkdownIssues(fixable),
      () => { this.loadFiles(); }
    ).open();
  }

  /** 扫描所有 Markdown 文件，收集格式问题 */
  private async collectMarkdownFormatIssues(): Promise<MarkdownFormatIssue[]> {
    const allMarkdownFiles = this.app.vault.getMarkdownFiles();
    const issues: MarkdownFormatIssue[] = [];

    for (const file of allMarkdownFiles) {
      try {
        const content = await this.app.vault.cachedRead(file);
        const lines = content.split('\n');

        let inCodeBlock = false;
        let fenceChar = '';
        let unclosedFenceLine = 0;

        const spaceIndentLineNums: number[] = [];

        const lineIssues = new Map<number, Set<MarkdownIssueType>>();
        const addIssue = (lineNum: number, type: MarkdownIssueType) => {
          let set = lineIssues.get(lineNum);
          if (!set) {
            set = new Set();
            lineIssues.set(lineNum, set);
          }
          set.add(type);
        };

        let inFrontmatter = false;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const lineNum = i + 1;

          // Frontmatter（仅文件起始位置）
          if (i === 0 && line.trim() === '---') {
            inFrontmatter = true;
            continue;
          }
          if (inFrontmatter) {
            if (line.trim() === '---') {
              inFrontmatter = false;
            }
            continue;
          }

          // 围栏代码块跟踪
          const fenceMatch = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
          if (fenceMatch) {
            const fc = fenceMatch[1][0];
            if (!inCodeBlock) {
              inCodeBlock = true;
              fenceChar = fc;
              unclosedFenceLine = lineNum;
              if (fenceMatch[2].trim() === '') {
                addIssue(lineNum, 'missing-code-language');
              }
            } else if (fc === fenceChar) {
              inCodeBlock = false;
              fenceChar = '';
            }
            continue;
          }

          if (inCodeBlock) continue;

          // 缩进检测（只检查 -/*/+ 列表项的缩进，标记后必须跟空白才算列表项）
          const isHorizontalRule = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line);
          const listIndentMatch = line.match(/^(\s+)([-*+])\s/);
          if (listIndentMatch && listIndentMatch[1].includes(' ') && !isHorizontalRule) {
            spaceIndentLineNums.push(lineNum);
          }

          // 任务列表缺空格: -[] / -[x] / -[X] / - [X]
          if (/^(\s*)([-*+])\[( |x|X)\]/.test(line) || /^(\s*)([-*+]) \[X\]/.test(line)) {
            addIssue(lineNum, 'task-list-space');
          }

          // 标题缺空格: ##title（2-6 个 # 后无空格，单 # 视为标签跳过）
          if (/^ {0,3}#{2,6}(?=[^\s#])/.test(line)) {
            addIssue(lineNum, 'heading-space');
          }

        }

        // 代码块未闭合
        if (inCodeBlock) {
          addIssue(unclosedFenceLine, 'unclosed-code-block');
        }

        // 列表缩进用了空格，统一改为 tab（2 空格 = 1 tab）
        for (const lineNum of spaceIndentLineNums) {
          addIssue(lineNum, 'mixed-indent');
        }

        // 为每个有问题的行创建 issue
        for (const [lineNum, types] of lineIssues) {
          const originalText = lines[lineNum - 1] || '';
          const fixable = !types.has('missing-code-language') && !types.has('unclosed-code-block');
          const suggestedText = fixable ? this.applyLineFixes(originalText, types) : null;
          issues.push({
            sourceFile: file,
            line: lineNum,
            originalText,
            types: Array.from(types),
            fixable,
            suggestedText,
          });
        }
      } catch (error) {
        console.error(`扫描 Markdown 格式失败: ${file.path}`, error);
      }
    }

    return issues;
  }

  /** 对单行应用所有相关修复 */
  private applyLineFixes(line: string, types: Set<MarkdownIssueType>): string {
    let result = line;
    // 先修缩进（影响前导空白）：空格转 tab（2 空格 = 1 tab，与旧版 2 空格替换一致以便还原）
    if (types.has('mixed-indent')) {
      result = result.replace(/^\s+/, (match: string) => {
        let tabs = 0;
        let spaces = 0;
        for (const ch of match) {
          if (ch === '\t') tabs++;
          else spaces++;
        }
        // 奇数空格向上进位为 1 个 tab，保证修复后不再残留空格缩进，
        // 否则「检测认为有问题、修复后又检出同一行」永远收敛不了
        return '\t'.repeat(tabs + Math.ceil(spaces / 2));
      });
    }
    // 再修内容
    if (types.has('task-list-space')) {
      result = result
        .replace(/^(\s*)([-*+])\[( |x|X)\]/, (_match: string, indent: string, marker: string, box: string) => `${indent}${marker} [${box.toLowerCase()}]`)
        .replace(/^(\s*)([-*+]) \[X\]/, '$1$2 [x]');
    }
    if (types.has('heading-space')) {
      result = result.replace(/^( {0,3})(#{2,6})(?=[^\s#])/, '$1$2 ');
    }
    return result;
  }

  /** 应用 Markdown 格式修复，返回成功修复的文件数 */
  private async fixMarkdownIssues(issues: MarkdownFormatIssue[]): Promise<number> {
    const fixable = issues.filter(i => i.fixable);
    if (fixable.length === 0) return 0;

    // 按文件分组，再按行分组，每个文件只读写一次
    const byFile = new Map<TFile, Map<number, Set<MarkdownIssueType>>>();
    for (const issue of fixable) {
      let lineMap = byFile.get(issue.sourceFile);
      if (!lineMap) {
        lineMap = new Map();
        byFile.set(issue.sourceFile, lineMap);
      }
      for (const type of issue.types) {
        let set = lineMap.get(issue.line);
        if (!set) {
          set = new Set();
          lineMap.set(issue.line, set);
        }
        set.add(type);
      }
    }

    let successCount = 0;
    let failCount = 0;

    for (const [file, lineMap] of byFile) {
      try {
        const content = await this.app.vault.read(file);
        const lines = content.split('\n');
        let changed = false;
        for (const [lineNum, types] of lineMap) {
          if (lineNum >= 1 && lineNum <= lines.length) {
            const fixed = this.applyLineFixes(lines[lineNum - 1], types);
            if (fixed !== lines[lineNum - 1]) {
              lines[lineNum - 1] = fixed;
              changed = true;
            }
          }
        }
        if (changed) {
          const newContent = lines.join('\n');
          await this.app.vault.modify(file, newContent);
          successCount++;
        }
      } catch (error) {
        console.error(`修复 Markdown 格式失败: ${file.path}`, error);
        failCount++;
      }
    }

    new Notice(`Markdown 格式修复完成: 成功 ${successCount} 个文件，失败 ${failCount} 个`);
    return successCount;
  }

  /** 获取笔记内嵌入的图片文件（按出现顺序，去重） */
  private getEmbeddedImages(note: TFile): TFile[] {
    const cache = this.app.metadataCache.getFileCache(note);
    if (!cache?.embeds?.length) return [];

    const imageExtensions = this.plugin.settings.imageExtensions
      .split(',')
      .map(ext => ext.trim().toLowerCase());
    const seen = new Set<string>();
    const result: TFile[] = [];

    for (const embed of cache.embeds) {
      const file = this.app.metadataCache.getFirstLinkpathDest(embed.link, note.path);
      if (!file || !(file instanceof TFile)) continue;
      const ext = file.extension.toLowerCase();
      if (!imageExtensions.includes(ext)) continue;
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      result.push(file);
    }
    return result;
  }

  /**
   * 将名称规范化为适合 Markdown 图片链接的文件名：空格→下划线，其他特殊字符替换为下划线。
   * 很多 Markdown 软件不支持带空格的图片链接。
   */
  private sanitizeFileNameForLink(name: string): string {
    if (!name || typeof name !== 'string') return 'untitled';
    return name
      .replace(/\s+/g, '_')                    // 空格、制表符等 → 下划线
      .replace(/[#%&+=?@[\]\\|<>:"*]/g, '_')  // URL/链接中易出问题的字符 → 下划线
      .replace(/_+/g, '_')                     // 连续多个下划线合并为一个
      .replace(/^_|_$/g, '')                   // 去掉首尾下划线
      .trim() || 'untitled';
  }

  /** 在所有 Markdown 中将旧文件名替换为新文件名（用于相对路径等不一致的链接） */
  private async updateImageLinksInAllMd(oldFileName: string, newFileName: string): Promise<void> {
    if (oldFileName === newFileName) return;
    const escaped = oldFileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'g');
    for (const md of this.app.vault.getMarkdownFiles()) {
      try {
        const content = await this.app.vault.read(md);
        const newContent = content.replace(re, newFileName);
        if (newContent !== content) await this.app.vault.modify(md, newContent);
      } catch {
        // 单文件失败不中断
      }
    }
  }

  /** 将所有 md 中「未规范化的基名-」替换为「规范化基名-」，修复已改名但链接仍为旧名的断链 */
  private async fixBrokenImageLinksWithBaseName(unsanitizedBase: string, sanitizedBase: string): Promise<void> {
    if (unsanitizedBase === sanitizedBase) return;
    const oldPrefix = unsanitizedBase + '-';
    const newPrefix = sanitizedBase + '-';
    for (const md of this.app.vault.getMarkdownFiles()) {
      try {
        const content = await this.app.vault.read(md);
        const newContent = content.split(oldPrefix).join(newPrefix);
        if (newContent !== content) await this.app.vault.modify(md, newContent);
      } catch {
        // 单文件失败不中断
      }
    }
  }

  /** 获取文件夹中已占用的「基名-数字」编号，用于避免重名 */
  private getUsedNumberSuffixes(folderPath: string, baseName: string, ext: string): Set<number> {
    const used = new Set<number>();
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!folder || !(folder instanceof TFolder)) return used;
    const prefix = baseName + '-';
    const suffix = '.' + ext;
    for (const child of folder.children) {
      if (!(child instanceof TFile)) continue;
      if (!child.name.startsWith(prefix) || !child.name.endsWith(suffix)) continue;
      const numStr = child.name.slice(prefix.length, child.name.length - suffix.length);
      const num = parseInt(numStr, 10);
      if (numStr === String(num) && num >= 1 && num <= 999) used.add(num);
    }
    return used;
  }

  /** 将选中笔记内的图片重命名为「笔记名-001」「笔记名-002」等，并更新引用 */
  private async renameImagesToNoteName() {
    const selected = this.getSelectedFiles();
    if (selected.length === 0) {
      new Notice('请先选择要处理的笔记');
      return;
    }

    const noteFiles = selected.filter(f => f.extension === 'md');
    if (noteFiles.length === 0) {
      new Notice('选中的文件中没有笔记（.md）');
      return;
    }

    let totalRenamed = 0;
    let totalSkipped = 0;
    let totalFailed = 0;

    for (const note of noteFiles) {
      const images = this.getEmbeddedImages(note);
      // 规范化基名：空格→下划线、特殊字符替换，便于 Markdown 图片链接兼容
      const baseName = this.sanitizeFileNameForLink(note.basename);

      if (images.length === 0) {
        // 无已解析的图片（可能链接已断），仍尝试修复「旧基名-」→「新基名-」的引用
        await this.fixBrokenImageLinksWithBaseName(note.basename, baseName);
        continue;
      }

      const usedNumbersByFolder: Record<string, Set<number>> = {};

      for (const img of images) {
        const ext = img.extension;
        const imgFolderPath = img.parent?.path ?? '';
        const key = imgFolderPath + '|' + ext;
        if (!usedNumbersByFolder[key]) {
          usedNumbersByFolder[key] = this.getUsedNumberSuffixes(imgFolderPath, baseName, ext);
        }
        const usedNumbers = usedNumbersByFolder[key];

        let num = 1;
        while (usedNumbers.has(num)) num++;
        usedNumbers.add(num);
        const newName = `${baseName}-${pad3(num)}.${ext}`;
        const newPath = imgFolderPath ? `${imgFolderPath}/${newName}` : newName;

        if (img.name === newName) {
          totalSkipped++;
          // 文件已改名，但链接可能仍是旧名（如相对路径 ../assets/旧 名.png），需单独更新
          const oldNameForLink = `${note.basename}-${pad3(num)}.${ext}`;
          if (oldNameForLink !== newName) {
            await this.updateImageLinksInAllMd(oldNameForLink, newName);
          }
          continue;
        }

        const existing = this.app.vault.getAbstractFileByPath(newPath);
        if (existing && existing !== img) {
          totalFailed++;
          new Notice(`跳过 ${img.path}：目标名称已被占用 ${newPath}`);
          continue;
        }

        try {
          const oldPathInLink = img.path;

          await this.app.fileManager.renameFile(img, newPath);
          totalRenamed++;

          const newFile = this.app.vault.getAbstractFileByPath(newPath);
          if (!(newFile instanceof TFile)) continue;

          const allMd = this.app.vault.getMarkdownFiles();
          for (const md of allMd) {
            try {
              let content = await this.app.vault.read(md);
              let changed = false;
              const oldPathEscaped = oldPathInLink.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const newPathForLink = newFile.path;

              const wikilinkRegex = new RegExp(`(!?\\[\\[)${oldPathEscaped}(\\|[^\\]]*)?\\]\\]`, 'g');
              let newContent = content.replace(wikilinkRegex, (_, prefix, opt) => prefix + newPathForLink + (opt || '') + ']]');
              if (newContent !== content) {
                content = newContent;
                changed = true;
              }
              const mdLinkRegex = new RegExp(`(\\]\\()(${oldPathEscaped})([^)]*\\))`, 'g');
              newContent = content.replace(mdLinkRegex, (_, before, _path, after) => before + newPathForLink + after);
              if (newContent !== content) {
                content = newContent;
                changed = true;
              }
              if (changed) await this.app.vault.modify(md, content);
            } catch {
              // 单文件更新失败不中断
            }
          }
          // 相对路径等：按“文件名”替换，确保 ](../assets/旧 名.png) 也会被更新
          await this.updateImageLinksInAllMd(img.name, newName);
        } catch (err) {
          totalFailed++;
          console.error(`重命名图片失败: ${img.path}`, err);
          new Notice(`重命名失败: ${img.path}`);
        }
      }
      // 修复已改名但链接仍为旧名（含空格）的断链，如 ](../assets/旧 名.png)
      await this.fixBrokenImageLinksWithBaseName(note.basename, baseName);
    }

    new Notice(`图片重命名完成: 成功 ${totalRenamed}，跳过 ${totalSkipped}，失败 ${totalFailed}`);
    this.loadFiles();
  }

  /** 日文件 → 月文件：将 yyyy-mm-dd.md 合并为 yyyy-mm.md（跳过当前月） */
  private async mergeJournalsToMonth() {
    const dir = this.plugin.settings.journalsFolder?.trim() || 'journals';
    const folder = this.app.vault.getAbstractFileByPath(dir);
    if (!folder || !(folder instanceof TFolder)) {
      new Notice(`日记文件夹不存在: ${dir}`);
      return;
    }
    const dailyPattern = /^(\d{4})-(\d{2})-(\d{2})\.md$/;
    const sectionHeader = /^(?:- )?## (\d{4}-\d{2}-\d{2})\s*$/gm;

    const now = new Date();
    const currentYm = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;

    const monthEntries: Record<string, { dateStr: string; content: string }[]> = {};
    const monthDeletes: Record<string, TFile[]> = {};

    for (const child of folder.children) {
      if (!(child instanceof TFile)) continue;
      const m = child.name.match(dailyPattern);
      if (!m) continue;
      const dateStr = `${m[1]}-${m[2]}-${m[3]}`;
      const yearMonth = dateStr.slice(0, 7);
      if (yearMonth === currentYm) continue;
      let raw: string;
      try {
        raw = (await this.app.vault.read(child)).trim();
        if (!raw) continue;
      } catch {
        continue;
      }
      if (!monthEntries[yearMonth]) {
        monthEntries[yearMonth] = [];
        monthDeletes[yearMonth] = [];
      }
      monthEntries[yearMonth].push({ dateStr, content: raw });
      monthDeletes[yearMonth].push(child);
    }

    let totalMerged = 0;
    let totalDeleted = 0;
    for (const month of Object.keys(monthEntries).sort()) {
      const outputPath = dir ? `${dir}/${month}.md` : `${month}.md`;
      // 已隐藏的归档（.md.hide）存在时直接合并进隐藏文件，不再创建可见的月文件
      let targetFile = this.app.vault.getAbstractFileByPath(outputPath);
      if (!(targetFile instanceof TFile)) {
        const hideFile = this.app.vault.getAbstractFileByPath(`${outputPath}.hide`);
        if (hideFile instanceof TFile) targetFile = hideFile;
      }
      let existing: Record<string, string> = {};
      if (targetFile instanceof TFile) {
        try {
          const content = await this.app.vault.read(targetFile);
          const parts = content.split(sectionHeader);
          for (let i = 1; i + 1 < parts.length; i += 2) {
            const d = parts[i].trim();
            existing[d] = parts[i + 1].trim();
          }
        } catch {
          /* ignore */
        }
      }
      for (const { dateStr, content } of monthEntries[month]) {
        // 逐行去重合并，避免 iCloud 同步回来的旧副本覆盖已有内容
        existing[dateStr] = existing[dateStr]
          ? mergeLinesWithoutDuplicates(existing[dateStr], content).merged
          : content;
      }
      const entries = recordEntries(existing)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([d, c]) => `## ${d}\n\n${c}\n\n`);
      const body = entries.join('\n');
      if (targetFile instanceof TFile) {
        await this.app.vault.modify(targetFile, body);
      } else {
        await this.app.vault.create(outputPath, body);
      }
      totalMerged++;
      for (const f of monthDeletes[month]) {
        await this.app.fileManager.trashFile(f);
        totalDeleted++;
      }
    }
    new Notice(`一键归档完成: 合并 ${totalMerged} 个月份，删除 ${totalDeleted} 个日文件`);
    this.loadFiles();
  }



  /** 月文件 → 日文件：将 yyyy-mm.md 按 ## yyyy-mm-dd 拆成 yyyy-mm-dd.md */
  private async monthToDaily() {
    const dir = this.plugin.settings.journalsFolder?.trim() || 'journals';
    const folder = this.app.vault.getAbstractFileByPath(dir);
    if (!folder || !(folder instanceof TFolder)) {
      new Notice(`日记文件夹不存在: ${dir}`);
      return;
    }
    const monthPattern = /^(\d{4})-(\d{2})\.md$/;
    const sectionHeader = /^(?:- )?## (\d{4}-\d{2}-\d{2})\s*$/gm;

    const monthFiles: TFile[] = [];
    for (const child of folder.children) {
      if (!(child instanceof TFile)) continue;
      if (monthPattern.test(child.name)) monthFiles.push(child);
    }
    monthFiles.sort((a, b) => a.name.localeCompare(b.name));

    let totalRestored = 0;
    for (const mf of monthFiles) {
      const content = await this.app.vault.read(mf);
      const parts = content.split(sectionHeader);
      const entries: { dateStr: string; block: string }[] = [];
      for (let i = 1; i + 1 < parts.length; i += 2) {
        const dateStr = parts[i].trim();
        const block = parts[i + 1].trim();
        if (!block) continue;
        entries.push({ dateStr, block });
      }
      if (entries.length === 0) {
        new Notice(`跳过 ${mf.path}：未找到日期段落`);
        continue;
      }
      for (const { dateStr, block } of entries) {
        const outPath = dir ? `${dir}/${dateStr}.md` : `${dateStr}.md`;
        const exists = this.app.vault.getAbstractFileByPath(outPath);
        if (exists && exists instanceof TFile) {
          await this.app.vault.modify(exists, block);
        } else {
          await this.app.vault.create(outPath, block);
        }
        totalRestored++;
      }
      await this.app.fileManager.trashFile(mf);
    }
    new Notice(`一键还原完成: 还原 ${totalRestored} 个日文件`);
    this.loadFiles();
  }

  /** 隐藏归档日志：将 journals 下 yyyy-MM.md（当月除外）改名为 yyyy-MM.md.hide，Obsidian 不再索引 */
  private async hideArchivedJournals() {
    const dir = this.plugin.settings.journalsFolder?.trim() || 'journals';
    const folder = this.app.vault.getAbstractFileByPath(dir);
    if (!folder || !(folder instanceof TFolder)) {
      new Notice(`日记文件夹不存在: ${dir}`);
      return;
    }
    const now = new Date();
    const currentYm = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
    const monthPattern = /^(\d{4})-(\d{2})\.md$/;
    const targets: TFile[] = [];
    for (const child of folder.children) {
      if (!(child instanceof TFile)) continue;
      const m = child.name.match(monthPattern);
      if (!m) continue;
      if (`${m[1]}-${m[2]}` === currentYm) continue;
      targets.push(child);
    }
    if (targets.length === 0) {
      new Notice('没有可隐藏的归档日志');
      return;
    }
    let hidden = 0;
    let mergedIntoHide = 0;
    let failed = 0;
    for (const file of targets) {
      const hidePath = `${file.path}.hide`;
      try {
        const existingHide = this.app.vault.getAbstractFileByPath(hidePath);
        if (existingHide instanceof TFile) {
          // 同名 .hide 已存在（iCloud 可能同步回了旧副本）：逐行去重合并后删除可见文件
          const hideContent = await this.app.vault.read(existingHide);
          const visibleContent = await this.app.vault.read(file);
          // iCloud 占位文件（未下载完成）会读到空内容，此时删除可见文件会造成数据丢失，必须跳过
          if (visibleContent.trim().length === 0) {
            failed++;
            console.warn(`归档文件内容为空，跳过隐藏: ${file.path}`);
            continue;
          }
          await this.app.vault.modify(existingHide, mergeMonthFileContents(hideContent, visibleContent));
          await this.app.fileManager.trashFile(file);
          mergedIntoHide++;
          continue;
        }
        await this.app.vault.rename(file, hidePath);
        hidden++;
      } catch (error) {
        failed++;
        console.error(`隐藏归档日志失败: ${file.path}`, error);
      }
    }
    const summaryParts = [`已隐藏 ${hidden} 个月归档文件（后缀改为 .md.hide）`];
    if (mergedIntoHide > 0) summaryParts.push(`合并 ${mergedIntoHide} 个到已有隐藏文件`);
    if (failed > 0) summaryParts.push(`失败 ${failed} 个`);
    new Notice(summaryParts.join('，'));
    this.loadFiles();
  }

  /** 展示归档日志：将 journals 下所有 yyyy-MM.md.hide 改回 yyyy-MM.md */
  private async showArchivedJournals() {
    const dir = this.plugin.settings.journalsFolder?.trim() || 'journals';
    const folder = this.app.vault.getAbstractFileByPath(dir);
    if (!folder || !(folder instanceof TFolder)) {
      new Notice(`日记文件夹不存在: ${dir}`);
      return;
    }
    const hidePattern = /^(\d{4})-(\d{2})\.md\.hide$/;
    const targets: TFile[] = [];
    for (const child of folder.children) {
      if (!(child instanceof TFile)) continue;
      if (hidePattern.test(child.name)) targets.push(child);
    }
    if (targets.length === 0) {
      new Notice('没有已隐藏的归档日志');
      return;
    }
    let restored = 0;
    let skipped = 0;
    for (const file of targets) {
      const newPath = file.path.slice(0, -'.hide'.length);
      if (this.app.vault.getAbstractFileByPath(newPath)) {
        skipped++;
        continue;
      }
      await this.app.vault.rename(file, newPath);
      restored++;
    }
    const suffix = skipped > 0 ? `，跳过 ${skipped} 个（同名 .md 已存在）` : '';
    new Notice(`已恢复 ${restored} 个月归档文件${suffix}`);
    this.loadFiles();
  }

  /** 流程图转导出版：渲染 mermaid 代码块为图片，生成新 md（去掉代码块，仅保留图片引用），便于复制到其他网站 */
  private async mermaidToExportMd() {
    const selected = this.getSelectedFiles();
    const mdFiles = selected.filter((f) => f.extension === 'md');
    if (mdFiles.length === 0) {
      new Notice('请先选择包含 Mermaid 流程图的笔记');
      return;
    }

    const assetsFolder = (this.plugin.settings.imageFolders?.split(',')[0]?.trim() || 'assets').replace(/\/$/, '');
    const MERMAID_BLOCK_RE = /^```mermaid\s*\n([\s\S]*?)```\s*$/gm;

    let renderId = 0;
    let mermaid: MermaidApi;
    try {
      const mod = (await import('mermaid')) as { default: MermaidApi };
      mermaid = mod.default;
      mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' });
    } catch {
      new Notice('Mermaid 加载失败');
      return;
    }

    let totalExported = 0;
    for (const note of mdFiles) {
      let content: string;
      try {
        content = await this.app.vault.read(note);
      } catch {
        new Notice(`无法读取 ${note.path}`);
        continue;
      }

      const blocks: { fullMatch: string; code: string; index: number }[] = [];
      let m: RegExpExecArray | null;
      MERMAID_BLOCK_RE.lastIndex = 0;
      while ((m = MERMAID_BLOCK_RE.exec(content)) !== null) {
        blocks.push({ fullMatch: m[0], code: m[1].trim(), index: m.index });
      }
      if (blocks.length === 0) {
        new Notice(`${note.basename}：未找到 mermaid 代码块`);
        continue;
      }

      const replacements: { from: string; to: string }[] = [];
      for (let i = 0; i < blocks.length; i++) {
        const { fullMatch, code } = blocks[i];
        if (!code) continue;
        const id = `mermaid-${Date.now()}-${renderId++}`;
        let svg: string;
        try {
          const result = await mermaid.render(id, code);
          svg = result.svg;
        } catch (err) {
          new Notice(`Mermaid 渲染失败 (第 ${i + 1} 个): ${String(err)}`);
          continue;
        }

        const baseName = note.basename.replace(/[#%&+=?@[\]\\|<>:"*]/g, '_');
        const folder = this.app.vault.getAbstractFileByPath(assetsFolder);
        if (!folder || !(folder instanceof TFolder)) {
          try {
            await this.app.vault.createFolder(assetsFolder);
          } catch {
            new Notice(`无法创建文件夹 ${assetsFolder}`);
            continue;
          }
        }

        let imgPath: string;
        try {
          const pngBuffer = await this.svgToPng(svg);
          const imgName = `${baseName}-mermaid-${pad3(i + 1)}.png`;
          imgPath = assetsFolder ? `${assetsFolder}/${imgName}` : imgName;
          await this.app.vault.adapter.writeBinary(imgPath, pngBuffer);
        } catch {
          // Canvas taint 时回退到 SVG
          const imgName = `${baseName}-mermaid-${pad3(i + 1)}.svg`;
          imgPath = assetsFolder ? `${assetsFolder}/${imgName}` : imgName;
          try {
            await this.app.vault.adapter.write(imgPath, svg);
          } catch {
            new Notice(`保存图片失败 ${imgPath}`);
            continue;
          }
        }

        const outDir = note.parent?.path ?? '';
        const pathForLink = this.getRelativePath(outDir, imgPath);
        const imgLink = `\n![](${pathForLink})\n`;
        replacements.push({ from: fullMatch, to: imgLink });
      }

      if (replacements.length === 0) continue;

      let newContent = content;
      for (const { from, to } of replacements) {
        newContent = newContent.replace(from, to);
      }

      const outDir = note.parent?.path ?? '';
      const outName = `${note.basename}-导出版.md`;
      const outPath = outDir ? `${outDir}/${outName}` : outName;
      const exists = this.app.vault.getAbstractFileByPath(outPath);
      try {
        if (exists && exists instanceof TFile) {
          await this.app.vault.modify(exists, newContent);
        } else {
          await this.app.vault.create(outPath, newContent);
        }
        totalExported++;
      } catch {
        new Notice(`创建导出版失败 ${outPath}`);
      }
    }
    new Notice(`流程图转导出版完成: ${totalExported} 个文件`);
    this.loadFiles();
  }

  /** SVG → PNG，使用 data URL 加载以减少 Canvas taint 风险 */
  private svgToPng(svg: string): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const encoded = 'data:image/svg+xml;base64,' + btoa(Array.from(new TextEncoder().encode(svg), b => String.fromCharCode(b)).join(''));
      const img = activeDocument.createEl('img');
      img.onload = () => {
        const canvas = activeDocument.createEl('canvas');
        const w = img.naturalWidth || 800, h = img.naturalHeight || 600;
        const minSide = 1200;
        const scale = Math.max(1, minSide / Math.max(w, h));
        canvas.width = Math.ceil(w * scale);
        canvas.height = Math.ceil(h * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('无法获取 canvas 上下文'));
          return;
        }
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (b) => {
            if (!b) {
              reject(new Error('toBlob 失败'));
              return;
            }
            b.arrayBuffer().then(resolve).catch(reject);
          },
          'image/png',
          0.95
        );
      };
      img.onerror = () => reject(new Error('SVG 加载失败'));
      img.src = encoded;
    });
  }

  /** 计算从 fromPath 到 toPath 的相对路径 */
  private getRelativePath(fromDir: string, toPath: string): string {
    const fromParts = fromDir ? fromDir.split('/') : [];
    const toParts = toPath.split('/');
    
    // 找到共同前缀长度
    let commonLength = 0;
    while (commonLength < fromParts.length && commonLength < toParts.length - 1 &&
           fromParts[commonLength] === toParts[commonLength]) {
      commonLength++;
    }
    
    // 计算需要回退的层数
    const backSteps = fromParts.length - commonLength;
    const relativeParts: string[] = [];
    
    // 添加 .. 回退
    for (let i = 0; i < backSteps; i++) {
      relativeParts.push('..');
    }
    
    // 添加目标路径的剩余部分
    for (let i = commonLength; i < toParts.length; i++) {
      relativeParts.push(toParts[i]);
    }
    
    return relativeParts.join('/');
  }

  /** 
   * 按优先级查找图片文件
   * 优先级：同级目录 → 同级 assets → 同级 attachments → 根目录 assets → 根目录 attachments → 全局查找
   */
  private findImageFile(fileName: string, noteDir: string, notePath: string): TFile | null {
    const decoded = this.safeDecodeUriPath(fileName);
    const namesToTry = decoded !== fileName ? [fileName, decoded] : [fileName];
    
    // 常用图片文件夹名称
    const commonFolders = ['assets', 'attachments', 'images', 'img', 'pics', 'media'];
    
    for (const name of namesToTry) {
      // 1. 同级目录
      const sameDirPath = noteDir ? `${noteDir}/${name}` : name;
      const sameDirFile = this.app.vault.getAbstractFileByPath(sameDirPath);
      if (sameDirFile && sameDirFile instanceof TFile) return sameDirFile;
      
      // 2. 同级目录下的常用文件夹
      for (const folder of commonFolders) {
        const subFolderPath = noteDir ? `${noteDir}/${folder}/${name}` : `${folder}/${name}`;
        const subFolderFile = this.app.vault.getAbstractFileByPath(subFolderPath);
        if (subFolderFile && subFolderFile instanceof TFile) return subFolderFile;
      }
      
      // 3. 根目录下的常用文件夹
      for (const folder of commonFolders) {
        const rootFolderPath = `${folder}/${name}`;
        const rootFolderFile = this.app.vault.getAbstractFileByPath(rootFolderPath);
        if (rootFolderFile && rootFolderFile instanceof TFile) return rootFolderFile;
      }
    }
    
    // 4. 使用 metadataCache 全局查找（兜底）
    for (const name of namesToTry) {
      const file = this.app.metadataCache.getFirstLinkpathDest(name, notePath);
      if (file && file instanceof TFile) return file;
    }
    
    return null;
  }

  /** 将选中笔记中的图片链接转换为相对路径（兼容 Typora 等编辑器） */
  private async convertImageLinksToRelativePath() {
    const selected = this.getSelectedFiles();
    if (selected.length === 0) {
      new Notice('请先选择要处理的笔记');
      return;
    }

    const noteFiles = selected.filter(f => f.extension === 'md');
    if (noteFiles.length === 0) {
      new Notice('选中的文件中没有笔记（.md）');
      return;
    }

    let totalConverted = 0;
    let totalNotes = 0;

    for (const note of noteFiles) {
      try {
        let content = await this.app.vault.read(note);
        let changed = false;
        const noteDir = note.parent?.path || '';

        // 处理 ![[xxx]] 格式（Obsidian wiki 风格）
        content = content.replace(/!\[\[([^\]|]+)(\|[^\]]*)?\]\]/g, (match: string, linkPath: string, _displayPart: string) => {
          // 提取文件名（可能包含路径）
          const fileName = linkPath.split('/').pop() || linkPath;
          const file = this.findImageFile(fileName, noteDir, note.path);
          if (file) {
            const relativePath = this.getRelativePath(noteDir, file.path);
            // 如果链接已经是相对路径，跳过
            if (linkPath === relativePath) return match;
            changed = true;
            totalConverted++;
            return `![](${relativePath})`;
          }
          return match;
        });

        // 处理 ![xxx](yyy) 格式（Markdown 风格）
        content = content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match: string, alt: string, linkPath: string) => {
          // 跳过已经是相对路径的（包含 ../ 或 ./）
          if (linkPath.startsWith('../') || linkPath.startsWith('./')) return match;
          // 跳过网络链接
          if (linkPath.startsWith('http://') || linkPath.startsWith('https://')) return match;
          
          // 提取文件名
          const fileName = linkPath.split('/').pop() || linkPath;
          const file = this.findImageFile(fileName, noteDir, note.path);
          if (file) {
            const relativePath = this.getRelativePath(noteDir, file.path);
            if (linkPath === relativePath) return match;
            changed = true;
            totalConverted++;
            return `![${alt}](${relativePath})`;
          }
          return match;
        });

        if (changed) {
          await this.app.vault.modify(note, content);
          totalNotes++;
        }
      } catch (err) {
        console.error(`转换图片链接失败: ${note.path}`, err);
      }
    }

    new Notice(`图片转相对路径完成: ${totalNotes} 个笔记，${totalConverted} 个链接`);
  }

  /** 将选中笔记中的图片链接转换为最简路径（仅文件名） */
  private async convertImageLinksToSimplePath() {
    const selected = this.getSelectedFiles();
    if (selected.length === 0) {
      new Notice('请先选择要处理的笔记');
      return;
    }

    const noteFiles = selected.filter(f => f.extension === 'md');
    if (noteFiles.length === 0) {
      new Notice('选中的文件中没有笔记（.md）');
      return;
    }

    let totalConverted = 0;
    let totalNotes = 0;

    for (const note of noteFiles) {
      try {
        let content = await this.app.vault.read(note);
        let changed = false;
        const noteDir = note.parent?.path || '';

        // 处理 ![[xxx]] 格式 - 已经是最简路径，跳过
        // 处理 ![xxx](yyy) 格式
        content = content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match: string, alt: string, linkPath: string) => {
          // 跳过网络链接
          if (linkPath.startsWith('http://') || linkPath.startsWith('https://')) return match;
          
          // 提取文件名
          const fileName = linkPath.split('/').pop();
          if (!fileName) return match;
          
          // 如果已经是最简路径（不包含路径分隔符），跳过
          if (!linkPath.includes('/')) return match;
          
          // 使用优先级查找验证文件是否存在
          const file = this.findImageFile(fileName, noteDir, note.path);
          if (file) {
            changed = true;
            totalConverted++;
            return `![${alt}](${file.name})`;
          }
          return match;
        });

        if (changed) {
          await this.app.vault.modify(note, content);
          totalNotes++;
        }
      } catch (err) {
        console.error(`转换图片链接失败: ${note.path}`, err);
      }
    }

    new Notice(`图片转最简路径完成: ${totalNotes} 个笔记，${totalConverted} 个链接`);
  }
}

class BatchFileManagerSettingTab extends PluginSettingTab {
  plugin: BatchFileManagerPlugin;

  constructor(app: App, plugin: BatchFileManagerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // 经典命令式渲染：覆盖 display()，绕开 1.13 声明式 getSettingDefinitions 容器的布局问题（同 keyword-notes-editor 1.0.22 回退先例）。
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    try {
      this.buildSettings(containerEl);
    } catch (e) {
      console.error('File Commander settings render failed', e);
      const errEl = containerEl.createDiv();
      errEl.createEl('p', { text: '设置渲染失败：' });
      errEl.createEl('pre', { text: e instanceof Error ? (e.stack || e.message) : String(e) });
    }
  }

  private buildSettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('标签').setHeading();

    // 标签设置
    new Setting(containerEl).setName('标签').setHeading();

    new Setting(containerEl)
      .setName('默认标签')
      .setDesc('批量打标签时的默认值（多个标签用空格分隔）')
      .addText(text => text
        .setPlaceholder('#todo #important')
        .setValue(this.plugin.settings.defaultTags)
        .onChange(async (value) => {
          this.plugin.settings.defaultTags = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('标签位置')
      .setDesc('选择标签添加的位置')
      .addDropdown(dropdown => dropdown
        .addOption('start', '文件开头')
        .addOption('end', '文件末尾')
        .addOption('frontmatter', 'Frontmatter')
        .setValue(this.plugin.settings.tagPosition)
        .onChange(async (value) => {
          this.plugin.settings.tagPosition = value as 'start' | 'end' | 'frontmatter';
          await this.plugin.saveSettings();
        }));

    // 图片扫描设置
    new Setting(containerEl).setName('图片扫描').setHeading();

    new Setting(containerEl)
      .setName('扫描外部图片')
      .setDesc('是否检查外部链接（HTTP/HTTPS）的图片')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.scanExternalImages)
        .onChange(async (value) => {
          this.plugin.settings.scanExternalImages = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('图片扩展名')
      .setDesc('要扫描的图片文件扩展名（用逗号分隔）')
      .addText(text => text
        .setPlaceholder('PNG, JPG, JPEG, GIF, SVG')
        .setValue(this.plugin.settings.imageExtensions)
        .onChange(async (value) => {
          this.plugin.settings.imageExtensions = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('图片文件夹')
      .setDesc('图片存储的文件夹路径（多个用逗号分隔，例如: assets,attachments）')
      .addText(text => text
        .setPlaceholder('Assets')
        .setValue(this.plugin.settings.imageFolders)
        .onChange(async (value) => {
          this.plugin.settings.imageFolders = value;
          await this.plugin.saveSettings();
        }));

    // 日记归档设置
    new Setting(containerEl).setName('日记归档').setHeading();

    new Setting(containerEl)
      .setName('日记文件夹')
      .setDesc('日/月日记所在文件夹（如 journals），用于「一键归档日志」「一键还原」「合并 iCloud 冲突文件」')
      .addText(text => text
        .setPlaceholder('Journals')
        .setValue(this.plugin.settings.journalsFolder)
        .onChange(async (value) => {
          this.plugin.settings.journalsFolder = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('启动时自动迁移昨日任务')
      .setDesc('插件启动 15 秒后（等待 iCloud/Git 同步稳定）自动将昨天日记中未完成的任务迁移到今天')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoMigrateYesterdayTasks)
        .onChange(async (value) => {
          this.plugin.settings.autoMigrateYesterdayTasks = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('启动时自动合并 iCloud 冲突文件')
      .setDesc('插件启动 15 秒后（等待 iCloud/Git 同步稳定）在日记文件夹中自动合并 iCloud 冲突副本（如 2026-07-02 2.md），逐行去重后追加到原文件')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoMergeIcloudConflictFiles)
        .onChange(async (value) => {
          this.plugin.settings.autoMergeIcloudConflictFiles = value;
          await this.plugin.saveSettings();
        }));

    const donateSection = containerEl.createDiv({ cls: 'plugin-donate-section' });
    new Setting(donateSection).setName('打赏').setHeading();
    donateSection.createEl('p', { text: '如果这个插件帮助了你，欢迎请作者喝杯咖啡 ☕', cls: 'plugin-donate-desc' });
    const imgWrap = donateSection.createDiv({ cls: 'plugin-donate-qr' });
    const donateImg = imgWrap.createEl('img', { attr: { src: "https://raw.githubusercontent.com/fengshuzi/images/main/wechat-donate.jpg", alt: '微信打赏' }, cls: 'plugin-donate-img' });
    donateImg.addEventListener('click', () => {
        const overlay = document.body.createDiv({ cls: 'plugin-donate-lightbox' });
        overlay.createEl('img', { attr: { src: "https://raw.githubusercontent.com/fengshuzi/images/main/wechat-donate.jpg", alt: '微信打赏' }, cls: 'plugin-donate-lightbox-img' });
        overlay.addEventListener('click', () => overlay.remove());
    });
    imgWrap.createEl('p', { text: '微信扫码', cls: 'plugin-donate-label' });
  }
}

export default class BatchFileManagerPlugin extends Plugin {
  settings: BatchFileManagerSettings;

  async onload() {
    await this.loadSettings();

    // 注册视图
    this.registerView(
      VIEW_TYPE_BATCH_MANAGER,
      (leaf) => new BatchFileManagerView(leaf, this)
    );

    // 添加设置标签页
    this.addSettingTab(new BatchFileManagerSettingTab(this.app, this));

    // 添加命令
    this.addCommand({
      id: 'open',
      name: '打开批量文件管理器',
      callback: () => {
        void this.activateView();
      }
    });

    // 在工作区准备好后，在左侧边栏添加视图
    this.app.workspace.onLayoutReady(() => {
      this.initLeaf();
      this.scheduleStartupJournalTasks();
    });
  }

  onunload() {
    // cleanup handled by Obsidian
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<BatchFileManagerSettings>);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  initLeaf(): void {
    if (this.app.workspace.getLeavesOfType(VIEW_TYPE_BATCH_MANAGER).length) {
      return;
    }
    void this.app.workspace.getLeftLeaf(false).setViewState({
      type: VIEW_TYPE_BATCH_MANAGER,
    });
  }

  /** 延迟调度启动日记任务：15 秒后再合并/迁移，避免与 iCloud / Git 的启动同步互相冲突 */
  private scheduleStartupJournalTasks(): void {
    if (!this.settings.autoMergeIcloudConflictFiles && !this.settings.autoMigrateYesterdayTasks) {
      return;
    }
    const timer = window.setTimeout(() => {
      void this.runStartupJournalTasks();
    }, STARTUP_JOURNAL_TASKS_DELAY_MS);
    this.register(() => window.clearTimeout(timer));
  }

  private async runStartupJournalTasks(): Promise<void> {
    if (this.settings.autoMergeIcloudConflictFiles) {
      await this.mergeIcloudConflictFiles(false);
    }
    if (this.settings.autoMigrateYesterdayTasks) {
      await this.migrateYesterdayTasks(false);
    }
  }

  /** 合并 iCloud 冲突副本（如 `2026-07-02 2.md`）到原文件，逐行去重后追加 */
  async mergeIcloudConflictFiles(showNotices = true): Promise<void> {
    const dir = this.settings.journalsFolder?.trim() || 'journals';
    const folder = this.app.vault.getAbstractFileByPath(dir);
    if (!folder || !(folder instanceof TFolder)) {
      if (showNotices) new Notice(`日记文件夹不存在: ${dir}`);
      return;
    }

    const conflicts: { file: TFile; baseName: string; num: number }[] = [];
    let pendingSync = 0;
    for (const child of folder.children) {
      if (!(child instanceof TFile)) continue;
      const match = child.name.match(ICLOUD_CONFLICT_FILE_PATTERN);
      if (!match) continue;
      // 创建/最后编辑不足 15 秒的副本可能仍在 iCloud 下载或同步写入中，本轮跳过
      const ageMs = Date.now() - Math.max(child.stat.ctime, child.stat.mtime);
      if (ageMs < ICLOUD_CONFLICT_STABLE_MS) {
        pendingSync++;
        console.warn(`冲突文件创建/编辑不足 ${ICLOUD_CONFLICT_STABLE_MS / 1000} 秒，可能仍在同步，跳过: ${child.path}`);
        continue;
      }
      conflicts.push({
        file: child,
        baseName: match[1],
        num: Number.parseInt(match[2], 10),
      });
    }

    if (conflicts.length === 0) {
      if (showNotices) {
        new Notice(pendingSync > 0
          ? `发现 ${pendingSync} 个刚同步的冲突文件，等待其稳定（15 秒）后下次再合并`
          : '未发现 iCloud 冲突文件');
      }
      return;
    }

    conflicts.sort((a, b) => {
      const baseCmp = a.baseName.localeCompare(b.baseName);
      if (baseCmp !== 0) return baseCmp;
      return a.num - b.num;
    });

    let processed = 0;
    let addedLines = 0;
    let skipped = 0;

    for (const { file, baseName } of conflicts) {
      const basePath = dir ? `${dir}/${baseName}.md` : `${baseName}.md`;
      const baseFile = this.app.vault.getAbstractFileByPath(basePath);
      if (!baseFile || !(baseFile instanceof TFile)) {
        skipped++;
        continue;
      }

      let baseContent: string;
      let conflictContent: string;
      try {
        baseContent = await this.app.vault.read(baseFile);
        conflictContent = await this.app.vault.read(file);
      } catch (error) {
        console.error(`读取冲突文件失败: ${file.path}`, error);
        skipped++;
        continue;
      }

      // iCloud 占位文件（未下载完成）会读到空内容，此时删除冲突副本会造成数据丢失，必须跳过
      if (conflictContent.trim().length === 0) {
        console.warn(`冲突文件内容为空，跳过合并: ${file.path}`);
        skipped++;
        continue;
      }

      const { merged, addedCount } = mergeLinesWithoutDuplicates(baseContent, conflictContent);
      try {
        if (addedCount > 0) {
          await this.app.vault.modify(baseFile, merged);
          addedLines += addedCount;
        }
        await this.app.fileManager.trashFile(file);
        processed++;
      } catch (error) {
        console.error(`合并冲突文件失败: ${file.path}`, error);
        skipped++;
      }
    }

    if (processed === 0) {
      if (showNotices) {
        new Notice(`发现 ${conflicts.length} 个冲突文件，但未找到可合并的原文件`);
      }
      return;
    }

    if (showNotices) {
      const skippedMsg = skipped > 0 ? `，跳过 ${skipped} 个` : '';
      new Notice(`合并冲突完成: 处理 ${processed} 个冲突文件，新增 ${addedLines} 行${skippedMsg}`);
    }
    this.refreshManagerViews();
  }

  /** 迁移昨天日记中的未完成任务到今天日记 */
  async migrateYesterdayTasks(showNotices = true): Promise<void> {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const todayStr = formatJournalDate(today);
    const yesterdayStr = formatJournalDate(yesterday);
    await this.migrateTasksBetweenDates(yesterdayStr, todayStr, showNotices);
  }

  /** 迁移所有历史日记中的未完成任务到今天日记 */
  async migrateAllTasksToToday(): Promise<void> {
    const today = new Date();
    const todayStr = formatJournalDate(today);
    const dir = this.settings.journalsFolder?.trim() || 'journals';
    const folder = this.app.vault.getAbstractFileByPath(dir);
    if (!folder || !(folder instanceof TFolder)) {
      new Notice(`日记文件夹不存在: ${dir}`);
      return;
    }
    const dailyPattern = /^\d{4}-\d{2}-\d{2}\.md$/;
    let total = 0;
    for (const child of folder.children) {
      if (!(child instanceof TFile)) continue;
      if (!dailyPattern.test(child.name)) continue;
      const dateStr = child.name.replace(/\.md$/, '');
      if (dateStr === todayStr) continue;
      const count = await this.migrateTasksBetweenDates(dateStr, todayStr, false);
      total += count;
    }
    new Notice(`已迁移 ${total} 个任务到今天`);
    this.refreshManagerViews();
  }

  /** 将 sourceDate 的日记中未完成任务迁移到 targetDate 日记；返回迁移的任务数 */
  private async migrateTasksBetweenDates(sourceDate: string, targetDate: string, showNotice = true): Promise<number> {
    const dir = this.settings.journalsFolder?.trim() || 'journals';
    const folder = this.app.vault.getAbstractFileByPath(dir);
    if (!folder || !(folder instanceof TFolder)) {
      if (showNotice) new Notice(`日记文件夹不存在: ${dir}`);
      return 0;
    }
    const sourcePath = dir ? `${dir}/${sourceDate}.md` : `${sourceDate}.md`;
    const targetPath = dir ? `${dir}/${targetDate}.md` : `${targetDate}.md`;
    const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!sourceFile || !(sourceFile instanceof TFile)) {
      if (showNotice) new Notice(`源日记不存在: ${sourceDate}`);
      return 0;
    }
    let content: string;
    try {
      content = await this.app.vault.read(sourceFile);
    } catch (error) {
      console.error(`读取源日记失败: ${sourcePath}`, error);
      if (showNotice) new Notice(`读取源日记失败: ${sourceDate}`);
      return 0;
    }
    const { kept, tasks: migrated } = this.splitContentByTasks(content);
    if (migrated.length === 0) {
      if (showNotice) new Notice(`${sourceDate} 没有需要迁移的任务`);
      return 0;
    }
    let targetContent = '';
    const targetFile = this.app.vault.getAbstractFileByPath(targetPath);
    if (targetFile && targetFile instanceof TFile) {
      try {
        targetContent = await this.app.vault.read(targetFile);
      } catch (error) {
        console.error(`读取目标日记失败: ${targetPath}`, error);
      }
    }
    if (!targetFile) {
      targetContent = '';
    }
    const { tasks: existingTasks } = this.splitContentByTasks(targetContent);
    const existingTaskKeys = new Set(existingTasks.map(block => block.join('\n')));
    const newTasks = migrated.filter(block => !existingTaskKeys.has(block.join('\n')));
    if (newTasks.length === 0) {
      if (showNotice) new Notice(`${targetDate} 已存在相同任务，无需迁移`);
      return 0;
    }
    if (targetContent.length > 0) {
      if (!targetContent.endsWith('\n')) {
        targetContent += '\n';
      } else if (!targetContent.endsWith('\n\n')) {
        targetContent += '\n';
      }
    }
    targetContent += newTasks.map(block => block.join('\n')).join('\n') + '\n';
    try {
      if (targetFile && targetFile instanceof TFile) {
        await this.app.vault.modify(targetFile, targetContent);
      } else {
        try {
          await this.app.vault.create(targetPath, targetContent);
        } catch (createError) {
          if (createError instanceof Error && createError.message.includes('already exists')) {
            const existingFile = this.app.vault.getAbstractFileByPath(targetPath);
            if (existingFile instanceof TFile) {
              await this.app.vault.modify(existingFile, targetContent);
            } else {
              throw createError;
            }
          } else {
            throw createError;
          }
        }
      }
      await this.app.vault.modify(sourceFile, kept.join('\n'));
    } catch (error) {
      console.error(`迁移任务失败: ${sourceDate} -> ${targetDate}`, error);
      if (showNotice) new Notice(`迁移任务失败: ${sourceDate} -> ${targetDate}`);
      return 0;
    }
    if (showNotice) {
      new Notice(`已迁移 ${newTasks.length} 行任务从 ${sourceDate} 到 ${targetDate}`);
    }
    this.refreshManagerViews();
    return newTasks.length;
  }

  private splitContentByTasks(content: string): { kept: string[]; tasks: string[][] } {
    const lines = content.split('\n');
    const kept: string[] = [];
    const tasks: string[][] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim().startsWith('- TODO ') || line.trim().startsWith('- [ ]')) {
        const block = [line];
        let j = i + 1;
        while (j < lines.length && (lines[j].startsWith('\t') || lines[j].startsWith('    '))) {
          block.push(lines[j]);
          j++;
        }
        tasks.push(block);
        i = j;
      } else {
        kept.push(line);
        i++;
      }
    }
    return { kept, tasks };
  }

  private refreshManagerViews(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_BATCH_MANAGER);
    for (const leaf of leaves) {
      if (leaf.view instanceof BatchFileManagerView) {
        leaf.view.refreshFileList();
      }
    }
  }

  async activateView() {
    const { workspace } = this.app;

    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_BATCH_MANAGER);

    if (leaves.length > 0) {
      // 视图已存在，激活它
      leaf = leaves[0];
    } else {
      // 创建新视图在左侧
      leaf = workspace.getLeftLeaf(false);
      await leaf.setViewState({
        type: VIEW_TYPE_BATCH_MANAGER,
        active: true,
      });
    }

    await workspace.revealLeaf(leaf);
  }
}
