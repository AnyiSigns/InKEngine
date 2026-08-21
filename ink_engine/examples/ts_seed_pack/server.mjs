// TS 种子包执行件：MCP stdio server（零 npm 依赖，手写 JSON-RPC over stdio）。
// 领域执行件跨语言示范——Python 引擎经 MCP 协议（JSON-RPC 2.0 + 换行分隔）
// 调用本 server 的工具；语言无关契约 = JSON 数据形态 + stdio 传输。
import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";

const SERVER_INFO = { name: "ts-seed-pack", version: "0.1.0" };

// ── 领域工具实现（TypeScript/JavaScript 执行件：具体怎么做）──
const TOOLS = [
  {
    name: "taboo_check",
    description: "正文禁忌词确定性检测：返回命中的禁忌表述清单",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "待检正文" },
        taboos: {
          type: "array",
          items: { type: "string" },
          description: "禁忌表述清单",
        },
      },
      required: ["text", "taboos"],
    },
    run: (args) => {
      const text = String(args.text ?? "");
      const taboos = Array.isArray(args.taboos) ? args.taboos.map(String) : [];
      const hits = taboos.filter((t) => t && text.includes(t));
      return { ok: true, hits };
    },
  },
  {
    name: "causal_reverse_check",
    description: "因果链后果早于原因检测：返回违规的因果边",
    inputSchema: {
      type: "object",
      properties: {
        causal_links: {
          type: "array",
          items: {
            type: "object",
            properties: {
              cause_event_id: { type: "string" },
              effect_event_id: { type: "string" },
            },
          },
        },
        events: { type: "object", description: "事件表 id -> { chapter_id }" },
      },
      required: ["causal_links", "events"],
    },
    run: (args) => {
      const links = Array.isArray(args.causal_links) ? args.causal_links : [];
      const events =
        args.events && typeof args.events === "object" ? args.events : {};
      const violations = [];
      for (const link of links) {
        const cause = events[link.cause_event_id];
        const effect = events[link.effect_event_id];
        if (
          cause &&
          effect &&
          cause.chapter_id != null &&
          effect.chapter_id != null &&
          effect.chapter_id < cause.chapter_id
        ) {
          violations.push({
            message: `后果早于原因：事件 ${link.cause_event_id}（第 ${cause.chapter_id} 章）的后果不可能在第 ${effect.chapter_id} 章体现`,
            effect_event_id: link.effect_event_id,
          });
        }
      }
      return { ok: true, violations };
    },
  },
];

// ── MCP 协议处理（initialize / tools/list / tools/call）──
function send(message) {
  output.write(JSON.stringify(message) + "\n");
}

function resultOf(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

async function handleCall(id, params) {
  const tool = TOOLS.find((t) => t.name === params?.name);
  if (!tool) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: `未知工具: ${params?.name}` },
    });
    return;
  }
  try {
    const out = await tool.run(params?.arguments ?? {});
    resultOf(id, {
      content: [{ type: "text", text: JSON.stringify(out) }],
    });
  } catch (err) {
    send({ jsonrpc: "2.0", id, error: { code: -32000, message: String(err) } });
  }
}

const rl = createInterface({ input, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (method === "initialize") {
    resultOf(id, {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  } else if (method === "tools/list") {
    resultOf(id, {
      tools: TOOLS.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    });
  } else if (method === "tools/call") {
    handleCall(id, params);
  } else if (method === "ping") {
    resultOf(id, {});
  } else if (typeof method === "string" && method.startsWith("notifications/")) {
    // 通知无需响应
  } else {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `方法未实现: ${method}` },
    });
  }
});
