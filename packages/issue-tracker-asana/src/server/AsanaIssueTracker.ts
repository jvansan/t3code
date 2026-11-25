/**
 * Asana as an issue tracker. A scope is a project gid and an issue key a task gid. A task is
 * either Incomplete or Completed; Asana's sections are not workflow states here. A task is shown
 * by its `Eng. ID` custom field when it has one, and by its gid otherwise.
 */
import * as Effect from "effect/Effect";
import type {
  IssueActor,
  IssueCapabilities,
  IssueComment,
  IssueEvent,
  IssueState,
  IssueViewerPermissions,
  StandaloneIssueTrackerDescriptor,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type StandaloneIssueTrackerApi,
  type TrackerIssueDetail,
  type TrackerIssueSummary,
} from "@t3tools/source-control-core/server/IssueTracker";

import { ASANA_HOST, ASANA_KIND, ASANA_WORKSPACE, parseAsanaTaskUrl } from "../shared/issueUrl.ts";
import * as AsanaApi from "./AsanaApi.ts";

const DESCRIPTOR: StandaloneIssueTrackerDescriptor = {
  tracker: ASANA_KIND,
  displayName: "Asana",
  host: ASANA_HOST,
  scopeNoun: "project",
  credential: {
    label: "Personal access token",
    helpUrl: "https://app.asana.com/0/my-apps",
  },
};

const CAPABILITIES: IssueCapabilities = {
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
};

/** Everything granted: Asana's API reports no per-task permissions and refuses with a message. */
const VIEWER_PERMISSIONS: IssueViewerPermissions = {
  setState: true,
  comment: true,
  edit: true,
  labels: true,
  assignees: true,
};

const OPEN_STATE: IssueState = { category: "open", name: "Incomplete" };
const CLOSED_STATE: IssueState = {
  category: "closed",
  name: "Completed",
  closeReason: "completed",
};
const STATES: ReadonlyArray<IssueState> = [OPEN_STATE, CLOSED_STATE];

const COMMENTS_PAGE = 50;
const EVENT_STORIES = 100;
const PAGE_MAX = 100;
const TAG_PAGES = 5;
/** The custom field some workspaces use for a short task id such as `ENG-120`. */
const DISPLAY_KEY_FIELD = "eng. id";

const isGid = (value: string) => /^\d{1,32}$/.test(value);

const fail = (
  operation: string,
  reason: IssueTrackerError["reason"],
  detail: string,
): IssueTrackerError => new IssueTrackerError({ tracker: ASANA_KIND, operation, reason, detail });

const COLORS: Readonly<Record<string, string>> = {
  "dark-pink": "#b4417b",
  "light-pink": "#f9aaef",
  "dark-green": "#3b8b4d",
  "light-green": "#b4dfab",
  "dark-blue": "#2e6bd1",
  "light-blue": "#a7c6f5",
  "dark-red": "#c43c39",
  "light-red": "#f4a6a3",
  "dark-teal": "#21857d",
  "light-teal": "#9fe0d6",
  "dark-brown": "#8a5b3a",
  "light-brown": "#e0c4a8",
  "dark-orange": "#d0682a",
  "light-orange": "#f8c29b",
  "dark-purple": "#7b4bc4",
  "light-purple": "#cfb5f5",
  "dark-warm-gray": "#6d6e6f",
  "light-warm-gray": "#cbcbcb",
};

/** Asana names its tag colours and publishes no hex values; the clients draw only hex. */
export const hexOf = (color: string | null | undefined): string | null =>
  color === null || color === undefined ? null : (COLORS[color] ?? null);

/** Asana accepts an email or a gid wherever it names a user, so the login needs no lookup. */
export const login = (user: AsanaApi.AsanaUser): string => user.email?.trim() || user.gid;

const toActor = (user: AsanaApi.AsanaUser): IssueActor => ({
  login: login(user),
  name: user.name?.trim() || null,
  avatarUrl: user.photo?.image_60x60 ?? null,
});

/** The `Eng. ID` the workspace gave the task, else the gid. */
export const displayKeyOf = (task: AsanaApi.AsanaTask): string =>
  task.custom_fields
    ?.find((field) => field.name?.trim().toLowerCase() === DISPLAY_KEY_FIELD)
    ?.display_value?.trim() || task.gid;

const toSummary = (task: AsanaApi.AsanaSummaryTask): TrackerIssueSummary => ({
  key: task.gid,
  displayKey: displayKeyOf(task),
  title: task.name?.trim() || "Untitled task",
  url: task.permalink_url,
  author: task.created_by ? toActor(task.created_by) : null,
  state: task.completed === true ? CLOSED_STATE : OPEN_STATE,
  createdAt: task.created_at,
  updatedAt: task.modified_at,
  closedAt: task.completed_at ?? null,
  assignees: task.assignee ? [toActor(task.assignee)] : [],
  labels: (task.tags ?? []).flatMap((tag) =>
    tag.name.trim() ? [{ name: tag.name.trim(), color: hexOf(tag.color) }] : [],
  ),
  commentCount: 0,
});

const toComment = (story: AsanaApi.AsanaStory): IssueComment => ({
  id: story.gid,
  author: story.created_by ? toActor(story.created_by) : null,
  body: story.text ?? "",
  createdAt: story.created_at,
  url: null,
});

/** The event a system story stands for, or null for a subtype T3 Code has no word for. */
const toEvent = (story: AsanaApi.AsanaStory): IssueEvent | null => {
  if (story.type !== "system") return null;
  const make = (kind: IssueEvent["kind"], detail: string | null | undefined): IssueEvent => ({
    id: story.gid,
    kind,
    actor: story.created_by ? toActor(story.created_by) : null,
    createdAt: story.created_at,
    detail: detail?.trim() || null,
  });
  switch (story.resource_subtype) {
    case "marked_complete":
      return make("closed", null);
    case "marked_incomplete":
      return make("reopened", null);
    case "assigned":
      return make(
        "assigned",
        story.assignee ? story.assignee.name?.trim() || login(story.assignee) : null,
      );
    case "unassigned":
      return make("unassigned", null);
    case "added_to_tag":
      return make("labeled", story.tag?.name);
    case "removed_from_tag":
      return make("unlabeled", story.tag?.name);
    case "name_changed":
      return make("renamed", story.new_name);
    default:
      return null;
  }
};

const cursorOf = (operation: string, offset: string | null) => {
  if (offset === null) return Effect.succeed(null);
  const cursor = AsanaApi.encodeCursor(offset);
  return cursor === null
    ? Effect.fail(fail(operation, "failed", "Asana returned a page token T3 Code cannot carry."))
    : Effect.succeed(cursor);
};

const offsetOf = (operation: string, cursor: string | undefined) => {
  if (cursor === undefined) return Effect.undefined;
  const offset = AsanaApi.decodeCursor(cursor);
  return offset === null
    ? Effect.fail(
        fail(operation, "failed", "This Asana list position is no longer valid. Reload the list."),
      )
    : Effect.succeed(offset);
};

const requireGidScope = (operation: string, scope: string) =>
  isGid(scope)
    ? Effect.void
    : Effect.fail(fail(operation, "failed", "Asana projects are named by gid."));

const requireGidKey = (operation: string, key: string) =>
  isGid(key)
    ? Effect.void
    : Effect.fail(fail(operation, "not-found", "Asana tasks are named by gid."));

const timeOf = (value: string) => {
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
};

export const make = Effect.gen(function* () {
  const api = yield* AsanaApi.AsanaApi;

  /** The task, after proving it is in the project the caller names. */
  const requireScopedTask = Effect.fn("AsanaIssueTracker.requireScopedTask")(function* (
    operation: string,
    target: { readonly scope: string; readonly key: string },
  ) {
    yield* requireGidKey(operation, target.key);
    const task = yield* api.getTask(target.key, "guard");
    if (task === null) {
      return yield* fail(
        operation,
        "not-found",
        "Asana has no such task, or this account cannot see it.",
      );
    }
    if (!(task.memberships ?? []).some((entry) => entry.project?.gid === target.scope)) {
      return yield* fail(
        operation,
        "failed",
        `Asana task ${target.key} is not in project ${target.scope}.`,
      );
    }
    return task;
  });

  const assigneeFor = (operation: string, assignees: ReadonlyArray<string>) => {
    if (assignees.length === 0) return Effect.succeed(null);
    if (assignees.length > 1) {
      return Effect.fail(fail(operation, "failed", "An Asana task has one assignee at most."));
    }
    const name = assignees[0]?.trim() ?? "";
    return isGid(name) || name.includes("@")
      ? Effect.succeed(name)
      : Effect.fail(fail(operation, "failed", "Name an Asana user by gid or email."));
  };

  const tagGidsFor = Effect.fn("AsanaIssueTracker.tagGidsFor")(function* (
    operation: string,
    workspaceGid: string,
    names: ReadonlyArray<string>,
  ) {
    if (names.length === 0) return [] as ReadonlyArray<string>;
    const { tags, truncated } = yield* api.listWorkspaceTags(workspaceGid, TAG_PAGES);
    const gids: Array<string> = [];
    for (const name of names) {
      const wanted = name.trim().toLowerCase();
      const tag = tags.find((candidate) => candidate.name.trim().toLowerCase() === wanted);
      if (tag === undefined) {
        return yield* fail(
          operation,
          "failed",
          `Asana has no tag named "${name}" in this workspace.${
            truncated ? ` Looked among the first ${TAG_PAGES * PAGE_MAX} tags.` : ""
          }`,
        );
      }
      if (!gids.includes(tag.gid)) gids.push(tag.gid);
    }
    return gids;
  });

  const matchesViewer = (
    user: AsanaApi.AsanaUser | null | undefined,
    viewer: string,
    viewerGid: string | null,
  ) => user !== null && user !== undefined && (login(user) === viewer || user.gid === viewerGid);

  const tracker: StandaloneIssueTrackerApi = {
    kind: ASANA_KIND,
    capabilities: CAPABILITIES,
    standalone: DESCRIPTOR,
    parseIssueUrl: parseAsanaTaskUrl,

    probeCredential: Effect.fn("AsanaIssueTracker.probeCredential")(function* (token) {
      const me = yield* api.me(token);
      const workspaces = yield* Effect.forEach(
        me.workspaces,
        (workspace) =>
          api.listProjects(workspace.gid, token).pipe(
            Effect.map((projects) =>
              projects.map((project) => ({
                key: project.gid,
                name:
                  (me.workspaces.length > 1
                    ? `${workspace.name?.trim() || workspace.gid} / `
                    : "") + (project.name.trim() || project.gid),
              })),
            ),
          ),
        { concurrency: 4 },
      );
      return {
        account: me.name?.trim() || login(me),
        workspace: ASANA_WORKSPACE,
        scopes: workspaces.flat(),
      };
    }),

    getViewer: () => api.me().pipe(Effect.map(login)),

    listIssues: Effect.fn("AsanaIssueTracker.listIssues")(function* (input) {
      const operation = "listIssues";
      const offset = yield* offsetOf(operation, input.cursor);
      yield* requireGidScope(operation, input.scope);
      const narrowed = input.involvement !== "all";
      const [page, me] = yield* Effect.all(
        [
          api.listProjectTasks({
            projectGid: input.scope,
            incompleteOnly: input.state === "open",
            withFollowers: input.involvement === "mentioned",
            limit: Math.min(input.limit, PAGE_MAX),
            offset,
          }),
          narrowed ? api.me() : Effect.succeed(null),
        ],
        { concurrency: "unbounded" },
      );
      const viewer = input.involvement === "all" ? "" : input.viewer;
      const viewerGid = me?.gid ?? null;
      const labels = (input.labels ?? []).map((label) => label.trim().toLowerCase());
      const kept = page.data.filter((task) => {
        if (task.parent !== null && task.parent !== undefined) return false;
        if (input.state === "open" && task.completed === true) return false;
        if (input.state === "closed" && task.completed !== true) return false;
        if (input.involvement === "assigned" && !matchesViewer(task.assignee, viewer, viewerGid)) {
          return false;
        }
        if (
          input.involvement === "authored" &&
          !matchesViewer(task.created_by, viewer, viewerGid)
        ) {
          return false;
        }
        if (
          input.involvement === "mentioned" &&
          !(task.followers ?? []).some((user) => matchesViewer(user, viewer, viewerGid))
        ) {
          return false;
        }
        if (
          input.assignee !== undefined &&
          !(
            task.assignee !== null &&
            task.assignee !== undefined &&
            (login(task.assignee) === input.assignee || task.assignee.gid === input.assignee)
          )
        ) {
          return false;
        }
        const names = (task.tags ?? []).map((tag) => tag.name.trim().toLowerCase());
        return labels.every((label) => names.includes(label));
      });
      const dateOf = (task: AsanaApi.AsanaSummaryTask) =>
        timeOf(input.sort === "created" ? task.created_at : task.modified_at);
      const sorted = [...kept].sort((a, b) => dateOf(b) - dateOf(a));
      return {
        items: sorted.map(toSummary),
        nextCursor: yield* cursorOf(operation, page.nextOffset),
      };
    }),

    getIssue: Effect.fn("AsanaIssueTracker.getIssue")(function* (input) {
      const operation = "getIssue";
      yield* requireGidKey(operation, input.key);
      const [task, comments, stories, me] = yield* Effect.all(
        [
          api.getTaskDetail(input.key).pipe(
            Effect.filterOrFail(
              (found): found is AsanaApi.AsanaSummaryTask => found !== null,
              () =>
                fail(
                  operation,
                  "not-found",
                  "Asana has no such task, or this account cannot see it.",
                ),
            ),
          ),
          api.listStories({ taskGid: input.key, commentsOnly: true, limit: COMMENTS_PAGE }),
          api.listStories({ taskGid: input.key, commentsOnly: false, limit: EVENT_STORIES }),
          api.me().pipe(Effect.orElseSucceed(() => null)),
        ],
        { concurrency: "unbounded" },
      );
      const detail: TrackerIssueDetail = {
        ...toSummary(task),
        body: task.notes ?? "",
        viewer: me === null ? null : login(me),
        viewerPermissions: VIEWER_PERMISSIONS,
        states: STATES,
        comments: comments.data.map(toComment).reverse(),
        commentsCursor: yield* cursorOf(operation, comments.nextOffset),
        events: stories.data
          .flatMap((story) => {
            const event = toEvent(story);
            return event === null ? [] : [event];
          })
          .reverse(),
        linkedPullRequests: [],
      };
      return detail;
    }),

    getIssueLink: Effect.fn("AsanaIssueTracker.getIssueLink")(function* (input) {
      const operation = "getIssueLink";
      yield* requireGidKey(operation, input.key);
      const task = yield* api.getTask(input.key, "link");
      if (task === null || task.permalink_url === undefined) {
        return yield* fail(
          operation,
          "not-found",
          "Asana has no such task, or this account cannot see it.",
        );
      }
      return {
        title: task.name?.trim() || "Untitled task",
        url: task.permalink_url,
        displayKey: displayKeyOf(task),
      };
    }),

    getComments: Effect.fn("AsanaIssueTracker.getComments")(function* (input) {
      const operation = "getComments";
      const offset = yield* offsetOf(operation, input.cursor);
      yield* requireGidKey(operation, input.key);
      const page = yield* api.listStories({
        taskGid: input.key,
        commentsOnly: true,
        limit: COMMENTS_PAGE,
        offset,
      });
      return {
        comments: page.data.map(toComment).reverse(),
        nextCursor: yield* cursorOf(operation, page.nextOffset),
      };
    }),

    create: Effect.fn("AsanaIssueTracker.create")(function* (input) {
      const operation = "create";
      yield* requireGidScope(operation, input.scope);
      const project = yield* api.getProject(input.scope);
      if (project === null) {
        return yield* fail(
          operation,
          "failed",
          `No Asana project has gid ${input.scope}, or this account cannot see it.`,
        );
      }
      const tagGids = yield* tagGidsFor(operation, project.workspace.gid, input.labels);
      const assignee = yield* assigneeFor(operation, input.assignees);
      const created = yield* api.createTask({
        projectGid: input.scope,
        name: input.title,
        notes: input.body,
        tagGids,
        assignee,
      });
      return { key: created.gid, displayKey: displayKeyOf(created), url: created.permalink_url };
    }),

    comment: Effect.fn("AsanaIssueTracker.comment")(function* (input) {
      yield* requireScopedTask("comment", input);
      yield* api.addComment(input.key, input.body);
    }),

    update: Effect.fn("AsanaIssueTracker.update")(function* (input) {
      const operation = "update";
      const task = yield* requireScopedTask(operation, input);
      let tagChanges: { add: ReadonlyArray<string>; remove: ReadonlyArray<string> } | null = null;
      if (input.labels !== undefined) {
        const workspace = task.workspace?.gid;
        if (workspace === undefined && input.labels.length > 0) {
          return yield* fail(
            operation,
            "failed",
            "Asana did not say which workspace the task is in.",
          );
        }
        const wanted = yield* tagGidsFor(operation, workspace ?? "", input.labels);
        const current = (task.tags ?? []).map((tag) => tag.gid);
        tagChanges = {
          add: wanted.filter((gid) => !current.includes(gid)),
          remove: current.filter((gid) => !wanted.includes(gid)),
        };
      }
      const assignee =
        input.assignees === undefined ? undefined : yield* assigneeFor(operation, input.assignees);
      const fields = {
        ...(input.title === undefined ? {} : { name: input.title }),
        ...(input.body === undefined ? {} : { notes: input.body }),
        ...(assignee === undefined ? {} : { assignee }),
      };
      if (Object.keys(fields).length > 0) yield* api.updateTask(input.key, fields);
      for (const gid of tagChanges?.add ?? []) yield* api.addTag(input.key, gid);
      for (const gid of tagChanges?.remove ?? []) yield* api.removeTag(input.key, gid);
    }),

    setState: Effect.fn("AsanaIssueTracker.setState")(function* (input) {
      const operation = "setState";
      const state = STATES.find((candidate) => candidate.name === input.state);
      if (state === undefined) {
        return yield* fail(
          operation,
          "failed",
          `An Asana task is ${OPEN_STATE.name} or ${CLOSED_STATE.name}, not "${input.state}".`,
        );
      }
      yield* requireScopedTask(operation, input);
      yield* api.updateTask(input.key, { completed: state.category === "closed" });
    }),

    listCandidates: Effect.fn("AsanaIssueTracker.listCandidates")(function* (input) {
      const operation = "listCandidates";
      yield* requireGidScope(operation, input.scope);
      const project = yield* api.getProject(input.scope);
      if (project === null) {
        return yield* fail(
          operation,
          "not-found",
          `No Asana project has gid ${input.scope}, or this account cannot see it.`,
        );
      }
      const { tags, truncated } = yield* api.listWorkspaceTags(project.workspace.gid, TAG_PAGES);
      return {
        labels: tags.map((tag) => ({
          name: tag.name.trim() || tag.gid,
          color: hexOf(tag.color),
          description: null,
        })),
        assignees: (project.members ?? []).map((member) => ({
          ...toActor(member),
          id: member.gid,
        })),
        truncated,
      };
    }),
  };
  return tracker;
});
