import { Command, CommanderError } from "commander";
import { MiosotisError } from "../domain/errors.js";
import { VERSION } from "../version.js";
import { registerArtifact } from "./commands/artifact.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerEnrich } from "./commands/enrich.js";
import { registerEvidence } from "./commands/evidence.js";
import { registerInit } from "./commands/init.js";
import { registerIntents } from "./commands/intents.js";
import { registerProject } from "./commands/project.js";
import { registerSave, type SaveOptions, saveAction } from "./commands/save.js";
import { registerSearch } from "./commands/search.js";
import { registerSource } from "./commands/source.js";
import { emitError, type OutputStreams, processStreams } from "./output/result.js";
import { type CliRuntime, runCommand } from "./runtime.js";

export function buildProgram(runtime: CliRuntime): Command {
  const program = new Command("miosotis")
    .description('Local-first, AI-managed personal knowledge. `miosotis "a thought"` saves it.')
    .version(VERSION, "-V, --version")
    .enablePositionalOptions()
    .showSuggestionAfterError(false)
    .exitOverride()
    .configureOutput({
      writeOut: (text) => runtime.streams.stdout(text),
      writeErr: (text) => runtime.streams.stderr(text),
    });

  registerInit(program, runtime);
  registerDoctor(program, runtime);
  registerSave(program, runtime);
  registerSource(program, runtime);
  registerProject(program, runtime);
  registerSearch(program, runtime);
  registerEnrich(program, runtime);
  registerEvidence(program, runtime);
  registerArtifact(program, runtime);
  registerIntents(program, runtime);

  // Default action: free text is a save shortcut. Exact subcommands always take precedence.
  program
    .argument("[text...]", "text to save")
    .option("--project <slug>", "working context for the saved text")
    .option("--json", "print a JSON result envelope")
    .action(async (words: string[], options: SaveOptions) => {
      if (words.length === 0) {
        program.outputHelp();
        return;
      }
      await runCommand(runtime, options.json, () => {
        guardAgainstCommandTypo(program, words);
        return saveAction(runtime, words, options);
      });
    });

  return program;
}

/** A lone word close to a command name is far more likely a typo than a thought worth saving. */
function guardAgainstCommandTypo(program: Command, words: string[]): void {
  if (words.length !== 1) {
    return;
  }
  const word = words[0] ?? "";
  if (!/^[a-z-]{3,}$/.test(word)) {
    return;
  }
  // Short command names get a tighter threshold so ordinary words ("love", "same") still save.
  const suggestion = program.commands
    .map((command) => command.name())
    .find((name) => editDistance(name, word) <= (name.length <= 4 ? 1 : 2));
  if (suggestion !== undefined) {
    throw new MiosotisError(
      "usage",
      `Unknown command "${word}". Did you mean \`miosotis ${suggestion}\`? To save this word as text, use \`miosotis save ${word}\`.`,
    );
  }
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j] ?? 0;
      row[j] = Math.min(current + 1, (row[j - 1] ?? 0) + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length] ?? 0;
}

export async function runCli(
  argv: string[],
  options: { env?: NodeJS.ProcessEnv; streams?: OutputStreams; now?: () => Date } = {},
): Promise<number> {
  const runtime: CliRuntime = {
    env: options.env ?? process.env,
    streams: options.streams ?? processStreams,
    now: options.now ?? (() => new Date()),
    exitCode: 0,
  };
  const program = buildProgram(runtime);
  try {
    await program.parseAsync(argv, { from: "user" });
    return runtime.exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version" ||
        error.code === "commander.help"
      ) {
        return 0;
      }
      const json = argv.includes("--json");
      if (json) {
        return emitError(new MiosotisError("usage", error.message.replace(/^error:\s*/i, "")), true, runtime.streams);
      }
      return 2;
    }
    return emitError(error, argv.includes("--json"), runtime.streams);
  }
}
