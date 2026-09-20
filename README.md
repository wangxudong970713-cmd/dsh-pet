# dsh-pet 桌面宠物（独立桌面客户端） 🐾

<p align="center">
  <a href="https://github.com/wangxudong970713-cmd/dsh-pet"><img alt="stars" src="https://img.shields.io/github/stars/wangxudong970713-cmd/dsh-pet?style=social"></a>
  <a href="https://github.com/wangxudong970713-cmd/dsh-pet/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-orange"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue">
  <img alt="edition" src="https://img.shields.io/badge/edition-Standalone%20Desktop%20App-8A2BE2">
  <img alt="assets" src="https://img.shields.io/badge/assets-100%2B%20dynamic%20animations-ff69b4">
</p>

一只完全**脱离浏览器与宿主环境、独立常驻运行在操作系统桌面**上的透明桌宠：待机呼吸、随机丰富动作（打瞌睡、玩魔方、吃火锅、写代码……）、左右转向、屏幕漫游、点击 Q 弹响应、物理阻尼拖拽与甩抛反弹、右键分类点播。

内置**图形化独立设置面板**，支持自由配置 DeepSeek 官方或任何 OpenAI 兼容的 API Key，提供主动碎碎念气泡、自由聊天对话（记忆持久化）以及账户实时余额展示。同时支持系统托盘常驻与一键打包为免安装绿色版 EXE。

> 🌟 **二创与开源致谢声明**：  
> 本项目基于原优秀开源项目 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 进行二次开发，完成了从浏览器插件到**全独立桌面客户端（Standalone Desktop App）**的架构改造与功能增强。  
> - **代码协议**：基于标准 MIT 许可证。  
> - **素材版权**：动画、源视频与提示词配方遵循原作者非商业开源授权约定。  
> - **二创约定**：在任何展示、介绍、分发该作品的地方，请保留原作者 GitHub 链接：<https://github.com/PC2005-cloud/dsh-pet>。

---

## ✨ 独立桌面端核心特性

- 🖥️ **完全独立桌面运行**：彻底脱离任何浏览器插件或外部宿主环境，直接作为原生桌面常驻应用运行（基于 Electron 透明置顶窗口）。
- ⚙️ **图形化独立设置面板（Settings Panel）**：
  - **API 密钥自由配置**：支持 DeepSeek 官方 API 或任何 OpenAI 兼容格式服务（如本地 Ollama、OneAPI 等），输入框支持明文/密码切换保护隐私。
  - **自定义 Base URL 与 Model**：默认 `https://api.deepseek.com` 与 `deepseek-chat`，自由切换不同大模型。
  - **一键测试连接**：可视化检测网络和 API Key 有效性，免去排错困扰。
  - **行为个性化**：碎碎念开关、刷新周期（秒）、自定义人设 Prompt、表情包配图等全界面调节，修改即时热生效。
- 📌 **系统任务栏托盘（Tray）**：
  - Windows 系统托盘常驻，防重复启动（单实例锁保护）。
  - 支持双击打开设置、一键桌宠位置复位、安全退出。
- 🎮 **丝滑拟真物理交互**：
  - **点击回应**：点击触发随机欢快动作并伴随 Q 弹缩放挤压。
  - **阻尼拖拽与甩抛**：过阻尼弹簧跟手拖拽；鼠标快速甩出即触发抛物线加速度飞行、碰到屏幕边缘弹性反弹，落地摩擦减速并停稳。
- 💬 **智能互动与主动陪伴**：
  - **智能碎碎念**：根据设定的人设和周期自动生成幽默短句，伴随说话动画与头顶气泡。
  - **右键自由对话**：右键菜单点击「对话」，即可与桌宠聊天，对话记忆自动持久化在本地。
  - **账户余额展示**：配置 DeepSeek API Key 后支持实时查询账户余额，并分档位联动金币动画与联想气泡。
- 📦 **开箱即用与便携打包**：提供自动化打包脚本，一键生成绿色免安装版 `dsh-pet-win-x64`（内置 `dsh-pet.exe`），无需安装 Node.js 随拷随走。

---

## 🚀 快速开始

### 方式一：直接运行免安装绿色版 EXE（最简单）

1. 在 Release 页面下载打包好的 `dsh-pet-win-x64.zip`；
2. 解压到任意目录，直接双击运行其中的 **`dsh-pet.exe`**；
3. 桌宠即出现在屏幕右上角，右键桌宠点击 **【⚙️ 设置】** 即可配置你的专属 API Key。

---

### 方式二：从源码启动（开发者/本地运行）

```sh
# ① 克隆本仓库并进入插件目录
git clone https://github.com/wangxudong970713-cmd/dsh-pet.git
cd dsh-pet/dsh-pet

# ② 安装依赖
npm install

# ③ 启动独立桌面客户端
npm run start:standalone
```

> **注意**：首次启动如果提示缺少 Electron，可运行 `npm run ensure:electron` 自动下载对应平台的 Electron 运行时。

---

### 方式三：打包为 Windows 独立免安装版 EXE

如果你修改了源码或想分发给朋友，可以使用内置打包脚本一键产出便携版：

```sh
cd dsh-pet
npm run build:exe
```

构建完成后，产物目录为：
```
release/dsh-pet-win-x64/
├── dsh-pet.exe           # 免安装独立主程序
├── resources/app/        # 打包好的核心逻辑与动画素材
└── ... (运行时动态库)
```
整个目录即为纯绿色版桌面程序，直接压缩即可分发！

---

## ⚙️ 设置面板指南

可通过两种方式打开设置面板：
1. **右键桌面宠物** → 选择菜单顶部的 **【⚙️ 设置】**
2. **右键/双击 Windows 任务栏系统托盘** 图标 → 选择 **【⚙️ 打开设置】**

### 配置说明
| 配置项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| **API Key** | 空 | 填入您的 DeepSeek API Key（如 `sk-xxxx`）或任何 OpenAI 兼容 Key |
| **API 地址 (Base URL)** | `https://api.deepseek.com` | 大模型服务端点，可自定义为反代或本地 Ollama 地址 |
| **模型名称 (Model)** | `deepseek-chat` | 使用的模型标识，例如 `deepseek-chat`、`deepseek-reasoner` 等 |
| **自动碎碎念** | 开启 | 是否开启周期性主动发言 |
| **碎碎念间隔 (秒)** | `300` | 主动说话的时间间隔 |
| **人设提示词** | 傲娇可爱的桌面宠物... | 设定宠物的性格与说话口吻 |
| **配图表情包** | 开启 | 碎碎念与对话时是否在气泡中附带趣味表情包 |

> 💾 **配置存储位置**：所有用户配置保存于 `%APPDATA%/dsh-pet/config.json`，记忆记录存储于 `%APPDATA%/dsh-pet/memory.json`，即使重新打包或升级版本也不会丢失。

---

## 🎨 动画效果预览

全部动画（640×360，VP9-Alpha 透明编码）——真实运行时背景完全透明，仅显示手绘风角色：

**待机 / 转向**

<p>
  <img src="dsh-pet/assets/preview/daiji-huxi-xiuxian.gif" width="160" alt="待机呼吸休闲" title="待机呼吸休闲">
  <img src="dsh-pet/assets/preview/dongzhangxiwang.gif" width="160" alt="东张西望" title="东张西望">
</p>

**屏幕漫步与移动**

<p>
  <img src="dsh-pet/assets/preview/pangxie-zoulu.gif" width="160" alt="螃蟹走路" title="螃蟹走路">
  <img src="dsh-pet/assets/preview/yuandi-piaofu-tabu.gif" width="160" alt="原地漂浮踏步" title="原地漂浮踏步">
  <img src="dsh-pet/assets/preview/yuandi-zuozhuan-benpao.gif" width="160" alt="原地左转奔跑" title="原地左转奔跑">
</p>

**丰富小动作**

<p>
  <img src="dsh-pet/assets/preview/youxian-hengga.gif" width="160" alt="悠闲哼歌" title="悠闲哼歌">
  <img src="dsh-pet/assets/preview/chaoda-shenlanyao.gif" width="160" alt="超大伸懒腰" title="超大伸懒腰">
  <img src="dsh-pet/assets/preview/yuandi-qiaoji-zhuomian-hudong.gif" width="160" alt="原地敲击桌面互动" title="原地敲击桌面互动">
  <img src="dsh-pet/assets/preview/haqian-liantian.gif" width="160" alt="哈欠连天" title="哈欠连天">
  <img src="dsh-pet/assets/preview/xie-daima.gif" width="160" alt="写代码" title="写代码">
  <img src="dsh-pet/assets/preview/da-keshui-bei-jingxing.gif" width="160" alt="打瞌睡被惊醒" title="打瞌睡被惊醒">
</p>

**日常玩耍与互动**

<p>
  <img src="dsh-pet/assets/preview/yuandi-zhuanxin-wan-mofang.gif" width="160" alt="原地专心玩魔方" title="原地专心玩魔方">
  <img src="dsh-pet/assets/preview/shuan-huoguo.gif" width="160" alt="涮火锅" title="涮火锅">
  <img src="dsh-pet/assets/preview/chi-token.gif" width="160" alt="吃Token" title="吃Token">
  <img src="dsh-pet/assets/preview/dakou-chi-lingshi.gif" width="160" alt="大口吃零食" title="大口吃零食">
  <img src="dsh-pet/assets/preview/wan-youxi-qijibaituai.gif" width="160" alt="玩游戏气急败坏" title="玩游戏气急败坏">
  <img src="dsh-pet/assets/preview/lu-mao.gif" width="160" alt="撸猫" title="撸猫">
</p>

**点击与拖拽反馈**

<p>
  <img src="dsh-pet/assets/preview/dianji-huiying-kaixin-yuedong.gif" width="160" alt="开心跃动" title="开心跃动">
  <img src="dsh-pet/assets/preview/dianji-huiying-aojiao-shengqi-ceshen-zhanshi.gif" width="160" alt="傲娇生气" title="傲娇生气">
  <img src="dsh-pet/assets/preview/dianji-huiying-naoyang-gegexiao.gif" width="160" alt="挠痒咯咯笑" title="挠痒咯咯笑">
  <img src="dsh-pet/assets/preview/beishubiao-tuozhuai-xuankong-fankui.gif" width="160" alt="拖拽悬空" title="拖拽悬空">
</p>

**余额变动气泡与动画**

<p>
  <img src="dsh-pet/assets/preview/qian-dai-man-yi.gif" width="160" alt="余额-钱袋满溢" title="余额-钱袋满溢">
  <img src="dsh-pet/assets/preview/jin-dai-ding-dang.gif" width="160" alt="余额-金袋叮当" title="余额-金袋叮当">
  <img src="dsh-pet/assets/preview/shu-jin-zhou-mei.gif" width="160" alt="余额-数金皱眉" title="余额-数金皱眉">
  <img src="dsh-pet/assets/preview/dai-kong-ru-xi.gif" width="160" alt="余额-袋空如洗" title="余额-袋空如洗">
</p>

---

## 🛠️ 从零生成新宠物（AI 动画管线复现）

本项目完整保留了原项目的动画生成配方与全套自动化素材管线，您可以根据需要更换角色、新增动作：

```
① 提示词（配方）    →  ② 素材生成链（引擎）  →  ③ 客户端加载
AI 绿幕动画配方        绿幕视频 → 透明动画管线     直接拷贝进入 assets/webm/
```

### 1. 提示词 → 源视频
参考 `prompts/桌面宠物 10 秒动作提示词.md` 的规范，在 AI 视频工具（如豆包、可灵、Runway）中生成 16:9、纯绿幕（#00FF00）、首尾帧标准正立站姿的 10 秒绿幕视频并存入 `video/`。

### 2. 绿幕视频 → 透明动画
在 `scripts/` 下执行自动化抠像与归一化转码管线：
```sh
cd scripts
python chroma_step02.py      # 自动绿幕抠像转透明
python normalize_step03.py   # 归一化居中
python encode_thumbs.py      # 转码为透明 VP9 WebM
```

### 3. 加入素材库
将转码生成的 `.webm` 放入 `dsh-pet/assets/webm/`，并在 `dsh-pet/assets/config.jsonc` 的动画池中登记动作名，即可即刻在桌面宠物中调用和右键点播！

---

## 📂 项目结构

```
├── dsh-pet/                        # 桌面宠物核心代码
│   ├── runtime/
│   │   └── electron-helper/        # 独立桌面端运行时
│   │       ├── main.js             # 主进程：单实例、托盘 Tray、透明窗口生命周期
│   │       ├── preload.js          # 安全 IPC 桥接
│   │       ├── renderer.js         # 渲染进程：动画播放调度、物理引擎
│   │       ├── sprite.js           # 交互处理：点击、拖拽甩抛、右键菜单
│   │       ├── standalone-service.js # 独立服务：本地配置读写、LLM API 直连、余额查询
│   │       ├── settings.html       # 独立图形化设置中心
│   │       ├── settings.js         # 设置面板交互逻辑
│   │       └── settings.css        # 设置面板样式
│   ├── scripts/
│   │   ├── start-standalone.mjs    # 源码独立启动入口
│   │   └── build-exe.mjs           # Windows 免安装 EXE 一键打包脚本
│   └── assets/                     # 默认配置、字体、表情包及 WebM 动画资源
├── prompts/                        # AI 绿幕动画生成提示词配方
├── scripts/                        # 视频绿幕抠像、归一化与转码 Python 脚本管线
├── LICENSE                         # MIT 许可证
└── README.md                       # 项目说明文档
```

---

## 📜 许可证与使用条款

- **程序代码**：基于 [MIT License](LICENSE) 开源。
- **美术素材（动画、源视频、提示词）**：允许个人非商业性质的开源使用，**严禁用于商业用途**。
- **二次创作说明**：基于本项目的任何衍生、改版或重新分发作品，须注明原开源出处：[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)。
