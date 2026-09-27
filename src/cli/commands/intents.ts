import type { Command } from "commander";
import { MiosotisError } from "../../domain/errors.js";
import { type CliRuntime, type JsonOption, runCommand } from "../runtime.js";

const INTENTS = {
  review: "Find the relevant material and organize it so I can see it",
  analysis: "Answer an interpretive question from the evidence",
  discuss: "Recover the relevant context and continue thinking",
} as const;

/**
 * High-level intents need an inference runner. v0.1 has none of its own: the Skill (running inside an
 * AI host such as Claude Code) performs these through the lower-level protocol. Say so honestly.
 */
export function registerIntents(program: Command, runtime: CliRuntime): void {
  for (const [intent, description] of Object.entries(INTENTS)) {
    program
      .command(intent)
      .description(`${description} (requires an AI host in v0.1)`)
      .argument("[request...]", "what you want")
      .option("--project <slug>", "working context")
      .option("--json", "print a JSON result envelope")
      .action(async (_words: string[], options: JsonOption) => {
        await runCommand(runtime, options.json, () => {
          throw new MiosotisError(
            "capability_unavailable",
            `\`miosotis ${intent}\` needs an AI model, and this version has no built-in model runner. Ask your AI host (for example Claude Code with the miosotis Skill) to ${intent} instead; saving and searching work without AI.`,
            { intent, hint: "Use the miosotis Skill in Claude Code or Codex." },
          );
        });
      });
  }
}
