# Petty 中文说明

[English](README.md)

Petty 是一个桌宠应用，用来播放兼容 Codex 桌宠资源格式的 pet。

应用内置了一个桌宠 Hana，也支持从设置窗口或桌宠右键菜单导入本地自定义桌宠文件夹。

## 当前支持的功能

- 播放基于 spritesheet 的桌宠动画。
- 支持 `hatch-pet` 资源包结构：`pet.json` 加 `spritesheet.webp`。
- 内置一个桌宠：`resources/hana/`。
- 支持导入本地自定义桌宠文件夹。
- 支持在设置窗口中切换桌宠。
- 支持点击、双击、拖拽和右键菜单等基础交互。
- 支持大小设置和调试信息开关。

## 生成自定义 Pet

如果你想创建自定义桌宠资源包，可以使用 Codex 的 `hatch-pet` skill：

https://github.com/openai/skills/blob/main/skills/.curated/hatch-pet/SKILL.md

生成完成后，把产出的文件夹导入 Petty。该文件夹必须包含：

```text
pet.json
spritesheet.webp
```

## 开发

安装依赖：

```sh
npm install
```

启动 Vite 前端：

```sh
npm run dev
```

启动桌面应用：

```sh
npm run tauri:dev
```

启动桌面应用并打开 devtools：

```sh
npm run tauri:dev-console
```

构建 Web 前端：

```sh
npm run build
```

构建 Tauri 桌面应用：

```sh
npm run tauri:build
```

## 项目结构

- `src/`：TypeScript 前端代码。
- `src/pet-runtime/`：桌宠加载、渲染、状态、行为和屏幕边缘运行时代码。
- `src-tauri/`：Tauri 宿主外壳和平台集成。
- `resources/`：内置桌宠资源。
- `docs/`：产品和技术文档。
