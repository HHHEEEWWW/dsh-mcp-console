# DSH 插件开发经验总结（dsh-mcp-console 实战）

> 本文档总结从零开发并发布 DSH 插件 dsh-mcp-console 的完整经验：生态机制、踩坑记录、开发流程与发布流程。供后续 DSH 插件开发者参考。

## 一、DSH 插件生态机制（动手前必须先搞懂）

### 1. 插件是什么

插件就是 npm 包，通过 `dsh plugin --profile web add <npm名 | github:<owner>/<repo>#main>` 装进 profile 的 `node_modules`。源码真身在 GitHub 仓库（本地不保留源码副本）。

### 2. 激活三要素（缺一不可）

| 要素 | 字段 | 作用 |
|---|---|---|
| 安装 | 包名 | pnpm 装进 `profiles/<profile>/node_modules/` |
| 后端激活 | `dsh.bundle.patch`（指向 cordis.patch.yml） | `dsh plugin add` 后自动进入 `dsh.profile.bundles` 层，启动时自动挂载，**无需手工改配置** |
| 前端激活 | `dsh.client.platform: "web"` + `dsh.client.inject` | `dsh-client-modules` 扫描到声明后，自动服务 `/plugins/<id>/client.js`（读 `exports["./client"]`） |

### 3. 依赖解析（关键机制）

`$DSH_HOME/profiles/node_modules/` 是 DSH 维护的**平面符号链接层**（junction 指向 npm 全局宿主包）。Node parent-walk：profile 自己的 node_modules → 命中平面层 → 解析到宿主。

- 插件里 `import '@deepseek-ai/dsh-mcp-client'` **运行时直接可用**（宿主提供）
- **不要在 dependencies 里声明 `@deepseek-ai/*`**——registry 版本依赖私有 workspace 包，pnpm 安装必然失败
- 零依赖插件最省心：只用 node 内置 + 宿主包

### 4. 前端 bundle 格式（零构建工具链）

client 端就是一个手写 CJS 文件：

```js
window.__ModuleLoader__.load({
  id: "插件包名",          // 必须 === package.json 的 name
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const react = require("react");
    // ... 组件与注册逻辑
    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  }
});
```

- `react` 等由 loader 的模块表提供（external）
- CSS 通过 `<style data-plugin-css="插件名/xxx">` 注入
- **无需 esbuild/vite/ts**，纯手写 JS 即可（用 `react.createElement` 代替 JSX）

### 5. 槽位系统（UI 挂载点）

```js
// 设置面板新增一页（侧边栏导航条目）
ctx.slots.inject("settings.section", () => ctx.slots.register({
  name: "settings.section",
  id: "mcp-console",
  order: 50,
  label: "MCP",
}, McpSection));

// 会话面板新增 tab（conversation.view）
ctx.slots.inject("conversation.view", () => ctx.slots.register({ ... }, TabView));
```

契约定义在 `packages/client/ui-settings/src/client/contract/slots.ts`、`packages/client/ui-slots/src/index.ts`。

### 6. HTTP API 挂载

`webServer` 是 web-only 服务，**必须动态注入**（模块级 inject 会导致 TUI 永久 pending）：

```js
export const inject = ['tools']  // webServer 不在这里声明
// apply 内部：
const webFiber = ctx.inject(['webServer'], (webCtx) =>
  webCtx.effect(() => webCtx.webServer.register({
    kind: 'prefix',
    path: '/my-plugin/api',
    handler: async (req, res) => { /* node:http handler */ }
  }), 'my-plugin: routes'))
```

## 二、踩坑记录（血泪教训）

### 坑 1：config.transport 必须在 config 内层（最隐蔽的坑）

官方桥接 `createTransport(config)` 按 **`config.transport`** 分发（`switch (config.transport)`）。如果 transport 存在服务器顶层而 config 里没有：

- `createTransport` 返回 `undefined`
- SDK `connect(undefined)` 内部访问 `this._transport.onclose` → **`Cannot set properties of undefined (setting 'onclose')`**
- 报错完全看不出是 transport 缺失！

**教训**：桥接插件的 config 结构必须与官方 schema 完全一致；外层只存自己的元数据。

### 坑 2：Windows spawn 无法直接执行 npx

- `spawn('npx', ...)` → **ENOENT**（没有 npx.exe）
- `spawn('npx.cmd', ...)` → **EINVAL**（.cmd 需 shell）

**解法**：自动转换为 `node.exe + npx-cli.js` 绝对路径：

```js
command: process.execPath,
args: ['<npm前缀>/node_modules/npm/bin/npx-cli.js', ...原参数]
```

npx-cli.js 路径用 `npm config get prefix` 探测。

### 坑 3：编码（用户环境铁律）

- **.bat / .cmd / .ps1 必须纯 ASCII**——cmd 按 ANSI/GBK 解析 bat、PowerShell 5.1 按 ANSI 读 ps1，任何中文（注释/echo/字符串）都会把命令拆碎
- 写完必须做非 ASCII 字节扫描（>127 字节数 = 0）
- JS/YAML/JSON 用 UTF-8 无 BOM（PS `Set-Content -Encoding UTF8` 会产生 BOM 炸 Node 解析）

### 坑 4：P0——服务器运行中禁止任何 profile 变更

- package.json / cordis.patch.yml / pnpm 操作 / 插件本体修改，全部禁止（历史崩溃根因）
- **后台 job（pwsh run_in_background）随服务器死亡**——守护进程必须用 `Start-Process` 启动独立 OS 进程
- 守护进程方案：独立进程等待 3080 释放 → 自动安装 → 等待重启 → 自动验证 → 写日志。用户只需"停止 → 等 20 秒 → 启动"

### 坑 5：npm registry 版官方包不可独立安装

`@deepseek-ai/dsh-mcp-client` 的 registry 版依赖私有包（`@deepseek-ai/dsh-type-meta` 404）、源码版 peerDeps 全是 workspace 私包——**不要试图 pnpm 安装**，一律走宿主平面层解析。

### 坑 6：宿主 SDK 版本漂移

官方 mcp-client 源码按 SDK ^1.12 编写，宿主实际装 1.30（`onclose` 已改私有 `_onclose`）——版本漂移的 bug 极难发现。**调试要抓错误链**：

```js
function errorChain(e) {
  const parts = []
  let cur = e, depth = 0
  while (cur && depth < 8) {
    const msg = cur?.message || String(cur)
    if (!parts.includes(msg)) parts.push(msg)
    cur = cur?.cause; depth++
  }
  return parts.join(' <- ')
}
```

并给插件加 `/diag` 端点（进程内直接验证 SDK 行为），排查效率倍增。

### 坑 7：环境变量差异

独立 node 进程测试成功 ≠ dsh web 进程内成功（进程环境不同：scrubbed env、PATH 缺失等）。诊断脚本必须在 profile 目录上下文跑（`workdir = profiles/web`），import 才能解析宿主包。

## 三、开发流程建议

1. **先克隆官方仓库深度学习**：`git clone https://github.com/deepseek-ai/deepseek-harness C:\Users\59263\.dsh\source\current`——机制全部以源码为准（loader/vendor、槽位契约、bundle 机制），不要猜
2. **源码放 `~/.dsh/plugins/<插件名>/`**（插件相关一律在 .dsh 下，不占工作区）
3. **开发期安装**（无需发布）：停服后复制目录到 `profiles/<profile>/node_modules/<插件名>/` + `cordis.patch.yml` 手工 insert（与 memory-evolve 同款）
4. **守护进程自动化**：`wait-install-<插件>.ps1`（等停服→装→等重启→验证→日志），用户零操作
5. **验证脚本**：`verify-<插件>.ps1`（API 断言 + 状态检查），重启后一键验证
6. **回滚预案**：安装前自动备份 cordis.patch.yml + package.json 到 `~/.dsh/backups/`；独立 rollback 脚本（不依赖 GUI）

## 四、发布流程

1. **隐私审计**（公开仓库前必须）：扫描文件名/内容里的用户名、token、机器路径（`59263`/`gho_`/`C:\Users` 等）；**git rm 掉任何自动截图/日志**（含对话内容的截图是重灾区）
2. **生态合规**：package.json（version、keywords 含 `dsh-plugin`、dsh 字段）+ LICENSE + .gitignore
3. **README**：截图（用户提供）+ 安装 + 使用 + API + 架构 + 限制
4. **发布**：
   ```sh
   git init && git add -A && git commit -m "..."
   gh repo create <owner>/<name> --public --source . --push
   git branch -M main && git push -u origin main   # 生态惯例默认分支 main
   gh repo edit --default-branch main
   git tag v1.0.0 && git push --tags
   gh release create v1.0.0
   ```
5. **部署验证**：raw URL 200 + lib 产物齐全 + `dsh.bundle.patch` 字段正确（他人 `dsh plugin add github:<owner>/<repo>#main` 即可部署）

## 五、一句话总结

**DSH 插件开发 = 官方源码先行 + 零依赖手写 + 宿主平面层解析 + 停服安装纪律 + 隐私审计发布**。五个环节缺一不可，前四个保证"能跑"，最后一个保证"能发"。
