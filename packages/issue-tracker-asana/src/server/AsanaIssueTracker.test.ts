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
  /** The custom fields Asana gives a task created in this model, such as a project's `Eng. ID`. */
  createdFields?: ReadonlyArray<FakeCustomField>;
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
      custom_fields: model.createdFields ?? [],
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

  it.effect("lists a project's tasks with the summary fields and Asana's own filters", () =>
    Effect.gen(function* () {
      const fake = fakeAsana();
      const [open, mentioned] = yield* withTracker(fake, (tracker) =>
        Effect.all([
          tracker.listIssues({
            ...SCOPE,
            state: "open",
            involvement: "all",
            sort: "updated",
            limit: 150,
          }),
          tracker.listIssues({
            ...SCOPE,
            state: "all",
            involvement: "mentioned",
            viewer: JULIUS.email ?? "",
            sort: "created",
            limit: 20,
          }),
        ]),
      );
      expect(open.items.map((item) => item.key)).toEqual(["7001"]);
      expect(open.nextCursor).toBeNull();
      expect(mentioned.items).toEqual([]);
      const reads = fake.requests.map((request) => {
        const url = new URL(request.url);
        return [
          url.pathname,
          url.searchParams.get("limit"),
          url.searchParams.get("completed_since"),
          optFieldsOf(request),
        ];
      });
      expect(reads).toEqual(
        expect.arrayContaining([
          [`/api/1.0/projects/${PROJECT.gid}/tasks`, "100", "now", TASK_SUMMARY],
          [`/api/1.0/projects/${PROJECT.gid}/tasks`, "20", null, `${TASK_SUMMARY},followers.email`],
          ["/api/1.0/users/me", null, null, "name,email,workspaces.name"],
        ]),
      );
      expect(reads).toHaveLength(3);
    }),
  );

  it.effect("hands back the next cursor even when filters left the page empty", () =>
    Effect.gen(function* () {
      const fake = fakeAsana({ model: { pageSize: 1 } });
      const page = yield* withTracker(fake, (tracker) =>
        tracker.listIssues({
          ...SCOPE,
          state: "closed",
          involvement: "all",
          sort: "updated",
          limit: 100,
        }),
      );
      expect(page.items).toEqual([]);
      expect(page.nextCursor).toBe("a1.fake-offset-1");
      const next = yield* withTracker(fake, (tracker) =>
        tracker.listIssues({
          ...SCOPE,
          state: "closed",
          involvement: "all",
          sort: "updated",
          limit: 100,
          cursor: page.nextCursor ?? "",
        }),
      );
      expect(next.items.map((item) => item.key)).toEqual(["7002"]);
      expect(next.nextCursor).toBeNull();
      expect(new URL(fake.requests[1]?.url ?? "").searchParams.get("offset")).toBe("fake-offset-1");
    }),
  );

  it.effect("an expired offset fails with the reload detail", () =>
    Effect.gen(function* () {
      const fake = fakeAsana();
      const error = yield* withTracker(fake, (tracker) =>
        Effect.flip(
          tracker.listIssues({
            ...SCOPE,
            state: "all",
            involvement: "all",
            sort: "updated",
            limit: 50,
            cursor: "a1.stale-offset",
          }),
        ),
      );
      expect(error.reason).toBe("failed");
      expect(error.detail).toBe("Asana's page token expired. Reload the list.");
      expect(fake.requests).toHaveLength(1);
    }),
  );

  it.effect("a foreign cursor or a non-gid scope fails before any request", () =>
    Effect.gen(function* () {
      const fake = fakeAsana();
      const listing = { state: "all", involvement: "all", sort: "updated", limit: 50 } as const;
      const foreign = yield* withTracker(fake, (tracker) =>
        Effect.flip(tracker.listIssues({ ...SCOPE, ...listing, cursor: "linear:abc" })),
      );
      expect(foreign.reason).toBe("failed");
      expect(foreign.detail).toBe("This Asana list position is no longer valid. Reload the list.");
      const named = yield* withTracker(fake, (tracker) =>
        Effect.flip(tracker.listIssues({ ...SCOPE, ...listing, scope: "ENG" })),
      );
      expect(named.reason).toBe("failed");
      expect(named.detail).toBe("Asana projects are named by gid.");
      expect(fake.requests).toEqual([]);
    }),
  );

  const STORY_FIELDS = `type,resource_subtype,text,created_at,${USER("created_by")},${USER("assignee")},tag.name,new_name`;
  const system = (
    gid: string,
    resource_subtype: string,
    created_at: string,
    extra: Partial<FakeStory> = {},
  ): FakeStory => ({
    gid,
    task: "7001",
    type: "system",
    resource_subtype,
    text: resource_subtype.replaceAll("_", " "),
    created_at,
    created_by: THEO,
    ...extra,
  });

  it.effect("reads a task with its newest comments and the events T3 Code has words for", () =>
    Effect.gen(function* () {
      const fake = fakeAsana({
        model: {
          tasks: [
            task("7001", {
              notes: "Body text",
              custom_fields: [{ gid: "8001", name: "Eng. ID", display_value: "ENG-120" }],
            }),
          ],
          stories: [
            comment("8101", "7001", "First", "2026-07-03T00:00:00.000Z"),
            comment("8102", "7001", "Second", "2026-07-04T00:00:00.000Z", THEO),
            system("8103", "marked_complete", "2026-07-03T12:00:00.000Z", { created_by: JULIUS }),
            system("8104", "added_to_tag", "2026-07-05T00:00:00.000Z", { tag: tagRef(BUG_TAG) }),
            system("8105", "liked", "2026-07-06T00:00:00.000Z"),
          ],
        },
      });
      const detail = yield* withTracker(fake, (tracker) =>
        tracker.getIssue({ ...SCOPE, key: "7001" }),
      );
      expect(detail.key).toBe("7001");
      expect(detail.displayKey).toBe("ENG-120");
      expect(detail.body).toBe("Body text");
      expect(detail.viewer).toBe(JULIUS.email);
      expect(detail.viewerPermissions).toEqual({
        setState: true,
        comment: true,
        edit: true,
        labels: true,
        assignees: true,
      });
      expect(detail.states).toEqual([
        { category: "open", name: "Incomplete" },
        { category: "closed", name: "Completed", closeReason: "completed" },
      ]);
      expect(detail.linkedPullRequests).toEqual([]);
      expect("reactions" in detail).toBe(false);
      expect(detail.comments).toEqual([
        {
          id: "8101",
          author: actorOf(JULIUS),
          body: "First",
          createdAt: "2026-07-03T00:00:00.000Z",
          url: null,
        },
        {
          id: "8102",
          author: actorOf(THEO),
          body: "Second",
          createdAt: "2026-07-04T00:00:00.000Z",
          url: null,
        },
      ]);
      expect(detail.comments.every((entry) => !("reactions" in entry))).toBe(true);
      expect(detail.commentsCursor).toBeNull();
      expect(detail.events).toEqual([
        {
          id: "8103",
          kind: "closed",
          actor: actorOf(JULIUS),
          createdAt: "2026-07-03T12:00:00.000Z",
          detail: null,
        },
        {
          id: "8104",
          kind: "labeled",
          actor: actorOf(THEO),
          createdAt: "2026-07-05T00:00:00.000Z",
          detail: "Bug",
        },
      ]);
      const reads = fake.requests.map((request) => {
        const url = new URL(request.url);
        url.searchParams.delete("opt_fields");
        return [`${url.pathname}?${url.searchParams.toString()}`, optFieldsOf(request)];
      });
      expect(reads).toHaveLength(4);
      expect(reads).toEqual(
        expect.arrayContaining([
          ["/api/1.0/tasks/7001?", `${TASK_SUMMARY},notes,memberships.project.name`],
          [
            "/api/1.0/tasks/7001/stories?limit=50&sort_ascending=false&resource_subtype=comment_added",
            STORY_FIELDS,
          ],
          ["/api/1.0/tasks/7001/stories?limit=100&sort_ascending=false", STORY_FIELDS],
          ["/api/1.0/users/me?", "name,email,workspaces.name"],
        ]),
      );
    }),
  );

  it.effect("hands older comments over fifty at a time, each page oldest first", () =>
    Effect.gen(function* () {
      const stories = Array.from({ length: 60 }, (_, index) =>
        comment(String(8200 + index), "7001", `Comment ${index}`, at(index * 60)),
      );
      const fake = fakeAsana({ model: { stories } });
      const detail = yield* withTracker(fake, (tracker) =>
        tracker.getIssue({ ...SCOPE, key: "7001" }),
      );
      expect(detail.comments.map((entry) => entry.body)).toEqual(
        stories.slice(10).map((story) => story.text),
      );
      expect(detail.commentsCursor).toBe("a1.fake-offset-50");
      const older = yield* withTracker(fake, (tracker) =>
        tracker.getComments({ ...SCOPE, key: "7001", cursor: detail.commentsCursor ?? "" }),
      );
      expect(older.comments.map((entry) => entry.body)).toEqual(
        stories.slice(0, 10).map((story) => story.text),
      );
      expect(older.nextCursor).toBeNull();
      const url = new URL(fake.requests.at(-1)?.url ?? "");
      url.searchParams.delete("opt_fields");
      expect(`${url.pathname}?${url.searchParams.toString()}`).toBe(
        "/api/1.0/tasks/7001/stories?limit=50&sort_ascending=false&resource_subtype=comment_added&offset=fake-offset-50",
      );
    }),
  );

  it.effect("names a task for a thread link with one read", () =>
    Effect.gen(function* () {
      const fake = fakeAsana();
      const link = yield* withTracker(
        fake,
        (tracker) =>
          tracker.getIssueLink?.({ ...SCOPE, key: "7002" }) ?? Effect.die("no getIssueLink"),
      );
      expect(link).toEqual({
        title: "Task 7002",
        url: permalink(WORKSPACE.gid, PROJECT.gid, "7002"),
        displayKey: "7002",
      });
      expect(fake.requests.map(optFieldsOf)).toEqual([`name,permalink_url,${CUSTOM_FIELDS}`]);
    }),
  );

  it.effect("a read of a missing task fails not-found", () =>
    Effect.gen(function* () {
      const fake = fakeAsana();
      const [detail, link, comments] = yield* withTracker(fake, (tracker) =>
        Effect.all([
          Effect.flip(tracker.getIssue({ ...SCOPE, key: "7999" })),
          Effect.flip(tracker.getIssueLink?.({ ...SCOPE, key: "7999" }) ?? Effect.die("none")),
          Effect.flip(tracker.getComments({ ...SCOPE, key: "7999", cursor: "a1.fake-offset-0" })),
        ]),
      );
      expect([detail.reason, link.reason, comments.reason]).toEqual([
        "not-found",
        "not-found",
        "not-found",
      ]);
      expect(fake.requests.length).toBeGreaterThan(0);
    }),
  );

  it.effect("a key that is not a gid fails not-found before any request", () =>
    Effect.gen(function* () {
      const fake = fakeAsana();
      const [detail, link, comments] = yield* withTracker(fake, (tracker) =>
        Effect.all([
          Effect.flip(tracker.getIssue({ ...SCOPE, key: "ENG-120" })),
          Effect.flip(tracker.getIssueLink?.({ ...SCOPE, key: "ENG-120" }) ?? Effect.die("none")),
          Effect.flip(
            tracker.getComments({ ...SCOPE, key: "ENG-120", cursor: "a1.fake-offset-0" }),
          ),
        ]),
      );
      expect([detail.reason, link.reason, comments.reason]).toEqual([
        "not-found",
        "not-found",
        "not-found",
      ]);
      expect(fake.requests).toEqual([]);
    }),
  );

  it.effect("a failing viewer read leaves the detail without a viewer", () =>
    Effect.gen(function* () {
      const fake = fakeAsana({
        respond: (_, url) =>
          url.pathname.endsWith("/users/me")
            ? Response.json({ errors: [{ message: "Server Error", help: "" }] }, { status: 500 })
            : undefined,
      });
      const detail = yield* withTracker(fake, (tracker) =>
        tracker.getIssue({ ...SCOPE, key: "7001" }),
      );
      expect(detail.viewer).toBeNull();
      expect(detail.key).toBe("7001");
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

  const writes = (fake: ReturnType<typeof fakeAsana>) =>
    fake.requests
      .filter((request) => request.method !== "GET")
      .map((request) => [request.method, new URL(request.url).pathname, request.body]);

  it.effect("creates a task in the project with its tags and assignee, shown by its Eng. ID", () =>
    Effect.gen(function* () {
      const fake = fakeAsana({
        model: { createdFields: [{ gid: "8001", name: "Eng. ID", display_value: "ENG-121" }] },
      });
      const created = yield* withTracker(
        fake,
        (tracker) =>
          tracker.create?.({
            ...SCOPE,
            title: "Ship it",
            body: "Body\n\nwith **markdown**",
            labels: [" bug "],
            assignees: [THEO.gid],
          }) ?? Effect.die("no create"),
      );
      const gid = fake.model.tasks.at(-1)?.gid ?? "";
      expect(created).toEqual({
        key: gid,
        displayKey: "ENG-121",
        url: permalink(WORKSPACE.gid, PROJECT.gid, gid),
      });
      expect(fake.requests.map((request) => new URL(request.url).pathname)).toEqual([
        `/api/1.0/projects/${PROJECT.gid}`,
        "/api/1.0/tags",
        "/api/1.0/tasks",
      ]);
      expect(writes(fake)).toEqual([
        [
          "POST",
          "/api/1.0/tasks",
          {
            data: {
              name: "Ship it",
              notes: "Body\n\nwith **markdown**",
              projects: [PROJECT.gid],
              tags: [BUG_TAG.gid],
              assignee: THEO.gid,
            },
            options: {
              fields: ["permalink_url", "custom_fields.name", "custom_fields.display_value"],
            },
          },
        ],
      ]);
    }),
  );

  it.effect("a created task without an Eng. ID is shown by its gid, assigned by email", () =>
    Effect.gen(function* () {
      const fake = fakeAsana();
      const [byEmail, unassigned] = yield* withTracker(fake, (tracker) =>
        Effect.all([
          tracker.create?.({
            ...SCOPE,
            title: "By email",
            body: "",
            labels: [],
            assignees: [THEO.email ?? ""],
          }) ?? Effect.die("no create"),
          tracker.create?.({ ...SCOPE, title: "Nobody", body: "", labels: [], assignees: [] }) ??
            Effect.die("no create"),
        ]),
      );
      const [first, second] = fake.model.tasks.slice(-2);
      expect(byEmail).toEqual({
        key: first?.gid,
        displayKey: first?.gid,
        url: permalink(WORKSPACE.gid, PROJECT.gid, first?.gid ?? ""),
      });
      expect(unassigned.displayKey).toBe(second?.gid);
      expect(writes(fake).map((write) => (write[2] as { data: unknown }).data)).toEqual([
        { name: "By email", notes: "", projects: [PROJECT.gid], assignee: THEO.email },
        { name: "Nobody", notes: "", projects: [PROJECT.gid] },
      ]);
      expect(fake.requests.some((request) => request.url.endsWith("/tags"))).toBe(false);
    }),
  );

  it.effect("a create names a missing project or a non-gid scope before writing", () =>
    Effect.gen(function* () {
      const fake = fakeAsana();
      const input = { ...SCOPE, title: "T", body: "", labels: [], assignees: [] };
      const named = yield* withTracker(fake, (tracker) =>
        Effect.flip(tracker.create?.({ ...input, scope: "ENG" }) ?? Effect.die("no create")),
      );
      expect(named.reason).toBe("failed");
      expect(named.detail).toBe("Asana projects are named by gid.");
      expect(fake.requests).toEqual([]);
      const missing = yield* withTracker(fake, (tracker) =>
        Effect.flip(tracker.create?.({ ...input, scope: "5999" }) ?? Effect.die("no create")),
      );
      expect(missing.reason).toBe("failed");
      expect(missing.detail).toBe("No Asana project has gid 5999, or this account cannot see it.");
      expect(writes(fake)).toEqual([]);
    }),
  );

  it.effect("updates only the named fields, and an empty assignee list clears the assignee", () =>
    Effect.gen(function* () {
      const fake = fakeAsana({
        model: { tasks: [task("7001", { assignee: THEO, tags: [tagRef(BUG_TAG)] })] },
      });
      yield* withTracker(fake, (tracker) =>
        Effect.gen(function* () {
          yield* (
            tracker.update?.({ ...SCOPE, key: "7001", title: "Renamed" }) ?? Effect.die("no update")
          );
          yield* (
            tracker.update?.({ ...SCOPE, key: "7001", body: "New body", assignees: [] }) ??
            Effect.die("no update")
          );
          yield* (
            tracker.update?.({ ...SCOPE, key: "7001", assignees: [JULIUS.email ?? ""] }) ??
            Effect.die("no update")
          );
        }),
      );
      expect(writes(fake)).toEqual([
        ["PUT", "/api/1.0/tasks/7001", { data: { name: "Renamed" } }],
        ["PUT", "/api/1.0/tasks/7001", { data: { notes: "New body", assignee: null } }],
        ["PUT", "/api/1.0/tasks/7001", { data: { assignee: JULIUS.email } }],
      ]);
      const stored = fake.model.tasks[0];
      expect(stored?.name).toBe("Renamed");
      expect(stored?.notes).toBe("New body");
      expect(stored?.assignee?.gid).toBe(JULIUS.gid);
      expect(stored?.tags).toEqual([tagRef(BUG_TAG)]);
    }),
  );

  it.effect("updates labels by difference, one tag request each, after the field write", () =>
    Effect.gen(function* () {
      const feature: FakeTag = { ...BUG_TAG, gid: "6002", name: "Feature" };
      const fake = fakeAsana({
        model: {
          tasks: [task("7001", { tags: [tagRef(BUG_TAG)] })],
          tags: [BUG_TAG, feature],
        },
      });
      yield* withTracker(fake, (tracker) =>
        Effect.gen(function* () {
          yield* (
            tracker.update?.({ ...SCOPE, key: "7001", title: "T", labels: ["FEATURE"] }) ??
            Effect.die("no update")
          );
          yield* tracker.update?.({ ...SCOPE, key: "7001", labels: [] }) ?? Effect.die("no update");
        }),
      );
      expect(writes(fake)).toEqual([
        ["PUT", "/api/1.0/tasks/7001", { data: { name: "T" } }],
        ["POST", "/api/1.0/tasks/7001/addTag", { data: { tag: feature.gid } }],
        ["POST", "/api/1.0/tasks/7001/removeTag", { data: { tag: BUG_TAG.gid } }],
        ["POST", "/api/1.0/tasks/7001/removeTag", { data: { tag: feature.gid } }],
      ]);
      expect(fake.model.tasks[0]?.tags).toEqual([]);
      const tagReads = fake.requests.filter((request) => request.url.includes("/tags?"));
      expect(tagReads).toHaveLength(1);
    }),
  );

  it.effect("comments on a task after proving it is in the project", () =>
    Effect.gen(function* () {
      const fake = fakeAsana();
      yield* withTracker(
        fake,
        (tracker) =>
          tracker.comment?.({ ...SCOPE, key: "7001", body: "Looks good." }) ??
          Effect.die("no comment"),
      );
      expect(
        fake.requests.map((request) => [request.method, new URL(request.url).pathname]),
      ).toEqual([
        ["GET", "/api/1.0/tasks/7001"],
        ["POST", "/api/1.0/tasks/7001/stories"],
      ]);
      expect(
        optFieldsOf(fake.requests[0] ?? { method: "", url: "", authorization: "", body: null }),
      ).toBe("memberships.project,tags.name,workspace");
      expect(fake.requests[1]?.body).toEqual({ data: { text: "Looks good." } });
      expect(fake.model.stories.map((story) => [story.task, story.text])).toEqual([
        ["7001", "Looks good."],
      ]);
    }),
  );

  it.effect("completes and reopens a task by its two state names", () =>
    Effect.gen(function* () {
      const fake = fakeAsana();
      yield* withTracker(fake, (tracker) =>
        Effect.gen(function* () {
          yield* (
            tracker.setState?.({ ...SCOPE, key: "7001", state: "Completed" }) ??
            Effect.die("no setState")
          );
          yield* (
            tracker.setState?.({ ...SCOPE, key: "7002", state: "Incomplete" }) ??
            Effect.die("no setState")
          );
        }),
      );
      expect(writes(fake)).toEqual([
        ["PUT", "/api/1.0/tasks/7001", { data: { completed: true } }],
        ["PUT", "/api/1.0/tasks/7002", { data: { completed: false } }],
      ]);
      expect(
        fake.model.tasks.map((entry) => [entry.gid, entry.completed, entry.completed_at]),
      ).toEqual([
        ["7001", true, FAKE_NOW],
        ["7002", false, null],
      ]);
    }),
  );

  it.effect("a task in two projects takes a write through either project", () =>
    Effect.gen(function* () {
      const other: FakeProject = { ...PROJECT, gid: "5002", name: "Mobile" };
      const fake = fakeAsana({
        model: {
          projects: [PROJECT, other],
          tasks: [
            task("7001", {
              memberships: [
                { project: { gid: PROJECT.gid, name: PROJECT.name } },
                { project: { gid: other.gid, name: other.name } },
              ],
            }),
          ],
        },
      });
      yield* withTracker(fake, (tracker) =>
        Effect.gen(function* () {
          yield* (
            tracker.comment?.({ ...SCOPE, key: "7001", body: "From Platform" }) ??
            Effect.die("no comment")
          );
          yield* (
            tracker.setState?.({ ...SCOPE, scope: other.gid, key: "7001", state: "Completed" }) ??
            Effect.die("no setState")
          );
          yield* (
            tracker.update?.({ ...SCOPE, scope: other.gid, key: "7001", title: "Both" }) ??
            Effect.die("no update")
          );
        }),
      );
      expect(writes(fake).map((write) => write[1])).toEqual([
        "/api/1.0/tasks/7001/stories",
        "/api/1.0/tasks/7001",
        "/api/1.0/tasks/7001",
      ]);
    }),
  );

  it.effect("every refused write names its reason before Asana sees a write", () =>
    Effect.gen(function* () {
      const fake = fakeAsana();
      const outside = { ...SCOPE, scope: "5002", key: "7001" };
      const errors = yield* withTracker(fake, (tracker) =>
        Effect.all({
          commentOutside: Effect.flip(
            tracker.comment?.({ ...outside, body: "x" }) ?? Effect.die("none"),
          ),
          updateOutside: Effect.flip(
            tracker.update?.({ ...outside, title: "x" }) ?? Effect.die("none"),
          ),
          stateOutside: Effect.flip(
            tracker.setState?.({ ...outside, state: "Completed" }) ?? Effect.die("none"),
          ),
          nonGidKey: Effect.flip(
            tracker.comment?.({ ...SCOPE, key: "ENG-120", body: "x" }) ?? Effect.die("none"),
          ),
          missingTask: Effect.flip(
            tracker.comment?.({ ...SCOPE, key: "7999", body: "x" }) ?? Effect.die("none"),
          ),
          unknownState: Effect.flip(
            tracker.setState?.({ ...SCOPE, key: "7001", state: "Done" }) ?? Effect.die("none"),
          ),
          twoAssignees: Effect.flip(
            tracker.update?.({ ...SCOPE, key: "7001", assignees: [THEO.gid, JULIUS.gid] }) ??
              Effect.die("none"),
          ),
          namedAssignee: Effect.flip(
            tracker.create?.({ ...SCOPE, title: "T", body: "", labels: [], assignees: ["theo"] }) ??
              Effect.die("none"),
          ),
          unknownLabel: Effect.flip(
            tracker.update?.({ ...SCOPE, key: "7001", labels: ["Bug", "Urgent"] }) ??
              Effect.die("none"),
          ),
        }),
      );
      const seen = Object.fromEntries(
        Object.entries(errors).map(([name, error]) => [name, [error.reason, error.detail]]),
      );
      expect(seen).toEqual({
        commentOutside: ["failed", "Asana task 7001 is not in project 5002."],
        updateOutside: ["failed", "Asana task 7001 is not in project 5002."],
        stateOutside: ["failed", "Asana task 7001 is not in project 5002."],
        nonGidKey: ["not-found", "Asana tasks are named by gid."],
        missingTask: ["not-found", "Asana has no such task, or this account cannot see it."],
        unknownState: ["failed", 'An Asana task is Incomplete or Completed, not "Done".'],
        twoAssignees: ["failed", "An Asana task has one assignee at most."],
        namedAssignee: ["failed", "Name an Asana user by gid or email."],
        unknownLabel: ["failed", 'Asana has no tag named "Urgent" in this workspace.'],
      });
      expect(Object.values(errors).every((error) => error.tracker === "asana")).toBe(true);
      expect(writes(fake)).toEqual([]);
    }),
  );

  it.effect("an unknown label names the tag cap when the tag read was cut short", () =>
    Effect.gen(function* () {
      const tags = Array.from({ length: 501 }, (_, index) => ({
        ...BUG_TAG,
        gid: String(6000 + index),
        name: `Tag ${index}`,
      }));
      const fake = fakeAsana({ model: { tags } });
      const error = yield* withTracker(fake, (tracker) =>
        Effect.flip(
          tracker.create?.({
            ...SCOPE,
            title: "T",
            body: "",
            labels: ["Tag 500"],
            assignees: [],
          }) ?? Effect.die("none"),
        ),
      );
      expect(error.reason).toBe("failed");
      expect(error.detail).toContain('Asana has no tag named "Tag 500" in this workspace.');
      expect(error.detail).toContain("among the first 500 tags.");
      expect(fake.requests.filter((request) => request.url.includes("/tags?"))).toHaveLength(5);
      expect(writes(fake)).toEqual([]);
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
  const SomeWorkspace = Schema.Struct({
    name: Text,
    projects: Schema.Array(Text).check(Schema.isBetweenLength(0, 60)),
  });

  it.effect.prop(
    "Feature: asana-issue-tracker, Property 6: A probe reports every live project of every workspace",
    {
      viewer: Schema.NullOr(Text),
      workspaces: Schema.Array(SomeWorkspace).check(Schema.isBetweenLength(1, 4)),
      pageSize: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
    },
    ({ viewer, workspaces, pageSize }) =>
      Effect.gen(function* () {
        const fakeWorkspaces = workspaces.map((workspace, index) => ({
          gid: String(1100 + index),
          name: workspace.name,
        }));
        const projects = workspaces.flatMap((workspace, workspaceIndex) =>
          workspace.projects.map((name, projectIndex): FakeProject => ({
            gid: String(5000 + workspaceIndex * 1000 + projectIndex),
            name,
            workspace: { gid: fakeWorkspaces[workspaceIndex]?.gid ?? "" },
            members: [],
          })),
        );
        const fake = fakeAsana({
          model: {
            me: { ...JULIUS, name: viewer, workspaces: fakeWorkspaces },
            projects,
            pageSize,
          },
        });
        const probed = yield* withTracker(fake, (tracker) =>
          tracker.probeCredential("submitted_pat_test"),
        );
        const shown = (name: string | null, gid: string) => name?.trim() || gid;
        expect(probed.account).toBe(shown(viewer, JULIUS.email ?? ""));
        expect(probed.workspace).toBe(ASANA_WORKSPACE);
        expect(probed.scopes).toEqual(
          projects.map((project) => {
            const workspace = fakeWorkspaces.find((w) => w.gid === project.workspace.gid);
            const prefix =
              fakeWorkspaces.length > 1 && workspace !== undefined
                ? `${shown(workspace.name, workspace.gid)} / `
                : "";
            return { key: project.gid, name: `${prefix}${shown(project.name, project.gid)}` };
          }),
        );
        expect(
          fake.requests.every((request) => request.authorization === "Bearer submitted_pat_test"),
        ).toBe(true);
      }),
    runs,
  );

  const Printable = (max: number) =>
    Schema.String.check(Schema.isPattern(new RegExp(`^[\\x21-\\x7e]{0,${max}}$`)));
  const ForeignCursor = Schema.Union([
    Schema.Struct({ kind: Schema.Literal("other"), text: Printable(40) }),
    Schema.Struct({ kind: Schema.Literal("bare") }),
    Schema.Struct({
      kind: Schema.Literal("unprintable"),
      before: Printable(10),
      bad: Schema.Literals([" ", "\t", "\n", "\u007f", "\u00e9", "\u2028"]),
      after: Printable(10),
    }),
    Schema.Struct({
      kind: Schema.Literal("long"),
      extra: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 40 })),
    }),
  ]);
  const foreignCursorOf = (foreign: typeof ForeignCursor.Type) => {
    switch (foreign.kind) {
      case "other":
        return foreign.text.startsWith("a1.") ? `b${foreign.text}` : foreign.text;
      case "bare":
        return "a1.";
      case "unprintable":
        return `a1.${foreign.before}${foreign.bad}${foreign.after}`;
      case "long":
        return `a1.${"x".repeat(4094 + foreign.extra)}`;
    }
  };

  it.effect.prop(
    "Feature: asana-issue-tracker, Property 4: Cursors round-trip, stay bounded, and reject anything foreign",
    {
      offset: Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,4093}$/)),
      foreign: ForeignCursor,
    },
    ({ offset, foreign }) =>
      Effect.gen(function* () {
        const cursor = AsanaApi.encodeCursor(offset);
        expect(cursor).not.toBeNull();
        expect((cursor ?? "").length).toBeLessThanOrEqual(4096);
        expect(AsanaApi.decodeCursor(cursor ?? "")).toBe(offset);

        const stray = foreignCursorOf(foreign);
        expect(/^a1\.[\x21-\x7e]{1,4093}$/.test(stray)).toBe(false);
        expect(AsanaApi.decodeCursor(stray)).toBeNull();
        const fake = fakeAsana();
        const [listing, comments] = yield* withTracker(fake, (tracker) =>
          Effect.all([
            Effect.flip(
              tracker.listIssues({
                ...SCOPE,
                state: "all",
                involvement: "all",
                sort: "updated",
                limit: 50,
                cursor: stray,
              }),
            ),
            Effect.flip(tracker.getComments({ ...SCOPE, key: "7001", cursor: stray })),
          ]),
        );
        expect(listing.reason).toBe("failed");
        expect(comments.reason).toBe("failed");
        expect(fake.requests).toEqual([]);
      }),
    runs,
  );

  const ADA: FakeUser = { gid: "2003", name: "Ada", email: null, photo: null };
  const PEOPLE = [JULIUS, THEO, ADA] as const;
  const FEATURE_TAG: FakeTag = { ...BUG_TAG, gid: "6002", name: "Feature", color: null };
  const INFO_TAG: FakeTag = { ...BUG_TAG, gid: "6003", name: "  Needs info ", color: "neon" };
  const LABELS = [BUG_TAG, FEATURE_TAG, INFO_TAG] as const;
  const Person = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: PEOPLE.length - 1 }));
  const Label = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: LABELS.length - 1 }));
  const Tick = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 50 }));
  const ListedTask = Schema.Struct({
    completed: Schema.Boolean,
    hasParent: Schema.Boolean,
    assignee: Schema.NullOr(Person),
    createdBy: Schema.NullOr(Person),
    followers: Schema.Array(Person).check(Schema.isBetweenLength(0, 3)),
    tags: Schema.Array(Label).check(Schema.isBetweenLength(0, 3)),
    createdAt: Tick,
    modifiedAt: Tick,
  });
  const Listing = Schema.Struct({
    state: Schema.Literals(["all", "open", "closed"]),
    involvement: Schema.Literals(["all", "assigned", "authored", "mentioned"]),
    assignee: Schema.NullOr(
      Schema.Struct({ person: Person, by: Schema.Literals(["login", "gid"]) }),
    ),
    labels: Schema.Array(
      Schema.Struct({ label: Label, casing: Schema.Literals(["as-is", "upper", "lower"]) }),
    ).check(Schema.isBetweenLength(0, 3)),
    sort: Schema.Literals(["updated", "created"]),
    limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
  });
  const loginOf = (person: FakeUser) => person.email ?? person.gid;
  const unique = <A>(items: ReadonlyArray<A>) => [...new Set(items)];

  it.effect.prop(
    "Feature: asana-issue-tracker, Property 5: Listing pages concatenate to exactly the filtered task set",
    {
      tasks: Schema.Array(ListedTask).check(Schema.isBetweenLength(0, 30)),
      me: Person,
      pageSize: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
      listing: Listing,
    },
    ({ tasks, me, pageSize, listing }) =>
      Effect.gen(function* () {
        const viewer = PEOPLE[me] ?? JULIUS;
        const fakeTasks = tasks.map((source, index) =>
          task(String(7200 + index), {
            completed: source.completed,
            completed_at: source.completed ? FAKE_NOW : null,
            parent: source.hasParent ? { gid: "7000" } : null,
            assignee: source.assignee === null ? null : (PEOPLE[source.assignee] ?? null),
            created_by: source.createdBy === null ? null : (PEOPLE[source.createdBy] ?? null),
            followers: unique(source.followers).flatMap((index) => PEOPLE[index] ?? []),
            tags: unique(source.tags).flatMap((index) => {
              const tag = LABELS[index];
              return tag === undefined ? [] : [tagRef(tag)];
            }),
            created_at: at(source.createdAt),
            modified_at: at(source.modifiedAt),
          }),
        );
        const fake = fakeAsana({
          model: {
            me: { ...viewer, workspaces: [WORKSPACE] },
            tasks: fakeTasks,
            tags: [...LABELS],
            pageSize,
          },
        });
        const assigneeFilter =
          listing.assignee === null
            ? undefined
            : listing.assignee.by === "gid"
              ? (PEOPLE[listing.assignee.person] ?? JULIUS).gid
              : loginOf(PEOPLE[listing.assignee.person] ?? JULIUS);
        const labels = listing.labels.map(({ label, casing }) => {
          const name = LABELS[label]?.name ?? "";
          return casing === "upper"
            ? name.toUpperCase()
            : casing === "lower"
              ? name.toLowerCase()
              : name;
        });
        const input = {
          ...SCOPE,
          state: listing.state,
          sort: listing.sort,
          limit: listing.limit,
          assignee: assigneeFilter,
          labels,
          ...(listing.involvement === "all"
            ? { involvement: "all" as const }
            : { involvement: listing.involvement, viewer: loginOf(viewer) }),
        };

        const isViewer = (user: FakeUser | null) => user !== null && user.gid === viewer.gid;
        const expected = fakeTasks.filter((candidate) => {
          if (candidate.parent !== null) return false;
          if (listing.state === "open" && candidate.completed) return false;
          if (listing.state === "closed" && !candidate.completed) return false;
          if (listing.involvement === "assigned" && !isViewer(candidate.assignee)) return false;
          if (listing.involvement === "authored" && !isViewer(candidate.created_by)) return false;
          if (listing.involvement === "mentioned" && !candidate.followers.some(isViewer)) {
            return false;
          }
          if (
            assigneeFilter !== undefined &&
            !(
              candidate.assignee !== null &&
              (loginOf(candidate.assignee) === assigneeFilter ||
                candidate.assignee.gid === assigneeFilter)
            )
          ) {
            return false;
          }
          const names = candidate.tags.map((tag) => tag.name.trim().toLowerCase());
          return labels.every((label) => names.includes(label.trim().toLowerCase()));
        });

        const seen: Array<string> = [];
        let cursor: string | undefined;
        let previousOffset: string | null = null;
        for (let round = 0; round < 200; round += 1) {
          const before = fake.requests.length;
          const page = yield* withTracker(fake, (tracker) =>
            tracker.listIssues({ ...input, cursor }),
          );
          const reads = fake.requests
            .slice(before)
            .filter((request) => new URL(request.url).pathname.endsWith("/tasks"));
          expect(reads).toHaveLength(1);
          const params = new URL(reads[0]?.url ?? "").searchParams;
          expect(params.get("limit")).toBe(String(Math.min(listing.limit, 100)));
          expect(params.get("completed_since")).toBe(listing.state === "open" ? "now" : null);
          expect(params.get("offset")).toBe(previousOffset);

          const dates = page.items.map((item) =>
            Date.parse(listing.sort === "created" ? item.createdAt : item.updatedAt),
          );
          expect(dates).toEqual([...dates].sort((left, right) => right - left));
          seen.push(...page.items.map((item) => item.key));
          if (page.nextCursor === null) break;
          previousOffset = AsanaApi.decodeCursor(page.nextCursor);
          cursor = page.nextCursor;
        }
        expect([...seen].sort()).toEqual(expected.map((candidate) => candidate.gid).sort());
      }),
    runs,
  );

  it.effect.prop(
    "Feature: asana-issue-tracker, Property 7: Detail and older comment pages reassemble the conversation",
    {
      count: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 300 })),
      systems: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
      pageSize: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
    },
    ({ count, systems, pageSize }) =>
      Effect.gen(function* () {
        const comments = Array.from({ length: count }, (_, index) =>
          comment(String(8300 + index), "7001", `Comment ${index}`, at(index * 60)),
        );
        const noise = Array.from({ length: systems }, (_, index) => ({
          gid: String(8900 + index),
          task: "7001",
          type: "system" as const,
          resource_subtype: "marked_complete",
          text: "completed this task",
          created_at: at(index * 60 + 30),
          created_by: THEO,
        }));
        const fake = fakeAsana({ model: { stories: [...noise, ...comments], pageSize } });
        const detail = yield* withTracker(fake, (tracker) =>
          tracker.getIssue({ ...SCOPE, key: "7001" }),
        );
        const chronological = (page: ReadonlyArray<{ readonly createdAt: string }>) =>
          page
            .map((entry) => entry.createdAt)
            .every((value, index, all) => index === 0 || (all[index - 1] ?? "") <= value);
        expect(detail.comments.length).toBeLessThanOrEqual(50);
        expect(chronological(detail.comments)).toBe(true);
        const assembled = [...detail.comments];
        let cursor = detail.commentsCursor;
        for (let round = 0; round < 400 && cursor !== null; round += 1) {
          expect(assembled.length).toBeLessThan(count);
          const page = yield* withTracker(fake, (tracker) =>
            tracker.getComments({ ...SCOPE, key: "7001", cursor: cursor ?? "" }),
          );
          expect(page.comments.length).toBeLessThanOrEqual(50);
          expect(chronological(page.comments)).toBe(true);
          assembled.unshift(...page.comments);
          cursor = page.nextCursor;
        }
        expect(assembled.map((entry) => entry.id)).toEqual(comments.map((story) => story.gid));
        expect(assembled.map((entry) => entry.body)).toEqual(comments.map((story) => story.text));
      }),
    runs,
  );

  const EVENT_KINDS: Readonly<Record<string, string>> = {
    marked_complete: "closed",
    marked_incomplete: "reopened",
    assigned: "assigned",
    unassigned: "unassigned",
    added_to_tag: "labeled",
    removed_from_tag: "unlabeled",
    name_changed: "renamed",
  };
  const EventStory = Schema.Struct({
    type: Schema.Literals(["comment", "system"]),
    subtype: Schema.Literals([
      ...(Object.keys(EVENT_KINDS) as [string, ...Array<string>]),
      "comment_added",
      "liked",
      "due_date_changed",
      "attachment_added",
    ]),
    createdBy: Schema.NullOr(SomeUser),
    assignee: Schema.NullOr(SomeUser),
    tagName: Schema.NullOr(Text),
    newName: Schema.NullOr(Text),
    text: Text,
  });

  it.effect.prop(
    "Feature: asana-issue-tracker, Property 9: System stories map to events by the subtype table",
    { stories: Schema.Array(EventStory).check(Schema.isBetweenLength(0, 100)) },
    ({ stories }) =>
      Effect.gen(function* () {
        const fakeStories = stories.map((source, index): FakeStory => ({
          gid: String(8400 + index),
          task: "7001",
          type: source.type,
          resource_subtype: source.subtype,
          text: source.text,
          created_at: at(index * 60),
          created_by: source.createdBy,
          assignee: source.assignee,
          tag: source.tagName === null ? null : { gid: "6900", name: source.tagName },
          new_name: source.newName,
        }));
        const fake = fakeAsana({ model: { stories: fakeStories } });
        const detail = yield* withTracker(fake, (tracker) =>
          tracker.getIssue({ ...SCOPE, key: "7001" }),
        );
        const subjectOf = (story: FakeStory) => {
          switch (story.resource_subtype) {
            case "assigned":
              return story.assignee
                ? story.assignee.name?.trim() || actorOf(story.assignee).login
                : null;
            case "added_to_tag":
            case "removed_from_tag":
              return story.tag?.name ?? null;
            case "name_changed":
              return story.new_name ?? null;
            default:
              return null;
          }
        };
        const expected = fakeStories.flatMap((story) => {
          const kind = EVENT_KINDS[story.resource_subtype];
          if (story.type !== "system" || kind === undefined) return [];
          return [
            {
              id: story.gid,
              kind,
              actor: story.created_by === null ? null : actorOf(story.created_by),
              createdAt: story.created_at,
              detail: subjectOf(story)?.trim() || null,
            },
          ];
        });
        expect(detail.events).toEqual(expected);
        for (const event of detail.events) {
          expect(event.detail === null || event.detail.trim() !== "").toBe(true);
        }
      }),
    runs,
  );

  const PROJECTS: ReadonlyArray<FakeProject> = [PROJECT, "5002", "5003", "5004"].map((entry) =>
    typeof entry === "string" ? { ...PROJECT, gid: entry, name: `Project ${entry}` } : entry,
  );
  const ProjectIndex = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 }));
  const Write = Schema.Literals(["comment", "update", "setState"]);
  const Refusal = Schema.Literals([
    "scope outside memberships",
    "non-gid key",
    "unknown state",
    "two assignees",
    "assignee by name",
    "unmatched label",
  ]);
  const isWrite = (request: RecordedRequest) =>
    request.method === "POST" || request.method === "PUT";

  it.effect.prop(
    "Feature: asana-issue-tracker, Property 14: A refused write sends no write",
    {
      memberships: Schema.Array(ProjectIndex).check(Schema.isBetweenLength(0, 4)),
      scope: ProjectIndex,
      write: Write,
      refusal: Refusal,
    },
    ({ memberships, scope, write, refusal }) =>
      Effect.gen(function* () {
        const member = unique(memberships).flatMap((index) => PROJECTS[index] ?? []);
        const fake = fakeAsana({
          model: {
            projects: [...PROJECTS],
            tasks: [
              task("7001", {
                memberships: member.map((project) => ({
                  project: { gid: project.gid, name: project.name },
                })),
              }),
              task("7002"),
            ],
          },
        });
        const target = { ...SCOPE, scope: PROJECTS[scope]?.gid ?? "", key: "7001" };
        const attempt = (
          tracker: StandaloneIssueTrackerApi,
          input: typeof target,
          kind: typeof Write.Type,
        ) => {
          switch (kind) {
            case "comment":
              return tracker.comment?.({ ...input, body: "Hi" }) ?? Effect.die("no comment");
            case "update":
              return tracker.update?.({ ...input, title: "Renamed" }) ?? Effect.die("no update");
            case "setState":
              return (
                tracker.setState?.({ ...input, state: "Completed" }) ?? Effect.die("no setState")
              );
          }
        };

        const inScope = member.some((project) => project.gid === target.scope);
        const exit = yield* withTracker(fake, (tracker) =>
          Effect.exit(attempt(tracker, target, write)),
        );
        expect(Exit.isSuccess(exit)).toBe(inScope);
        expect(fake.requests.filter(isWrite)).toHaveLength(inScope ? 1 : 0);
        if (Exit.isFailure(exit)) {
          const error = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(error)).toBe(true);
          if (Option.isSome(error)) {
            expect(error.value.reason).toBe("failed");
            expect(error.value.detail).toBe(`Asana task 7001 is not in project ${target.scope}.`);
          }
        }

        const before = fake.requests.length;
        const scoped = { ...SCOPE, key: "7002" };
        const refused = yield* withTracker(fake, (tracker) => {
          switch (refusal) {
            case "scope outside memberships":
              return Effect.flip(attempt(tracker, { ...scoped, scope: "5999" }, write));
            case "non-gid key":
              return Effect.flip(attempt(tracker, { ...scoped, key: "ENG-7001" }, write));
            case "unknown state":
              return Effect.flip(
                tracker.setState?.({ ...scoped, state: "Done" }) ?? Effect.die("no setState"),
              );
            case "two assignees":
              return Effect.flip(
                tracker.update?.({ ...scoped, assignees: [THEO.gid, JULIUS.gid] }) ??
                  Effect.die("no update"),
              );
            case "assignee by name":
              return Effect.flip(
                tracker.update?.({ ...scoped, assignees: ["theo"] }) ?? Effect.die("no update"),
              );
            case "unmatched label":
              return Effect.flip(
                tracker.update?.({ ...scoped, labels: ["Bug", "Urgent"] }) ??
                  Effect.die("no update"),
              );
          }
        });
        expect(["failed", "not-found"]).toContain(refused.reason);
        expect(refused.reason).toBe(refusal === "non-gid key" ? "not-found" : "failed");
        expect(fake.requests.slice(before).filter(isWrite)).toEqual([]);
      }),
    runs,
  );

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
