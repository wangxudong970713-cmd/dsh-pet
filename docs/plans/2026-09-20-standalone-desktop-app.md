# dsh-pet 独立桌面端 EXE 改造实施计划

**目标**: 将原作为 DSH 插件运行的 dsh-pet 改造为可脱离 DSH 独立常驻运行的桌面应用（支持 Windows 独立 EXE），内置密钥管理面板，支持配置 DeepSeek / OpenAI 兼容 API Key，并打包为免安装绿色版 EXE。

## 涉及文件清单
- **新增**:
  - `dsh-pet/runtime/electron-helper/standalone-service.js`（独立主进程服务：本地配置合并、素材读盘、直接调用 LLM API、余额查询、记忆持久化）
  - `dsh-pet/runtime/electron-helper/settings.html`（独立设置面板页面）
  - `dsh-pet/runtime/electron-helper/settings.css`（设置面板样式）
  - `dsh-pet/runtime/electron-helper/settings.js`（设置面板渲染端交互逻辑）
  - `dsh-pet/scripts/start-standalone.mjs`（本地免安装独立启动脚本）
  - `electron-builder.json`（打包 Windows 独立 EXE 配置文件）
- **修改**:
  - `dsh-pet/runtime/electron-helper/main.js`（主进程生命周期管理、托盘图标、单实例锁、协议拦截直连 standalone-service、设置窗口创建与通信）
  - `dsh-pet/runtime/electron-helper/preload.js`（暴露打开设置、测试连接、保存设置的 IPC 接口）
  - `dsh-pet/runtime/electron-helper/sprite.js`（右键菜单加入【⚙️ 设置】项、未配置 Key 时友好引导）
  - `dsh-pet/src/shared/menu.ts`（右键菜单数据结构中支持设置项）
  - `dsh-pet/package.json`（补充打包依赖与快捷启动脚本）

---

## 实施任务拆解

### Task 1: 主进程与独立服务内嵌（Standalone Service & Bridge Protocol）
- **目标**: 彻底脱离 DSH 宿主后端与 `@deepseek-ai/*` 依赖，主进程内嵌配置读取、本地静态素材服务、直接 LLM 调用与记忆存储。
- **改动点**:
  - 新建 `standalone-service.js`：
    - 读取内置 `assets/config.jsonc` 并与 `%APPDATA%/dsh-pet/config.json` 深度合并。
    - 静态素材（webm、memes、pic、fonts）本地直接读盘返回。
    - 使用标准 `fetch` 调用 `${baseUrl}/chat/completions` 实现碎碎念生成与对话，支持记忆写入 `%APPDATA%/dsh-pet/memory.json`。
    - 针对 DeepSeek 官方 API 实现 `/user/balance` 余额查询。
  - 改造 `main.js`：
    - 移除父进程探测自杀（`host-liveness.js`）及管道守卫。
    - 增加单实例锁（`app.requestSingleInstanceLock()`）与系统托盘图标（Tray），托盘菜单提供：打开设置、关于、重置位置、退出。
    - 拦截 `dsh-pet-bridge://` 协议，直接在主进程内部调用 `standalone-service.js` 响应。
- **验证方式**:
  - 使用 Electron 启动，验证 `dsh-pet-bridge://` 协议能否成功返回配置、加载动画视频并显示在屏幕上。

### Task 2: 图形化独立设置中心（Settings Window & IPC）
- **目标**: 提供优雅、卡通风格的轻量半透明设置面板，供用户独立配置密钥及桌宠行为。
- **改动点**:
  - 创建 `settings.html`、`settings.css`、`settings.js`：
    - API 配置区：API Key 输入框（密码框 + 显示/隐藏开关）、API 地址 Base URL（默认 `https://api.deepseek.com`）、模型选择 Model（默认 `deepseek-chat`）。
    - 行为设置区：碎碎念开关、碎碎念间隔、人设 Prompt、表情包配图开关。
    - 交互按钮：「测试连接」（一键验证 Key 与网络有效性）、「保存设置」（保存并即时热更新到桌宠）。
  - 在 `preload.js` 与 `main.js` 中新增设置相关的 IPC 通道（`pet:open-settings`、`settings:get`、`settings:save`、`settings:test`）。
- **验证方式**:
  - 打开设置窗口，修改 API 配置与桌宠大小/碎碎念选项，保存后验证 `%APPDATA%/dsh-pet/config.json` 成功落盘并即时生效。

### Task 3: 桌宠交互联动与右键菜单升级
- **目标**: 右键菜单集成设置入口，并在用户未配置 Key 时友好引导。
- **改动点**:
  - 更新 `menu.ts` 与 `sprite.js`：
    - 右键菜单首屏增加【⚙️ 设置】，点击呼出设置窗口。
    - 对话弹窗与碎碎念在没有检测到 API Key 时，弹出气泡提示：“还没配置 API Key 哦，请右键打开设置~”。
- **验证方式**:
  - 右键桌宠点击【⚙️ 设置】能否成功唤出设置窗口；清空 Key 时点击对话是否能正常给出气泡提示。

### Task 4: 构建打包配置与独立 EXE 产出（Packaging & Standalone Exe）
- **目标**: 配置 `electron-builder` 并产出 Windows 独立绿色便携版 EXE。
- **改动点**:
  - 在 `package.json` 配置打包参数、资源包含项（`assets/`、`runtime/electron-helper/`）。
  - 添加 `pnpm start:standalone` 与 `pnpm build:exe` 脚本。
  - 执行构建，打包出单文件便携式 `dsh-pet.exe`。
- **验证方式**:
  - 运行 `pnpm build:exe`，验证打包过程无报错，产物目录生成 Windows 可执行文件，双击测试正常运行。
