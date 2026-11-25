/**
 * Asana's REST API, signed with the personal access token saved in Settings. One `request`
 * function sends every call exactly once: a failed call is mapped to an `IssueTrackerError` and
 * never retried, and no part of the token reaches an error.
 */
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import { IssueTrackerError } from "@t3tools/source-control-core/server/IssueTracker";
import * as IssueTrackerHost from "@t3tools/source-control-core/server/IssueTrackerHost";

import { ASANA_KIND } from "../shared/issueUrl.ts";

export const KIND = ASANA_KIND;
const DEFAULT_API_URL = "https://app.asana.com/api/1.0";
/** The most pages one list read follows, so a runaway offset cannot loop forever. */
const MAX_LIST_PAGES = 50;

const AsanaApiConfig = Config.all({
  apiUrl: Config.String("T3CODE_ASANA_API_URL").pipe(Config.withDefault(DEFAULT_API_URL)),
});

const Gid = Schema.String.check(Schema.isPattern(/^\d{1,32}$/));
const NextPage = Schema.Struct({ offset: Schema.String });
const optionalNull = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema));

export const AsanaUser = Schema.Struct({
  gid: Gid,
  name: optionalNull(Schema.String),
  email: optionalNull(Schema.String),
  photo: optionalNull(Schema.Struct({ image_60x60: optionalNull(Schema.String) })),
});
export type AsanaUser = typeof AsanaUser.Type;

const AsanaWorkspaceRef = Schema.Struct({ gid: Gid, name: Schema.optional(Schema.String) });
export const AsanaMe = Schema.Struct({
  ...AsanaUser.fields,
  workspaces: Schema.Array(AsanaWorkspaceRef),
});
export type AsanaMe = typeof AsanaMe.Type;

export const AsanaProjectRef = Schema.Struct({ gid: Gid, name: Schema.String });
export type AsanaProjectRef = typeof AsanaProjectRef.Type;

export const AsanaProject = Schema.Struct({
  gid: Gid,
  name: Schema.String,
  workspace: Schema.Struct({ gid: Gid }),
  members: Schema.optional(Schema.Array(AsanaUser)),
});
export type AsanaProject = typeof AsanaProject.Type;

export const AsanaTag = Schema.Struct({
  gid: Gid,
  name: Schema.String,
  color: optionalNull(Schema.String),
});
export type AsanaTag = typeof AsanaTag.Type;

const AsanaCustomField = Schema.Struct({
  gid: Schema.optional(Schema.String),
  name: optionalNull(Schema.String),
  display_value: optionalNull(Schema.String),
});

const taskFields = {
  gid: Gid,
  name: Schema.optional(Schema.String),
  notes: Schema.optional(Schema.String),
  completed: Schema.optional(Schema.Boolean),
  completed_at: optionalNull(Schema.String),
  created_at: Schema.optional(Schema.String),
  modified_at: Schema.optional(Schema.String),
  permalink_url: Schema.optional(Schema.String),
  parent: optionalNull(Schema.Struct({ gid: Gid })),
  assignee: optionalNull(AsanaUser),
  created_by: optionalNull(AsanaUser),
  followers: Schema.optional(Schema.Array(AsanaUser)),
  tags: Schema.optional(Schema.Array(AsanaTag)),
  custom_fields: Schema.optional(Schema.Array(AsanaCustomField)),
  memberships: Schema.optional(
    Schema.Array(
      Schema.Struct({
        project: optionalNull(Schema.Struct({ gid: Gid, name: Schema.optional(Schema.String) })),
      }),
    ),
  ),
  workspace: Schema.optional(Schema.Struct({ gid: Gid })),
};
export const AsanaTask = Schema.Struct(taskFields);
export type AsanaTask = typeof AsanaTask.Type;

/** A task as a listing needs it: a summary never invents a date or a URL. */
export const AsanaSummaryTask = Schema.Struct({
  ...taskFields,
  created_at: Schema.String,
  modified_at: Schema.String,
  permalink_url: Schema.String,
});
export type AsanaSummaryTask = typeof AsanaSummaryTask.Type;

export const AsanaStory = Schema.Struct({
  gid: Gid,
  type: Schema.optional(Schema.String),
  resource_subtype: Schema.optional(Schema.String),
  text: optionalNull(Schema.String),
  created_at: Schema.String,
  created_by: optionalNull(AsanaUser),
  assignee: optionalNull(AsanaUser),
  tag: optionalNull(Schema.Struct({ gid: Gid, name: Schema.optional(Schema.String) })),
  new_name: optionalNull(Schema.String),
});
export type AsanaStory = typeof AsanaStory.Type;

const AsanaErrorBody = Schema.Struct({
  errors: Schema.Array(Schema.Struct({ message: Schema.optional(Schema.String) })),
});

const decodeErrorBody = Schema.decodeOption(Schema.fromJsonString(AsanaErrorBody));

export interface AsanaPage<A> {
  readonly data: ReadonlyArray<A>;
  readonly nextOffset: string | null;
}

const user = (prefix: string) => `${prefix}.name,${prefix}.email,${prefix}.photo.image_60x60`;
const CUSTOM_FIELDS = "custom_fields.name,custom_fields.display_value";
const TASK_SUMMARY = [
  "name,completed,completed_at,created_at,modified_at,permalink_url,parent",
  user("assignee"),
  user("created_by"),
  "tags.name,tags.color",
  CUSTOM_FIELDS,
].join(",");
const FIELDS = {
  summary: TASK_SUMMARY,
  summaryWithFollowers: `${TASK_SUMMARY},followers.email`,
  detail: `${TASK_SUMMARY},notes,memberships.project.name`,
  guard: "memberships.project,tags.name,workspace",
  link: `name,permalink_url,${CUSTOM_FIELDS}`,
  story: `type,resource_subtype,text,created_at,${user("created_by")},${user("assignee")},tag.name,new_name`,
  me: "name,email,workspaces.name",
  project: `name,workspace,${user("members")}`,
  projectRef: "name",
  tag: "name,color",
} as const;

const CURSOR_PREFIX = "a1.";
const OFFSET = /^[\x21-\x7e]{1,4093}$/;

/** An Asana offset as a cursor, or null when it is not printable ASCII that fits. */
export function encodeCursor(offset: string): string | null {
  return OFFSET.test(offset) ? `${CURSOR_PREFIX}${offset}` : null;
}

/** The Asana offset inside a cursor this module made, or null for anything else. */
export function decodeCursor(cursor: string): string | null {
  if (!cursor.startsWith(CURSOR_PREFIX)) return null;
  const offset = cursor.slice(CURSOR_PREFIX.length);
  return OFFSET.test(offset) ? offset : null;
}

const WINDOW = 8;

/**
 * Replaces every run of `text` covered by a substring of `secret` of 8 or more characters, so no
 * such substring survives. A secret shorter than 8 characters is replaced only where it is whole.
 */
export function redactSecret(text: string, secret: string): string {
  if (secret === "") return text;
  if (secret.length < WINDOW) return text.split(secret).join("[redacted]");
  const windows = new Set<string>();
  for (let index = 0; index + WINDOW <= secret.length; index += 1) {
    windows.add(secret.slice(index, index + WINDOW));
  }
  const marked = new Array<boolean>(text.length).fill(false);
  for (let index = 0; index + WINDOW <= text.length; index += 1) {
    if (windows.has(text.slice(index, index + WINDOW))) marked.fill(true, index, index + WINDOW);
  }
  let out = "";
  let inRun = false;
  for (let index = 0; index < text.length; index += 1) {
    if (marked[index]) {
      if (!inRun) out += "[redacted]";
      inRun = true;
    } else {
      inRun = false;
      out += text[index];
    }
  }
  return out;
}

export interface FailedResponse {
  readonly operation: string;
  readonly status: number;
  /** The `Retry-After` header, when sent. */
  readonly retryAfter?: string | undefined;
  /** The first message of Asana's error body, when the body decoded. */
  readonly message?: string | undefined;
  /** The failed request carried an `offset`. */
  readonly hadOffset: boolean;
  readonly now: number;
  readonly token: string;
}

const fail = (
  operation: string,
  reason: IssueTrackerError["reason"],
  detail: string,
  retryAt?: number,
) =>
  new IssueTrackerError({
    tracker: KIND,
    operation,
    reason,
    detail,
    ...(retryAt === undefined ? {} : { retryAt }),
  });

/** Asana's answer as the tracker's error. Carries no `cause`, and no part of the token. */
export function toTrackerError(input: FailedResponse): IssueTrackerError {
  const { operation, status, token } = input;
  const make = (reason: IssueTrackerError["reason"], detail: string, retryAt?: number) =>
    fail(operation, reason, redactSecret(detail, token), retryAt);
  if (status === 429) {
    const header = input.retryAfter?.trim() ?? "";
    const seconds = /^\d+$/.test(header) ? Number(header) : Number.NaN;
    return make(
      "rate-limited",
      "Asana's rate limit was reached.",
      Number.isSafeInteger(seconds) ? input.now + seconds * 1000 : undefined,
    );
  }
  if (status === 401) return make("unauthenticated", "Asana rejected the personal access token.");
  if (status === 402) return make("failed", "This Asana plan does not include that feature.");
  if (status === 403) return make("failed", "This Asana account cannot do that in Asana.");
  if (status === 404) {
    return make("not-found", "Asana has no such item, or this account cannot see it.");
  }
  if (status === 400 && input.hadOffset) {
    return make("failed", "Asana's page token expired. Reload the list.");
  }
  const message = input.message?.trim();
  return make(
    "failed",
    message ? message : `Asana returned HTTP ${status} with a body T3 Code could not read.`,
  );
}

export class AsanaApi extends Context.Service<
  AsanaApi,
  {
    /** The token's user and workspaces. Takes a token so it can vet a new one. */
    readonly me: (token?: string) => Effect.Effect<AsanaMe, IssueTrackerError>;
    /** Every live project of a workspace, following each offset. */
    readonly listProjects: (
      workspaceGid: string,
      token?: string,
    ) => Effect.Effect<ReadonlyArray<AsanaProjectRef>, IssueTrackerError>;
    /** Null for a project Asana has not, or this token cannot see. */
    readonly getProject: (gid: string) => Effect.Effect<AsanaProject | null, IssueTrackerError>;
    readonly listProjectTasks: (input: {
      readonly projectGid: string;
      readonly incompleteOnly: boolean;
      readonly withFollowers: boolean;
      readonly limit: number;
      readonly offset?: string | undefined;
    }) => Effect.Effect<AsanaPage<AsanaSummaryTask>, IssueTrackerError>;
    /** Null for a task Asana has not, or this token cannot see. */
    readonly getTask: (
      gid: string,
      fields: "link" | "guard",
    ) => Effect.Effect<AsanaTask | null, IssueTrackerError>;
    /** The task as the detail page reads it; null as for `getTask`. */
    readonly getTaskDetail: (
      gid: string,
    ) => Effect.Effect<AsanaSummaryTask | null, IssueTrackerError>;
    readonly listStories: (input: {
      readonly taskGid: string;
      readonly commentsOnly: boolean;
      readonly limit: number;
      readonly offset?: string | undefined;
    }) => Effect.Effect<AsanaPage<AsanaStory>, IssueTrackerError>;
    /** Up to `maxPages` pages of 100; `truncated` when Asana had more. */
    readonly listWorkspaceTags: (
      workspaceGid: string,
      maxPages: number,
    ) => Effect.Effect<
      { readonly tags: ReadonlyArray<AsanaTag>; readonly truncated: boolean },
      IssueTrackerError
    >;
    readonly createTask: (input: {
      readonly projectGid: string;
      readonly name: string;
      readonly notes: string;
      readonly tagGids: ReadonlyArray<string>;
      readonly assignee: string | null;
    }) => Effect.Effect<AsanaTask & { readonly permalink_url: string }, IssueTrackerError>;
    readonly updateTask: (
      gid: string,
      input: {
        readonly name?: string;
        readonly notes?: string;
        readonly assignee?: string | null;
        readonly completed?: boolean;
      },
    ) => Effect.Effect<void, IssueTrackerError>;
    readonly addTag: (taskGid: string, tagGid: string) => Effect.Effect<void, IssueTrackerError>;
    readonly removeTag: (taskGid: string, tagGid: string) => Effect.Effect<void, IssueTrackerError>;
    readonly addComment: (taskGid: string, text: string) => Effect.Effect<void, IssueTrackerError>;
  }
>()("@t3tools/issue-tracker-asana/server/AsanaApi") {}

interface RequestInput<A> {
  readonly operation: string;
  readonly method: "GET" | "POST" | "PUT";
  readonly path: string;
  readonly query?: Readonly<Record<string, string>> | undefined;
  /** Wrapped as `{ data }` beside `options.fields` on a write. */
  readonly body?: unknown;
  readonly fields?: ReadonlyArray<string> | undefined;
  /** What `data` decodes to. */
  readonly schema: Schema.Decoder<A>;
  readonly token?: string | undefined;
  readonly notFoundAsNull?: boolean | undefined;
}

export const make = Effect.gen(function* () {
  // Only a default-carrying string: nothing in the environment can make it fail.
  const config = yield* AsanaApiConfig.pipe(Effect.orDie);
  const baseUrl = config.apiUrl.replace(/\/+$/, "");
  const httpClient = yield* HttpClient.HttpClient;
  const host = yield* IssueTrackerHost.IssueTrackerHost;

  const storedToken = (operation: string) =>
    host.credentials
      .get(KIND)
      .pipe(
        Effect.flatMap(
          Effect.fromOption(() =>
            fail(operation, "unauthenticated", "Asana is not connected on this server."),
          ),
        ),
      );

  const request = Effect.fn("AsanaApi.request")(function* <A>(
    input: RequestInput<A>,
  ): Effect.fn.Return<
    { readonly data: A | null; readonly nextOffset: string | null },
    IssueTrackerError
  > {
    const { operation } = input;
    yield* Effect.annotateCurrentSpan({ "asana.operation": operation });
    const token = input.token ?? (yield* storedToken(operation));

    const base =
      input.method === "GET"
        ? HttpClientRequest.get(`${baseUrl}${input.path}`)
        : input.method === "POST"
          ? HttpClientRequest.post(`${baseUrl}${input.path}`)
          : HttpClientRequest.put(`${baseUrl}${input.path}`);
    const withAuth = base.pipe(
      HttpClientRequest.setUrlParams(input.query ?? {}),
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.acceptJson,
    );
    const prepared =
      input.method === "GET"
        ? withAuth
        : HttpClientRequest.bodyJsonUnsafe(withAuth, {
            data: input.body,
            ...(input.fields === undefined ? {} : { options: { fields: input.fields } }),
          });

    // Executed once: no retry policy is attached.
    const response = yield* httpClient
      .execute(prepared)
      .pipe(
        Effect.mapError(() =>
          fail(operation, "failed", redactSecret("Asana could not be reached.", token)),
        ),
      );

    const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));

    if (response.status < 200 || response.status >= 300) {
      if (input.notFoundAsNull === true && response.status === 404) {
        return { data: null, nextOffset: null };
      }
      const now = yield* Clock.currentTimeMillis;
      const body = decodeErrorBody(text);
      return yield* toTrackerError({
        operation,
        status: response.status,
        retryAfter: response.headers["retry-after"],
        message: Option.match(body, {
          onNone: () => undefined,
          onSome: (decoded) => decoded.errors.find((entry) => entry.message?.trim())?.message,
        }),
        hadOffset: input.query?.["offset"] !== undefined,
        now,
        token,
      });
    }

    const unreadable = () =>
      fail(operation, "failed", "Asana answered with a body T3 Code could not read.");
    const envelope = Schema.Struct({
      data: input.schema,
      next_page: Schema.optional(Schema.NullOr(NextPage)),
    });
    const decoded = Schema.decodeOption(Schema.fromJsonString(envelope))(text);
    if (Option.isNone(decoded)) return yield* unreadable();
    return {
      data: decoded.value.data,
      nextOffset: decoded.value.next_page?.offset ?? null,
    };
  });

  const required = <A>(
    operation: string,
    result: { readonly data: A | null; readonly nextOffset: string | null },
  ) =>
    result.data === null
      ? Effect.fail(fail(operation, "failed", "Asana answered with a body T3 Code could not read."))
      : Effect.succeed(result.data);

  const one = <A>(input: RequestInput<A>) =>
    request(input).pipe(Effect.flatMap((result) => required(input.operation, result)));

  const page = <A>(input: RequestInput<ReadonlyArray<A>>) =>
    request(input).pipe(
      Effect.flatMap((result) =>
        Effect.map(required(input.operation, result), (data) => ({
          data,
          nextOffset: result.nextOffset,
        })),
      ),
    );

  /** Follows each offset to the end, up to `maxPages`; `truncated` when Asana had more. */
  const pages = Effect.fnUntraced(function* <A>(
    read: (offset: string | undefined) => Effect.Effect<AsanaPage<A>, IssueTrackerError>,
    maxPages: number,
  ) {
    const items: Array<A> = [];
    let offset: string | undefined;
    for (let index = 0; index < maxPages; index += 1) {
      const result = yield* read(offset);
      items.push(...result.data);
      if (result.nextOffset === null) return { items, truncated: false };
      offset = result.nextOffset;
    }
    return { items, truncated: true };
  });

  const me: AsanaApi["Service"]["me"] = (token) =>
    one({
      operation: "me",
      method: "GET",
      path: "/users/me",
      query: { opt_fields: FIELDS.me },
      schema: AsanaMe,
      token,
    });

  const listProjects: AsanaApi["Service"]["listProjects"] = (workspaceGid, token) =>
    pages(
      (offset) =>
        page({
          operation: "listProjects",
          method: "GET",
          path: "/projects",
          query: {
            workspace: workspaceGid,
            archived: "false",
            limit: "100",
            opt_fields: FIELDS.projectRef,
            ...(offset === undefined ? {} : { offset }),
          },
          schema: Schema.Array(AsanaProjectRef),
          token,
        }),
      MAX_LIST_PAGES,
    ).pipe(Effect.map((result) => result.items));

  const getProject: AsanaApi["Service"]["getProject"] = (gid) =>
    request({
      operation: "getProject",
      method: "GET",
      path: `/projects/${gid}`,
      query: { opt_fields: FIELDS.project },
      schema: AsanaProject,
      notFoundAsNull: true,
    }).pipe(Effect.map((result) => result.data));

  const listProjectTasks: AsanaApi["Service"]["listProjectTasks"] = (input) =>
    page({
      operation: "listProjectTasks",
      method: "GET",
      path: `/projects/${input.projectGid}/tasks`,
      query: {
        limit: String(input.limit),
        opt_fields: input.withFollowers ? FIELDS.summaryWithFollowers : FIELDS.summary,
        ...(input.incompleteOnly ? { completed_since: "now" } : {}),
        ...(input.offset === undefined ? {} : { offset: input.offset }),
      },
      schema: Schema.Array(AsanaSummaryTask),
    });

  const getTask: AsanaApi["Service"]["getTask"] = (gid, fields) =>
    request({
      operation: "getTask",
      method: "GET",
      path: `/tasks/${gid}`,
      query: { opt_fields: FIELDS[fields] },
      schema: AsanaTask,
      notFoundAsNull: true,
    }).pipe(Effect.map((result) => result.data));

  const getTaskDetail: AsanaApi["Service"]["getTaskDetail"] = (gid) =>
    request({
      operation: "getTaskDetail",
      method: "GET",
      path: `/tasks/${gid}`,
      query: { opt_fields: FIELDS.detail },
      schema: AsanaSummaryTask,
      notFoundAsNull: true,
    }).pipe(Effect.map((result) => result.data));

  const listStories: AsanaApi["Service"]["listStories"] = (input) =>
    page({
      operation: "listStories",
      method: "GET",
      path: `/tasks/${input.taskGid}/stories`,
      query: {
        limit: String(input.limit),
        opt_fields: FIELDS.story,
        sort_ascending: "false",
        ...(input.commentsOnly ? { resource_subtype: "comment_added" } : {}),
        ...(input.offset === undefined ? {} : { offset: input.offset }),
      },
      schema: Schema.Array(AsanaStory),
    });

  const listWorkspaceTags: AsanaApi["Service"]["listWorkspaceTags"] = (workspaceGid, maxPages) =>
    pages(
      (offset) =>
        page({
          operation: "listWorkspaceTags",
          method: "GET",
          path: "/tags",
          query: {
            workspace: workspaceGid,
            limit: "100",
            opt_fields: FIELDS.tag,
            ...(offset === undefined ? {} : { offset }),
          },
          schema: Schema.Array(AsanaTag),
        }),
      maxPages,
    ).pipe(Effect.map((result) => ({ tags: result.items, truncated: result.truncated })));

  const createTask: AsanaApi["Service"]["createTask"] = (input) =>
    one({
      operation: "createTask",
      method: "POST",
      path: "/tasks",
      body: {
        name: input.name,
        notes: input.notes,
        projects: [input.projectGid],
        ...(input.tagGids.length === 0 ? {} : { tags: input.tagGids }),
        ...(input.assignee === null ? {} : { assignee: input.assignee }),
      },
      fields: ["permalink_url", "custom_fields.name", "custom_fields.display_value"],
      schema: Schema.Struct({ ...taskFields, permalink_url: Schema.String }),
    });

  const write = (operation: string, method: "POST" | "PUT", path: string, body: unknown) =>
    request({ operation, method, path, body, schema: Schema.Unknown }).pipe(Effect.asVoid);

  const updateTask: AsanaApi["Service"]["updateTask"] = (gid, input) =>
    write("updateTask", "PUT", `/tasks/${gid}`, input);

  const addTag: AsanaApi["Service"]["addTag"] = (taskGid, tagGid) =>
    write("addTag", "POST", `/tasks/${taskGid}/addTag`, { tag: tagGid });

  const removeTag: AsanaApi["Service"]["removeTag"] = (taskGid, tagGid) =>
    write("removeTag", "POST", `/tasks/${taskGid}/removeTag`, { tag: tagGid });

  const addComment: AsanaApi["Service"]["addComment"] = (taskGid, text) =>
    write("addComment", "POST", `/tasks/${taskGid}/stories`, { text });

  return AsanaApi.of({
    me,
    listProjects,
    getProject,
    listProjectTasks,
    getTask,
    getTaskDetail,
    listStories,
    listWorkspaceTags,
    createTask,
    updateTask,
    addTag,
    removeTag,
    addComment,
  });
});

export const layer = Layer.effect(AsanaApi, make);
