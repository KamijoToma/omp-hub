# omp 上游修改跟踪

记录需要对上游 [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) 作出的修改、完成情况与 PR 链接。

- 本地 checkout:`~/Projects/oh-my-pi`(origin = fork `KamijoToma/oh-my-pi`,upstream = `can1357/oh-my-pi`)。
- 上游改动一律在 fork 开分支、向上游提 PR;合并进上游 release 后才能被 omp-hub 消费。
- omp-hub 侧消费方式:`packages/agent/package.json` 的 `@oh-my-pi/*` pin(版本 = 上游 git release tag)→ 升 pin + restart-daemon。

状态流转:`候选 → 本地完成 → PR 已开 → 上游已合并/发版 → 已接入`。

## 上游修改

| # | 修改 | 原因 / 背景 | 状态 | PR |
|---|------|-------------|------|----|
| 1 | collab host 转发 `reset_boundary` 条目:`packages/wire/src/index.ts` 加 `ResetBoundaryEntry` + union 成员;`packages/coding-agent/src/collab/host.ts` 的 `WIRE_SESSION_ENTRY_TYPES` 白名单加 `reset_boundary: true`;两包 CHANGELOG `[Unreleased]` Fixed | `/clear`(`resetSessionContext`)在 session 文件落盘 payload-free 的 `reset_boundary` 边界,但 collab host 在实时 `entry` 帧与 welcome 快照两处都用白名单过滤,该类型被丢弃 → web transcript 收不到边界,`/clear` 后没有任何消息区分割线(对比 `/compact` 有 compaction divider),重连后快照同样缺失。上游 main(v18.4.2+)同样缺失,确认为上游缺口;旧 guest 对未知 entry 类型容忍,转发向后兼容 | **本地完成**(2026-09-29,`~/Projects/oh-my-pi` 工作树未提交;新增 `packages/coding-agent/test/collab/host-reset-boundary.test.ts` 验证 live 转发 + 新 join 快照 + 分支顺序,未修复时可复现失败;collab 套件 233 例全过,`bun check` 通过) | 待提交 |

## 接入依赖(omp-hub 侧)

| 上游项 | omp-hub 侧状态 | 解锁条件 |
|--------|----------------|----------|
| #1 `reset_boundary` 转发 | `feat/clear-divider` 已合入 main(a4923b8):vendored `lib/wire.ts` 加类型,`Transcript` 按 divider 分组渲染 `context cleared` 分割线;E2E 见 `docs/e2e.md` #37。旧 host 下保持 toast-only,无回归 | 上游发版后升 `packages/agent` 的 `@oh-my-pi/*` pin + 面板 restart-daemon |
