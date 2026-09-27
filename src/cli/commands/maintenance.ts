import type { Command } from "commander";
import { createBackup, restoreBackup, verifyBackup } from "../../app/backup.js";
import { withContextAsync } from "../../app/context.js";
import { installSkill, skillStatus, uninstallSkill } from "../../app/skill.js";
import { undoLastCapture } from "../../app/undo.js";
import { loadConfig } from "../../infra/config/config.js";
import { type CliRuntime, inLibrary, type JsonOption, runCommand } from "../runtime.js";

export function registerBackup(program: Command, runtime: CliRuntime): void {
  const backup = program.command("backup").description("Consistent library backups (backup is not live sync)");

  backup
    .command("create")
    .description("Write a verified snapshot folder to --output or [backup].dir (a cloud-synced folder is fine)")
    .option("--output <dir>", "destination folder")
    .option("--json", "print a JSON result envelope")
    .action(async (options: JsonOption & { output?: string }) => {
      await runCommand(runtime, options.json, async () => {
        const result = await withContextAsync({ env: runtime.env, now: runtime.now }, (context) =>
          createBackup(context, { output: options.output }),
        );
        const counts = result.manifest.counts;
        return {
          data: result,
          human: `Backup written and verified: ${result.path}\n${counts.sources} sources, ${counts.artifacts} artifacts, schema v${result.manifest.schema_version}`,
        };
      });
    });

  backup
    .command("verify")
    .description("Check a backup folder's manifest, hash, and integrity")
    .argument("<dir>")
    .option("--json", "print a JSON result envelope")
    .action(async (directory: string, options: JsonOption) => {
      await runCommand(runtime, options.json, () => {
        const result = verifyBackup(directory);
        return {
          data: result,
          human: `Backup OK: ${result.path} (${result.manifest.created_at}, schema v${result.manifest.schema_version})`,
        };
      });
    });

  program
    .command("restore")
    .description("Restore a backup into a new, empty data folder (never over the live library)")
    .argument("<dir>", "backup folder")
    .requiredOption("--data-dir <path>", "new, empty folder for the restored library")
    .option("--json", "print a JSON result envelope")
    .action(async (directory: string, options: JsonOption & { dataDir: string }) => {
      await runCommand(runtime, options.json, () => {
        const result = restoreBackup(directory, { dataDir: options.dataDir, env: runtime.env });
        return {
          data: result,
          human: `Restored to ${result.data_dir} (schema v${result.schema_version}).\n${result.next_step}`,
        };
      });
    });
}

export function registerSkill(program: Command, runtime: CliRuntime): void {
  const skill = program.command("skill").description("Install the miosotis Skill into an AI host");

  skill
    .command("install")
    .description("Symlink the Skill into the host's personal skills folder")
    .requiredOption("--host <host>", "claude-code | codex")
    .option("--yes", "confirm writing into the host's skills folder")
    .option("--json", "print a JSON result envelope")
    .action(async (options: JsonOption & { host: string; yes?: boolean }) => {
      await runCommand(runtime, options.json, () => {
        const result = installSkill({ host: options.host, yes: options.yes === true, env: runtime.env });
        return {
          data: result,
          human: `${result.changed ? "Installed" : "Already installed"}: ${result.target} -> ${result.source}\n${result.next_step}`,
        };
      });
    });

  skill
    .command("uninstall")
    .description("Remove the Skill symlink (never touches anything else)")
    .requiredOption("--host <host>", "claude-code | codex")
    .option("--json", "print a JSON result envelope")
    .action(async (options: JsonOption & { host: string }) => {
      await runCommand(runtime, options.json, () => {
        const result = uninstallSkill({ host: options.host, env: runtime.env });
        return {
          data: result,
          human: result.changed ? `Removed ${result.target}` : `Nothing installed at ${result.target}`,
        };
      });
    });

  skill
    .command("status")
    .description("Show where the Skill is installed")
    .option("--json", "print a JSON result envelope")
    .action(async (options: JsonOption) => {
      await runCommand(runtime, options.json, () => {
        const status = skillStatus({ env: runtime.env });
        return {
          data: status,
          human: [`source: ${status.source}`, ...status.hosts.map((h) => `${h.label}: ${h.state} (${h.target})`)].join(
            "\n",
          ),
        };
      });
    });
}

export function registerUndo(program: Command, runtime: CliRuntime): void {
  program
    .command("undo")
    .description("Take back the most recent save (moves it to the trash; reversible with source restore)")
    .option("--confirm", "confirm the action")
    .option("--json", "print a JSON result envelope")
    .action(async (options: JsonOption & { confirm?: boolean }) => {
      await runCommand(runtime, options.json, () => {
        const result = inLibrary(runtime, (context) => undoLastCapture(context, { confirm: options.confirm === true }));
        const lines = [
          `${result.changed ? "Undid" : "Nothing changed for"} the capture from ${result.captured_at}:`,
          ...result.sources.map((source) => `  ${source.ref}  [${source.retention}]  ${source.preview}`),
          result.note,
        ];
        return { data: result, human: lines.join("\n") };
      });
    });
}

export function registerPrefs(program: Command, runtime: CliRuntime): void {
  program
    .command("prefs")
    .description("Show user preferences AI hosts should follow (reply language, timezone)")
    .option("--json", "print a JSON result envelope")
    .action(async (options: JsonOption) => {
      await runCommand(runtime, options.json, () => {
        const config = loadConfig(runtime.env);
        const data = {
          language: config.language ?? null,
          language_rule:
            config.language === undefined
              ? "Reply in the language the user writes in."
              : `Reply, and write titles, abstracts, and artifacts, in ${config.language} unless the user asks otherwise. Never translate saved text.`,
          timezone: config.timezone,
        };
        return { data, human: `language: ${data.language ?? "(follow the user)"}\ntimezone: ${data.timezone}` };
      });
    });
}
