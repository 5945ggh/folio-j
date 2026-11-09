# 设置离开时重复继续导航的修复验收

日期：2026-11-09。实施起点为 `main fa284419`，在阅读与片段导航验收中发现并独立提交。

设置页点击「放弃修改」时，清理草稿可能触发重新渲染；自动保存完成的 effect 仍持有旧的 blocked 状态，再次调用 `proceed()`，导致 `Invalid blocker state transition: unblocked -> proceeding`。错误边界可能恢复页面，原测试只判断最终页面，未必能发现中间异常。

`SettingsDraftProvider` 统一核对最新 blocker、目标 Location 身份及该次导航是否已消费，先标记再清理草稿并继续。取消操作也消费旧目标，异步保存结束后只允许继续当初仍有效的导航；原有保存、放弃及继续编辑规则保持。

`route-loading` 对普通设置导航增加非预期 console.error 断言，专门的 lazy 失败恢复场景单独执行。最终工作区的三场离线 Chrome 回归通过，覆盖桌面、窄屏、路径和分类切换、取消与确认离开；没有重复继续异常。`just lint`、`just test`、构建与文档检查通过，后端 1404 passed／2 skipped，前端 822 passed。

未使用真实模型或日常资料库，未验证实体触屏、Windows 或其他浏览器。本修复未新增产品确认步骤、依赖或 TBD 决策。设置交互见[页面约定](../../INFORMATION_ARCHITECTURE.md#设置顶部分类)。
