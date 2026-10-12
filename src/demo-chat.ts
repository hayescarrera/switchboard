// Chat to chat, end to end, without setting up a chat app: this script plays
// the part of your Claude chat. It connects to the hub's MCP connector like
// Claude would, hands work to Grok and to ChatGPT, and checks in. Open the board
// URL it prints to watch. Run with `npm run demo:chat` (add --auto to skip the pauses).

import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createPool } from "./db/pool.js";
import { modelsFromEnv, startHub } from "./hub.js";
import { startServer } from "./server.js";

const auto = process.argv.includes("--auto");
const token = process.env.SWITCHBOARD_TOKEN ?? randomBytes(18).toString("base64url");
const port = Number(process.env.PORT ?? 3030);
const db = createPool();
const models = modelsFromEnv(process.env, Number(process.env.STAND_IN_DELAY_MS ?? 2500));
const hub = await startHub({ db, models, ownerName: process.env.OWNER_NAME });
const server = await startServer(hub, { token, port });
const terminal = createInterface({ input: process.stdin, output: process.stdout });
const pause = async (prompt: string, ms = 4000) => {
  if (auto) await new Promise((r) => setTimeout(r, ms));
  else await terminal.question(`\n${prompt} [Enter] `);
};

console.log(`\nOpen the board: http://localhost:${port}/board/${token}`);
if (models.missingKeys.length) console.log(`Stand-ins for: ${models.missingKeys.join(", ")}.`);
await pause("Press Enter once the board is open.", 1000);

const chat = new Client({ name: "demo-chat", version: "1.0.0" });
await chat.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp/${token}`)));
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await chat.callTool({ name, arguments: args });
  const text = (res.content as { text: string }[]).map((c) => c.text).join("\n");
  console.log(`\n> ${name}\n${text.replace(/^/gm, "  ")}`);
  return text;
};

await call("list_agents");

console.log("\n1. A thin handoff gets turned away:");
await call("start_thread", {
  title: "Pricing", to: ["Grok"], instruction: "Look into competitor pricing.",
  goal: "Pricing", summary: "", plan: "research", decisions: [], constraints: [], open_questions: [], links: [],
});

console.log("\n2. A full handoff to Grok. Grok asks a question; the Planner answers it from your decisions:");
const started = await call("start_thread", {
  title: "Launch pricing research",
  to: ["Grok"],
  instruction: "Research how our competitors price their entry plans, with sources.",
  goal: "Set the launch price for our new team plan with evidence from the market.",
  summary: "We talked through the new team plan launching next month. We want to price it against the market " +
    "rather than guess. Ben is leaning toward a per-seat price and wants the competitor picture before deciding.",
  plan: "1) Grok researches competitor entry-plan pricing. 2) ChatGPT drafts the launch brief from it. 3) Ben picks the price.",
  decisions: ["Compare against our three main competitors: Acme, Globex and Initech.", "US pricing only for now."],
  constraints: ["Cite a source for every price."],
  open_questions: ["Which competitors should I compare against?"],
  links: [],
});
await pause("Watch Grok ask and the Planner answer on the board, then press Enter.", 9000);
await call("catch_up");

console.log("\n3. A handoff to ChatGPT with a question only you can answer:");
await call("start_thread", {
  title: "Launch brief",
  to: ["ChatGPT"],
  instruction: "Draft the launch brief for the team plan.",
  goal: "A launch brief the team can review before the plan goes live.",
  summary: "Following the pricing research, we need a short brief for the internal team that explains the plan, " +
    "who it's for and the launch timeline, so everyone tells the same story.",
  plan: "Draft the brief, then Ben reviews it and shares it with the team.",
  decisions: ["The audience is the internal team, not customers."],
  constraints: ["Plain language, no jargon."],
  open_questions: ["Should the brief be one page or two?"],
  links: [],
});
await pause("The Planner can't settle that one, so it lands on Waiting on you. Press Enter to answer it.", 7000);
const waiting = await call("waiting_on_me");
const id = waiting.match(/question id ([0-9a-f-]{36})/)?.[1];
if (id) await call("answer_question", { question_id: id, answer: "One page." });
await pause("ChatGPT carries on with your answer. Press Enter to catch up.", 7000);
await call("catch_up");

void started;
await pause("That's the demo. Press Enter to stop the hub.", 3000);
await chat.close();
terminal.close();
hub.stop();
await server.close();
await db.end();
