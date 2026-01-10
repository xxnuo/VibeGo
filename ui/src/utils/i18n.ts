import type { Locale } from '@/stores';

export const translations = {
  en: {
    project: 'Project',
    explorer: 'Explorer',
    sourceControl: 'Source Control',
    terminal: 'Terminal',
    files: 'Files',
    git: 'Git',
    settings: 'Settings',
    theme: 'Theme',
    language: 'Language',
    saveAll: 'Save All',
    open: 'Open...',
    export: 'Export',
    home: 'Home',
    changes: 'Changes',
    commit: 'Commit',
    pullRequest: 'Pull Request',
    noActiveSession: 'No terminal session active',
    projectRoot: 'Project Root',
    commitMessage: 'Commit message...',
    configureUpstream: 'Configure upstream to enable PRs.'
  },
  zh: {
    project: '项目',
    explorer: '资源管理器',
    sourceControl: '源代码管理',
    terminal: '终端',
    files: '文件',
    git: 'Git',
    settings: '设置',
    theme: '主题',
    language: '语言',
    saveAll: '保存所有',
    open: '打开...',
    export: '导出',
    home: '首页',
    changes: '更改',
    commit: '提交',
    pullRequest: '合并请求',
    noActiveSession: '无活动终端会话',
    projectRoot: '项目根目录',
    commitMessage: '提交信息...',
    configureUpstream: '配置上游以启用 PR。'
  }
};

export const useTranslation = (locale: Locale) => {
  return (key: keyof typeof translations['en']) => {
    return translations[locale][key] || key;
  };
};