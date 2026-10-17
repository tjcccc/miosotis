import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A stand-in for the `codex` executable, so tests never run the real Codex. Behavior follows
 * FAKE_CODEX_MODE: ok (default), tool (reports a shell command), invalid (answer breaks the
 * contract), fail (exits non-zero), signed_out (`login status` fails). Each exec call appends
 * its arguments and prompt to FAKE_CODEX_CALLS when set.
 */
const SCRIPT = `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_MODE || "ok";
if (args[0] === "login") {
  if (mode === "signed_out") { console.error("Not logged in"); process.exit(1); }
  console.error("Logged in using ChatGPT");
  process.exit(0);
}
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  if (process.env.FAKE_CODEX_CALLS) {
    appendFileSync(process.env.FAKE_CODEX_CALLS, JSON.stringify({ args, prompt, cwd: process.cwd() }) + "\\n");
  }
  const say = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
  say({ type: "thread.started", thread_id: "t" });
  if (mode === "fail") { say({ type: "turn.failed", error: { message: "usage limit reached" } }); process.exit(1); }
  if (mode === "tool") { say({ type: "item.completed", item: { type: "command_execution", command: "ls ~" } }); }
  const note = JSON.parse(prompt.trim().split("\\n").at(-1));
  const dentist = note.text.includes("Dentist");
  const answer = mode === "invalid"
    ? { title: "x", terms: "not a list" }
    : {
        title: note.text.slice(0, 40), abstract: null, language: "en", terms: ["fake-term", "假词"], entities: null,
        project_suggestions: [], assertions: null, cancels: null, warnings: null,
        events: dentist ? [{ title: "Dentist", start: { date: "2026-09-30", time: "15:00", part_of_day: null }, end: null,
          timezone: null, location: null, phrase: null, repeat: null, replaces: null, occurrence: null }] : null,
      };
  writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify(answer));
  say({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(answer) } });
  say({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20 } });
});
`;

export function installFakeCodex(directory: string): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "codex");
  writeFileSync(path, SCRIPT);
  chmodSync(path, 0o755);
  return path;
}
