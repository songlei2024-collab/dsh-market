# 本地 DSH 插件市场（索引格式 1）

一份可直接用的插件市场索引：`index.json` + 零依赖校验器 + 本地静态服务。用途是给 DSH 的「插件 → 发现」标签页提供一个索引源。

```
plugin-market/
  index.json                  索引本体（format 1）
  scripts/validate-index.mjs  按 DSH 的读取规则校验，零依赖
  scripts/serve.mjs           本地静态服务，只监听 127.0.0.1
  README.md
```

## 1. 先启用市场功能（一次性）

DSH 自带这个能力，默认关闭：

1. 侧栏「插件」→「实验性插件」分组 →「更多」→ 启用「自定义插件市场」
2. 它会装 `@deepseek-ai/dsh-experimental-plugin-market-bundle@0.2.1-rc.2`（官方按需安装）
3. 插件页多出「发现」标签页；Creator 模式多一个只读的 `plugin_market` 工具

命令行等价物（不推荐手改；UI 这条路会顺带处理好 lockfile 和 bundles 列表）：

```bash
dsh plugin --profile web add @deepseek-ai/dsh-experimental-plugin-market-bundle@0.2.1-rc.2
```

然后把 `@deepseek-ai/dsh-experimental-plugin-market-bundle` 追加到 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 数组末尾，再重启 DSH。只 add 而不加进 bundles 列表，结果只是「已安装、未启用」。

## 2. 把索引挂上去

DSH 只接受 http(s) URL：`file://` 不行，带 `?` 或 `#` 不行，指望 302 跳到最终地址也不行。

本地自测：

```bash
node scripts/serve.mjs . 8788
# serving C:\...\plugin-market
# index source: http://127.0.0.1:8788/index.json
```

然后在「发现」→ 添加索引源 → 粘贴这个 URL。

长期托管：GitHub Pages、`raw.githubusercontent.com`、或任意静态站点。raw 地址别带 `?raw=true`。

## 3. 校验

```bash
node scripts/validate-index.mjs index.json --url http://127.0.0.1:8788/index.json --targets
```

- 通过时打印条目的默认版本；`--targets` 额外打印最终传给 `plugin_manager` 的安装 spec
- 失败时报第一条违规规则的 JSON 路径，例如：

```
INVALID index.json
  at $.plugins[0].metadata.labels[1]
  references undeclared id "nope"
```

## 4. 加一个插件条目

最小可用（npm 来源）：

```json
{
  "name": "@scope/my-plugin",
  "title": { "en": "My plugin", "zh": "我的插件" },
  "description": { "en": "...", "zh": "..." },
  "metadata": { "category": "agent", "labels": ["third-party"] },
  "versions": [
    { "version": "1.2.3", "publishTimestamp": 1760000000, "source": { "type": "npm" } }
  ]
}
```

Git 来源（必须 pin 到 40 位小写 commit）：

```json
"source": {
  "type": "git",
  "url": "https://github.com/you/plugin-repo",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "path": "packages/my-plugin"
}
```

字段表：

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `format` | 是 | 只能是 `1` |
| `title` | 是 | 字符串，或按语言分组的对象，且必须含 `en` |
| `metadata.categories` / `labels` / `sortKeys` | 否 | 声明表。插件里引用的 id 必须先在这里声明 |
| `plugins[].name` | 是 | 合法 npm 包名，≤214 字符，全索引唯一 |
| `plugins[].versions` | 是 | 非空；`version` 精确 SemVer 且不重复，`publishTimestamp` 为 Unix 秒整数 |
| `versions[].source` | 是 | `npm`（可带 `registry`）或 `git`（必须 commit） |
| `versions[].engines.dsh` | 否 | SemVer range，用来卡 DSH 版本；不写就不卡 |
| `icon` | 否 | 相对路径按索引 URL 解析；必须 https 或与索引同源；内联 `data:` 仅 svg/png/jpeg/webp 且解码后 ≤32 KiB |
| `homepage` | 否 | http(s)，允许 `#` |
| `repository.url` | 否 | http(s)，不能带 `git+` 前缀，不能带 query/fragment |

同一插件的 `versions` 会按 SemVer 降序；默认版本取「最高且兼容当前 DSH」的那个。

## 5. 安全（别跳过）

- **索引不签名**：`name`/`version` 只是索引的声明，实际装什么由那个包自己的 manifest 决定。谁改得了你的 `index.json`，谁就能把你的「发现」页指向任意包。
- **装完就是宿主代码**：走 pnpm 安装，Host 代码跑在宿主进程里，不受工作区沙箱约束。点一次「安装」的信任成本和 `npm install` 一个陌生包相同。
- **没有升级路径**：发现页最多显示 `update-available`，真升级要卸载再装。
- **整份读进内存**：几万条会吃掉上百 MB，别拿它当 npm 镜像。

## 6. 排错

| 现象 | 大概率原因 |
| --- | --- |
| 发现页报 `fetch-failed` | URL 带 query/fragment、被重定向、超过 15s、响应体超过 128MB |
| 只改坏一条，整份消失 | `category`/`labels`/`sortKeys` 引用了未声明的 id，校验失败是整份拒绝 |
| 改了 `index.json` 发现页没变 | 成功读取的文档默认缓存 10 分钟；在发现页刷新或重新添加索引源 |
| 装完看不到 | 看「已安装」标签；bundles 列表顺序影响优先级；部分组合包要重启 |

## 7. 发布到 GitHub Pages

仓库根目录就是站点根目录：`index.json` 放在根上，索引源就是 `https://<用户名>.github.io/<仓库名>/index.json`。

```bash
git init -b main
git add .
git commit -m "Add DSH plugin market index"
git remote add origin https://github.com/<用户名>/<仓库名>.git
git push -u origin main
```

然后仓库 Settings → Pages → Source 选 `Deploy from a branch` → `main` / `/ (root)` → Save。等约一分钟，
把 Pages 给出的站点地址加上 `/index.json` 就是索引源。

之后改索引只要 `git push`；发现页有 10 分钟缓存，会自动跟上。
