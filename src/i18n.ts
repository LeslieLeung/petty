export type SupportedLanguage = 'en' | 'zh'
export type LanguagePreference = 'system' | SupportedLanguage

export const LANGUAGE_KEY = 'petty.language'

type TranslationKey =
  | 'settings.title'
  | 'settings.sidebarTitle'
  | 'settings.nav.models'
  | 'settings.nav.appearance'
  | 'settings.nav.integrations'
  | 'settings.nav.about'
  | 'settings.models.title'
  | 'settings.models.description'
  | 'settings.models.loadFolder'
  | 'settings.models.active'
  | 'settings.models.remove'
  | 'settings.models.hint'
  | 'settings.appearance.title'
  | 'settings.appearance.description'
  | 'settings.appearance.size.label'
  | 'settings.appearance.size.description'
  | 'settings.appearance.scale.normal'
  | 'settings.appearance.scale.large'
  | 'settings.appearance.scale.xlarge'
  | 'settings.appearance.visualSizeLock.label'
  | 'settings.appearance.visualSizeLock.description'
  | 'settings.appearance.language.label'
  | 'settings.appearance.language.description'
  | 'settings.appearance.language.system'
  | 'settings.appearance.language.english'
  | 'settings.appearance.language.chinese'
  | 'settings.integrations.title'
  | 'settings.integrations.description'
  | 'settings.integrations.codex.label'
  | 'settings.integrations.codex.connected'
  | 'settings.integrations.codex.disconnected'
  | 'settings.integrations.codex.checking'
  | 'settings.integrations.codex.connect'
  | 'settings.integrations.codex.repair'
  | 'settings.integrations.codex.disconnect'
  | 'settings.integrations.codex.refresh'
  | 'settings.integrations.codex.updating'
  | 'settings.integrations.detail.codexSettings'
  | 'settings.integrations.detail.pettyHelper'
  | 'settings.integrations.detail.codexHooks'
  | 'settings.integrations.detail.pettyConnection'
  | 'settings.integrations.detail.enabled'
  | 'settings.integrations.detail.off'
  | 'settings.integrations.detail.installed'
  | 'settings.integrations.detail.missing'
  | 'settings.integrations.moreAgents.label'
  | 'settings.integrations.moreAgents.description'
  | 'settings.about.title'
  | 'settings.about.description'
  | 'settings.about.version'
  | 'settings.about.builtWith'
  | 'settings.about.license'
  | 'context.settings'
  | 'context.loadCustomModel'
  | 'context.size'
  | 'context.toggleDebug'
  | 'context.quit'
  | 'agent.name.codex'
  | 'agent.name.claudeCode'
  | 'agent.name.opencode'
  | 'agent.name.generic'
  | 'agent.state.thinking'
  | 'agent.state.editing'
  | 'agent.state.running'
  | 'agent.state.testing'
  | 'agent.state.waiting'
  | 'agent.state.success'
  | 'agent.state.error'
  | 'agent.state.working'
  | 'agent.state.idle'
  | 'agent.summary.thinking'
  | 'agent.summary.editing'
  | 'agent.summary.editingFile'
  | 'agent.summary.readingFile'
  | 'agent.summary.running'
  | 'agent.summary.testing'
  | 'agent.summary.waiting'
  | 'agent.summary.success'
  | 'agent.summary.error'
  | 'agent.summary.working'
  | 'agent.summary.idle'
  | 'agent.summary.build'
  | 'agent.summary.tauriDev'
  | 'agent.summary.devServer'
  | 'agent.summary.rustTests'
  | 'agent.summary.tests'
  | 'agent.summary.gitDiff'
  | 'agent.summary.gitStatus'
  | 'agent.summary.git'
  | 'agent.summary.search'
  | 'agent.summary.readFile'
  | 'agent.summary.listFiles'
  | 'agent.summary.projectCommand'
  | 'agent.summary.externalTool'
  | 'agent.summary.browser'
  | 'agent.tool.edit'
  | 'agent.tool.command'
  | 'agent.tool.search'
  | 'agent.tool.read'
  | 'agent.tool.browser'
  | 'agent.tool.action'
  | 'agent.approval.title'
  | 'agent.approval.allow'
  | 'agent.approval.deny'
  | 'agent.approval.command'
  | 'agent.approval.edit'
  | 'agent.approval.generic'
  | 'error.startup'
  | 'error.importFolderMissing'
  | 'error.selectedFolderMissing'
  | 'error.petWindowMissing'
  | 'error.unknownApprovalDecision'
  | 'error.hookBinaryMissing'
  | 'model.importedPetName'
  | 'model.importedFrom'
  | 'model.hana.description'

const translations: Record<SupportedLanguage, Record<TranslationKey, string>> = {
  en: {
    'settings.title': 'Petty Settings',
    'settings.sidebarTitle': 'Settings',
    'settings.nav.models': 'Models',
    'settings.nav.appearance': 'Appearance',
    'settings.nav.integrations': 'Integrations',
    'settings.nav.about': 'About',
    'settings.models.title': 'Pet Models',
    'settings.models.description': 'Choose which character appears on your desktop.',
    'settings.models.loadFolder': 'Load folder...',
    'settings.models.active': 'Active',
    'settings.models.remove': 'Remove {name}',
    'settings.models.hint': 'Folder must contain <code>pet.json</code> and <code>spritesheet.webp</code>. Imported models persist across sessions.',
    'settings.appearance.title': 'Appearance',
    'settings.appearance.description': 'Adjust the size and language of your desktop pet.',
    'settings.appearance.size.label': 'Size',
    'settings.appearance.size.description': 'Choose how large the pet appears on screen.',
    'settings.appearance.scale.normal': 'Small',
    'settings.appearance.scale.large': 'Medium',
    'settings.appearance.scale.xlarge': 'Large',
    'settings.appearance.visualSizeLock.label': 'Keep visual size across displays',
    'settings.appearance.visualSizeLock.description': 'Use each display’s physical size so the pet looks the same size across screens.',
    'settings.appearance.language.label': 'Language',
    'settings.appearance.language.description': 'Use the system language by default, or choose a fixed language.',
    'settings.appearance.language.system': 'System',
    'settings.appearance.language.english': 'English',
    'settings.appearance.language.chinese': 'Chinese',
    'settings.integrations.title': 'Connect Coding Agents',
    'settings.integrations.description': 'Let Petty react when your local coding agent is working. Your project files and repositories stay unchanged.',
    'settings.integrations.codex.label': 'Codex',
    'settings.integrations.codex.connected': 'Codex is connected. Petty can show what Codex is doing and surface approval requests.',
    'settings.integrations.codex.disconnected': 'Codex is not connected yet. Enable it to let Petty follow Codex activity.',
    'settings.integrations.codex.checking': 'Checking Codex connection...',
    'settings.integrations.codex.connect': 'Connect Codex',
    'settings.integrations.codex.repair': 'Repair Connection',
    'settings.integrations.codex.disconnect': 'Disconnect',
    'settings.integrations.codex.refresh': 'Check Again',
    'settings.integrations.codex.updating': 'Updating Codex connection...',
    'settings.integrations.detail.codexSettings': 'Codex settings',
    'settings.integrations.detail.pettyHelper': 'Petty helper',
    'settings.integrations.detail.codexHooks': 'Codex hooks',
    'settings.integrations.detail.pettyConnection': 'Petty connection',
    'settings.integrations.detail.enabled': 'enabled',
    'settings.integrations.detail.off': 'off',
    'settings.integrations.detail.installed': 'installed',
    'settings.integrations.detail.missing': 'missing',
    'settings.integrations.moreAgents.label': 'More agents',
    'settings.integrations.moreAgents.description': 'Claude Code and OpenCode support can be added later.',
    'settings.about.title': 'About Petty',
    'settings.about.description': 'Open-source desktop companion app.',
    'settings.about.version': 'Version',
    'settings.about.builtWith': 'Built with',
    'settings.about.license': 'License',
    'context.settings': 'Settings',
    'context.loadCustomModel': 'Load custom model...',
    'context.size': 'Size',
    'context.toggleDebug': 'Toggle debug overlay',
    'context.quit': 'Quit',
    'agent.name.codex': 'Codex',
    'agent.name.claudeCode': 'Claude Code',
    'agent.name.opencode': 'OpenCode',
    'agent.name.generic': 'Agent',
    'agent.state.thinking': 'is thinking',
    'agent.state.editing': 'is editing',
    'agent.state.running': 'is running commands',
    'agent.state.testing': 'is running checks',
    'agent.state.waiting': 'is waiting for approval',
    'agent.state.success': 'finished',
    'agent.state.error': 'needs attention',
    'agent.state.working': 'is working',
    'agent.state.idle': 'is idle',
    'agent.summary.thinking': 'Reading context and planning the next step',
    'agent.summary.editing': 'Editing project files',
    'agent.summary.editingFile': 'Editing {file}',
    'agent.summary.readingFile': 'Reading {file}',
    'agent.summary.running': 'Running a project command',
    'agent.summary.testing': 'Checking whether the changes pass',
    'agent.summary.waiting': 'Waiting for your approval to continue',
    'agent.summary.success': 'Task completed',
    'agent.summary.error': 'One step needs attention',
    'agent.summary.working': 'Working on the current request',
    'agent.summary.idle': 'No active task',
    'agent.summary.build': 'Building and type-checking the frontend',
    'agent.summary.tauriDev': 'Starting the desktop app in dev mode',
    'agent.summary.devServer': 'Starting the frontend dev server',
    'agent.summary.rustTests': 'Running Rust tests',
    'agent.summary.tests': 'Running tests',
    'agent.summary.gitDiff': 'Reviewing code changes',
    'agent.summary.gitStatus': 'Checking the working tree',
    'agent.summary.git': 'Running a Git operation',
    'agent.summary.search': 'Searching the project',
    'agent.summary.readFile': 'Reading project files',
    'agent.summary.listFiles': 'Listing project files',
    'agent.summary.projectCommand': 'Running a project command',
    'agent.summary.externalTool': 'Querying an external tool',
    'agent.summary.browser': 'Checking the page in a browser',
    'agent.tool.edit': 'Edit',
    'agent.tool.command': 'Command',
    'agent.tool.search': 'Search',
    'agent.tool.read': 'Read',
    'agent.tool.browser': 'Browser',
    'agent.tool.action': 'Action',
    'agent.approval.title': '{agent} needs approval',
    'agent.approval.allow': 'Allow',
    'agent.approval.deny': 'Deny',
    'agent.approval.command': '{agent} wants to run a command',
    'agent.approval.edit': '{agent} wants to edit project files',
    'agent.approval.generic': '{agent} wants to perform an action that needs approval',
    'error.startup': 'Petty failed to start.',
    'error.importFolderMissing': 'Folder must contain pet.json and spritesheet.webp.',
    'error.selectedFolderMissing': 'Selected folder must contain pet.json and spritesheet.webp.',
    'error.petWindowMissing': 'Pet window was not found.',
    'error.unknownApprovalDecision': 'Unknown approval decision.',
    'error.hookBinaryMissing': 'Petty helper was not found at {path}.',
    'model.importedPetName': 'Imported Pet',
    'model.importedFrom': 'Imported from {folder}.',
    'model.hana.description': 'A tiny chibi yukata companion with blonde curls, cream hair bows, blue eyes, a black floral kimono, and a red obi bow.',
  },
  zh: {
    'settings.title': 'Petty 设置',
    'settings.sidebarTitle': '设置',
    'settings.nav.models': '模型',
    'settings.nav.appearance': '外观',
    'settings.nav.integrations': '集成',
    'settings.nav.about': '关于',
    'settings.models.title': '宠物模型',
    'settings.models.description': '选择显示在桌面上的角色。',
    'settings.models.loadFolder': '载入文件夹...',
    'settings.models.active': '使用中',
    'settings.models.remove': '移除 {name}',
    'settings.models.hint': '文件夹必须包含 <code>pet.json</code> 和 <code>spritesheet.webp</code>。导入的模型会跨会话保留。',
    'settings.appearance.title': '外观',
    'settings.appearance.description': '调整桌面宠物的大小和语言。',
    'settings.appearance.size.label': '大小',
    'settings.appearance.size.description': '选择宠物在屏幕上显示的尺寸。',
    'settings.appearance.scale.normal': '小',
    'settings.appearance.scale.large': '中',
    'settings.appearance.scale.xlarge': '大',
    'settings.appearance.visualSizeLock.label': '跨屏保持视觉大小一致',
    'settings.appearance.visualSizeLock.description': '读取每块屏幕的物理尺寸，让宠物跨屏时看起来保持一样大。',
    'settings.appearance.language.label': '语言',
    'settings.appearance.language.description': '默认跟随系统语言，也可以指定固定语言。',
    'settings.appearance.language.system': '跟随系统',
    'settings.appearance.language.english': '英语',
    'settings.appearance.language.chinese': '中文',
    'settings.integrations.title': '连接编程助手',
    'settings.integrations.description': '让 Petty 在本地编程助手工作时作出反应。你的项目文件和仓库不会被改动。',
    'settings.integrations.codex.label': 'Codex',
    'settings.integrations.codex.connected': 'Codex 已连接。Petty 可以显示 Codex 正在做什么，并弹出需要确认的请求。',
    'settings.integrations.codex.disconnected': 'Codex 还没有连接。连接后，Petty 就能跟随 Codex 的工作状态。',
    'settings.integrations.codex.checking': '正在检查 Codex 连接...',
    'settings.integrations.codex.connect': '连接 Codex',
    'settings.integrations.codex.repair': '修复连接',
    'settings.integrations.codex.disconnect': '断开连接',
    'settings.integrations.codex.refresh': '重新检查',
    'settings.integrations.codex.updating': '正在更新 Codex 连接...',
    'settings.integrations.detail.codexSettings': 'Codex 设置',
    'settings.integrations.detail.pettyHelper': 'Petty 助手',
    'settings.integrations.detail.codexHooks': 'Codex hooks',
    'settings.integrations.detail.pettyConnection': 'Petty 连接',
    'settings.integrations.detail.enabled': '已开启',
    'settings.integrations.detail.off': '关闭',
    'settings.integrations.detail.installed': '已安装',
    'settings.integrations.detail.missing': '缺失',
    'settings.integrations.moreAgents.label': '更多助手',
    'settings.integrations.moreAgents.description': '之后可以继续添加 Claude Code 和 OpenCode 支持。',
    'settings.about.title': '关于 Petty',
    'settings.about.description': '开源桌面陪伴应用。',
    'settings.about.version': '版本',
    'settings.about.builtWith': '构建技术',
    'settings.about.license': '许可证',
    'context.settings': '设置',
    'context.loadCustomModel': '载入自定义模型...',
    'context.size': '大小',
    'context.toggleDebug': '切换调试信息',
    'context.quit': '退出',
    'agent.name.codex': 'Codex',
    'agent.name.claudeCode': 'Claude Code',
    'agent.name.opencode': 'OpenCode',
    'agent.name.generic': 'Agent',
    'agent.state.thinking': '正在思考',
    'agent.state.editing': '正在改代码',
    'agent.state.running': '正在运行命令',
    'agent.state.testing': '正在跑检查',
    'agent.state.waiting': '正在等待确认',
    'agent.state.success': '已完成',
    'agent.state.error': '遇到问题',
    'agent.state.working': '正在处理任务',
    'agent.state.idle': '空闲中',
    'agent.summary.thinking': '正在阅读上下文并规划下一步',
    'agent.summary.editing': '正在修改项目文件',
    'agent.summary.editingFile': '正在修改 {file}',
    'agent.summary.readingFile': '正在阅读 {file}',
    'agent.summary.running': '正在执行项目命令',
    'agent.summary.testing': '正在验证改动是否通过检查',
    'agent.summary.waiting': '需要你确认后才能继续',
    'agent.summary.success': '任务已经完成',
    'agent.summary.error': '有一步需要处理',
    'agent.summary.working': '正在处理当前请求',
    'agent.summary.idle': '当前没有任务',
    'agent.summary.build': '正在构建并检查前端代码',
    'agent.summary.tauriDev': '正在启动桌面应用调试',
    'agent.summary.devServer': '正在启动前端开发服务',
    'agent.summary.rustTests': '正在运行 Rust 测试',
    'agent.summary.tests': '正在运行测试',
    'agent.summary.gitDiff': '正在查看代码改动',
    'agent.summary.gitStatus': '正在检查工作区状态',
    'agent.summary.git': '正在执行 Git 操作',
    'agent.summary.search': '正在搜索项目代码',
    'agent.summary.readFile': '正在阅读项目文件',
    'agent.summary.listFiles': '正在查看项目文件列表',
    'agent.summary.projectCommand': '正在执行项目命令',
    'agent.summary.externalTool': '正在查询外部工具',
    'agent.summary.browser': '正在检查页面效果',
    'agent.tool.edit': '修改文件',
    'agent.tool.command': '命令',
    'agent.tool.search': '搜索',
    'agent.tool.read': '查看文件',
    'agent.tool.browser': '浏览器',
    'agent.tool.action': '操作',
    'agent.approval.title': '{agent} 需要确认',
    'agent.approval.allow': '允许',
    'agent.approval.deny': '拒绝',
    'agent.approval.command': '{agent} 想要运行一条命令',
    'agent.approval.edit': '{agent} 想要修改项目文件',
    'agent.approval.generic': '{agent} 想要执行一个需要确认的操作',
    'error.startup': 'Petty 启动失败。',
    'error.importFolderMissing': '文件夹必须包含 pet.json 和 spritesheet.webp。',
    'error.selectedFolderMissing': '所选文件夹必须包含 pet.json 和 spritesheet.webp。',
    'error.petWindowMissing': '没有找到宠物窗口。',
    'error.unknownApprovalDecision': '未知的审批选择。',
    'error.hookBinaryMissing': '没有在 {path} 找到 Petty 助手。',
    'model.importedPetName': '导入的宠物',
    'model.importedFrom': '导入自 {folder}。',
    'model.hana.description': '一个小巧的 Q 版浴衣伙伴，金色卷发、奶油色发蝴蝶结、蓝色眼睛、黑色花纹和服，以及红色蝴蝶结腰带。',
  },
}

export function getLanguagePreference(): LanguagePreference {
  const stored = localStorage.getItem(LANGUAGE_KEY)
  return stored === 'en' || stored === 'zh' || stored === 'system' ? stored : 'system'
}

export function setLanguagePreference(preference: LanguagePreference): void {
  localStorage.setItem(LANGUAGE_KEY, preference)
}

export function getCurrentLanguage(): SupportedLanguage {
  const preference = getLanguagePreference()
  return preference === 'system' ? detectSystemLanguage() : preference
}

export function detectSystemLanguage(): SupportedLanguage {
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  return languages.some((language) => language.toLowerCase().startsWith('zh')) ? 'zh' : 'en'
}

export function applyLanguageMetadata(title?: string): void {
  document.documentElement.lang = getCurrentLanguage() === 'zh' ? 'zh-CN' : 'en'
  if (title) document.title = title
}

export function t(key: TranslationKey, values: Record<string, string> = {}): string {
  let value = translations[getCurrentLanguage()][key]
  Object.entries(values).forEach(([name, replacement]) => {
    value = value.replaceAll(`{${name}}`, replacement)
  })
  return value
}

export function translateModelDescription(id: string, fallback: string): string {
  if (id === 'hana') return t('model.hana.description')
  return fallback
}

export function translateUserVisibleError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'pet window not found') return t('error.petWindowMissing')
  if (message === 'unknown approval decision') return t('error.unknownApprovalDecision')

  const hookBinaryPrefix = 'petty-agent-hook binary was not found at '
  if (message.startsWith(hookBinaryPrefix)) {
    return t('error.hookBinaryMissing', { path: message.slice(hookBinaryPrefix.length) })
  }

  return message
}
