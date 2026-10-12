// The MCP connector (CLAUDE.md 6.4): the tools a chat app (Claude app, Claude
// Code, ...) uses to hand work to Ben's other agents and to see what they did.
//
// Two honest limits shape it. The connector only gets what the chat's model
// puts in a tool call, so start_thread demands a full, structured handoff and
// rejects thin ones. And the hub can't type into the chat, so every response
// ends with a "since you last checked" digest, and the tool descriptions tell
// the model to check in before it talks about handed-off work.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCursor, happeningsSince, latestEventId, renderDigest, setCursor } from "../digest.js";
import type { Hub } from "../hub.js";
import { addToContext, createThread, getThread, messagesForThread, openEscalations } from "../store.js";
import type { Agent, Thread } from "../types.js";

const CHECK_IN = "Before you say anything about work handed off through Switchboard, call catch_up (or get_thread): " +
  "other agents may have moved it on since you last looked. Never assume the state you last saw is still true.";

export const SERVER_INSTRUCTIONS = `Switchboard lets this chat hand work to the user's other AI agents (for example Grok \
for research, ChatGPT for writing) and keeps them talking to each other without the user copying and pasting. \
A planner agent on the hub takes over each thread you start: it hands the task on, answers the agents' questions \
from your handoff, and asks the user only when it can't. ${CHECK_IN}`;

const Handoff = {
  goal: z.string().describe("What the user is trying to get done, in a sentence or two."),
  summary: z.string().describe(
    "What the conversation covered so far: the background, what was tried or ruled out, and why this work matters. " +
    "Several sentences. The receiving agents have never seen this chat."),
  plan: z.string().describe("The plan or approach agreed in the conversation, step by step if there was one."),
  decisions: z.array(z.string()).describe(
    "Every decision the user made or agreed to (scope, format, audience, tone, tools, what's out). One per item."),
  constraints: z.array(z.string()).describe("Limits: deadlines, budget, length, must-use or must-avoid, style."),
  open_questions: z.array(z.string()).describe("Things still undecided. Empty only if nothing is open."),
  links: z.array(z.string()).describe("URLs, file names and other artifacts mentioned. Empty if none."),
};

type HandoffInput = { [K in keyof typeof Handoff]: z.infer<(typeof Handoff)[K]> };

/** Why a handoff is too thin to work from, or an empty list if it's fine. */
export function handoffProblems(h: HandoffInput): string[] {
  const problems: string[] = [];
  const filled = (xs: string[]) => xs.filter((x) => x.trim().length > 0);
  if (h.goal.trim().length < 15) problems.push("goal: say what the user is trying to get done, in a full sentence.");
  if (h.summary.trim().length < 80) problems.push("summary: a few sentences on what the conversation covered; the other agents have never seen it.");
  if (h.plan.trim().length < 40) problems.push("plan: the approach agreed in the conversation, not a one-liner.");
  if (filled(h.decisions).length + filled(h.constraints).length === 0) {
    problems.push("decisions / constraints: list what the user decided and any limits they set. If the conversation " +
      "truly made none, add one decision that says so and what the agents may choose for themselves.");
  }
  return problems;
}

export function createConnector(hub: Hub, client: () => string): McpServer {
  const server = new McpServer({ name: "switchboard", version: "0.3.0" }, { instructions: SERVER_INSTRUCTIONS });
  const { db, router, user, chat, planner } = hub;

  /** The tool's own text, then whatever changed since this chat last checked. */
  const respond = async (text: string, opts: { digest?: boolean } = {}) => {
    const key = client();
    const upTo = await latestEventId(db);
    const items = await happeningsSince(db, await getCursor(db, key), upTo);
    await setCursor(db, key, upTo);
    const digest = opts.digest === false ? "" : `\n\n--- Since you last checked ---\n${renderDigest(items)}`;
    return { content: [{ type: "text" as const, text: text + digest }] };
  };
  const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

  /** Agents the planner has a working line to: who this chat can hand work to. */
  const reachable = async (): Promise<Agent[]> => {
    const { rows } = await db.query<Agent>(
      `SELECT a.* FROM lines l JOIN agents a ON a.id = l.to_node
       WHERE l.from_node = $1 AND l.enabled AND a.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM line_owners o WHERE o.line_id = l.id AND o.accepted_at IS NULL)
       ORDER BY a.created_at`,
      [planner.id],
    );
    return rows;
  };
  const resolveTargets = async (names: string[]) => {
    const options = await reachable();
    const picked: Agent[] = [];
    const unknown: string[] = [];
    for (const name of names) {
      const a = options.find((o) => o.name.toLowerCase() === name.trim().toLowerCase());
      if (a) { if (!picked.includes(a)) picked.push(a); } else unknown.push(name);
    }
    return { picked, unknown, options };
  };
  const findThread = async (id: string): Promise<Thread | null> => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    try { return await getThread(db, id); } catch { return null; }
  };
  const describeAgent = (a: Agent) =>
    `- ${a.name}: ${a.card.description ?? a.vendor} (running on ${hub.modelLabels[a.id] ?? a.vendor})`;

  server.registerTool("list_agents", {
    title: "List agents",
    description: "The agents this chat can hand work to through Switchboard, and what each is for. " + CHECK_IN,
    inputSchema: {},
  }, async () => {
    const agents = await reachable();
    return respond(agents.length
      ? `You can hand work to:\n${agents.map(describeAgent).join("\n")}\n\nThe Planner (Claude on the hub) holds ` +
        `your handoff and answers their questions for you.`
      : "No agents are connected to the planner yet. Draw a line on the board first.");
  });

  server.registerTool("start_thread", {
    title: "Hand work to another agent",
    description:
      "Hand a piece of work to one or more of the user's other agents (see list_agents), with a complete, " +
      "structured handoff of THIS conversation. The agents never see this chat: they work only from what you " +
      "pass here, and the Planner answers their questions from it. So fill every field fully from the " +
      "conversation (goal, a real summary, the plan, every decision and constraint, open questions, links). " +
      "Thin handoffs are rejected. Returns a thread id; the work carries on without this chat. " + CHECK_IN,
    inputSchema: {
      title: z.string().describe("A short name for the thread, a few words."),
      to: z.array(z.string()).min(1).describe("Agent names from list_agents, e.g. [\"Grok\"]."),
      instruction: z.string().describe("What the agents should do, as you'd brief a colleague."),
      ...Handoff,
    },
  }, async (args) => {
    const problems = handoffProblems(args);
    if (args.instruction.trim().length < 15) problems.unshift("instruction: say what the agents should do.");
    if (problems.length) {
      return fail(`Handoff rejected: it's too thin for the other agents to work from. Fix these and call ` +
        `start_thread again:\n${problems.map((p) => `- ${p}`).join("\n")}`);
    }
    const { picked, unknown, options } = await resolveTargets(args.to);
    if (unknown.length || picked.length === 0) {
      return fail(`Not connected: ${unknown.join(", ")}. This chat can reach: ${options.map((o) => o.name).join(", ") || "nobody yet"}.`);
    }
    const thread = await createThreadFor(args);
    const sent = await router.send({
      threadId: thread.id, from: chat.id, to: planner.id, type: "task", body: args.instruction,
      routeTo: picked.map((a) => a.id),
    });
    if (!sent.delivered) return fail(`The hub wouldn't start it: ${sent.detail}`);
    return respond(`Started thread "${thread.title}" (id ${thread.id}). The Planner is handing it to ` +
      `${picked.map((a) => a.name).join(" and ")} now. They'll work without this chat; their questions go to the ` +
      `Planner, and anything only the user can answer shows up in waiting_on_me. Check back with catch_up.`);
  });

  async function createThreadFor(args: HandoffInput & { title: string }): Promise<Thread> {
    return createThread(db, {
      title: args.title, goal: args.goal, origin: client(),
      context: {
        summary: args.summary, plan: args.plan, decisions: args.decisions, constraints: args.constraints,
        open_questions: args.open_questions, links: args.links,
      },
    });
  }

  server.registerTool("send_message", {
    title: "Add to a thread",
    description:
      "Add to a thread you started: new decisions or constraints the user just gave (every agent reads them " +
      "from then on), and optionally more work for an agent. Picks a finished thread back up. " + CHECK_IN,
    inputSchema: {
      thread_id: z.string(),
      message: z.string().describe("What to tell the agents, or the new piece of work."),
      to: z.array(z.string()).optional().describe("Agent names to hand this to as new work. Leave out for a note only."),
      new_decisions: z.array(z.string()).optional(),
      new_constraints: z.array(z.string()).optional(),
    },
  }, async (args) => {
    const thread = await findThread(args.thread_id);
    if (!thread) return fail(`No thread with id ${args.thread_id}. catch_up lists your threads.`);
    if (thread.status === "waiting_on_user") {
      return fail("This thread is paused waiting on the user. Answer what's in waiting_on_me first.");
    }
    const targets = args.to?.length ? await resolveTargets(args.to) : null;
    if (targets && (targets.unknown.length || targets.picked.length === 0)) {
      return fail(`Not connected: ${targets.unknown.join(", ")}. This chat can reach: ${targets.options.map((o) => o.name).join(", ")}.`);
    }
    if (args.new_decisions?.length || args.new_constraints?.length) {
      await addToContext(db, thread.id, { decisions: args.new_decisions, constraints: args.new_constraints }, "chat");
    }
    const sent = await router.send({
      threadId: thread.id, from: chat.id, to: planner.id, type: targets ? "task" : "status", body: args.message,
      routeTo: targets?.picked.map((a) => a.id),
    });
    if (!sent.delivered) return fail(`The hub wouldn't send it: ${sent.detail}`);
    return respond(targets
      ? `Sent. The Planner is handing it to ${targets.picked.map((a) => a.name).join(" and ")}.`
      : "Added to the thread. Every agent on it reads it from now on.");
  });

  server.registerTool("get_thread", {
    title: "Read a thread",
    description: "A thread's current state and its whole conversation between agents. " + CHECK_IN,
    inputSchema: { thread_id: z.string() },
  }, async ({ thread_id }) => {
    const thread = await findThread(thread_id);
    if (!thread) return fail(`No thread with id ${thread_id}. catch_up lists your threads.`);
    const names = await agentNames();
    const messages = await messagesForThread(db, thread.id);
    const waiting = await openEscalations(db, thread.id);
    const c = thread.context;
    const lines = [
      `Thread "${thread.title}" (id ${thread.id}): ${statusText(thread)}`,
      `Goal: ${thread.goal}`,
      c.decisions?.length ? `Decisions:\n${c.decisions.map((d) => `- ${d}`).join("\n")}` : "",
      c.user_answers?.length ? `The user's answers so far:\n${c.user_answers.map((a) => `- ${a.question} → ${a.answer}`).join("\n")}` : "",
      `Conversation (${messages.length} messages):`,
      ...messages.map((m) => `- ${names.get(m.from_agent)} → ${names.get(m.to_agent)} [${m.type}]: ${m.body}`),
      waiting.length ? `Waiting on the user:\n${waiting.map((e) => `- ${e.question ?? e.summary} [question id ${e.id}]`).join("\n")}` : "",
    ];
    return respond(lines.filter(Boolean).join("\n"));
  });

  server.registerTool("catch_up", {
    title: "Catch up",
    description:
      "What changed in the user's Switchboard threads since this chat last checked (agents' questions and " +
      "answers, results delivered, threads finished, things waiting on the user), plus the threads still open. " +
      "Call this whenever the user asks how handed-off work is going, and before relying on anything you said earlier about it.",
    inputSchema: {},
  }, async () => {
    const key = client();
    const upTo = await latestEventId(db);
    const items = await happeningsSince(db, await getCursor(db, key), upTo);
    await setCursor(db, key, upTo);
    const open = await db.query<Thread>(
      `SELECT * FROM threads WHERE status <> 'done' ORDER BY created_at DESC LIMIT 20`);
    const waiting = await openEscalations(db);
    const text = [
      `Since you last checked:\n${renderDigest(items)}`,
      open.rows.length ? `Open threads:\n${open.rows.map((t) => `- "${t.title}" (id ${t.id}): ${statusText(t)}`).join("\n")}` : "No open threads.",
      waiting.length ? `${waiting.length} thing(s) waiting on the user; see waiting_on_me.` : "Nothing is waiting on the user.",
    ];
    return respond(text.join("\n\n"), { digest: false });
  });

  server.registerTool("waiting_on_me", {
    title: "Waiting on me",
    description: "Questions the agents couldn't settle without the user, newest first. Answer them with answer_question.",
    inputSchema: {},
  }, async () => {
    const waiting = await openEscalations(db);
    const titles = new Map((await db.query<{ id: string; title: string }>(`SELECT id, title FROM threads`)).rows.map((r) => [r.id, r.title]));
    return respond(waiting.length
      ? waiting.map((e) => `- [${titles.get(e.thread_id)}] ${e.question ?? e.summary} (${e.summary}) [question id ${e.id}]`).join("\n")
      : "Nothing is waiting on the user.");
  });

  server.registerTool("answer_question", {
    title: "Answer a question",
    description: "Give the user's answer to something on waiting_on_me. It goes to the agent that asked, the thread " +
      "carries on, and the Planner remembers it so it won't ask again. Only pass what the user actually said.",
    inputSchema: { question_id: z.string(), answer: z.string() },
  }, async ({ question_id, answer }) => {
    const open = (await openEscalations(db)).find((e) => e.id === question_id);
    if (!open) return fail(`No open question with id ${question_id}. waiting_on_me lists them.`);
    await router.answerEscalation({ escalationId: open.id, userId: user.id, answer });
    return respond("Answered. The thread is moving again.");
  });

  async function agentNames() {
    const { rows } = await db.query<{ id: string; name: string }>(`SELECT id, name FROM agents`);
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  return server;
}

function statusText(t: Thread): string {
  switch (t.status) {
    case "active": return "agents working";
    case "waiting_on_user": return "waiting on the user";
    case "done": return "done";
    default: return t.status;
  }
}
