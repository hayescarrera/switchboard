// A stand-in worker for running the hub without an xAI or OpenAI key. It asks
// the planner one question (so you can watch an agent-to-agent question get
// answered), then returns a clearly labelled placeholder result.

import type { WorkerInput, WorkerModel, WorkerReply } from "./model.js";

export class StandInWorker implements WorkerModel {
  readonly label: string = "stand-in";
  constructor(private readonly opts: { askFirst?: boolean; delayMs?: number } = {}) {}

  async respond(input: WorkerInput): Promise<WorkerReply> {
    if (this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs));
    const answers = input.conversation.filter((m) => m.type === "answer");
    const task = input.conversation.find((m) => m.type === "task")?.body ?? "the task";
    if ((this.opts.askFirst ?? true) && answers.length === 0 && input.questionsLeft > 0) {
      const open = input.context.open_questions?.[0];
      return { action: "question", body: open ?? `Before I start on "${task}": is there a decision I should follow?` };
    }
    const went = answers.length ? ` Went with: ${answers[answers.length - 1].body}` : "";
    return {
      action: "result",
      body: `[Stand-in ${input.agent.name}: add an API key for the real one] Done: ${task.replace(/[.\s]+$/, "")}.${went}`,
    };
  }
}
