import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeArtifact, fakeEnrichment } from "../helpers/fake-agent.js";

const BIN = new URL("../../dist/index.js", import.meta.url).pathname;
let root: string;
let env: NodeJS.ProcessEnv;

/** Runs the built CLI like an AI host would: argument arrays plus JSON on stdin, never a shell. */
function miosotis(args: string[], input?: unknown) {
  const result = spawnSync(process.execPath, [BIN, ...args, "--json"], {
    env,
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: "utf8",
  });
  expect(result.stderr).toBe("");
  const envelope = JSON.parse(result.stdout);
  if (!envelope.ok) {
    throw new Error(`${args.join(" ")} failed: ${envelope.error.code} ${envelope.error.message}`);
  }
  return envelope.data;
}

beforeAll(() => {
  if (!existsSync(BIN)) {
    throw new Error("dist/index.js is missing; run `pnpm build` first");
  }
  root = mkdtempSync(join(tmpdir(), "miosotis-slice-"));
  env = { MIOSOTIS_HOME: join(root, "home"), PATH: process.env.PATH ?? "" };
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("phase-1 vertical slice through the built CLI (deterministic fake agent)", () => {
  it("capture → enrich → retrieve → pin → artifact → open → correct → notice → regenerate", () => {
    miosotis(["init"]);
    const saved = miosotis(["save", "--request-file", "-"], {
      text: "Artifacts stay frozen.\n用户希望重新生成必须由用户明确发起。",
      project: "miosotis",
      idempotency_key: "slice-capture-1",
    });
    const sourceId = saved.sources[0].id;
    expect(miosotis(["enrich", "pending"]).sources.map((row: { ref: string }) => row.ref)).toEqual([`${sourceId}@v1`]);

    const prepared = miosotis(["enrich", "prepare", sourceId]);
    miosotis(["enrich", "apply", "--request-file", "-"], {
      ...fakeEnrichment(prepared),
      terms: ["artifact", "regeneration", "重新生成"],
    });
    expect(miosotis(["search", "regeneration", "--project", "miosotis"]).hits[0].source_id).toBe(sourceId);

    const evidence = miosotis(["evidence", "prepare", "--request-file", "-"], {
      request: "How should artifacts update?",
      intent: "review",
      project: "miosotis",
      queries: ["重新生成"],
    });
    expect(evidence.items.length).toBeGreaterThan(0);
    const created = miosotis(["artifact", "create", "--request-file", "-"], fakeArtifact(evidence, "Artifact policy"));
    const opened = miosotis(["artifact", "open", created.id, "--no-launch"]);
    expect(readFileSync(opened.path, "utf8")).toContain("Evidence unchanged");
    const frozenMarkdown = spawnSync(process.execPath, [BIN, "artifact", "export", created.id, "--format", "md"], {
      env,
      encoding: "utf8",
    }).stdout;
    expect(frozenMarkdown).toBe(miosotis(["artifact", "get", created.id]).markdown);

    miosotis(["source", "correct", sourceId, "--expected-version", "1", "--request-file", "-"], {
      text: "Artifacts stay frozen.\n用户希望重新生成必须由用户明确发起，并保留历史。",
    });
    const reopened = miosotis(["artifact", "open", created.id, "--no-launch"]);
    expect(reopened.notices.join("\n")).toContain("was corrected");
    const view = miosotis(["artifact", "get", created.id]);
    expect(view.content_hash).toBe(created.content_hash);
    expect(view.citations[0].ref).toBe(`${sourceId}@v1`);
    expect(
      spawnSync(process.execPath, [BIN, "artifact", "export", created.id, "--format", "md"], { env, encoding: "utf8" })
        .stdout,
    ).toBe(frozenMarkdown);

    const fresh = miosotis(["evidence", "prepare", "--request-file", "-"], {
      request: "How should artifacts update?",
      intent: "review",
      project: "miosotis",
      source_refs: [{ ref: sourceId }],
    });
    expect(fresh.items[0].ref).toBe(`${sourceId}@v2`);
    const regenerated = miosotis(
      ["artifact", "create", "--request-file", "-", "--derived-from", created.id],
      fakeArtifact(fresh, "Artifact policy (regenerated)"),
    );
    expect(regenerated.id).not.toBe(created.id);
    expect(miosotis(["artifact", "get", regenerated.id]).lineage.derived_from).toEqual([created.id]);
    expect(miosotis(["artifact", "get", created.id]).lineage.derivatives).toEqual([regenerated.id]);
  });
});
