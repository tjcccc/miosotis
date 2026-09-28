import { type Command, Option } from "commander";
import { resumePurge } from "../../app/purge.js";
import { emptyTrash, removeItems, restoreItems, trashList } from "../../app/trash.js";
import { MiosotisError } from "../../domain/errors.js";
import { type CliRuntime, inLibrary, type JsonOption, runCommand } from "../runtime.js";

export function registerTrash(program: Command, runtime: CliRuntime): void {
  program
    .command("remove")
    .description("Move Sources and/or artifacts to the trash (reversible with `restore`)")
    .argument("<ids...>", "S-<id> and/or A-<id>")
    .option("--with-artifacts", "also move the artifacts that cite these Sources")
    .option("--confirm", "confirm the action")
    .option("--json", "print a JSON result envelope")
    .action(async (ids: string[], options: JsonOption & { withArtifacts?: boolean; confirm?: boolean }) => {
      await runCommand(runtime, options.json, () => {
        const result = inLibrary(runtime, (context) =>
          removeItems(context, ids, {
            withArtifacts: options.withArtifacts === true,
            confirm: options.confirm === true,
          }),
        );
        const moved = [...result.removed.sources, ...result.removed.artifacts];
        const lines = [
          moved.length > 0 ? `Moved to the trash: ${moved.join(", ")}` : "Nothing moved.",
          ...(result.already_in_trash.length > 0
            ? [`Already in the trash: ${result.already_in_trash.join(", ")}`]
            : []),
          ...(result.kept_citing_artifacts.length > 0
            ? [`Still citing them (kept, with a notice): ${result.kept_citing_artifacts.join(", ")}`]
            : []),
          result.note,
        ];
        return { data: result, human: lines.join("\n") };
      });
    });

  program
    .command("restore")
    .description("Bring items back from the trash (all of them with no IDs, after --confirm)")
    .argument("[ids...]", "S-<id> and/or A-<id>")
    .option("--confirm", "confirm restoring everything in the trash")
    .addOption(new Option("--data-dir <path>").hideHelp())
    .option("--json", "print a JSON result envelope")
    .action(async (ids: string[], options: JsonOption & { confirm?: boolean; dataDir?: string }) => {
      await runCommand(runtime, options.json, () => {
        if (options.dataDir !== undefined) {
          throw new MiosotisError(
            "usage",
            `Backups are restored with \`miosotis backup restore ${ids[0] ?? "<dir>"} --data-dir ${options.dataDir}\`; \`miosotis restore\` brings items back from the trash.`,
          );
        }
        const result = inLibrary(runtime, (context) =>
          restoreItems(context, ids, { confirm: options.confirm === true }),
        );
        const back = [...result.restored.sources, ...result.restored.artifacts];
        const lines = [
          back.length > 0 ? `Restored: ${back.join(", ")}` : "Nothing restored.",
          ...(result.not_in_trash.length > 0 ? [`Not in the trash: ${result.not_in_trash.join(", ")}`] : []),
        ];
        return { data: result, human: lines.join("\n") };
      });
    });

  const trash = program.command("trash").description("See, restore, or permanently empty the trash");

  trash
    .command("list")
    .description("List trashed Sources and artifacts, newest first")
    .option("--json", "print a JSON result envelope")
    .action(async (options: JsonOption) => {
      await runCommand(runtime, options.json, () => {
        const result = inLibrary(runtime, (context) => trashList(context));
        const lines = [
          ...result.sources.map(
            (row) =>
              `${row.id}  ${row.trashed_at}  ${row.label}${row.cited_by.length > 0 ? `  (cited by ${row.cited_by.join(", ")})` : ""}`,
          ),
          ...result.artifacts.map((row) => `${row.id}  ${row.trashed_at ?? ""}  ${row.label}`),
        ];
        return { data: result, human: lines.join("\n") || "The trash is empty." };
      });
    });

  trash
    .command("empty")
    .description("Permanently delete trashed items (all of them with no IDs); shows a plan first")
    .argument("[ids...]", "trashed S-<id> and/or A-<id>")
    .option("--keep-artifacts", "keep artifacts outside the trash that cite these Sources")
    .option("--confirm", "apply the reviewed plan")
    .option("--plan <id>", "the plan ID shown by the review (required with --confirm)")
    .option("--resume", "finish an interrupted deletion (erase pending files, compact the database)")
    .option("--json", "print a JSON result envelope")
    .action(
      async (
        ids: string[],
        options: JsonOption & { keepArtifacts?: boolean; confirm?: boolean; plan?: string; resume?: boolean },
      ) => {
        await runCommand(runtime, options.json, () => {
          if (options.resume === true) {
            if (ids.length > 0) {
              throw new MiosotisError("usage", "--resume takes no IDs");
            }
            const result = inLibrary(runtime, (context) => resumePurge(context));
            return {
              data: result,
              human: `Erased ${result.files_erased} pending file(s) and ${result.folders_removed} folder(s); database ${result.compacted ? "compacted" : "not compacted yet"}.`,
              warnings: result.warnings,
            };
          }
          const result = inLibrary(runtime, (context) =>
            emptyTrash(context, ids, {
              keepArtifacts: options.keepArtifacts === true,
              confirm: options.confirm === true,
              plan: options.plan,
            }),
          );
          const lines =
            result.plan_id === ""
              ? [result.note]
              : [
                  `Deleted permanently: ${result.purged.sources.length} Source(s), ${result.purged.artifacts.length} artifact(s), ${result.purged.datasets.length} dataset(s); erased ${result.files_erased} file(s).`,
                  ...(result.kept_artifacts.length > 0
                    ? [`Kept (may still quote them): ${result.kept_artifacts.join(", ")}`]
                    : []),
                  ...result.warnings,
                  result.note,
                ];
          return { data: result, human: lines.join("\n"), warnings: result.warnings };
        });
      },
    );
}
