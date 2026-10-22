# deepseek-web-search-mcp

一个本地 stdio MCP server，把 DeepSeek 的 [Web Search](https://api-docs.deepseek.com/zh-cn/guides/search) 与 Fetch 接口暴露给 AI 客户端。它返回 DeepSeek 的原始 JSON 响应，不做结果过滤、不重排、不截断。

## 功能

- `search`：调用 `POST /v1/tools/search`，返回原始 JSON（`results` 数组）。
- `fetch`：调用 `POST /v1/tools/fetch`，返回原始 JSON（`title` + Markdown `content`）。
- 自由 `query` 支持 DeepSeek 搜索语法；另有 7 个结构化过滤参数。
- 仅使用环境变量配置，不读取 `.env`。
- 成功与失败都返回 DeepSeek 的响应体原文。

## 要求

- Node.js >= 22.12（`engines` 与测试工具的要求）
- 一个可用的 DeepSeek API Key
- 可选：Claude Code 或其他支持 stdio MCP server 的客户端

## 安装与构建

```bash
cd /home/redrocker/File/deepseek-web-search-mcp
npm install
npm run build
```

构建产物是 `dist/index.js`。这个包是 `private: true`，不会发布到 npm。

## 在 Claude Code 中配置

```bash
claude mcp add --env DEEPSEEK_API_KEY=sk-... \
  --transport stdio \
  deepseek-web-search \
  -- node /home/redrocker/File/deepseek-web-search-mcp/dist/index.js
```

`--env` 与 server 名之间必须隔一个其它选项（上面用 `--transport stdio`），否则 CLI 会把 server 名当成又一个 `KEY=value`。

等价的 JSON 配置（可以放进 `~/.claude.json` 的 `mcpServers`、项目 `.mcp.json`，或其他客户端）：

```json
{
  "mcpServers": {
    "deepseek-web-search": {
      "type": "stdio",
      "command": "node",
      "args": ["/home/redrocker/File/deepseek-web-search-mcp/dist/index.js"],
      "env": {
        "DEEPSEEK_API_KEY": "sk-..."
      },
      "timeout": 180000
    }
  }
}
```

`timeout` 覆盖客户端默认的工具超时。server 内部最坏情况下 search 约 90 秒、fetch 约 180 秒（含重试），建议把它设为 180000 毫秒或更大。

配置完成后，在 Claude Code 中工具名为：

- `mcp__deepseek-web-search__search`
- `mcp__deepseek-web-search__fetch`

## 工具

### `search`

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `query` | string | 必填 | 搜索词，1~128 个 Unicode 字符，支持 DeepSeek 搜索语法 |
| `count` | integer | `10` | 返回条数，1~50 |
| `need_content` | boolean | `false` | 是否在每条结果的 `content` 字段返回网页正文；可能非常大 |
| `ori_question` | string | — | 触发搜索的用户原始问题，1~128 字符 |
| `site` | string[] | — | 只搜索这些站点，多个站点用 `OR` 连接 |
| `exclude_sites` | string[] | — | 排除这些站点 |
| `lang` | string[] | — | 限定语言，例如 `["zh", "en"]` |
| `after` | string | — | 发布日期下限：`YYYY`、`YYYY-MM` 或 `YYYY-MM-DD` |
| `before` | string | — | 发布日期上限：`YYYY`、`YYYY-MM` 或 `YYYY-MM-DD` |
| `exact_phrase` | string | — | 精确匹配短语 |
| `exclude_terms` | string[] | — | 排除包含这些词的网页 |

结构化过滤参数会追加到 `query` 后面；`query` 本身原样透传。两边都写同一个操作符时会叠加，不会自动去重。

### `fetch`

| 参数 | 类型 | 说明 |
|---|---|---|
| `url` | string | 绝对 HTTP/HTTPS URL，最多 8192 字符，不能带用户名或密码 |

## 搜索语法

| 操作符 | 示例 | 含义 |
|---|---|---|
| `site:` | `DeepSeek site:github.com` | 限定站点 |
| `-site:` | `DeepSeek -site:example.com` | 排除站点 |
| `-` | `DeepSeek -广告` | 排除含关键词的网页 |
| `-"..."` | `DeepSeek -"release notes"` | 排除含指定短语的网页 |
| `"..."` | `DeepSeek "精确短语"` | 精确匹配短语 |
| `lang:` | `DeepSeek lang:zh,en` | 限定语言 |
| `after:` | `DeepSeek after:2025` | 发布日期下限 |
| `before:` | `DeepSeek before:2026-06-01` | 发布日期上限 |

多站点示例：`DeepSeek site:github.com OR site:example.com`。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 是 | DeepSeek API Key。缺失时 server 仍能启动，调用工具会返回配置错误 |
| `DEEPSEEK_BASE_URL` | 否 | 默认 `https://api.deepseek.com`；不要包含 `/v1`，也不要在 URL 里带凭据 |

server 不读取 `.env`。客户端启动 server 时通过 env 注入 Key。

## 返回格式

- 成功（HTTP 2xx）：MCP 结果只有一个 text block，内容是 DeepSeek 响应体原文。
- HTTP 非 2xx：结果有两个 text block，第一个是 `HTTP <status>`，第二个是响应体原文，并设置 `isError: true`。
- 配置错误、参数校验错误、网络错误：一个 text block 说明原因，设置 `isError: true`。
- 不做截断：`need_content=true` 或抓取长网页时，结果可能很大；MCP 客户端可能自行截断显示。
- `resp.text()` 是 UTF-8 解码后的响应体；DeepSeek 返回 JSON，因此与原文等价。

可以用 curl 直接对照 DeepSeek 的原始响应：

```bash
curl -s https://api.deepseek.com/v1/tools/search \
  -H "Authorization: Bearer $DEEPSEEK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"DeepSeek site:github.com","count":5,"need_content":false}'
```

## 超时与重试

- 单次请求超时：search 30 秒，fetch 60 秒。
- 总耗时上限：search 90 秒，fetch 180 秒。
- 仅对 HTTP 408、429 和 5xx 重试，最多 2 次。
- 退避为指数退避加抖动；如果响应带 `Retry-After`，优先使用它（上限 30 秒）。
- 其它 4xx、网络错误、超时都不重试。
- 不记录 API Key、Authorization 头、请求体或响应体。

## 计费与限速

- Search 与 Fetch 都是每 1,000 次成功请求 5 元。
- 只有 HTTP 200 且产生结果的请求才计费；失败、空结果、超时不计费。
- `count` 只影响返回条数，不影响单价。
- Search 限速 100 QPS，Fetch 限速 25 QPS，按账号计算；超限返回 429。
- fetch 对目标域名也有 QPS 限制。

## 开发与测试

```bash
npm run typecheck
npm test                 # 单元测试，不触网
npm run build
npm run dev              # 用 tsx 直接启动 src/index.ts
```

真实 API 集成测试（会实际发起 1 次 search + 1 次 fetch，可能产生少量费用）：

```bash
DEEPSEEK_INTEGRATION=1 DEEPSEEK_API_KEY=... npm run test:integration
```

集成测试通过 stdio 启动 `dist/index.js`，调用 `search` 与 `fetch`，验证返回的 JSON 可以被解析、fetch 的 `content` 非空。没有设置 `DEEPSEEK_INTEGRATION=1` 时，该测试会被跳过。

## 安全

- API Key 只从环境变量读取，不写入日志或工具输出。
- `claude mcp add` 会把 Key 写入客户端配置文件，请限制这些文件的权限。
- stdio 模式下 stdout 只承载 MCP 协议消息；日志全部走 stderr。
- 除非设置 `DEEPSEEK_BASE_URL`，server 只连接 `api.deepseek.com`。
- `fetch` 由 DeepSeek 按目标站点的访问策略抓取；被拒绝时返回 403 或 404。

## English Quick Start

A local stdio MCP server for the DeepSeek Web Search and Fetch APIs. It returns the raw JSON response from DeepSeek without filtering, reordering, or truncating.

Requirements: Node.js >= 22.12 and a DeepSeek API key.

```bash
npm install
npm run build

claude mcp add --env DEEPSEEK_API_KEY=sk-... \
  --transport stdio \
  deepseek-web-search \
  -- node /home/redrocker/File/deepseek-web-search-mcp/dist/index.js
```

Tools exposed:

- `search`: `query`, `count` (default 10), `need_content` (default false), `ori_question`, `site`, `exclude_sites`, `lang`, `after`, `before`, `exact_phrase`, `exclude_terms`.
- `fetch`: `url` (absolute HTTP/HTTPS URL, no credentials, at most 8192 characters).

Successful calls return the raw HTTP body as a single text block. Non-2xx responses return `HTTP <status>` and the raw body as two text blocks with `isError: true`. Content is never truncated by the server.

Environment variables: `DEEPSEEK_API_KEY` (required), `DEEPSEEK_BASE_URL` (optional, default `https://api.deepseek.com`, must not include `/v1`).

Development:

```bash
npm run typecheck
npm test
DEEPSEEK_INTEGRATION=1 DEEPSEEK_API_KEY=... npm run test:integration
```

## License

MIT
