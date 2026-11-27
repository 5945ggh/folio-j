# Folio-J 源码发行包

Folio-J 是一个运行在本机的日语沉浸阅读与学习工具。导入日文 EPUB 后，可以在阅读中即时查词、结合语境翻译、保存带出处的学习片段并编写讲解，重读时还能从讲解直接回到书中原句。

阅读、查词、保存片段和手写讲解均可直接使用，无需配置模型；应用内翻译与 AI 讨论可接入你自己的 OpenAI 兼容模型服务。

## 快速开始

本发行包从源码启动，已在 macOS 上验证；Windows 11 x64 提供实验性支持，Linux 尚未完成验证。

**环境要求**：**Python 3.11**、**Node.js 24**、`uv` 和 `pnpm 10`，推荐同时安装 `just` 以简化命令。

<details>
<summary>Windows 使用说明</summary>

使用 Windows PowerShell 5.1 或 PowerShell 7，以及 Chrome／Edge 浏览器；推荐 `just 1.58` 或更新版本。下方命令可直接在 PowerShell 中执行，无需安装 Bash。`~` 表示当前用户目录（如 `C:/Users/你的用户名`）。

</details>

将源码包解压到新文件夹，在终端进入该目录并依次运行：

```sh
# 1. 安装前后端依赖
just setup

# 2. 构建并启动应用
just start
```

<details>
<summary>未安装 just 时的等价命令</summary>

在解压后的目录中依次执行：

```sh
# 1. 安装依赖
uv sync --project backend --locked --no-dev
pnpm --dir frontend install --frozen-lockfile

# 2. 构建前端并启动服务
pnpm --dir frontend build
uv run --project backend --no-dev python scripts/run.py start
```

</details>

启动后会自动打开系统浏览器（默认地址为 [http://127.0.0.1:8010](http://127.0.0.1:8010)）。首次启动时，按页面提示选择数据存放位置（Windows 默认为 `%LOCALAPPDATA%\Folio-J\Data`，macOS 和 Linux 默认为 `~/Folio-J-Data`）即可进入应用。在终端按 `Ctrl-C` 可停止服务。

进入应用后，可以从「素材库」新建来源并导入一本可重排 EPUB；首次试用可下载[发行页](https://github.com/5945ggh/folio-j/releases)中的示例 EPUB。在书中划选句子保存为学习片段，试试手写讲解或翻译。

- **数据位置与配置**：学习数据与程序文件夹独立存放，更新或移动程序不会影响已有数据。日常可在「设置 → 数据位置」查看当前路径；修改端口等高级选项见[应用配置](docs/USAGE.md#应用配置)。
- **版本升级**：如果此前已经保存过学习数据，更新前请先阅读[升级与备份](docs/UPGRADING.md)完成备份。

## 文档与版本信息

- [使用指南](docs/USAGE.md) · 阅读器操作、词典导入、模型配置与讲解管理
- [升级与备份](docs/UPGRADING.md) · 数据备份、版本升级与跨设备迁移

同目录的 `RELEASE.json` 记录了当前发行包的版本号与对应的 Git 提交号。

## 许可证

Folio-J 采用 AGPL-3.0-or-later。完整条款见 [LICENSE](LICENSE)，授权范围与源代码获取说明见 [COPYING.md](COPYING.md)。
