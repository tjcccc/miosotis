import { writeFileSync } from "node:fs";
import type { Command } from "commander";
import {
  artifactSources,
  artifactView,
  createArtifact,
  exportArtifact,
  exportBundle,
  listArtifacts,
  materializeArtifact,
  openInBrowser,
  trashArtifact,
} from "../../app/artifacts.js";
import type { ArtifactRequestInput } from "../../contracts/artifact.js";
import { MiosotisError } from "../../domain/errors.js";
import { parseInteger, readRequestFile } from "../io.js";
import { type CliRuntime, inLibrary, type JsonOption, runCommand } from "../runtime.js";

export function registerArtifact(program: Command, runtime: CliRuntime): void {
  const artifact = program.command("artifact").description("Frozen, traceable outputs produced from evidence");

  artifact
    .command("create")
    .description("Validate and store a miosotis.artifact.v1 request (citations must come from its evidence run)")
    .requiredOption("--request-file <path>", "JSON file, or - for stdin")
    .option("--derived-from <A-id>", "record lineage to an earlier artifact (regeneration or follow-up)")
    .option("--supersedes", "mark --derived-from as replaced by the new artifact")
    .option("--assets <mode>", "html pages: embedded (self-contained, default) | linked (pinned allowlisted URLs)")
    .option("--json", "print a JSON result envelope")
    .action(
      async (
        options: JsonOption & { requestFile: string; derivedFrom?: string; supersedes?: boolean; assets?: string },
      ) => {
        await runCommand(runtime, options.json, async () => {
          const body = (await readRequestFile(options.requestFile)) as ArtifactRequestInput;
          const request: ArtifactRequestInput = {
            ...body,
            ...(options.derivedFrom === undefined ? {} : { derived_from: options.derivedFrom }),
            ...(options.supersedes === true ? { supersedes: true } : {}),
            ...(options.assets === undefined ? {} : { assets: options.assets as ArtifactRequestInput["assets"] }),
          };
          const result = inLibrary(runtime, (context) => {
            const receipt = createArtifact(context, request);
            const materialized = materializeArtifact(context, receipt.id);
            return { ...receipt, path: materialized.path };
          });
          return {
            data: result,
            human: `${result.replayed ? "Already stored" : "Stored"} ${result.id} · ${result.citations.length} citations\n${result.path}`,
            warnings: result.warnings,
          };
        });
      },
    );

  artifact
    .command("get")
    .description("Show an artifact's stored content, citations, lineage, and live provenance notices")
    .argument("<A-id>")
    .option("--no-content", "omit the Markdown body")
    .option("--json", "print a JSON result envelope")
    .action(async (id: string, options: JsonOption & { content: boolean }) => {
      await runCommand(runtime, options.json, () => {
        const view = inLibrary(runtime, (context) => artifactView(context, id, { includeContent: options.content }));
        const lines = [
          `${view.id} · ${view.intent} · ${view.format} · ${view.lifecycle} · ${view.finalized_at}`,
          view.title ?? "",
          ...view.notices.map((n) => `! ${n}`),
        ];
        if (options.content && view.markdown) {
          lines.push("", view.markdown);
        }
        return { data: view, human: lines.join("\n") };
      });
    });

  artifact
    .command("list")
    .description("List artifacts, newest first")
    .option("--all", "include trashed artifacts")
    .option("--limit <n>", "page size (max 200)", "50")
    .option("--cursor <cursor>", "continue from a previous page")
    .option("--json", "print a JSON result envelope")
    .action(async (options: JsonOption & { all?: boolean; limit: string; cursor?: string }) => {
      await runCommand(runtime, options.json, () => {
        const page = inLibrary(runtime, (context) =>
          listArtifacts(context, {
            all: options.all === true,
            limit: parseInteger(options.limit, "--limit"),
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
          }),
        );
        const lines = page.artifacts.map(
          (row) =>
            `${row.id}  ${row.finalized_at}  ${row.intent}${row.format === "html" ? " (html)" : ""}  ${row.title ?? ""}${row.notices > 0 ? `  (${row.notices} notices)` : ""}${row.lifecycle === "active" ? "" : `  [${row.lifecycle}]`}`,
        );
        lines.push(`${page.artifacts.length} of ${page.total}`);
        return { data: page, human: lines.join("\n") };
      });
    });

  artifact
    .command("sources")
    .description("Show the evidence an artifact cited (and what was retrieved but not cited)")
    .argument("<A-id>")
    .option("--json", "print a JSON result envelope")
    .action(async (id: string, options: JsonOption) => {
      await runCommand(runtime, options.json, () => {
        const result = inLibrary(runtime, (context) => artifactSources(context, id));
        const lines = result.cited.map(
          (row) => `[${row.handle}] ${row.ref}  now v${row.current_version} ${row.retention}/${row.inclusion}`,
        );
        return { data: result, human: lines.join("\n") || "No citations." };
      });
    });

  artifact
    .command("open")
    .description("Refresh the status banner and open the stored artifact (no model call)")
    .argument("<A-id>")
    .option("--no-launch", "only write the page and print its path")
    .option("--json", "print a JSON result envelope")
    .action(async (id: string, options: JsonOption & { launch: boolean }) => {
      await runCommand(runtime, options.json, () => {
        const result = inLibrary(runtime, (context) => materializeArtifact(context, id));
        if (options.launch) {
          openInBrowser(result.path);
        }
        return {
          data: { ...result, launched: options.launch },
          human: [result.path, ...result.notices.map((n) => `! ${n}`)].join("\n"),
        };
      });
    });

  artifact
    .command("export")
    .description(
      "Export stored content: md (Markdown body or summary), html (standalone viewer; rich pages stay sandboxed), json",
    )
    .argument("<A-id>")
    .option("--format <format>", "md | html | json | bundle (the whole folder, with files; needs --output)", "md")
    .option("--output <path>", "write to a file instead of stdout")
    .action(async (id: string, options: { format: string; output?: string }) => {
      await runCommand(runtime, false, () => {
        if (!["md", "html", "json", "bundle"].includes(options.format)) {
          throw new MiosotisError("usage", "--format must be md, html, json, or bundle");
        }
        if (options.format === "bundle") {
          if (options.output === undefined) {
            throw new MiosotisError("usage", "--format bundle needs --output <folder>");
          }
          const output = options.output;
          const bundle = inLibrary(runtime, (context) => exportBundle(context, id, output));
          return { data: bundle, human: `Wrote ${bundle.path}` };
        }
        const exported = inLibrary(runtime, (context) =>
          exportArtifact(context, id, options.format as "md" | "html" | "json"),
        );
        if (options.output !== undefined) {
          writeFileSync(options.output, exported.content, { mode: 0o600 });
          return { data: { path: options.output }, human: `Wrote ${options.output}` };
        }
        // Byte-exact: bypass the human renderer's newline normalization.
        runtime.streams.stdout(exported.content);
        return { data: exported, human: "" };
      });
    });

  artifact
    .command("trash")
    .description("Move an artifact to the trash (its Sources are not affected)")
    .argument("<A-id>")
    .option("--confirm", "confirm the action")
    .option("--json", "print a JSON result envelope")
    .action(async (id: string, options: JsonOption & { confirm?: boolean }) => {
      await runCommand(runtime, options.json, () => {
        const result = inLibrary(runtime, (context) =>
          trashArtifact(context, id, { confirm: options.confirm === true }),
        );
        return {
          data: result,
          human: result.changed ? `Trashed ${result.id}` : `${result.id} is already ${result.lifecycle}`,
        };
      });
    });
}
