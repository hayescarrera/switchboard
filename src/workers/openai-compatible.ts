// A worker on any OpenAI-compatible chat completions API. xAI (Grok) and
// OpenAI (ChatGPT) both speak it, with JSON-schema structured outputs, so one
// small client covers both. Plain fetch; no vendor SDK.

import { renderWorkerInput, WORKER_SYSTEM_PROMPT, type WorkerInput, type WorkerModel, type WorkerReply } from "./model.js";

const REPLY_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["question", "result"] },
    body: { type: "string" },
  },
  required: ["action", "body"],
  additionalProperties: false,
};

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
}

export class OpenAICompatibleWorker implements WorkerModel {
  readonly label: string;
  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.label = opts.model;
  }

  async respond(input: WorkerInput): Promise<WorkerReply> {
    const res = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify({
        model: this.opts.model,
        messages: [
          { role: "system", content: WORKER_SYSTEM_PROMPT(input) },
          { role: "user", content: renderWorkerInput(input) },
        ],
        response_format: { type: "json_schema", json_schema: { name: "reply", strict: true, schema: REPLY_SCHEMA } },
      }),
    });
    if (!res.ok) throw new Error(`${this.opts.model} returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string; refusal?: string } }[] };
    const msg = data.choices?.[0]?.message;
    if (msg?.refusal) throw new Error(`${this.opts.model} declined: ${msg.refusal}`);
    let parsed: WorkerReply;
    try {
      parsed = JSON.parse(msg?.content ?? "");
    } catch {
      throw new Error(`${this.opts.model}'s reply could not be read`);
    }
    if ((parsed.action !== "question" && parsed.action !== "result") || typeof parsed.body !== "string") {
      throw new Error(`${this.opts.model}'s reply was not in the expected shape`);
    }
    return parsed;
  }
}

export const xaiWorker = (apiKey: string, model = process.env.XAI_MODEL ?? "grok-4.7") =>
  new OpenAICompatibleWorker({ baseUrl: "https://api.x.ai/v1", apiKey, model });

export const openaiWorker = (apiKey: string, model = process.env.OPENAI_MODEL ?? "gpt-5") =>
  new OpenAICompatibleWorker({ baseUrl: "https://api.openai.com/v1", apiKey, model });
