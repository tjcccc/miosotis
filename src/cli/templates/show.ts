import type { ShowResult } from "../../app/show.js";

/** "YYYY-MM-DD HH:mm" in the user's timezone. */
function localStamp(instant: string, timezone: string): string {
  const fields = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  return `${fields.year}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute}`;
}

function projectsLabel(projects: { slug: string }[]): string {
  return projects.length === 0 ? "" : `  · ${projects.map((project) => project.slug).join(", ")}`;
}

function more(shown: number, total: number, cursor: string | null): string {
  return `${shown} of ${total}${cursor === null ? "" : ` · more: --cursor ${cursor}`}`;
}

/** The terminal view of `miosotis show`. A single note's text is printed exactly as saved. */
export function renderShow(result: ShowResult): string {
  if (result.view === "source") {
    const view = result.source;
    const status = [
      view.retention === "retained" ? null : view.retention,
      view.inclusion === "included" ? null : view.inclusion,
      view.version.is_current ? null : `older revision (current v${view.current_version})`,
    ].filter((part) => part !== null);
    const header = `${view.ref} · saved ${localStamp(view.version.received_at, result.timezone)}${projectsLabel(view.projects)}${status.length > 0 ? ` · ${status.join(", ")}` : ""}`;
    const body = view.text ?? "[content purged]";
    const tail = view.truncated
      ? `\n\n… truncated (${view.version.char_length} characters in all; \`miosotis source get ${view.ref} --range <start:end>\` reads the rest)`
      : "";
    return `${header}\n\n${body}${tail}`;
  }
  if (result.view === "list") {
    if (result.notes.length === 0) {
      return result.total === 0 ? "No notes found." : more(0, result.total, result.next_cursor);
    }
    const lines = result.notes.map(
      (note) =>
        `${localStamp(note.created_at, result.timezone)}  ${note.title ?? note.preview ?? `(${note.kind})`}${projectsLabel(note.projects)}  ${note.id}`,
    );
    lines.push(more(result.notes.length, result.total, result.next_cursor), "Open one: miosotis show <S-ID>");
    return lines.join("\n");
  }
  if (result.hits.length === 0) {
    return "No matching notes.";
  }
  const lines = result.hits.map((hit) => {
    const excerpt = hit.matches[0]?.excerpt.replace(/\s+/g, " ").trim() ?? "";
    return `${localStamp(hit.created_at, result.timezone)}  ${hit.title ?? excerpt.slice(0, 100)}${projectsLabel(hit.projects)}  ${hit.source_id}${hit.title === null ? "" : `\n    ${excerpt.slice(0, 160)}`}`;
  });
  lines.push(more(result.hits.length, result.total, result.next_cursor), "Open one: miosotis show <S-ID>");
  return lines.join("\n");
}
