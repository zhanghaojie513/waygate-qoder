# waygate-qoder

**把 Qoder CN 客户端订阅，变成你自己的本地 API。**

读取本机 Qoder 客户端的登录态，在本机起一个 **Anthropic / OpenAI 兼容**的聊天端点 ——
Cursor、Claude Code、Cherry Studio、任何能改 base_url 的工具都能直接用你的订阅额度。

```bash
npx waygate-qoder      # 或全局装：npm i -g waygate-qoder && qoc
```

```
途关 · Qoder CN 反代 v0.1.0

凭证    ✓ 你的账号（uid 01a0d156…）
上游    https://gateway.qoder.com.cn  (COSY 签名协议)
代理    http://127.0.0.1:8789
密钥    sk-qoc-3f8a…c21d

模型 ID（填进你的客户端）：
  qmodel_38max   Qwen3.8-Max
  qfmodel        Qwen3.8-Flash
  qmodel         Qwen3.7-Plus
  …（共 14 个）

把上面的「代理地址 + 密钥」填进 Cursor / Claude Code / Cherry Studio 等客户端即可。
```

## 安装

```bash
# 免安装试用
npx waygate-qoder

# 或全局安装（之后命令就是 qoc）
npm i -g waygate-qoder
```

要求：**Node.js ≥ 20**；本机装有 Qoder CN 桌面客户端**且已登录**。

## 命令

| 命令 | 作用 |
| --- | --- |
| `qoc`（= `qoc serve`） | 启动反代，打印模型 ID 与代理地址 |
| `qoc models` | 只列出模型 ID（不起服务） |
| `qoc doctor` | 自检：端口 / 凭证 / 模型清单 / 上游连通 |
| `qoc login` | 重新读取客户端登录态（令牌过期时用） |

参数：`--port <n>`（默认 8789）、`--host <addr>`（默认 `127.0.0.1`）、`--key <sk-…>`、`--json`、`--verbose`。

## 客户端怎么填

| 客户端 | 填法 |
| --- | --- |
| **Cursor / Cherry Studio / OpenAI SDK** | Base URL `http://127.0.0.1:8789/v1`，API Key 用上面打印的 `sk-qoc-…`，模型填模型 ID |
| **Claude Code** | `ANTHROPIC_BASE_URL=http://127.0.0.1:8789` + `ANTHROPIC_API_KEY=sk-qoc-…` |

暴露的端点：`POST /v1/chat/completions`（OpenAI）· `POST /v1/messages`（Anthropic）· `GET /v1/models` · `GET /healthz`

## 工作原理

```
你的客户端 ──(OpenAI/Anthropic)──► qoc（本机 8789）──(COSY 签名协议)──► Qoder 网关
                                        ▲
                              读取 ~/.waygate/qoc/credential.json
                              （首次由 qoc login 从客户端登录态解出）
```

- **凭证**：Qoder 客户端把登录态存在 Chromium 的 `auth.v1.dat`（os_crypt v10，密钥由 Windows DPAPI 保护）。`qoc login` 用本机 DPAPI 解出令牌，写到 `~/.waygate/qoc/credential.json`（0600）。
- **协议**：Qoder 网关用一套自研的请求签名（`COSY` bearer + 自定义 base64 编码）与 SSE 帧格式，本工具把它翻译成标准 OpenAI SSE。
- **模型清单**：真拉网关 `/model/list`，不是内置假清单。

## 常见问题

**Q：要装 Qoder 客户端吗？**
要。本工具不提供账号，只是把你**已有**的客户端登录态转成本地 API。

**Q：令牌过期了怎么办？**
在 Qoder 客户端重新登录，然后跑一次 `qoc login`。`qoc doctor` 会告诉你凭证是否还有效。

**Q：会不会把我的令牌上传？**
不会。全程只在本机读写：读客户端文件 → 写 `~/.waygate/` → 在本机转发。代码开源可查。

**Q：端口被占用？**
`qoc --port 9790`，或 `qoc doctor` 看是哪一项没过。

**Q：想给局域网内其他设备用？**
`qoc --host 0.0.0.0` —— 但请想清楚：那等于把你订阅的额度开放给能访问该端口的所有人。

## 免责声明

仅供**个人学习与研究**使用，请遵守 Qoder 的服务条款。上游接口随时可能变更，届时本工具可能失效
（`qoc doctor` 是排查入口）。作者不对使用后果负责。

## 相关项目

- [waygate-mmcode](https://github.com/zhanghaojie513/waygate-mmcode) —— 同款工具，对应 **MiniMax Code**
- [@waygate/core](https://github.com/zhanghaojie513/waygate-core) —— 两个工具共用的骨架
- [relay-station](https://github.com/zhanghaojie513/relay-station) —— 同一作者的完整多方反代（含控制台、用量统计）

## License

MIT
