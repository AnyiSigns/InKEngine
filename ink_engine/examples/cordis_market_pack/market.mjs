// 模拟 Cordis 插件市场的 MCP server（零 npm 依赖，手写 JSON-RPC over stdio）。
// 实验目标：产品层挂载"市场"MCP server → 市场工具取数据 → 经引擎自指
// 管线（apply_patch）修改数据集（知识集）——验证外部市场到集演化的闭环。
import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";

const SERVER_INFO = { name: "cordis-market-mock", version: "0.1.0" };

// ── 市场数据（模拟 Cordis 插件目录：dataset-viz 插件携带知识条目）──
const MARKET_PLUGINS = [
  {
    plugin_id: "cordis.dataset-viz",
    name: "dataset-viz",
    version: "0.3.0",
    description: "数据集可视化插件（模拟 Cordis 市场条目）",
    keywords: ["dataset", "viz", "cordis"],
  },
];

const MARKET_ENTRIES = [
  {
    id: "market.cordis.dataset_viz.intro",
    level: "work",
    kind: "note",
    data: {
      note: "来自 Cordis 插件市场（模拟）：dataset-viz 数据集可视化插件的集内使用说明",
    },
    source: "model",
    credibility: 0.7,
    title: "market: dataset-viz 说明",
    tags: ["market", "cordis", "dataset"],
  },
  {
    id: "market.cordis.dataset_viz.template",
    level: "work",
    kind: "template",
    data: {
      template: {
        name: "market_viz",
        description: "市场插件默认编排（数据集可视化）",
        plan: { steps: [{ nodes: ["viz"] }] },
      },
    },
    source: "model",
    credibility: 0.7,
    title: "market: dataset-viz 默认模板",
    tags: ["market", "cordis", "template"],
  },
];

// ── 领域工具实现（市场形态：搜索 / 取详情）──
const TOOLS = [
  {
    name: "market_search",
    description: "Cordis 插件市场搜索：按关键词返回插件清单",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
      },
      required: ["query"],
    },
    run: (args) => {
      const query = String(args.query ?? "");
      const hits = MARKET_PLUGINS.filter((p) =>
        [p.name, p.description, ...(p.keywords ?? [])]
          .join(" ")
          .toLowerCase()
          .includes(query.toLowerCase()),
      );
      return { ok: true, plugins: hits };
    },
  },
  {
    name: "market_fetch",
    description: "按插件 id 取详情：返回插件信息与其携带的知识条目（集内数据形态）",
    inputSchema: {
      type: "object",
      properties: {
        plugin_id: { type: "string", description: "插件标识" },
      },
      required: ["plugin_id"],
    },
    run: (args) => {
      const plugin = MARKET_PLUGINS.find((p) => p.plugin_id === args.plugin_id);
      if (!plugin) {
        return { ok: false, error: `未知插件: ${args.plugin_id}` };
      }
      return { ok: true, plugin, entries: MARKET_ENTRIES };
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
