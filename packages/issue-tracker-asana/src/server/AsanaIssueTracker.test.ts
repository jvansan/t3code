import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import type { StandaloneIssueTrackerApi } from "@t3tools/source-control-core/server/IssueTracker";
import * as IssueTrackerHost from "@t3tools/source-control-core/server/IssueTrackerHost";

import { ASANA_HOST, ASANA_WORKSPACE } from "../shared/issueUrl.ts";
import * as AsanaApi from "./AsanaApi.ts";
import * as AsanaIssueTracker from "./AsanaIssueTracker.ts";

const BASE_URL = "https://asana.test/api/1.0";
const STORED_TOKEN = "asana_pat_test";
const FAKE_NOW = "2026-07-10T12:00:00.000Z";

interface FakeUser {
  readonly gid: string;
  readonly name: string | null;
  readonly email?: string | null;
  readonly photo?: { readonly image_60x60: string | null } | null;
}
interface FakeWorkspace {
  readonly gid: string;
  readonly name: string;
}
interface FakeProject {
  readonly gid: string;
  readonly name: string;
  readonly workspace: { readonly gid: string };
  readonly members: ReadonlyArray<FakeUser>;
  readonly archived?: boolean;
}
interface FakeTag {
  readonly gid: string;
  readonly name: string;
  readonly color: string | null;
  readonly workspace: { readonly gid: string };
}
interface FakeCustomField {
  readonly gid: string;
  readonly name: string;
  readonly display_value: string | null;
}
interface FakeTask {
  readonly gid: string;
  name: string;
  notes: string;
  completed: boolean;
  completed_at: string | null;
  readonly created_at: string;
  modified_at: string;
  readonly permalink_url: string;
  readonly parent: { readonly gid: string } | null;
  assignee: FakeUser | null;
  readonly created_by: FakeUser | null;
  readonly followers: ReadonlyArray<FakeUser>;
  tags: ReadonlyArray<{
    readonly gid: string;
    readonly name: string;
    readonly color: string | null;
  }>;
  readonly custom_fields: ReadonlyArray<FakeCustomField>;
  readonly memberships: ReadonlyArray<{
    readonly project: { readonly gid: string; readonly name: string };
  }>;
  readonly workspace: { readonly gid: string };
}
interface FakeStory {
  readonly gid: string;
  readonly task: string;
  readonly type: "comment" | "system";
  readonly resource_subtype: string;
  readonly text: string | null;
  readonly created_at: string;
  readonly created_by: FakeUser | null;
  readonly assignee?: FakeUser | null;
  readonly tag?: { readonly gid: string; readonly name: string } | null;
  readonly new_name?: string | null;
}
interface FakeModel {
  me: FakeUser & { readonly workspaces: ReadonlyArray<FakeWorkspace> };
  projects: Array<FakeProject>;
  tasks: Array<FakeTask>;
  stories: Array<FakeStory>;
  tags: Array<FakeTag>;
  /** The most items one page holds, whatever `limit` asks; unset serves `limit`. */
  pageSize?: number;
}
interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

const WORKSPACE: FakeWorkspace = { gid: "1000", name: "Acme" };
const user = (gid: string, name: string, email: string | null = null): FakeUser => ({
  gid,
  name,
  email: email ?? `${name.toLowerCase()}@acme.test`,
  photo: { image_60x60: `https://asana.test/avatars/${gid}.png` },
});
const JULIUS = user("2001", "Julius");
const THEO = user("2002", "Theo");
const PROJECT: FakeProject = {
  gid: "5001",
  name: "Platform",
  workspace: { gid: WORKSPACE.gid },
  members: [JULIUS, THEO],
};
const BUG_TAG: FakeTag = {
  gid: "6001",
  name: "Bug",
  color: "dark-red",
  workspace: { gid: WORKSPACE.gid },
};

const permalink = (workspaceGid: string, projectGid: string, taskGid: string) =>
  `https://app.asana.com/1/${workspaceGid}/project/${projectGid}/task/${taskGid}`;

const task = (gid: string, overrides: Partial<FakeTask> = {}): FakeTask => ({
  gid,
  name: `Task ${gid}`,
  notes: "",
  completed: false,
  completed_at: null,
  created_at: "2026-07-01T00:00:00.000Z",
  modified_at: "2026-07-02T00:00:00.000Z",
  permalink_url: permalink(WORKSPACE.gid, PROJECT.gid, gid),
  parent: null,
  assignee: null,
  created_by: JULIUS,
  followers: [],
  tags: [],
  custom_fields: [],
  memberships: [{ project: { gid: PROJECT.gid, name: PROJECT.name } }],
  workspace: { gid: WORKSPACE.gid },
  ...overrides,
});

const comment = (
  gid: string,
  taskGid: string,
  text: string,
  created_at: string,
  created_by: FakeUser | null = JULIUS,
): FakeStory => ({
  gid,
  task: taskGid,
  type: "comment",
  resource_subtype: "comment_added",
  text,
  created_at,
  created_by,
});

function makeModel(overrides: Partial<FakeModel> = {}): FakeModel {
  return {
    me: { ...JULIUS, workspaces: [WORKSPACE] },
    projects: [PROJECT],
    tasks: [task("7001"), task("7002", { completed: true, completed_at: FAKE_NOW })],
    stories: [],
    tags: [BUG_TAG],
    ...overrides,
  };
}

const OFFSET_PREFIX = "fake-offset-";
const notFound = () =>
  Response.json({ errors: [{ message: "Not Found", help: "" }] }, { status: 404 });
const expiredOffset = () =>
  Response.json(
    { errors: [{ message: "offset: Your pagination token has expired.", help: "" }] },
    { status: 400 },
  );

function paged<A>(model: FakeModel, items: ReadonlyArray<A>, params: URLSearchParams): Response {
  const offsetParam = params.get("offset");
  let start = 0;
  if (offsetParam !== null) {
    if (!offsetParam.startsWith(OFFSET_PREFIX)) return expiredOffset();
    start = Number(offsetParam.slice(OFFSET_PREFIX.length));
    if (!Number.isInteger(start) || start < 0) return expiredOffset();
  }
  const limitParam = params.get("limit");
  const limit = Math.min(
    limitParam === null ? Number.POSITIVE_INFINITY : Number(limitParam),
    model.pageSize ?? Number.POSITIVE_INFINITY,
  );
  const end = Number.isFinite(limit) ? start + limit : items.length;
  const data = items.slice(start, end);
  const next_page =
    end < items.length
      ? { offset: `${OFFSET_PREFIX}${end}`, path: "/fake", uri: `${BASE_URL}/fake` }
      : null;
  return Response.json({ data, next_page });
}

let nextGid = 90_000;
const mintGid = () => String((nextGid += 1));

const toUser = (model: FakeModel, value: string): FakeUser =>
  [model.me, ...model.projects.flatMap((project) => project.members)].find(
    (candidate) => candidate.gid === value || candidate.email === value,
  ) ?? { gid: value, name: null, email: null, photo: null };

const tagRef = (tag: FakeTag) => ({ gid: tag.gid, name: tag.name, color: tag.color });

/** Answers one request from the model, applying writes to it the way Asana would. */
function answer(
  model: FakeModel,
  method: string,
  path: string,
  params: URLSearchParams,
  body: unknown,
) {
  const data = (body as { data?: Record<string, unknown> } | null)?.data ?? {};
  const taskOf = (gid: string) => model.tasks.find((candidate) => candidate.gid === gid);
  let match: RegExpExecArray | null;

  if (method === "GET" && path === "/users/me") return Response.json({ data: model.me });

  if (method === "GET" && path === "/projects") {
    const projects = model.projects.filter(
      (project) =>
        project.workspace.gid === params.get("workspace") &&
        (params.get("archived") !== "false" || project.archived !== true),
    );
    return paged(model, projects, params);
  }

  if (method === "GET" && (match = /^\/projects\/(\d+)$/.exec(path)) !== null) {
    const project = model.projects.find((candidate) => candidate.gid === match?.[1]);
    return project === undefined ? notFound() : Response.json({ data: project });
  }

  if (method === "GET" && (match = /^\/projects\/(\d+)\/tasks$/.exec(path)) !== null) {
    const projectGid = match[1];
    if (!model.projects.some((project) => project.gid === projectGid)) return notFound();
    const tasks = model.tasks.filter(
      (candidate) =>
        candidate.memberships.some((membership) => membership.project.gid === projectGid) &&
        (params.get("completed_since") !== "now" || !candidate.completed),
    );
    return paged(model, tasks, params);
  }

  if (method === "GET" && (match = /^\/tasks\/(\d+)$/.exec(path)) !== null) {
    const found = taskOf(match[1] ?? "");
    return found === undefined ? notFound() : Response.json({ data: found });
  }

  if (method === "GET" && (match = /^\/tasks\/(\d+)\/stories$/.exec(path)) !== null) {
    const taskGid = match[1];
    if (taskOf(taskGid ?? "") === undefined) return notFound();
    const subtype = params.get("resource_subtype");
    const stories = model.stories
      .filter(
        (story) =>
          story.task === taskGid && (subtype === null || story.resource_subtype === subtype),
      )
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
    if (params.get("sort_ascending") === "false") stories.reverse();
    return paged(model, stories, params);
  }

  if (method === "GET" && path === "/tags") {
    const tags = model.tags.filter((tag) => tag.workspace.gid === params.get("workspace"));
    return paged(model, tags, params);
  }

  if (method === "POST" && path === "/tasks") {
    const projectGids = (data["projects"] as ReadonlyArray<string> | undefined) ?? [];
    const projects = projectGids.map((gid) =>
      model.projects.find((candidate) => candidate.gid === gid),
    );
    const first = projects[0];
    if (projects.some((project) => project === undefined) || first === undefined) {
      return notFound();
    }
    const tagGids = (data["tags"] as ReadonlyArray<string> | undefined) ?? [];
    const tags = tagGids.map((gid) => model.tags.find((candidate) => candidate.gid === gid));
    if (tags.some((tag) => tag === undefined)) return notFound();
    const gid = mintGid();
    const assignee = data["assignee"];
    const created: FakeTask = task(gid, {
      name: typeof data["name"] === "string" ? data["name"] : "",
      notes: typeof data["notes"] === "string" ? data["notes"] : "",
      created_at: FAKE_NOW,
      modified_at: FAKE_NOW,
      permalink_url: permalink(first.workspace.gid, first.gid, gid),
      assignee: typeof assignee === "string" ? toUser(model, assignee) : null,
      created_by: model.me,
      tags: tags.flatMap((tag) => (tag === undefined ? [] : [tagRef(tag)])),
      memberships: projects.flatMap((project) =>
        project === undefined ? [] : [{ project: { gid: project.gid, name: project.name } }],
      ),
      workspace: { gid: first.workspace.gid },
    });
    model.tasks.push(created);
    return Response.json({ data: created }, { status: 201 });
  }

  if (method === "PUT" && (match = /^\/tasks\/(\d+)$/.exec(path)) !== null) {
    const found = taskOf(match[1] ?? "");
    if (found === undefined) return notFound();
    if (typeof data["name"] === "string") found.name = data["name"];
    if (typeof data["notes"] === "string") found.notes = data["notes"];
    if (typeof data["completed"] === "boolean") {
      found.completed = data["completed"];
      found.completed_at = data["completed"] ? FAKE_NOW : null;
    }
    if ("assignee" in data) {
      const assignee = data["assignee"];
      found.assignee = typeof assignee === "string" ? toUser(model, assignee) : null;
    }
    found.modified_at = FAKE_NOW;
    return Response.json({ data: found });
  }

  if (method === "POST" && (match = /^\/tasks\/(\d+)\/(addTag|removeTag)$/.exec(path)) !== null) {
    const found = taskOf(match[1] ?? "");
    const tag = model.tags.find((candidate) => candidate.gid === data["tag"]);
    if (found === undefined || tag === undefined) return notFound();
    found.tags =
      match[2] === "addTag"
        ? found.tags.some((current) => current.gid === tag.gid)
          ? found.tags
          : [...found.tags, tagRef(tag)]
        : found.tags.filter((current) => current.gid !== tag.gid);
    found.modified_at = FAKE_NOW;
    return Response.json({ data: {} });
  }

  if (method === "POST" && (match = /^\/tasks\/(\d+)\/stories$/.exec(path)) !== null) {
    const found = taskOf(match[1] ?? "");
    if (found === undefined) return notFound();
    const story = comment(
      mintGid(),
      found.gid,
      typeof data["text"] === "string" ? data["text"] : "",
      FAKE_NOW,
      model.me,
    );
    model.stories.push(story);
    return Response.json({ data: story }, { status: 201 });
  }

  return notFound();
}

interface FakeAsanaOptions {
  readonly model?: Partial<FakeModel>;
  /** The token the host stores; `null` is none. A function is read on every request. */
  readonly stored?: string | null | (() => string | null);
  /** Answers instead of the model when it returns a value; an error is the transport failing. */
  readonly respond?: (
    request: RecordedRequest,
    url: URL,
  ) => Response | HttpClientError.HttpClientError | undefined;
  /** What `T3CODE_ASANA_API_URL` resolves to; the fake still serves only `BASE_URL`. */
  readonly env?: Record<string, string>;
}

/**
 * An in-memory Asana over `HttpClient.make`. A request to any host other than `BASE_URL` is a
 * defect, so no test can reach real Asana.
 */
function fakeAsana(options: FakeAsanaOptions = {}) {
  const model = makeModel(options.model);
  const requests: Array<RecordedRequest> = [];
  const basePath = new URL(BASE_URL).pathname;
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.gen(function* () {
        const body =
          request.body._tag === "Uint8Array"
            ? (JSON.parse(new TextDecoder().decode(request.body.body)) as unknown)
            : null;
        const recorded: RecordedRequest = {
          method: request.method,
          url: url.href,
          authorization: request.headers["authorization"],
          body,
        };
        requests.push(recorded);
        if (!url.href.startsWith(`${BASE_URL}/`)) {
          return yield* Effect.die(new Error(`The fake Asana serves ${BASE_URL}, not ${url.href}`));
        }
        const injected = options.respond?.(recorded, url);
        if (injected instanceof HttpClientError.HttpClientError) return yield* injected;
        const response =
          injected ??
          answer(
            model,
            request.method,
            url.pathname.slice(basePath.length),
            url.searchParams,
            body,
          );
        return HttpClientResponse.fromWeb(request, response);
      }),
    ),
  );
  const stored = options.stored;
  const host = Layer.succeed(
    IssueTrackerHost.IssueTrackerHost,
    IssueTrackerHost.IssueTrackerHost.of({
      credentials: {
        get: () =>
          Effect.sync(() =>
            Option.fromNullishOr(
              stored === undefined
                ? STORED_TOKEN
                : typeof stored === "function"
                  ? stored()
                  : stored,
            ),
          ),
      },
    }),
  );
  const config = ConfigProvider.layer(
    ConfigProvider.fromEnv({ env: options.env ?? { T3CODE_ASANA_API_URL: BASE_URL } }),
  );
  const layer = AsanaApi.layer.pipe(Layer.provide(Layer.mergeAll(http, host, config)));
  return { layer, requests, model };
}

/** Runs `f` against the fake's `AsanaApi`. */
const withApi = <A, E>(
  fake: ReturnType<typeof fakeAsana>,
  f: (api: AsanaApi.AsanaApi["Service"]) => Effect.Effect<A, E>,
) => Effect.flatMap(AsanaApi.AsanaApi, f).pipe(Effect.provide(fake.layer));

const optFieldsOf = (request: RecordedRequest) =>
  new URL(request.url).searchParams.get("opt_fields");

const transportFailure = (request: RecordedRequest) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      request: { url: request.url } as never,
      description: "ECONNREFUSED",
    }),
  });

const USER = (prefix: string) => `${prefix}.name,${prefix}.email,${prefix}.photo.image_60x60`;
const CUSTOM_FIELDS = "custom_fields.name,custom_fields.display_value";
const TASK_SUMMARY = `name,completed,completed_at,created_at,modified_at,permalink_url,parent,${USER("assignee")},${USER("created_by")},tags.name,tags.color,${CUSTOM_FIELDS}`;

describe("AsanaApi", () => {
  it.effect("reads the stored token on every request", () =>
    Effect.gen(function* () {
      const tokens = [STORED_TOKEN, "asana_pat_test_rotated"];
      const fake = fakeAsana({ stored: () => tokens.shift() ?? null });
      yield* withApi(fake, (api) => Effect.andThen(api.me(), api.me()));
      expect(fake.requests.map((request) => request.authorization)).toEqual([
        `Bearer ${STORED_TOKEN}`,
        "Bearer asana_pat_test_rotated",
      ]);
    }),
  );

  it.effect("sends a submitted token instead of the stored one", () =>
    Effect.gen(function* () {
      const fake = fakeAsana();
      const me = yield* withApi(fake, (api) => api.me("submitted_pat_test"));
      expect(me.gid).toBe(JULIUS.gid);
      expect(fake.requests.map((request) => request.authorization)).toEqual([
        "Bearer submitted_pat_test",
      ]);
    }),
  );

  it.effect("fails unauthenticated and sends nothing when no token is stored", () =>
    Effect.gen(function* () {
      const fake = fakeAsana({ stored: null });
      const error = yield* withApi(fake, (api) => Effect.flip(api.me()));
      expect(error.reason).toBe("unauthenticated");
      expect(error.detail).toBe("Asana is not connected on this server.");
      expect(error.tracker).toBe("asana");
      expect(error.operation).toBe("me");
      expect(fake.requests).toEqual([]);
    }),
  );

  it.effect("reads the API URL from T3CODE_ASANA_API_URL, defaulting to app.asana.com", () =>
    Effect.gen(function* () {
      const configured = fakeAsana();
      yield* withApi(configured, (api) => api.me());
      expect(configured.requests[0]?.url.startsWith(`${BASE_URL}/users/me?`)).toBe(true);

      const unconfigured = fakeAsana({ env: {} });
      const exit = yield* withApi(unconfigured, (api) => api.me()).pipe(Effect.exit);
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
      expect(
        unconfigured.requests[0]?.url.startsWith("https://app.asana.com/api/1.0/users/me?"),
      ).toBe(true);
    }),
  );

  it.effect("asks for exactly the fields each read maps", () =>
    Effect.gen(function* () {
      const fake = fakeAsana();
      yield* withApi(fake, (api) =>
        Effect.gen(function* () {
          yield* api.me();
          yield* api.listProjects(WORKSPACE.gid);
          yield* api.getProject(PROJECT.gid);
          yield* api.listProjectTasks({
            projectGid: PROJECT.gid,
            incompleteOnly: false,
            withFollowers: false,
            limit: 50,
          });
          yield* api.listProjectTasks({
            projectGid: PROJECT.gid,
            incompleteOnly: true,
            withFollowers: true,
            limit: 50,
          });
          yield* api.getTaskDetail("7001");
          yield* api.getTask("7001", "guard");
          yield* api.getTask("7001", "link");
          yield* api.listStories({ taskGid: "7001", commentsOnly: true, limit: 50 });
          yield* api.listWorkspaceTags(WORKSPACE.gid, 5);
        }),
      );
      expect(fake.requests.map(optFieldsOf)).toEqual([
        "name,email,workspaces.name",
        "name",
        `name,workspace,${USER("members")}`,
        TASK_SUMMARY,
        `${TASK_SUMMARY},followers.email`,
        `${TASK_SUMMARY},notes,memberships.project.name`,
        "memberships.project,tags.name,workspace",
        `name,permalink_url,${CUSTOM_FIELDS}`,
        `type,resource_subtype,text,created_at,${USER("created_by")},${USER("assignee")},tag.name,new_name`,
        "name,color",
      ]);
    }),
  );

  it.effect("sends the listing and story parameters Asana filters by", () =>
    Effect.gen(function* () {
      const fake = fakeAsana();
      const [open, all, comments, stories] = yield* withApi(fake, (api) =>
        Effect.all([
          api.listProjectTasks({
            projectGid: PROJECT.gid,
            incompleteOnly: true,
            withFollowers: false,
            limit: 100,
          }),
          api.listProjectTasks({
            projectGid: PROJECT.gid,
            incompleteOnly: false,
            withFollowers: false,
            limit: 1,
          }),
          api.listStories({
            taskGid: "7001",
            commentsOnly: true,
            limit: 50,
            offset: "fake-offset-0",
          }),
          api.listStories({ taskGid: "7001", commentsOnly: false, limit: 100 }),
        ]),
      );
      const params = fake.requests.map((request) => {
        const url = new URL(request.url);
        url.searchParams.delete("opt_fields");
        return `${url.pathname}?${url.searchParams.toString()}`;
      });
      expect(params).toEqual([
        "/api/1.0/projects/5001/tasks?limit=100&completed_since=now",
        "/api/1.0/projects/5001/tasks?limit=1",
        "/api/1.0/tasks/7001/stories?limit=50&sort_ascending=false&resource_subtype=comment_added&offset=fake-offset-0",
        "/api/1.0/tasks/7001/stories?limit=100&sort_ascending=false",
      ]);
      expect(open.data.map((found) => found.gid)).toEqual(["7001"]);
      expect(all.data.map((found) => found.gid)).toEqual(["7001"]);
      expect(all.nextOffset).toBe("fake-offset-1");
      expect(comments.data).toEqual([]);
      expect(stories.nextOffset).toBeNull();
    }),
  );

  it.effect("follows every project page and caps tag pages", () =>
    Effect.gen(function* () {
      const projects = Array.from({ length: 7 }, (_, index) => ({
        ...PROJECT,
        gid: String(5100 + index),
        name: `Project ${index}`,
      }));
      const tags = Array.from({ length: 12 }, (_, index) => ({
        ...BUG_TAG,
        gid: String(6100 + index),
        name: `Tag ${index}`,
      }));
      const fake = fakeAsana({ model: { projects, tags, pageSize: 3 } });
      const listed = yield* withApi(fake, (api) => api.listProjects(WORKSPACE.gid));
      expect(listed.map((project) => project.gid)).toEqual(projects.map((project) => project.gid));
      const offsets = fake.requests.map((request) =>
        new URL(request.url).searchParams.get("offset"),
      );
      expect(offsets).toEqual([null, "fake-offset-3", "fake-offset-6"]);

      const capped = yield* withApi(fake, (api) => api.listWorkspaceTags(WORKSPACE.gid, 2));
      expect(capped.truncated).toBe(true);
      expect(capped.tags.map((tag) => tag.gid)).toEqual(tags.slice(0, 6).map((tag) => tag.gid));
      const whole = yield* withApi(fake, (api) => api.listWorkspaceTags(WORKSPACE.gid, 5));
      expect(whole.truncated).toBe(false);
      expect(whole.tags).toHaveLength(12);
    }),
  );

  it.effect("returns null for a task or project Asana answers 404 to", () =>
    Effect.gen(function* () {
      const fake = fakeAsana();
      const [project, guard, detail, link] = yield* withApi(fake, (api) =>
        Effect.all([
          api.getProject("5999"),
          api.getTask("7999", "guard"),
          api.getTaskDetail("7999"),
          api.getTask("7999", "link"),
        ]),
      );
      expect([project, guard, detail, link]).toEqual([null, null, null, null]);
      const error = yield* withApi(fake, (api) =>
        Effect.flip(api.listStories({ taskGid: "7999", commentsOnly: false, limit: 10 })),
      );
      expect(error.reason).toBe("not-found");
    }),
  );

  it.effect("wraps write bodies in data and names the fields a create reads back", () =>
    Effect.gen(function* () {
      const fake = fakeAsana();
      const created = yield* withApi(fake, (api) =>
        Effect.gen(function* () {
          const created = yield* api.createTask({
            projectGid: PROJECT.gid,
            name: "Ship it",
            notes: "Body",
            tagGids: [BUG_TAG.gid],
            assignee: THEO.email ?? null,
          });
          yield* api.updateTask(created.gid, { name: "Shipped", assignee: null });
          yield* api.addTag(created.gid, BUG_TAG.gid);
          yield* api.removeTag(created.gid, BUG_TAG.gid);
          yield* api.addComment(created.gid, "Done.");
          return created;
        }),
      );
      expect(created.permalink_url).toBe(permalink(WORKSPACE.gid, PROJECT.gid, created.gid));
      expect(fake.requests.map((request) => [request.method, request.body])).toEqual([
        [
          "POST",
          {
            data: {
              name: "Ship it",
              notes: "Body",
              projects: [PROJECT.gid],
              tags: [BUG_TAG.gid],
              assignee: THEO.email,
            },
            options: {
              fields: ["permalink_url", "custom_fields.name", "custom_fields.display_value"],
            },
          },
        ],
        ["PUT", { data: { name: "Shipped", assignee: null } }],
        ["POST", { data: { tag: BUG_TAG.gid } }],
        ["POST", { data: { tag: BUG_TAG.gid } }],
        ["POST", { data: { text: "Done." } }],
      ]);
      const stored = fake.model.tasks.find((candidate) => candidate.gid === created.gid);
      expect(stored?.name).toBe("Shipped");
      expect(stored?.assignee).toBeNull();
      expect(stored?.tags).toEqual([]);
      expect(fake.model.stories.map((story) => story.text)).toEqual(["Done."]);
    }),
  );

  it.effect("reports an unreachable Asana without a cause", () =>
    Effect.gen(function* () {
      const fake = fakeAsana({ respond: transportFailure });
      const error = yield* withApi(fake, (api) => Effect.flip(api.me()));
      expect(error.reason).toBe("failed");
      expect(error.detail).toBe("Asana could not be reached.");
      expect(error.cause).toBeUndefined();
      expect(fake.requests).toHaveLength(1);
    }),
  );

  it.effect("fails when a 2xx body does not decode", () =>
    Effect.gen(function* () {
      const bodies = ["not json", JSON.stringify({ data: { gid: "x" } }), JSON.stringify({})];
      const fake = fakeAsana({
        respond: () => new Response(bodies.shift() ?? "", { status: 200 }),
      });
      for (let index = 0; index < 3; index += 1) {
        const error = yield* withApi(fake, (api) => Effect.flip(api.me()));
        expect(error.reason).toBe("failed");
        expect(error.detail).toBe("Asana answered with a body T3 Code could not read.");
        expect(error.cause).toBeUndefined();
      }
      expect(fake.requests).toHaveLength(3);
    }),
  );
});

const runs = { arbitrary: { runs: 100 } };
const windowsOf = (secret: string) =>
  Array.from({ length: Math.max(0, secret.length - 7) }, (_, index) =>
    secret.slice(index, index + 8),
  );

describe("Asana API properties", () => {
  const Status = Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 599 }));
  const RetryAfter = Schema.Union([
    Schema.Struct({ kind: Schema.Literal("absent") }),
    Schema.Struct({
      kind: Schema.Literal("seconds"),
      seconds: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 604_800 })),
    }),
    Schema.Struct({
      kind: Schema.Literal("malformed"),
      value: Schema.Literals([
        "",
        "soon",
        "1.5",
        "-3",
        "3 seconds",
        "1e3",
        "Wed, 21 Oct 2026 07:28:00 GMT",
      ]),
    }),
  ]);
  const Body = Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("asana"),
      message: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9 .,'-]{1,60}$/)),
    }),
    Schema.Struct({ kind: Schema.Literal("empty") }),
    Schema.Struct({
      kind: Schema.Literal("text"),
      text: Schema.Literals(["<html>Bad gateway</html>", "not json", '{"errors":']),
    }),
  ]);

  it.effect.prop(
    "Feature: asana-issue-tracker, Property 11: Every Asana failure maps to one error and no retry",
    { status: Status, retryAfter: RetryAfter, body: Body, hadOffset: Schema.Boolean },
    ({ status, retryAfter, body, hadOffset }) =>
      Effect.gen(function* () {
        const headers =
          retryAfter.kind === "absent"
            ? {}
            : {
                "retry-after":
                  retryAfter.kind === "seconds" ? String(retryAfter.seconds) : retryAfter.value,
              };
        const text =
          body.kind === "asana"
            ? JSON.stringify({ errors: [{ message: body.message, help: "" }] })
            : body.kind === "text"
              ? body.text
              : "";
        const fake = fakeAsana({ respond: () => new Response(text, { status, headers }) });
        const now = yield* Clock.currentTimeMillis;
        const error = yield* withApi(fake, (api) =>
          Effect.flip(
            api.listProjectTasks({
              projectGid: PROJECT.gid,
              incompleteOnly: false,
              withFollowers: false,
              limit: 10,
              ...(hadOffset ? { offset: "fake-offset-10" } : {}),
            }),
          ),
        );

        const unreadable = `Asana returned HTTP ${status} with a body T3 Code could not read.`;
        const expected: { reason: string; detail: string; retryAt?: number } =
          status === 429
            ? {
                reason: "rate-limited",
                detail: "Asana's rate limit was reached.",
                ...(retryAfter.kind === "seconds"
                  ? { retryAt: now + retryAfter.seconds * 1000 }
                  : {}),
              }
            : status === 401
              ? { reason: "unauthenticated", detail: "Asana rejected the personal access token." }
              : status === 402
                ? { reason: "failed", detail: "This Asana plan does not include that feature." }
                : status === 403
                  ? { reason: "failed", detail: "This Asana account cannot do that in Asana." }
                  : status === 404
                    ? {
                        reason: "not-found",
                        detail: "Asana has no such item, or this account cannot see it.",
                      }
                    : status === 400 && hadOffset
                      ? { reason: "failed", detail: "Asana's page token expired. Reload the list." }
                      : {
                          reason: "failed",
                          detail:
                            body.kind === "asana" && body.message.trim() !== ""
                              ? body.message.trim()
                              : unreadable,
                        };
        expect(fake.requests).toHaveLength(1);
        expect({ reason: error.reason, detail: error.detail, retryAt: error.retryAt }).toEqual({
          retryAt: undefined,
          ...expected,
        });
        expect(error.cause).toBeUndefined();
        expect(error.tracker).toBe("asana");
        expect(error.operation).toBe("listProjectTasks");
      }),
    runs,
  );

  it.effect.prop(
    "Feature: asana-issue-tracker, Property 12: No error carries any part of the token",
    {
      token: Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{8,128}$/)),
      kind: Schema.Literals(["whole", "prefix", "substring"]),
      start: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 127 })),
      length: Schema.Int.check(Schema.isBetween({ minimum: 8, maximum: 128 })),
      before: Schema.String.check(Schema.isPattern(/^[a-z ]{0,16}$/)),
      after: Schema.String.check(Schema.isPattern(/^[a-z ]{0,16}$/)),
    },
    ({ token, kind, start, length, before, after }) =>
      Effect.gen(function* () {
        const size = Math.min(length, token.length);
        const from = Math.min(start, token.length - size);
        const fragment =
          kind === "whole"
            ? token
            : kind === "prefix"
              ? token.slice(0, size)
              : token.slice(from, from + size);
        const message = `${before}${fragment}${after}`;
        const fake = fakeAsana({
          respond: () => Response.json({ errors: [{ message, help: "" }] }, { status: 400 }),
        });
        const error = yield* withApi(fake, (api) => Effect.flip(api.me(token)));
        expect(error.reason).toBe("failed");
        for (const window of windowsOf(token)) {
          expect(error.detail).not.toContain(window);
          expect(error.message).not.toContain(window);
        }
        expect(error.detail).toContain("[redacted]");
      }),
    runs,
  );
});

/** Runs `f` against the tracker built over the fake's `AsanaApi`. */
const withTracker = <A, E>(
  fake: ReturnType<typeof fakeAsana>,
  f: (tracker: StandaloneIssueTrackerApi) => Effect.Effect<A, E>,
) => Effect.flatMap(AsanaIssueTracker.make, f).pipe(Effect.provide(fake.layer));

const SCOPE = { cwd: "/repo", host: ASANA_HOST, scope: PROJECT.gid };

const unauthorized = () =>
  Response.json({ errors: [{ message: "Not Authorized", help: "" }] }, { status: 401 });

describe("AsanaIssueTracker", () => {
  it.effect("describes Asana as a standalone tracker of projects", () =>
    Effect.gen(function* () {
      const fake = fakeAsana();
      const tracker = yield* withTracker(fake, Effect.succeed);
      expect(tracker.kind).toBe("asana");
      expect(tracker.standalone).toEqual({
        tracker: "asana",
        displayName: "Asana",
        host: ASANA_HOST,
        scopeNoun: "project",
        credential: {
          label: "Personal access token",
          helpUrl: "https://app.asana.com/0/my-apps",
        },
      });
      expect(tracker.capabilities).toEqual({
        create: true,
        edit: true,
        comment: true,
        labels: true,
        assignees: true,
        events: true,
        reactions: false,
        templates: false,
        linkedPullRequests: false,
        search: false,
      });
      expect(tracker.parseIssueUrl(new URL(permalink(WORKSPACE.gid, PROJECT.gid, "7001")))).toEqual(
        { host: ASANA_HOST, workspace: ASANA_WORKSPACE, scope: PROJECT.gid, key: "7001" },
      );
      expect(fake.requests).toEqual([]);
    }),
  );

  it.effect("probes a submitted token and names every project as a scope", () =>
    Effect.gen(function* () {
      const other: FakeProject = { ...PROJECT, gid: "5002", name: "Mobile" };
      const archived: FakeProject = { ...PROJECT, gid: "5003", name: "Old", archived: true };
      const fake = fakeAsana({ model: { projects: [PROJECT, other, archived] } });
      const probed = yield* withTracker(fake, (tracker) =>
        tracker.probeCredential("submitted_pat_test"),
      );
      expect(probed).toEqual({
        account: "Julius",
        workspace: ASANA_WORKSPACE,
        scopes: [
          { key: PROJECT.gid, name: "Platform" },
          { key: other.gid, name: "Mobile" },
        ],
      });
      expect(fake.requests.map((request) => request.authorization)).toEqual([
        "Bearer submitted_pat_test",
        "Bearer submitted_pat_test",
      ]);
      expect(new URL(fake.requests[1]?.url ?? "").searchParams.get("archived")).toBe("false");
    }),
  );

  it.effect("a probe Asana answers 401 to fails unauthenticated", () =>
    Effect.gen(function* () {
      const fake = fakeAsana({ respond: unauthorized });
      const error = yield* withTracker(fake, (tracker) =>
        Effect.flip(tracker.probeCredential("submitted_pat_test")),
      );
      expect(error.reason).toBe("unauthenticated");
      expect(error.tracker).toBe("asana");
      expect(fake.requests).toHaveLength(1);
    }),
  );

  it.effect("the viewer is the stored token's user, by email", () =>
    Effect.gen(function* () {
      const fake = fakeAsana();
      const viewer = yield* withTracker(fake, (tracker) =>
        tracker.getViewer({ cwd: SCOPE.cwd, host: SCOPE.host }),
      );
      expect(viewer).toBe(JULIUS.email);
      expect(fake.requests.map((request) => request.authorization)).toEqual([
        `Bearer ${STORED_TOKEN}`,
      ]);
    }),
  );
});

const SummaryGid = Schema.String.check(Schema.isPattern(/^[1-9]\d{0,15}$/));
const Text = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9 ]{0,12}$/));
const Email = Schema.String.check(Schema.isPattern(/^[a-z]{1,8}@acme\.test$/));
const Avatar = Schema.String.check(Schema.isPattern(/^https:\/\/asana\.test\/[a-z]{1,8}\.png$/));
const SomeUser = Schema.Struct({
  gid: SummaryGid,
  name: Schema.NullOr(Text),
  email: Schema.NullOr(Email),
  photo: Schema.NullOr(Schema.Struct({ image_60x60: Schema.NullOr(Avatar) })),
});
const Seconds = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000_000 }));
const EPOCH = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"));
const at = (seconds: number) => DateTime.formatIso(DateTime.makeUnsafe(EPOCH + seconds * 1000));
const SomeTag = Schema.Struct({
  gid: SummaryGid,
  name: Text,
  color: Schema.NullOr(Schema.Literals(["dark-red", "light-blue", "neon-green"])),
});
const SomeTask = Schema.Struct({
  name: Text,
  completed: Schema.Boolean,
  completedAt: Schema.NullOr(Seconds),
  createdAt: Seconds,
  modifiedAt: Seconds,
  assignee: Schema.NullOr(SomeUser),
  createdBy: Schema.NullOr(SomeUser),
  tags: Schema.Array(SomeTag).check(Schema.isBetweenLength(0, 4)),
  fieldName: Schema.Literals(["Eng. ID", "Priority"]),
  fieldValue: Schema.NullOr(Text),
});
type SomeTask = typeof SomeTask.Type;

const KNOWN_HEX: Readonly<Record<string, string>> = {
  "dark-red": "#c43c39",
  "light-blue": "#a7c6f5",
};
const actorOf = (user: FakeUser) => ({
  login: user.email?.trim() || user.gid,
  name: user.name?.trim() || null,
  avatarUrl: user.photo?.image_60x60 ?? null,
});
const fakeTaskOf = (gid: string, source: SomeTask): FakeTask =>
  task(gid, {
    name: source.name,
    completed: source.completed,
    completed_at: source.completedAt === null ? null : at(source.completedAt),
    created_at: at(source.createdAt),
    modified_at: at(source.modifiedAt),
    assignee: source.assignee,
    created_by: source.createdBy,
    tags: source.tags,
    custom_fields: [{ gid: "8001", name: source.fieldName, display_value: source.fieldValue }],
  });

describe("Asana tracker properties", () => {
  it.effect.prop(
    "Feature: asana-issue-tracker, Property 8: A task maps to a summary field for field",
    { tasks: Schema.Array(SomeTask).check(Schema.isBetweenLength(1, 8)) },
    ({ tasks }) =>
      Effect.gen(function* () {
        const fakeTasks = tasks.map((source, index) => fakeTaskOf(String(7100 + index), source));
        const fake = fakeAsana({ model: { tasks: fakeTasks } });
        const page = yield* withTracker(fake, (tracker) =>
          tracker.listIssues({
            ...SCOPE,
            state: "all",
            involvement: "all",
            sort: "updated",
            limit: 100,
          }),
        );
        expect(page.items).toHaveLength(fakeTasks.length);
        for (const source of fakeTasks) {
          const engId = source.custom_fields.find((field) => field.name === "Eng. ID");
          expect(page.items.find((item) => item.key === source.gid)).toEqual({
            key: source.gid,
            displayKey: engId?.display_value?.trim() || source.gid,
            title: source.name.trim() || "Untitled task",
            url: source.permalink_url,
            author: source.created_by === null ? null : actorOf(source.created_by),
            state: source.completed
              ? { category: "closed", name: "Completed", closeReason: "completed" }
              : { category: "open", name: "Incomplete" },
            createdAt: source.created_at,
            updatedAt: source.modified_at,
            closedAt: source.completed_at,
            assignees: source.assignee === null ? [] : [actorOf(source.assignee)],
            labels: source.tags.flatMap((tag) =>
              tag.name.trim() === ""
                ? []
                : [{ name: tag.name.trim(), color: KNOWN_HEX[tag.color ?? ""] ?? null }],
            ),
            commentCount: 0,
          });
        }
      }),
    runs,
  );
});
