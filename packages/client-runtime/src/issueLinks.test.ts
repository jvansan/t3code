import {
  EnvironmentId,
  IssueTrackerAccountId,
  IssueTrackerKind,
  ProjectId,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mayContainStandaloneIssueLink, resolveIssueLinkTarget } from "./issueLinks.ts";

const project = (id: string, repository: string, origin?: string) =>
  ({
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make("env"),
    repositoryIdentity: {
      canonicalKey: `github.com/${repository}`,
      provider: SourceControlProviderKind.make("github"),
      displayName: repository,
      owner: repository.split("/")[0],
      name: repository.split("/")[1],
      ...(origin ? { origin: { canonicalKey: `github.com/${origin}`, displayName: origin } } : {}),
    },
  }) as never;

describe("resolveIssueLinkTarget", () => {
  const projects = [project("p1", "acme/api"), project("p2", "acme/web")];

  it.each([
    {
      name: "reads an issue through the project bound to its repository",
      url: "https://github.com/acme/web/issues/7",
      expected: { projectId: "p2", scope: "acme/web", key: "7" },
    },
    {
      name: "lends a project on the same host to a repository no project is bound to",
      url: "https://github.com/other/repo/issues/9",
      expected: { projectId: "p1", scope: "other/repo", key: "9" },
    },
  ])("$name", ({ url, expected }) => {
    const target = resolveIssueLinkTarget({ url, projects });
    expect(target?.ref).toMatchObject({ tracker: "github", host: "github.com", ...expected });
  });

  it("reads a fork's own issue through the fork, not as a borrowed repository", () => {
    const target = resolveIssueLinkTarget({
      url: "https://github.com/me/web/issues/3",
      projects: [project("p1", "acme/api"), project("fork", "acme/web", "me/web")],
    });
    expect(target?.ref).toMatchObject({ projectId: "fork", scope: "me/web", key: "3" });
  });

  it("uses the current repository identity after a project changes repositories", () => {
    const url = "https://github.com/acme/api/issues/7";
    const original = project("p1", "acme/api");
    const replacement = project("p1", "acme/mobile");
    const lender = project("p3", "acme/web");
    expect(resolveIssueLinkTarget({ url, projects: [lender, original] })?.ref.projectId).toBe("p1");
    expect(resolveIssueLinkTarget({ url, projects: [lender, replacement] })?.ref.projectId).toBe(
      "p3",
    );
  });

  it("prefers the project bound to the link's own port over one on the bare hostname", () => {
    const enterprise = (id: string, host: string) =>
      ({
        id: ProjectId.make(id),
        environmentId: EnvironmentId.make("env"),
        repositoryIdentity: {
          canonicalKey: `${host}/acme/web`,
          provider: SourceControlProviderKind.make("github"),
          displayName: "acme/web",
          owner: "acme",
          name: "web",
        },
      }) as never;
    const target = resolveIssueLinkTarget({
      url: "https://github.example.com:8443/acme/web/issues/7",
      projects: [
        enterprise("bare", "github.example.com"),
        enterprise("ported", "github.example.com:8443"),
      ],
    });
    expect(target?.ref.projectId).toBe("ported");

    // An Enterprise Server's hostname need not say "github"; its project vouches for it.
    const custom = resolveIssueLinkTarget({
      url: "https://code.acme.test/acme/web/issues/7",
      projects: [enterprise("custom", "code.acme.test")],
    });
    expect(custom?.ref).toMatchObject({ projectId: "custom", host: "code.acme.test", key: "7" });
  });

  it("reads a Linear link through the project bound to its team, else any bound to Linear", () => {
    const trackers = {
      trackers: [
        {
          tracker: IssueTrackerKind.make("linear"),
          displayName: "Linear",
          host: "linear.app",
          scopeNoun: "team",
          credential: { label: "Personal API key", helpUrl: null },
          connected: true,
          account: "julius",
          detail: null,
          workspace: "acme",
          scopes: [],
        },
      ],
      bindings: {
        [ProjectId.make("p1")]: { tracker: IssueTrackerKind.make("linear"), scope: "API" },
        [ProjectId.make("p2")]: {
          tracker: IssueTrackerKind.make("linear"),
          scope: "WEB",
          additionalScopes: ["DOCS"],
        },
      },
    };
    const resolve = (url: string) => resolveIssueLinkTarget({ url, projects, trackers });
    expect(resolve("https://linear.app/acme/issue/WEB-17/fix-it")?.ref).toEqual({
      projectId: "p2",
      tracker: "linear",
      host: "linear.app",
      scope: "WEB",
      key: "WEB-17",
    });
    expect(resolve("https://linear.app/acme/issue/DOCS-4")?.ref).toMatchObject({
      projectId: "p2",
      scope: "DOCS",
    });
    expect(resolve("https://linear.app/acme/issue/OPS-3")?.ref).toMatchObject({
      projectId: "p1",
      scope: "OPS",
      key: "OPS-3",
    });
    expect(resolve("https://linear.app.evil.example/acme/issue/WEB-17")).toBeNull();
    // Team keys repeat across workspaces; only the connected one's links are its issues.
    expect(resolve("https://linear.app/othercorp/issue/WEB-17")).toBeNull();
    expect(
      resolveIssueLinkTarget({ url: "https://linear.app/acme/issue/WEB-17", projects }),
    ).toBeNull();

    // A second account reaches its own workspace, through only the projects bound with it.
    const accountId = IssueTrackerAccountId.make("second");
    const [p1, p2] = [ProjectId.make("p1"), ProjectId.make("p2")];
    const both = (url: string) =>
      resolveIssueLinkTarget({
        url,
        projects,
        trackers: {
          ...trackers,
          accounts: [{ ...trackers.trackers[0]!, accountId, workspace: "othercorp" }],
          bindings: { [p1]: trackers.bindings[p1]! },
          accountBindings: { [p2]: { ...trackers.bindings[p2]!, accountId } },
        },
      })?.ref.projectId;
    expect([
      both("https://linear.app/othercorp/issue/WEB-17"),
      both("https://linear.app/acme/issue/WEB-17"),
    ]).toEqual(["p2", "p1"]);
  });

  it("reads an Asana link through the project bound to its Asana project, else any bound to Asana", () => {
    const trackers = {
      trackers: [
        {
          tracker: IssueTrackerKind.make("asana"),
          displayName: "Asana",
          host: "app.asana.com",
          scopeNoun: "project",
          credential: { label: "Personal access token", helpUrl: null },
          connected: true,
          account: "julius",
          detail: null,
          workspace: "app.asana.com",
          scopes: [],
        },
      ],
      bindings: {
        [ProjectId.make("p1")]: {
          tracker: IssueTrackerKind.make("asana"),
          scope: "1201000000000001",
        },
        [ProjectId.make("p2")]: { tracker: IssueTrackerKind.make("linear"), scope: "WEB" },
      },
    };
    const resolve = (url: string) => resolveIssueLinkTarget({ url, projects, trackers })?.ref;
    const bound = {
      projectId: "p1",
      tracker: "asana",
      host: "app.asana.com",
      scope: "1201000000000001",
      key: "1203456789012345",
    };
    expect(resolve("https://app.asana.com/0/1201000000000001/1203456789012345/f")).toEqual(bound);
    expect(
      resolve(
        "https://app.asana.com/1/1100000000000000/project/1201000000000001/task/1203456789012345",
      ),
    ).toEqual(bound);
    // A project no T3 Code project is bound to, and a link naming no project, read through a lender.
    expect(resolve("https://app.asana.com/0/1201000000000002/1203456789012346")).toMatchObject({
      projectId: "p1",
      scope: "1201000000000002",
      key: "1203456789012346",
    });
    expect(resolve("https://app.asana.com/1/1100000000000000/task/1203456789012347")).toMatchObject(
      { projectId: "p1", scope: "0", key: "1203456789012347" },
    );
    expect(resolve("https://app.asana.com.evil.example/0/1201000000000001/1203456789012345")).toBe(
      undefined,
    );
    expect(mayContainStandaloneIssueLink("see https://app.asana.com/0/1/2")).toBe(true);
    expect(mayContainStandaloneIssueLink("see https://app.asana.com.evil.example/0/1/2")).toBe(
      false,
    );
  });

  it.each([
    "https://github.com.evil.example/acme/web/issues/7",
    "https://github.com/acme/web/pull/7",
  ])("leaves %s an ordinary link", (url) => {
    expect(resolveIssueLinkTarget({ url, projects })).toBeNull();
  });
});
