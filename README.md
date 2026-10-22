# deepseek-web-search-mcp

把 [DeepSeek](https://api-docs.deepseek.com/zh-cn/guides/search) 的 Web Search 和 Fetch 接口暴露给 AI 客户端的本地 stdio MCP server。原样返回 DeepSeek 的 JSON，不过滤、不重排、不截断。

## 安装

要求 Node.js >= 22.12。

```bash
npm install
npm run build
```

## 配置

server 只从环境变量读 Key，不读 `.env`。Key 已在 shell 中 export 时，一条命令完成注册：

```bash
claude mcp add-json --scope user deepseek-web-search \
  '{"type":"stdio","command":"/home/redrocker/.nvm/versions/node/v22.23.2/bin/node","args":["/home/redrocker/File/deepseek-web-search-mcp/dist/index.js"],"env":{"DEEPSEEK_API_KEY":"${DEEPSEEK_API_KEY}"},"timeout":180000}'
```

也可以把 `${DEEPSEEK_API_KEY}` 换成实际 Key。

- `--scope`：`user` 全局可用，`local` 仅当前项目（默认），`project` 写入仓库 `.mcp.json` 并会提交 Key。
- `timeout`：单次工具调用上限，fetch 最坏 180 秒，保留该字段。
- `command`：node 绝对路径，避免取到 PATH 里系统自带的旧版本。

其他客户端用等价的 JSON 配置（`timeout` 字段可以删）：

```json
{
  "mcpServers": {
    "deepseek-web-search": {
      "type": "stdio",
      "command": "/home/redrocker/.nvm/versions/node/v22.23.2/bin/node",
      "args": ["/home/redrocker/File/deepseek-web-search-mcp/dist/index.js"],
      "env": { "DEEPSEEK_API_KEY": "sk-..." },
      "timeout": 180000
    }
  }
}
```

工具名：`mcp__deepseek-web-search__search`、`mcp__deepseek-web-search__fetch`。改了 `src/` 要重新 `npm run build` 并重启会话。

## 工具

### search

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `query` | string | 必填 | 1~128 字符，支持 `site:` `-site:` `-` `"..."` `lang:` `after:` `before:` |
| `count` | integer | 10 | 1~50 |
| `need_content` | boolean | false | 返回网页正文，可能非常大 |
| `ori_question` | string | — | 用户原始问题 |
| `site` / `exclude_sites` | string[] | — | 限定 / 排除站点，多站点用 `OR` |
| `lang` | string[] | — | 如 `["zh","en"]` |
| `after` / `before` | string | — | `YYYY`、`YYYY-MM` 或 `YYYY-MM-DD` |
| `exact_phrase` | string | — | 精确匹配短语 |
| `exclude_terms` | string[] | — | 排除包含这些词的网页 |

结构化参数追加到 `query` 后面，与 `query` 里手写的操作符叠加，不去重。

### fetch

| 参数 | 类型 | 说明 |
|---|---|---|
| `url` | string | 绝对 HTTP/HTTPS URL，≤8192 字符，不能带凭据 |

## 返回与错误

- HTTP 2xx：一个 text block，DeepSeek 响应体原文。
- HTTP 非 2xx：两个 text block（`HTTP <status>` + 原文），`isError: true`。
- 配置、参数、网络错误：一个 text block 说明原因，`isError: true`。
- 不截断：`need_content=true` 或抓取长页面时结果可能很大。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 是 | 缺失时 server 仍能启动，调用工具返回配置错误 |
| `DEEPSEEK_BASE_URL` | 否 | 默认 `https://api.deepseek.com`，不要带 `/v1` 或凭据 |

## 超时与重试

- 单次超时：search 30 秒，fetch 60 秒；总上限 90 / 180 秒。
- 仅 408、429、5xx 重试，最多 2 次，指数退避 + 抖动，尊重 `Retry-After`（上限 30 秒）。
- 其他 4xx、网络错误、超时不重试。
- 限速 search 100 QPS、fetch 25 QPS；5 元 / 1000 次成功请求。

## 开发

```bash
npm run typecheck
npm test
npm run dev
DEEPSEEK_INTEGRATION=1 DEEPSEEK_API_KEY=... npm run test:integration
```

集成测试通过 stdio 启动 `dist/index.js`，实际发起 1 次 search + 1 次 fetch；未设置 `DEEPSEEK_INTEGRATION=1` 时跳过。

## 安全

Key 只从环境变量读取，不写入日志或工具输出；stdio 下 stdout 只承载 MCP 协议，日志走 stderr；除非设置 `DEEPSEEK_BASE_URL`，只连接 `api.deepseek.com`。

## License

MIT
