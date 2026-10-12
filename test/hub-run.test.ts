// The hub-run worker (Grok, ChatGPT) on its own: the OpenAI-compatible client
// both vendors speak, and the adapter's question limit.

import { describe, expect, it } from "vitest";
import { HubRunAdapter } from "../src/adapters/hub-run.js";
import type { Db } from "../src/db/pool.js";
import type { Thread } from "../src/types.js";
import type { WorkerInput } from "../src/workers/model.js";
import { OpenAICompatibleWorker } from "../src/workers/openai-compatible.js";

const input: WorkerInput = {
  agent: { name: "Grok", role: "Research" },
  goal: "Price the team plan.",
  context: { plan: "Research competitor pricing.", decisions: ["US only."] },
  conversation: [{ from: "planner", type: "task", body: "Research competitor pricing." }],
  questionsLeft: 2,
};

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("OpenAI-compatible worker", () => {
  it("asks for a structured reply and reads it", async () => {
    const { f, calls } = fakeFetch(200, { choices: [{ message: { content: JSON.stringify({ action: "result", body: "Acme: $10/seat." }) } }] });
    const worker = new OpenAICompatibleWorker({ baseUrl: "https://api.x.ai/v1/", apiKey: "k", model: "grok-4.7", fetch: f });
    expect(await worker.respond(input)).toEqual({ action: "result", body: "Acme: $10/seat." });

    expect(calls[0].url).toBe("https://api.x.ai/v1/chat/completions");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer k");
    const sent = JSON.parse(String(calls[0].init.body));
    expect(sent.model).toBe("grok-4.7");
    expect(sent.response_format.type).toBe("json_schema");
    expect(sent.messages[0].content).toContain("You are Grok");
    expect(sent.messages[1].content).toContain('"decisions"');
  });

  it("throws on an HTTP error or an unreadable reply", async () => {
    const http = new OpenAICompatibleWorker({ baseUrl: "https://x", apiKey: "k", model: "m", fetch: fakeFetch(401, "bad key").f });
    await expect(http.respond(input)).rejects.toThrow(/HTTP 401: bad key/);
    const junk = new OpenAICompatibleWorker({ baseUrl: "https://x", apiKey: "k", model: "m",
      fetch: fakeFetch(200, { choices: [{ message: { content: "not json" } }] }).f });
    await expect(junk.respond(input)).rejects.toThrow(/could not be read/);
  });
});

describe("hub-run adapter", () => {
  const thread = { id: "t", goal: "Price it" } as Thread;
  const collect = async (adapter: HubRunAdapter, ref: { externalRef: string }) => {
    const out = [];
    for await (const e of adapter.events(ref)) out.push(e);
    return out;
  };

  it("turns a model failure into an error event instead of hanging", async () => {
    const adapter = new HubRunAdapter({
      db: {} as Db, name: "Grok", role: "Research",
      model: { label: "x", respond: async () => { throw new Error("rate limited"); } },
    });
    const ref = await adapter.send(thread, { messageId: "m", type: "task", body: "Go", context: {}, fromAgentId: "p", toAgentId: "g" });
    expect(await collect(adapter, ref)).toEqual([{ kind: "error", body: "rate limited" }]);
  });

  it("stops an agent that keeps asking past its limit", async () => {
    const adapter = new HubRunAdapter({
      db: {} as Db, name: "Grok", role: "Research", maxQuestions: 0,
      model: { label: "x", respond: async () => ({ action: "question", body: "Again?" }) },
    });
    const ref = await adapter.send(thread, { messageId: "m", type: "task", body: "Go", context: {}, fromAgentId: "p", toAgentId: "g" });
    expect(await collect(adapter, ref)).toEqual([{ kind: "error", body: "Kept asking questions past its limit of 0." }]);
  });
});
