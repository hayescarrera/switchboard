// Chat to chat, end to end over real HTTP: a chat app connects to the MCP
// connector, hands work to Grok or ChatGPT (hub-run agents on stand-in models),
// and later sees what the other agents did. Plus the board's endpoints.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/pool.js";
import { startHub, type Hub } from "../src/hub.js";
import { StandInPlannerModel } from "../src/planner/stand-in.js";
import { startServer, type HubServer } from "../src/server.js";
import { getThread, messagesForThread, setLineEnabled } from "../src/store.js";
import type { WorkerInput, WorkerModel, WorkerReply } from "../src/workers/model.js";
import { StandInWorker } from "../src/workers/stand-in.js";
import { resetDb, testPool } from "./helpers.js";

let db: Db;
let hub: Hub;
let server: HubServer;
let clients: Client[] = [];
const TOKEN = "test-token-123";

/** A worker model that records what it was given. */
class Recording implements WorkerModel {
  readonly label = "recording";
  readonly inputs: WorkerInput[] = [];
  constructor(private readonly inner: WorkerModel = new StandInWorker()) {}
  respond(input: WorkerInput): Promise<WorkerReply> {
    this.inputs.push(structuredClone(input));
    return this.inner.respond(input);
  }
}
let grok: Recording;
let chatgpt: Recording;

beforeEach(async () => {
  db ??= testPool();
  await resetDb(db);
  grok = new Recording();
  chatgpt = new Recording();
  hub = await startHub({ db, models: { planner: new StandInPlannerModel(), grok, chatgpt }, followUpEveryMs: 0 });
  server = await startServer(hub, { token: TOKEN });
});

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
  await hub.router.idle();
  await server.close();
});

afterAll(async () => {
  await db?.end();
});

const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;

async function connect(name = "test-chat") {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url(`/mcp/${TOKEN}`))));
  clients.push(client);
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name: tool, arguments: args });
    return { text: (res.content as { text: string }[]).map((c) => c.text).join("\n"), isError: Boolean(res.isError) };
  };
  return { client, call };
}

const HANDOFF = {
  title: "Launch pricing research",
  instruction: "Research how our competitors price their entry plans, with sources.",
  goal: "Set the launch price for our new team plan with evidence from the market.",
  summary: "We talked through the new team plan launching next month. We want to price it against the market " +
    "rather than guess, and Ben wants the competitor picture before deciding.",
  plan: "Grok researches competitor entry-plan pricing, then ChatGPT drafts the launch brief from it.",
  decisions: ["Compare against our three main competitors: Acme, Globex and Initech."],
  constraints: ["Cite a source for every price."],
  open_questions: ["Which competitors should I compare against?"],
  links: ["https://example.com/pricing-notes"],
};

const threadId = (text: string) => text.match(/id ([0-9a-f-]{36})/)![1];

describe("the connector", () => {
  it("lists the agents this chat can hand work to", async () => {
    const { call } = await connect();
    const { text } = await call("list_agents");
    expect(text).toContain("- Grok: Research (running on recording)");
    expect(text).toContain("- ChatGPT: Writing");
  });

  it("rejects a thin handoff and says what's missing", async () => {
    const { call } = await connect();
    const res = await call("start_thread", {
      ...HANDOFF, to: ["Grok"], goal: "Pricing", summary: "", plan: "research", decisions: [], constraints: [],
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Handoff rejected/);
    for (const field of ["goal:", "summary:", "plan:", "decisions / constraints:"]) expect(res.text).toContain(field);
    expect((await db.query(`SELECT count(*)::int AS n FROM threads`)).rows[0].n).toBe(0);
  });

  it("rejects an agent the chat has no line to", async () => {
    const { call } = await connect();
    const res = await call("start_thread", { ...HANDOFF, to: ["Gemini"] });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Not connected: Gemini. This chat can reach: Grok, ChatGPT.");
  });
});

describe("a handoff to Grok", () => {
  it("hands the whole conversation over; Grok's question is answered from it without the user", async () => {
    const { call } = await connect();
    const started = await call("start_thread", { ...HANDOFF, to: ["grok"] });
    expect(started.isError).toBe(false);
    await hub.router.idle();

    const id = threadId(started.text);
    const names = new Map([[hub.chat.id, "chat"], [hub.planner.id, "planner"], [hub.workers[0].id, "grok"]]);
    const convo = (await messagesForThread(db, id)).map((m) => [names.get(m.from_agent), names.get(m.to_agent), m.type]);
    expect(convo).toEqual([
      ["chat", "planner", "task"],
      ["planner", "grok", "task"],
      ["grok", "planner", "question"],
      ["planner", "grok", "answer"],
      ["grok", "planner", "result"],
    ]);
    expect((await getThread(db, id)).status).toBe("done");

    // Grok worked from the full handoff that crossed its line.
    const first = grok.inputs[0];
    expect(first.goal).toBe(HANDOFF.goal);
    expect(first.context).toMatchObject({ plan: HANDOFF.plan, decisions: HANDOFF.decisions, links: HANDOFF.links });
    expect(first.conversation).toEqual([{ from: "planner", type: "task", body: HANDOFF.instruction }]);
    // On the second call it saw its own question and the planner's answer.
    expect(grok.inputs[1].conversation.map((m) => [m.from, m.type])).toEqual([["planner", "task"], ["you", "question"], ["planner", "answer"]]);
    expect(grok.inputs[1].conversation[2].body).toContain("Acme, Globex and Initech");
  });

  it("keeps the chat current: the next call reports what the agents did since", async () => {
    const { call } = await connect();
    await call("start_thread", { ...HANDOFF, to: ["Grok"] });
    await hub.router.idle();

    const { text } = await call("catch_up");
    expect(text).toContain("Planner answered Grok without you");
    expect(text).toContain("Grok delivered to Planner");
    expect(text).toContain("Done. Every agent reported back (1 of 1).");
    expect(text).toContain("No open threads.");

    // Seen once, not again.
    const again = await call("list_agents");
    expect(again.text).toContain("--- Since you last checked ---\nNothing new.");
  });

  it("keeps a separate last-seen marker per chat app", async () => {
    const claude = await connect("claude-ai");
    await claude.call("start_thread", { ...HANDOFF, to: ["Grok"] });
    await hub.router.idle();
    await claude.call("catch_up");

    const code = await connect("claude-code");
    const { text } = await code.call("catch_up");
    expect(text).toContain("You handed the Planner");
    expect(text).toContain("Grok delivered to Planner");
  });
});

describe("questions only the user can answer", () => {
  it("lands on waiting_on_me; the user's answer from the chat gets the work moving again", async () => {
    const { call } = await connect();
    const started = await call("start_thread", {
      ...HANDOFF, title: "Launch brief", to: ["ChatGPT"], open_questions: ["Should the brief be one page or two?"],
    });
    await hub.router.idle();
    const id = threadId(started.text);
    expect((await getThread(db, id)).status).toBe("waiting_on_user");

    const waiting = await call("waiting_on_me");
    expect(waiting.text).toContain("[Launch brief] Should the brief be one page or two?");
    const questionId = waiting.text.match(/question id ([0-9a-f-]{36})/)![1];

    const answered = await call("answer_question", { question_id: questionId, answer: "One page." });
    expect(answered.text).toContain("Answered.");
    await hub.router.idle();

    expect((await getThread(db, id)).status).toBe("done");
    expect(chatgpt.inputs.at(-1)!.conversation.at(-1)).toEqual({ from: "planner", type: "answer", body: "One page." });
    expect((await getThread(db, id)).context.user_answers).toEqual([{ question: "Should the brief be one page or two?", answer: "One page." }]);
  });

  it("won't take an answer for a question that isn't open", async () => {
    const { call } = await connect();
    const res = await call("answer_question", { question_id: "00000000-0000-0000-0000-000000000000", answer: "x" });
    expect(res.isError).toBe(true);
  });
});

describe("adding to a thread", () => {
  it("records new decisions and picks a finished thread back up with new work", async () => {
    const { call } = await connect();
    const started = await call("start_thread", { ...HANDOFF, to: ["Grok"] });
    await hub.router.idle();
    const id = threadId(started.text);

    const res = await call("send_message", {
      thread_id: id, message: "Now draft the launch brief from Grok's research.", to: ["ChatGPT"],
      new_decisions: ["The brief is for the internal team."],
    });
    expect(res.isError).toBe(false);
    await hub.router.idle();

    const thread = await getThread(db, id);
    expect(thread.context.decisions).toEqual([...HANDOFF.decisions, "The brief is for the internal team."]);
    expect(thread.status).toBe("done");
    expect(chatgpt.inputs[0].context.decisions).toContain("The brief is for the internal team.");
    const types = (await messagesForThread(db, id)).map((m) => m.type);
    expect(types.filter((t) => t === "result")).toHaveLength(2);
  });
});

describe("lines decide who can be reached", () => {
  it("drops an agent from the chat's reach as soon as its line is switched off", async () => {
    const { call } = await connect();
    const line = await db.query(`SELECT id FROM lines WHERE from_node = $1 AND to_node = $2`, [hub.planner.id, hub.workers[0].id]);
    await setLineEnabled(db, line.rows[0].id, false);

    expect((await call("list_agents")).text).not.toContain("Grok");
    const res = await call("start_thread", { ...HANDOFF, to: ["Grok"] });
    expect(res.isError).toBe(true);
  });
});

describe("the hub's web endpoints", () => {
  it("turns away the wrong token", async () => {
    expect((await fetch(url("/mcp/wrong-token"), { method: "POST", body: "{}" })).status).toBe(404);
    expect((await fetch(url("/board/wrong-token"))).status).toBe(404);
  });

  it("serves the board and its live state", async () => {
    const page = await fetch(url(`/board/${TOKEN}`));
    expect(await page.text()).toContain("Waiting on you");

    const { call } = await connect();
    await call("start_thread", { ...HANDOFF, title: "Launch brief", to: ["ChatGPT"], open_questions: ["Should the brief be one page or two?"] });
    await hub.router.idle();

    const state = await (await fetch(url(`/board/${TOKEN}/state`))).json();
    expect(state.agents.map((a: { name: string }) => a.name)).toEqual(["Your Claude chat", "Planner", "Grok", "ChatGPT"]);
    expect(state.lines.map((l: { label: string }) => l.label)).toEqual(["whole handoff", "everything", "everything"]);
    expect(state.agents.find((a: { name: string }) => a.name === "Planner").status).toBe("waiting");
    expect(state.waiting[0]).toMatchObject({ thread: "Launch brief", question: "Should the brief be one page or two?" });
    expect(state.thread.feed.map((m: { type: string }) => m.type)).toEqual(["task", "task", "question"]);
    expect(state.stats).toEqual({ answeredWithoutYou: 0, youWereNeeded: 1 });
  });
});
