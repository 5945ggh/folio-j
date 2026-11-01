# Folio-J

Folio-J 是在本机浏览器中使用的日语阅读与学习工具。导入日文 EPUB 后，可以在书中查词、保存带出处的片段、写讲解，重读时从讲解回到当时的原句。翻译与讨论可以接入自己的模型服务。阅读和手写讲解无需模型密钥。

## 快速开始

本包需要安装依赖并从源码启动。已在 macOS 上验证；Windows 11 x64 提供实验性支持，Linux 尚未完成验证。

**环境要求**：Python 3.11、Node.js 24、uv 和 pnpm 10，推荐同时安装 `just` 以简化命令。将源码包解压到一个新文件夹，用终端进入该文件夹。

<details>
<summary>Windows 使用说明</summary>

使用 Windows PowerShell 5.1 或 PowerShell 7，以及 Chrome／Edge 浏览器；推荐 `just 1.58` 或更新版本。下面的命令可直接在 PowerShell 中执行，无需 Bash。`~` 表示当前用户目录，例如 `C:/Users/你的用户名`。验证范围见 [Windows 实机测试清单](docs/handovers/WINDOWS_ACCEPTANCE.md)。

</details>

**首次安装**默认把书籍和学习记录保存在主目录下的 `~/Folio-J-Data/app.db`。如需换到其他位置，在第一次启动前编辑用户配置。[选择数据位置](docs/USAGE.md#自定义数据位置与端口)

**已有数据**请先从旧版本完成备份，再核对新版显示的数据库路径。升级步骤见[升级与备份](docs/UPGRADING.md)。

已安装 `just` 时，先安装依赖并查看数据路径。

```sh
just setup
```

确认路径后，构建并启动应用。

```sh
just start
```

<details>
<summary>未安装 just 时的等价命令</summary>

先安装依赖并查看数据路径。

```sh
uv sync --project backend --locked --no-dev
pnpm --dir frontend install --frozen-lockfile
uv run --project backend --no-dev python -m app.config
```

确认数据路径，再运行以下三步。

```sh
uv run --directory backend --no-dev alembic upgrade head
pnpm --dir frontend build
uv run --project backend --no-dev python scripts/run.py start
```

</details>

打开终端显示的地址，默认是 [http://127.0.0.1:8010](http://127.0.0.1:8010)。从「素材库」新建来源，导入一本可重排 EPUB。想试用讲解时，在书中选一句话，保存为学习片段，打开片段并选择手写讲解。在终端按 Ctrl-C 停止服务。

[使用指南](docs/USAGE.md)介绍查词、翻译、书签、讨论和模型设置。[升级与备份](docs/UPGRADING.md)说明怎样保管数据、换新版本和恢复到独立位置。包内 `RELEASE.json` 记录这份程序的版本与源代码提交号。
