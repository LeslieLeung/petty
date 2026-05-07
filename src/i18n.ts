export type SupportedLanguage = 'en' | 'zh'
export type LanguagePreference = 'system' | SupportedLanguage

export const LANGUAGE_KEY = 'petty.language'

type TranslationKey =
  | 'settings.title'
  | 'settings.sidebarTitle'
  | 'settings.nav.models'
  | 'settings.nav.appearance'
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
  | 'settings.appearance.language.label'
  | 'settings.appearance.language.description'
  | 'settings.appearance.language.system'
  | 'settings.appearance.language.english'
  | 'settings.appearance.language.chinese'
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
  | 'error.startup'
  | 'error.importFolderMissing'
  | 'error.selectedFolderMissing'
  | 'model.importedFrom'
  | 'model.hana.description'

const translations: Record<SupportedLanguage, Record<TranslationKey, string>> = {
  en: {
    'settings.title': 'Petty Settings',
    'settings.sidebarTitle': 'Settings',
    'settings.nav.models': 'Models',
    'settings.nav.appearance': 'Appearance',
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
    'settings.appearance.scale.normal': 'Normal',
    'settings.appearance.scale.large': 'Large',
    'settings.appearance.scale.xlarge': 'X-Large',
    'settings.appearance.language.label': 'Language',
    'settings.appearance.language.description': 'Use the system language by default, or choose a fixed language.',
    'settings.appearance.language.system': 'System',
    'settings.appearance.language.english': 'English',
    'settings.appearance.language.chinese': 'Chinese',
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
    'error.startup': 'Petty failed to start.',
    'error.importFolderMissing': 'Folder must contain pet.json and spritesheet.webp.',
    'error.selectedFolderMissing': 'Selected folder must contain pet.json and spritesheet.webp.',
    'model.importedFrom': 'Imported from {folder}.',
    'model.hana.description': 'A tiny chibi yukata companion with blonde curls, cream hair bows, blue eyes, a black floral kimono, and a red obi bow.',
  },
  zh: {
    'settings.title': 'Petty 设置',
    'settings.sidebarTitle': '设置',
    'settings.nav.models': '模型',
    'settings.nav.appearance': '外观',
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
    'settings.appearance.scale.normal': '普通',
    'settings.appearance.scale.large': '大',
    'settings.appearance.scale.xlarge': '超大',
    'settings.appearance.language.label': '语言',
    'settings.appearance.language.description': '默认跟随系统语言，也可以指定固定语言。',
    'settings.appearance.language.system': '跟随系统',
    'settings.appearance.language.english': '英语',
    'settings.appearance.language.chinese': '中文',
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
    'error.startup': 'Petty 启动失败。',
    'error.importFolderMissing': '文件夹必须包含 pet.json 和 spritesheet.webp。',
    'error.selectedFolderMissing': '所选文件夹必须包含 pet.json 和 spritesheet.webp。',
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
