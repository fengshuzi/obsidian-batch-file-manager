import { App, Plugin, TFile, TFolder, WorkspaceLeaf, ItemView, Menu, Notice, PluginSettingTab, Setting, Modal, TextComponent } from 'obsidian';

const VIEW_TYPE_BATCH_MANAGER = 'batch-file-manager-view';

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
}

const DEFAULT_SETTINGS: BatchFileManagerSettings = {
  defaultTags: '#todo #important',
  tagPosition: 'start',
  scanExternalImages: false,
  imageExtensions: 'png,jpg,jpeg,gif,svg,webp,bmp',
  imageFolders: 'assets',
  journalsFolder: 'journals'
};

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

    const description = contentEl.createEl('p', { 
      text: '选择一个文件夹来查看其中的笔记',
      cls: 'modal-description'
    });
    description.style.marginBottom = '15px';

    // 搜索框
    const searchContainer = contentEl.createDiv({ cls: 'folder-search-container' });
    const searchInput = new TextComponent(searchContainer);
    searchInput.setPlaceholder('搜索文件夹...');
    searchInput.inputEl.style.width = '100%';
    searchInput.inputEl.style.marginBottom = '10px';

    // 文件夹列表容器
    const folderListContainer = contentEl.createDiv({ cls: 'folder-list-container' });
    folderListContainer.style.maxHeight = '400px';
    folderListContainer.style.overflowY = 'auto';
    folderListContainer.style.border = '1px solid var(--background-modifier-border)';
    folderListContainer.style.borderRadius = '4px';
    folderListContainer.style.padding = '10px';
    folderListContainer.style.marginBottom = '15px';

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
        const folderItem = folderListContainer.createDiv({ cls: 'folder-filter-item' });
        folderItem.style.display = 'flex';
        folderItem.style.alignItems = 'center';
        folderItem.style.padding = '8px';
        folderItem.style.cursor = 'pointer';
        folderItem.style.borderRadius = '4px';

        const icon = folderItem.createEl('span', { text: '📁 ' });
        icon.style.marginRight = '8px';

        const label = folderItem.createEl('span', { text: folder.path || '/' });
        label.style.flex = '1';

        folderItem.onclick = () => {
          this.onSubmit(folder);
          this.close();
        };

        folderItem.onmouseenter = () => {
          folderItem.style.backgroundColor = 'var(--background-modifier-hover)';
        };
        folderItem.onmouseleave = () => {
          folderItem.style.backgroundColor = '';
        };
      });
    };

    renderFolderList();

    searchInput.onChange((value) => {
      renderFolderList(value);
    });

    // 按钮容器
    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
    buttonContainer.style.display = 'flex';
    buttonContainer.style.justifyContent = 'space-between';
    buttonContainer.style.gap = '10px';

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

    const description = contentEl.createEl('p', { 
      text: '选择一个或多个标签来筛选文件（显示包含任意选中标签的文件）',
      cls: 'modal-description'
    });
    description.style.marginBottom = '15px';

    // 搜索框
    const searchContainer = contentEl.createDiv({ cls: 'tag-search-container' });
    const searchInput = new TextComponent(searchContainer);
    searchInput.setPlaceholder('搜索标签...');
    searchInput.inputEl.style.width = '100%';
    searchInput.inputEl.style.marginBottom = '10px';

    // 标签列表容器
    const tagListContainer = contentEl.createDiv({ cls: 'tag-list-container' });
    tagListContainer.style.maxHeight = '400px';
    tagListContainer.style.overflowY = 'auto';
    tagListContainer.style.border = '1px solid var(--background-modifier-border)';
    tagListContainer.style.borderRadius = '4px';
    tagListContainer.style.padding = '10px';
    tagListContainer.style.marginBottom = '15px';

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
        const tagItem = tagListContainer.createDiv({ cls: 'tag-filter-item' });
        tagItem.style.display = 'flex';
        tagItem.style.alignItems = 'center';
        tagItem.style.padding = '5px';
        tagItem.style.cursor = 'pointer';
        tagItem.style.borderRadius = '4px';

        const checkbox = tagItem.createEl('input', { type: 'checkbox' });
        checkbox.checked = this.tempSelectedTags.has(tag);
        checkbox.style.marginRight = '10px';
        checkbox.onclick = (e) => {
          e.stopPropagation();
          if (checkbox.checked) {
            this.tempSelectedTags.add(tag);
          } else {
            this.tempSelectedTags.delete(tag);
          }
        };

        const label = tagItem.createEl('span', { text: tag });
        label.style.flex = '1';

        tagItem.onclick = () => {
          checkbox.checked = !checkbox.checked;
          if (checkbox.checked) {
            this.tempSelectedTags.add(tag);
          } else {
            this.tempSelectedTags.delete(tag);
          }
        };

        tagItem.onmouseenter = () => {
          tagItem.style.backgroundColor = 'var(--background-modifier-hover)';
        };
        tagItem.onmouseleave = () => {
          tagItem.style.backgroundColor = '';
        };
      });
    };

    renderTagList();

    searchInput.onChange((value) => {
      renderTagList(value);
    });

    // 按钮容器
    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
    buttonContainer.style.display = 'flex';
    buttonContainer.style.justifyContent = 'space-between';
    buttonContainer.style.gap = '10px';

    const clearBtn = buttonContainer.createEl('button', { text: '清除所有' });
    clearBtn.onclick = () => {
      this.tempSelectedTags.clear();
      renderTagList(searchInput.getValue());
    };

    const rightButtons = buttonContainer.createDiv();
    rightButtons.style.display = 'flex';
    rightButtons.style.gap = '10px';

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
    input.inputEl.style.width = '100%';
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
    buttonContainer.style.marginTop = '20px';
    buttonContainer.style.display = 'flex';
    buttonContainer.style.justifyContent = 'flex-end';
    buttonContainer.style.gap = '10px';

    const cancelBtn = buttonContainer.createEl('button', { text: '取消' });
    cancelBtn.onclick = () => {
      this.close();
    };

    const submitBtn = buttonContainer.createEl('button', { text: '确定', cls: 'mod-cta' });
    submitBtn.onclick = () => {
      this.submit();
    };

    // 自动聚焦输入框
    setTimeout(() => {
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
    input.inputEl.style.width = '100%';
    input.setPlaceholder('folder/subfolder');
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
    buttonContainer.style.marginTop = '20px';
    buttonContainer.style.display = 'flex';
    buttonContainer.style.justifyContent = 'flex-end';
    buttonContainer.style.gap = '10px';

    const cancelBtn = buttonContainer.createEl('button', { text: '取消' });
    cancelBtn.onclick = () => {
      this.close();
    };

    const submitBtn = buttonContainer.createEl('button', { text: '确定', cls: 'mod-cta' });
    submitBtn.onclick = () => {
      this.submit();
    };

    // 自动聚焦输入框
    setTimeout(() => {
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

    const description = contentEl.createEl('p', { 
      text: '将旧标签替换为新标签（标签可以带或不带 # 符号）',
      cls: 'modal-description'
    });
    description.style.marginBottom = '15px';

    // 旧标签输入
    const oldTagContainer = contentEl.createDiv({ cls: 'modal-input-container' });
    oldTagContainer.createEl('label', { text: '旧标签:' });
    const oldTagInput = new TextComponent(oldTagContainer);
    oldTagInput.inputEl.style.width = '100%';
    oldTagInput.setPlaceholder('例如: cy 或 #cy');
    oldTagInput.onChange((value) => {
      this.oldTag = value;
    });

    // 新标签输入
    const newTagContainer = contentEl.createDiv({ cls: 'modal-input-container' });
    newTagContainer.style.marginTop = '15px';
    newTagContainer.createEl('label', { text: '新标签:' });
    const newTagInput = new TextComponent(newTagContainer);
    newTagInput.inputEl.style.width = '100%';
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
    buttonContainer.style.marginTop = '20px';
    buttonContainer.style.display = 'flex';
    buttonContainer.style.justifyContent = 'flex-end';
    buttonContainer.style.gap = '10px';

    const cancelBtn = buttonContainer.createEl('button', { text: '取消' });
    cancelBtn.onclick = () => {
      this.close();
    };

    const submitBtn = buttonContainer.createEl('button', { text: '确定', cls: 'mod-cta' });
    submitBtn.onclick = () => {
      this.submit();
    };

    // 自动聚焦第一个输入框
    setTimeout(() => {
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

    const description = contentEl.createEl('p', { 
      text: '将 frontmatter 中的旧属性名重命名为新属性名',
      cls: 'modal-description'
    });
    description.style.marginBottom = '15px';

    // 旧属性名输入
    const oldPropertyContainer = contentEl.createDiv({ cls: 'modal-input-container' });
    oldPropertyContainer.createEl('label', { text: '旧属性名:' });
    const oldPropertyInput = new TextComponent(oldPropertyContainer);
    oldPropertyInput.inputEl.style.width = '100%';
    oldPropertyInput.setPlaceholder('例如: category 或 是否锻炼');
    oldPropertyInput.onChange((value) => {
      this.oldProperty = value;
    });

    // 新属性名输入
    const newPropertyContainer = contentEl.createDiv({ cls: 'modal-input-container' });
    newPropertyContainer.style.marginTop = '15px';
    newPropertyContainer.createEl('label', { text: '新属性名:' });
    const newPropertyInput = new TextComponent(newPropertyContainer);
    newPropertyInput.inputEl.style.width = '100%';
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
    buttonContainer.style.marginTop = '20px';
    buttonContainer.style.display = 'flex';
    buttonContainer.style.justifyContent = 'flex-end';
    buttonContainer.style.gap = '10px';

    const cancelBtn = buttonContainer.createEl('button', { text: '取消' });
    cancelBtn.onclick = () => {
      this.close();
    };

    const submitBtn = buttonContainer.createEl('button', { text: '确定', cls: 'mod-cta' });
    submitBtn.onclick = () => {
      this.submit();
    };

    // 自动聚焦第一个输入框
    setTimeout(() => {
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

class BatchFileManagerView extends ItemView {
  private files: FileItem[] = [];
  private allFiles: FileItem[] = []; // 保存所有文件
  private currentFolder: TFolder | null = null;
  private selectedFolder: TFolder | null = null; // 当前选中的文件夹
  private plugin: BatchFileManagerPlugin;
  private availableTags: Set<string> = new Set();
  private selectedTags: Set<string> = new Set();

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

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('batch-file-manager-view');

    // 先显示加载提示
    const loadingDiv = container.createDiv({ cls: 'batch-manager-empty' });
    loadingDiv.setText('正在加载文件...');

    // 异步加载文件
    await this.loadFiles();
  }

  async onClose() {
    // 清理
  }

  private renderView() {
    const container = this.containerEl.children[1];
    container.empty();

    // 工具栏
    const toolbar = container.createDiv({ cls: 'batch-manager-toolbar' });
    
    // 全选/取消全选
    const selectAllBtn = toolbar.createEl('button', { text: '全选' });
    selectAllBtn.onclick = () => this.selectAll();

    const deselectAllBtn = toolbar.createEl('button', { text: '取消全选' });
    deselectAllBtn.onclick = () => this.deselectAll();

    // 批量操作按钮
    const addTagBtn = toolbar.createEl('button', { text: '批量打标签' });
    addTagBtn.onclick = () => this.addTagsToSelected();

    const replaceTagBtn = toolbar.createEl('button', { text: '批量替换标签' });
    replaceTagBtn.onclick = () => this.replaceTagsInSelected();

    const renamePropertyBtn = toolbar.createEl('button', { text: '重命名元数据属性' });
    renamePropertyBtn.onclick = () => this.renameFrontmatterProperty();

    const deleteBtn = toolbar.createEl('button', { text: '删除选中', cls: 'mod-warning' });
    deleteBtn.onclick = () => this.deleteSelected();

    const moveBtn = toolbar.createEl('button', { text: '移动选中' });
    moveBtn.onclick = () => this.moveSelected();

    // 查找功能按钮
    const findBrokenImagesBtn = toolbar.createEl('button', { text: '查找失效图片' });
    findBrokenImagesBtn.onclick = () => this.findBrokenImages();

    const findUnreferencedImagesBtn = toolbar.createEl('button', { text: '查找未引用图片' });
    findUnreferencedImagesBtn.onclick = () => this.findUnreferencedImages();

    const findUntaggedBtn = toolbar.createEl('button', { text: '查找无标签笔记' });
    findUntaggedBtn.onclick = () => this.findUntaggedNotes();

    const findOrphanBtn = toolbar.createEl('button', { text: '查找孤立笔记' });
    findOrphanBtn.onclick = () => this.findOrphanNotes();

    const findEmptyBtn = toolbar.createEl('button', { text: '查找空文件' });
    findEmptyBtn.onclick = () => this.findEmptyFiles();

    // 图片重命名（文件名-001 格式）
    const renameImagesBtn = toolbar.createEl('button', { text: '图片重命名(文件名-001)' });
    renameImagesBtn.onclick = () => this.renameImagesToNoteName();

    // 图片路径风格切换
    const toRelativePathBtn = toolbar.createEl('button', { text: '图片转相对路径' });
    toRelativePathBtn.onclick = () => this.convertImageLinksToRelativePath();

    const toSimplePathBtn = toolbar.createEl('button', { text: '图片转最简路径' });
    toSimplePathBtn.onclick = () => this.convertImageLinksToSimplePath();

    // 日记归档 / 还原
    const mergeJournalsBtn = toolbar.createEl('button', { text: '一键归档日志' });
    mergeJournalsBtn.onclick = () => this.mergeJournalsToMonth();

    const splitJournalsBtn = toolbar.createEl('button', { text: '一键还原日志' });
    splitJournalsBtn.onclick = () => this.monthToDaily();

    // 按标签筛选按钮
    const filterByTagBtn = toolbar.createEl('button', { text: '按标签筛选' });
    filterByTagBtn.onclick = () => this.showTagFilterModal();

    // 按文件夹筛选按钮
    const filterByFolderBtn = toolbar.createEl('button', { text: '按文件夹筛选' });
    filterByFolderBtn.onclick = () => this.showFolderSelectModal();

    // 刷新按钮
    const refreshBtn = toolbar.createEl('button', { text: '刷新' });
    refreshBtn.onclick = () => this.loadFiles();

    // 选中计数
    const countDiv = toolbar.createDiv({ cls: 'batch-manager-count' });
    countDiv.setText(`已选中: ${this.getSelectedCount()} / ${this.files.length}`);

    // 标签筛选显示区域
    if (this.selectedTags.size > 0) {
      const tagFilterDiv = container.createDiv({ cls: 'batch-manager-tag-filter' });
      tagFilterDiv.createEl('span', { text: '当前筛选: ', cls: 'tag-filter-label' });
      
      this.selectedTags.forEach(tag => {
        const tagBadge = tagFilterDiv.createEl('span', { cls: 'tag-badge' });
        tagBadge.setText(tag);
        
        const removeBtn = tagBadge.createEl('span', { text: '×', cls: 'tag-remove' });
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
      const folderFilterDiv = container.createDiv({ cls: 'batch-manager-folder-filter' });
      folderFilterDiv.style.padding = '10px';
      folderFilterDiv.style.marginBottom = '10px';
      folderFilterDiv.style.backgroundColor = 'var(--background-secondary)';
      folderFilterDiv.style.borderRadius = '4px';
      folderFilterDiv.style.display = 'flex';
      folderFilterDiv.style.alignItems = 'center';
      folderFilterDiv.style.gap = '10px';
      
      folderFilterDiv.createEl('span', { text: '📁 当前文件夹: ', cls: 'folder-filter-label' });
      
      const folderPath = folderFilterDiv.createEl('span', { cls: 'folder-path' });
      folderPath.setText(this.selectedFolder.path || '/');
      folderPath.style.fontWeight = 'bold';
      folderPath.style.flex = '1';
      
      const clearFolderBtn = folderFilterDiv.createEl('button', { text: '清除', cls: 'clear-filter-btn' });
      clearFolderBtn.onclick = () => {
        this.selectedFolder = null;
        this.applyFilters();
        this.renderView();
      };
    }

    // 文件列表
    const fileList = container.createDiv({ cls: 'batch-manager-file-list' });
    this.renderFileList(fileList);
  }

  private renderFileList(container: HTMLElement) {
    container.empty();

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
        this.app.workspace.getLeaf().openFile(item.file);
      };

      // 添加 hover 样式
      fileItem.style.cursor = 'pointer';

      // 右键菜单
      fileItem.oncontextmenu = (e) => {
        e.preventDefault();
        const menu = new Menu();
        
        menu.addItem((menuItem) => {
          menuItem.setTitle('打开')
            .setIcon('file')
            .onClick(() => {
              this.app.workspace.getLeaf().openFile(item.file);
            });
        });

        menu.addItem((menuItem) => {
          menuItem.setTitle('删除')
            .setIcon('trash')
            .onClick(() => {
              this.deleteFile(item.file);
            });
        });

        menu.showAtMouseEvent(e);
      };
    }
  }

  private async loadFiles() {
    const allMarkdownFiles = this.app.vault.getMarkdownFiles();
    this.allFiles = allMarkdownFiles.map(file => ({
      file,
      selected: false
    }));
    
    // 按路径排序
    this.allFiles.sort((a, b) => a.file.path.localeCompare(b.file.path));
    
    // 提取所有标签
    await this.extractAllTags();
    
    // 应用所有筛选条件
    this.applyFilters();
    
    this.renderView();
  }

  private async extractAllTags() {
    this.availableTags.clear();
    
    for (const item of this.allFiles) {
      try {
        const cache = this.app.metadataCache.getFileCache(item.file);
        
        // 从 frontmatter 提取标签
        if (cache?.frontmatter?.tags) {
          const fmTags = cache.frontmatter.tags;
          if (Array.isArray(fmTags)) {
            fmTags.forEach(tag => {
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
    if (this.selectedFolder) {
      filteredFiles = filteredFiles.filter(item => {
        return this.isFileInFolder(item.file, this.selectedFolder!);
      });
    }

    // 应用标签筛选
    if (this.selectedTags.size > 0) {
      filteredFiles = filteredFiles.filter(item => {
        return this.fileHasAnyTag(item.file, this.selectedTags);
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
      const fmTags = cache.frontmatter.tags;
      if (Array.isArray(fmTags)) {
        fmTags.forEach(tag => {
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
  }

  private async deleteSelected() {
    const selected = this.getSelectedFiles();
    if (selected.length === 0) {
      new Notice('请先选择要删除的文件');
      return;
    }

    const confirmed = confirm(`确定要删除 ${selected.length} 个文件吗？此操作不可撤销！`);
    if (!confirmed) return;

    let successCount = 0;
    let failCount = 0;

    for (const file of selected) {
      try {
        await this.app.vault.delete(file);
        successCount++;
      } catch (error) {
        console.error(`删除文件失败: ${file.path}`, error);
        failCount++;
      }
    }

    new Notice(`删除完成: 成功 ${successCount} 个，失败 ${failCount} 个`);
    await this.loadFiles();
  }

  private async deleteFile(file: TFile) {
    const confirmed = confirm(`确定要删除 ${file.path} 吗？`);
    if (!confirmed) return;

    try {
      await this.app.vault.delete(file);
      new Notice(`已删除: ${file.path}`);
      await this.loadFiles();
    } catch (error) {
      new Notice(`删除失败: ${error.message}`);
    }
  }

  private async moveSelected() {
    const selected = this.getSelectedFiles();
    if (selected.length === 0) {
      new Notice('请先选择要移动的文件');
      return;
    }

    // 使用自定义模态框代替 prompt
    new FolderInputModal(this.app, async (targetPath) => {
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
      await this.loadFiles();
    }).open();
  }

  private async addTagsToSelected() {
    const selected = this.getSelectedFiles();
    if (selected.length === 0) {
      new Notice('请先选择要打标签的文件');
      return;
    }

    // 使用自定义模态框代替 prompt
    new TagInputModal(this.app, this.plugin.settings.defaultTags, async (tagsInput) => {
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
    }).open();
  }

  private addTagsToFrontmatter(content: string, tags: string): string {
    const tagArray = tags.split(/\s+/).filter(t => t);
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

  private async replaceTagsInSelected() {
    const selected = this.getSelectedFiles();
    if (selected.length === 0) {
      new Notice('请先选择要替换标签的文件');
      return;
    }

    new ReplaceTagModal(this.app, async (oldTag, newTag) => {
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
      await this.loadFiles();
    }).open();
  }

  private async renameFrontmatterProperty() {
    const selected = this.getSelectedFiles();
    if (selected.length === 0) {
      new Notice('请先选择要修改的文件');
      return;
    }

    new RenameFrontmatterPropertyModal(this.app, async (oldProperty, newProperty) => {
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
      await this.loadFiles();
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
        const matches = content.matchAll(imageRegex);
        let hasBrokenImage = false;
        
        for (const match of matches) {
          // match[1] 是 ![[]] 格式的图片路径
          // match[3] 是 ![]() 格式的图片路径
          let imagePath = match[1] || match[3];
          if (!imagePath) continue;
          
          // 移除可能的尺寸参数 (例如: image.png|100)
          imagePath = imagePath.split('|')[0].trim();
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
          const imageExists = await this.checkImageExists(file, imagePath, imageFolders);
          
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
        // 匹配 ![xxx](yyy) 格式
        const mdLinkRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
        let match;
        while ((match = mdLinkRegex.exec(content)) !== null) {
          const linkPath = match[1];
          const decoded = this.safeDecodeUriPath(linkPath);
          const variants = decoded !== linkPath ? [linkPath, decoded] : [linkPath];
          
          for (const variant of variants) {
            // 尝试完整路径
            if (imagePathSet.has(variant)) {
              referencedPaths.add(variant);
              break;
            }
            // 尝试仅文件名匹配（简写链接如 ![](xxx.png)）
            const fileName = variant.split('/').pop()?.toLowerCase();
            if (fileName && imageNameToPath.has(fileName)) {
              referencedPaths.add(imageNameToPath.get(fileName)!);
              break;
            }
          }
        }
        
        // 匹配 ![[xxx]] 格式
        const wikiLinkRegex = /!\[\[([^\]]+)\]\]/g;
        while ((match = wikiLinkRegex.exec(content)) !== null) {
          const linkPath = match[1].split('|')[0]; // 去除别名
          const decoded = this.safeDecodeUriPath(linkPath);
          const variants = decoded !== linkPath ? [linkPath, decoded] : [linkPath];
          
          for (const variant of variants) {
            if (imagePathSet.has(variant)) {
              referencedPaths.add(variant);
              break;
            }
            const fileName = variant.split('/').pop()?.toLowerCase();
            if (fileName && imageNameToPath.has(fileName)) {
              referencedPaths.add(imageNameToPath.get(fileName)!);
              break;
            }
          }
        }
      } catch (e) {
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

  /** 尝试对 URL 编码的路径解码（如 %20 -> 空格），解码失败则返回原串 */
  private safeDecodeUriPath(path: string): string {
    try {
      return decodeURIComponent(path);
    } catch {
      return path;
    }
  }

  private async checkImageExists(sourceFile: TFile, imagePath: string, imageFolders: string[]): Promise<boolean> {
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
      ? this.app.vault.getMarkdownFiles().filter(file => this.isFileInFolder(file, this.selectedFolder!))
      : this.app.vault.getMarkdownFiles();
    
    const untaggedFiles: TFile[] = [];
    
    for (const file of filesToCheck) {
      try {
        const cache = this.app.metadataCache.getFileCache(file);
        let hasTags = false;
        
        // 检查 frontmatter 中的标签
        if (cache?.frontmatter?.tags) {
          const fmTags = cache.frontmatter.tags;
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
          const tagPattern = /#[^\s#\[\](){}]+/g;
          const matches = content.match(tagPattern);
          if (matches && matches.length > 0) {
            // 过滤掉可能的误判（比如 markdown 标题 # 开头的）
            const validTags = matches.filter(match => {
              // 检查这个 # 前面是否是行首，如果是则可能是标题
              const index = content.indexOf(match);
              if (index > 0) {
                const charBefore = content[index - 1];
                // 如果前面是空白字符或标点，则是有效标签
                return /[\s\-\(\)\[\]（）【】]/.test(charBefore);
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

  private async findOrphanNotes() {
    new Notice('正在查找孤立笔记...');
    
    // 如果有选中的文件夹，只在该文件夹中查找
    const filesToCheck = this.selectedFolder 
      ? this.app.vault.getMarkdownFiles().filter(file => this.isFileInFolder(file, this.selectedFolder!))
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
      ? this.app.vault.getMarkdownFiles().filter(file => this.isFileInFolder(file, this.selectedFolder!))
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
        const newName = `${baseName}-${String(num).padStart(3, '0')}.${ext}`;
        const newPath = imgFolderPath ? `${imgFolderPath}/${newName}` : newName;

        if (img.name === newName) {
          totalSkipped++;
          // 文件已改名，但链接可能仍是旧名（如相对路径 ../assets/旧 名.png），需单独更新
          const oldNameForLink = `${note.basename}-${String(num).padStart(3, '0')}.${ext}`;
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
            } catch (_) {
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
    await this.loadFiles();
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
    const currentYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const monthEntries: Record<string, { dateStr: string; content: string }[]> = {};
    const monthDeletes: Record<string, TFile[]> = {};

    for (const child of folder.children) {
      if (!(child instanceof TFile)) continue;
      const m = child.basename.match(dailyPattern);
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
      let existing: Record<string, string> = {};
      const existingFile = this.app.vault.getAbstractFileByPath(outputPath);
      if (existingFile && existingFile instanceof TFile) {
        try {
          const content = await this.app.vault.read(existingFile);
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
        existing[dateStr] = content;
      }
      const entries = Object.entries(existing)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([d, c]) => `## ${d}\n\n${c}\n\n`);
      const body = entries.join('\n');
      if (existingFile && existingFile instanceof TFile) {
        await this.app.vault.modify(existingFile, body);
      } else {
        await this.app.vault.create(outputPath, body);
      }
      totalMerged++;
      for (const f of monthDeletes[month]) {
        await this.app.vault.delete(f);
        totalDeleted++;
      }
    }
    new Notice(`一键归档完成: 合并 ${totalMerged} 个月份，删除 ${totalDeleted} 个日文件`);
    await this.loadFiles();
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
      if (monthPattern.test(child.basename)) monthFiles.push(child);
    }
    monthFiles.sort((a, b) => a.basename.localeCompare(b.basename));

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
      await this.app.vault.delete(mf);
    }
    new Notice(`一键还原完成: 还原 ${totalRestored} 个日文件`);
    await this.loadFiles();
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
        content = content.replace(/!\[\[([^\]|]+)(\|[^\]]*)?\]\]/g, (match, linkPath, displayPart) => {
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
        content = content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, linkPath) => {
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
        content = content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, linkPath) => {
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

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: '批量文件管理器设置' });

    // 标签设置
    containerEl.createEl('h3', { text: '标签设置' });

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
    containerEl.createEl('h3', { text: '图片扫描设置' });

    new Setting(containerEl)
      .setName('扫描外部图片')
      .setDesc('是否检查外部链接（http/https）的图片')
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
        .setPlaceholder('png,jpg,jpeg,gif,svg')
        .setValue(this.plugin.settings.imageExtensions)
        .onChange(async (value) => {
          this.plugin.settings.imageExtensions = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('图片文件夹')
      .setDesc('图片存储的文件夹路径（多个用逗号分隔，例如: assets,attachments）')
      .addText(text => text
        .setPlaceholder('assets')
        .setValue(this.plugin.settings.imageFolders)
        .onChange(async (value) => {
          this.plugin.settings.imageFolders = value;
          await this.plugin.saveSettings();
        }));

    // 日记归档设置
    containerEl.createEl('h3', { text: '日记归档' });

    new Setting(containerEl)
      .setName('日记文件夹')
      .setDesc('日/月日记所在文件夹（如 journals），用于「一键归档日志」「一键还原」')
      .addText(text => text
        .setPlaceholder('journals')
        .setValue(this.plugin.settings.journalsFolder)
        .onChange(async (value) => {
          this.plugin.settings.journalsFolder = value;
          await this.plugin.saveSettings();
        }));
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
      id: 'open-batch-file-manager',
      name: '打开批量文件管理器',
      callback: () => {
        this.activateView();
      }
    });

    // 在工作区准备好后，在左侧边栏添加视图
    this.app.workspace.onLayoutReady(() => {
      this.initLeaf();
    });
  }

  async onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_BATCH_MANAGER);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  initLeaf(): void {
    if (this.app.workspace.getLeavesOfType(VIEW_TYPE_BATCH_MANAGER).length) {
      return;
    }
    this.app.workspace.getLeftLeaf(false).setViewState({
      type: VIEW_TYPE_BATCH_MANAGER,
    });
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

    workspace.revealLeaf(leaf);
  }
}
