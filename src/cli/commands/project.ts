import type { Command } from "commander";
import { createProject, listProjectViews } from "../../app/projects.js";
import { type CliRuntime, inLibrary, type JsonOption, runCommand } from "../runtime.js";

export function registerProject(program: Command, runtime: CliRuntime): void {
  const project = program.command("project").description("Optional working contexts");

  project
    .command("list")
    .description("List projects with their visible Source counts")
    .option("--json", "print a JSON result envelope")
    .action(async (options: JsonOption) => {
      await runCommand(runtime, options.json, () => {
        const projects = inLibrary(runtime, (context) => listProjectViews(context));
        const lines = projects.map((row) => `${row.slug}  ${row.name}  (${row.source_count} sources)  ${row.id}`);
        return { data: { projects }, human: lines.length > 0 ? lines.join("\n") : "No projects yet." };
      });
    });

  project
    .command("create")
    .description("Create a project explicitly (saving with --project also creates one)")
    .argument("<slug>", "short name in any script")
    .option("--name <name>", "display name")
    .option("--description <text>", "user-authored description")
    .option("--json", "print a JSON result envelope")
    .action(async (slug: string, options: JsonOption & { name?: string; description?: string }) => {
      await runCommand(runtime, options.json, () => {
        const created = inLibrary(runtime, (context) =>
          createProject(context, { slug, name: options.name, description: options.description }),
        );
        return { data: created, human: `Created project ${created.slug} (${created.id})` };
      });
    });
}
