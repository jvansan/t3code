import { IssueTrackerKind } from "@t3tools/contracts";

export const ASANA_KIND = IssueTrackerKind.make("asana");
export const ASANA_HOST = "app.asana.com";
/** What every Asana link and account report as their workspace: gids are globally unique. */
export const ASANA_WORKSPACE = ASANA_HOST;
/** The scope of a link that names no project; no Asana project has gid 0. */
export const ASANA_NO_PROJECT = "0";

const GID = /^\d{1,32}$/;

/**
 * An Asana task link, in the legacy form `/0/<project>/<task>[/f]` or the current
 * `/1/<workspace>/project/<project>/task/<task>` and `/1/<workspace>/task/<task>`. The workspace
 * gid of a current link is checked and dropped: every Asana account reports the same workspace.
 */
export function parseAsanaTaskUrl(url: URL) {
  if (
    url.protocol !== "https:" ||
    url.hostname !== ASANA_HOST ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== ""
  ) {
    return null;
  }
  const segments = url.pathname.split("/").slice(1);
  if (segments.at(-1) === "") segments.pop();
  const found = taskPath(segments);
  return found === null
    ? null
    : { host: ASANA_HOST, workspace: ASANA_WORKSPACE, scope: found.scope, key: found.key };
}

function taskPath(segments: ReadonlyArray<string>): { scope: string; key: string } | null {
  const [version, a, b, c, d, e] = segments;
  const isGid = (value: string | undefined): value is string =>
    value !== undefined && GID.test(value);
  if (version === "0" && isGid(a) && isGid(b)) {
    if (segments.length === 3 || (segments.length === 4 && c === "f")) {
      return { scope: a, key: b };
    }
    return null;
  }
  if (version === "1" && isGid(a)) {
    if (segments.length === 4 && b === "task" && isGid(c)) {
      return { scope: ASANA_NO_PROJECT, key: c };
    }
    if (segments.length === 6 && b === "project" && isGid(c) && d === "task" && isGid(e)) {
      return { scope: c, key: e };
    }
  }
  return null;
}
