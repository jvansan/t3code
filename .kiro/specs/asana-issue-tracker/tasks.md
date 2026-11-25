# Implementation Plan: Asana issue tracker

## Overview

The plan builds `packages/issue-tracker-asana` in dependency order, then registers it on the server and wires it into the clients. Each leaf task is one conventional commit in the worktree `/Users/jvansan/Code/t3code-wt/asana-issue-tracker`, and the code is TypeScript on Effect 4, as the design specifies.

Every task that changes files ends with the same commit protocol:

1. Run the task's listed commands from the worktree root and fix every failure.
2. Stage the task's paths by name with `git add <path>...`. Never run `git commit -a` or `-am`, and never stage anything under `.kiro/`.
3. Check the staged list with `git status --short`; only the task's paths are staged.
4. Commit with the task's conventional message. Add no AI or agent attribution lines.

Property tests use `it.prop` or `it.effect.prop` from `@effect/vitest`, pass `{ arbitrary: { runs: 100 } }`, and carry the name `Feature: asana-issue-tracker, Property N: <title>`. Tests use the visibly fake token `asana_pat_test` and the fake base URL `https://asana.test/api/1.0`, and send no request to a real Asana host.

The `Eng. ID` custom field as a Display_Key is deferred and has no task.

## Tasks

- [x] 1. Install dependencies and record a clean baseline
  - Run `vp i` (per `docs/operations/00_development.md`; the worktree has no `.t3/setup-*` marker).
  - Run the baseline checks before any change: `vp run --filter @t3tools/issue-tracker-linear typecheck`, `vp run --filter @t3tools/client-runtime typecheck`, `vp run --filter t3 typecheck`, `vp run --filter @t3tools/web typecheck`, `vp run --filter @t3tools/mobile typecheck`, and `vp test run packages/issue-tracker-linear/src/server/LinearIssueTracker.test.ts packages/client-runtime/src/issueLinks.test.ts packages/client-runtime/src/workflows.test.ts`.
  - Report each command and its result. If a baseline check fails, report the failure and stop; do not fix code outside this feature.
  - `git status --short` must show only `.kiro/` as untracked. This task makes no commit.
  - _Requirements: 23.1, 23.2, 23.6_

- [ ] 2. Scaffold the `@t3tools/issue-tracker-asana` package
  - Create `packages/issue-tracker-asana/package.json` as the design's manifest, with only the `./shared/issueUrl` export for now; task 7.1 adds `./server/driver` when `driver.ts` exists.
  - Copy `packages/issue-tracker-linear/tsconfig.json` to `packages/issue-tracker-asana/tsconfig.json`.
  - Create `packages/issue-tracker-asana/src/shared/issueUrl.ts` with `ASANA_KIND = IssueTrackerKind.make("asana")`, `ASANA_HOST`, `ASANA_WORKSPACE`, and `ASANA_NO_PROJECT`, importing only `@t3tools/contracts`.
  - Run `vp i`; `git diff --stat pnpm-lock.yaml` shows only the new importer. Run `vp run --filter @t3tools/issue-tracker-asana typecheck`, `vp lint packages/issue-tracker-asana`, and `vp fmt --check packages/issue-tracker-asana`; fix failures.
  - Commit per the protocol, staging `packages/issue-tracker-asana/package.json`, `packages/issue-tracker-asana/tsconfig.json`, `packages/issue-tracker-asana/src/shared/issueUrl.ts`, and `pnpm-lock.yaml`: `feat(issue-tracker-asana): add package scaffold`.
  - _Requirements: 1.1, 1.3, 1.4, 1.5, 16.1, 16.2, 21.3_

- [ ] 3. Parse Asana task URLs
  - [ ] 3.1 Implement `parseAsanaTaskUrl` with example tests
    - In `packages/issue-tracker-asana/src/shared/issueUrl.ts`, implement the design's parsing rules: `https:` only, exact host `app.asana.com`, no username, password, or port, gid pattern `/^\d{1,32}$/`, and the four path forms (V0 with and without `/f`, V1 with `/project/`, V1 project-less). Query and fragment are never read. The V1 workspace gid is validated and discarded; every link returns `workspace: ASANA_WORKSPACE`, and project-less links return scope `ASANA_NO_PROJECT`.
    - Create `packages/issue-tracker-asana/src/shared/issueUrl.test.ts` with example tests for each accepted form (including the live `permalink_url` form `https://app.asana.com/1/<w>/project/<p>/task/<t>`) and the design's rejected-path table: `/0/<p>/list`, `/0/portfolio/<g>/list`, `/0/inbox/<g>`, `/0/home/<g>`, `/1/<w>/project/<p>`, `/1/<w>/project/<p>/task/<t>/comment/<c>`, `/1/<w>/home/task/<t>`, plus `app.asana.com.example.net`, `evil-app.asana.com`, and `asana.com`.
    - Run `vp test run packages/issue-tracker-asana/src/shared/issueUrl.test.ts`, `vp run --filter @t3tools/issue-tracker-asana typecheck`, `vp lint packages/issue-tracker-asana/src/shared`, and `vp fmt --check packages/issue-tracker-asana/src/shared`; fix failures.
    - Commit per the protocol, staging the two files: `feat(issue-tracker-asana): parse Asana task URLs`.
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 22.2_

  - [ ] 3.2 Write property test for accepted task URLs
    - **Property 1: Accepted Task URLs parse to their project and task**
    - **Validates: Requirements 3.5, 4.1, 4.2, 4.3, 4.4, 4.5, 4.11, 5.4**
    - Add to `packages/issue-tracker-asana/src/shared/issueUrl.test.ts`: generate gids `t`, `p`, `w` (1 to 32 digits), a query string, and a fragment; assert the three project forms return one link with scope `p`, and the two project-less forms return scope `"0"`.
    - Run `vp test run packages/issue-tracker-asana/src/shared/issueUrl.test.ts`, `vp lint packages/issue-tracker-asana/src/shared`, and `vp fmt --check packages/issue-tracker-asana/src/shared`; fix failures.
    - Commit per the protocol, staging the test file: `test(issue-tracker-asana): property-test accepted task URLs`.

  - [ ] 3.3 Write property test for the format-then-parse round trip
    - **Property 2: Formatting then parsing a link is the identity**
    - **Validates: Requirements 4.12**
    - Add to `packages/issue-tracker-asana/src/shared/issueUrl.test.ts` a test-local V0 formatter (`https://app.asana.com/0/${scope}/${key}`), so the package ships no unused export, and assert that parsing the formatted link of any parsed link returns an equal link.
    - Run `vp test run packages/issue-tracker-asana/src/shared/issueUrl.test.ts`, `vp lint packages/issue-tracker-asana/src/shared`, and `vp fmt --check packages/issue-tracker-asana/src/shared`; fix failures.
    - Commit per the protocol, staging the test file: `test(issue-tracker-asana): property-test the task URL round trip`.

  - [ ] 3.4 Write property test for rejected URL mutations
    - **Property 3: Only exact, credential-free Asana task URLs are accepted**
    - **Validates: Requirements 4.6, 4.7, 4.8, 4.9**
    - Add to `packages/issue-tracker-asana/src/shared/issueUrl.test.ts`: from an accepted URL, apply exactly one mutation (other scheme; host with a generated prefix, suffix, subdomain, or one-character edit that differs ignoring case; added username, password, or port; a gid segment replaced by a non-gid string) and assert `null`.
    - Run `vp test run packages/issue-tracker-asana/src/shared/issueUrl.test.ts`, `vp lint packages/issue-tracker-asana/src/shared`, and `vp fmt --check packages/issue-tracker-asana/src/shared`; fix failures.
    - Commit per the protocol, staging the test file: `test(issue-tracker-asana): property-test rejected task URLs`.

- [ ] 4. Build the Asana API client over `HttpClient`
  - [ ] 4.1 Add Asana schemas and pure helpers
    - Create `packages/issue-tracker-asana/src/server/AsanaApi.ts` with the design's Data Models: `Gid`, `NextPage`, `Page`, `One`, `AsanaUser`, `AsanaWorkspaceRef`, `AsanaMe`, `AsanaProjectRef`, `AsanaProject`, `AsanaTag`, `AsanaTask`, the narrower `AsanaSummaryTask` (required `created_at`, `modified_at`, `permalink_url`), `AsanaStory`, `AsanaErrorBody`, and the `AsanaPage<A>` type.
    - Add the `opt_fields` sets (`USER`, `TASK_SUMMARY`, with followers, `TASK_DETAIL`, `TASK_GUARD`, `TASK_LINK`, `STORY`, `ME`, `PROJECT`, `PROJECT_REF`, `TAG`) exactly as the design's table lists them.
    - Implement and export `encodeCursor` and `decodeCursor` (`a1.` prefix, printable ASCII, 1 to 4,093 characters), `redactSecret` (8-character window algorithm; a secret shorter than 8 is replaced only where whole), and `toTrackerError` with the design's error mapping table, taking the current time from `Clock.currentTimeMillis` and attaching no `cause`.
    - Run `vp run --filter @t3tools/issue-tracker-asana typecheck`, `vp lint packages/issue-tracker-asana/src/server`, and `vp fmt --check packages/issue-tracker-asana/src/server`; fix failures.
    - Commit per the protocol, staging `AsanaApi.ts`: `feat(issue-tracker-asana): add Asana schemas, cursor codec, and error mapping`.
    - _Requirements: 2.7, 7.4, 7.5, 7.6, 13.1, 13.2, 13.3, 13.5, 13.6, 13.7, 13.8, 13.9, 13.10, 14.3, 14.5_

  - [ ] 4.2 Implement the `request` core and the `AsanaApi` service, with the fake Asana harness
    - In `AsanaApi.ts`, add `AsanaApiConfig` (`T3CODE_ASANA_API_URL`, default `https://app.asana.com/api/1.0`), the `request` function with the design's seven steps (span annotation `asana.operation` only, token from `input.token ?? host.credentials.get(KIND)`, `unauthenticated` with no request when none is stored, Bearer auth, `{ data, options: { fields } }` bodies for writes, one execution with no retry, `notFoundAsNull`, decode and transport failures), and every method of the `AsanaApi` service (`me`, `listProjects` following each offset, `getProject`, `listProjectTasks` with `completed_since=now` for incomplete-only, `getTask` by field set, `listStories` with `resource_subtype=comment_added` for comments and `sort_ascending=false`, `listWorkspaceTags` capped at `maxPages`, `createTask`, `updateTask`, `addTag`, `removeTag`, `addComment`). Export `make` and `layer`. Do not override `Headers.CurrentRedactedNames`.
    - Create `packages/issue-tracker-asana/src/server/AsanaIssueTracker.test.ts` with the fake Asana harness from the design: an `HttpClient.make` fake over an in-memory model (workspaces, projects, tasks, stories, tags) that serves `limit` and `offset` with its own offsets, honours `completed_since=now`, `resource_subtype=comment_added`, and `sort_ascending=false`, applies writes to its state, records `{ method, url, authorization, body }`, and fails the test on any host other than the configured base URL; and a fake `IssueTrackerHost` serving `asana_pat_test`.
    - Add example tests under a `describe("AsanaApi")` block: the token is read per request; a submitted token overrides the stored one; a missing token sends nothing; the `T3CODE_ASANA_API_URL` override through a test `ConfigProvider`; `opt_fields` on GET reads; transport failure yields "Asana could not be reached." with no `cause`; an undecodable 2xx body yields `failed`. Assert that span attributes omit the `authorization` header only if the `@effect/vitest` test tracer exposes span attributes; otherwise leave it to review.
    - Run `vp test run packages/issue-tracker-asana/src/server/AsanaIssueTracker.test.ts`, `vp run --filter @t3tools/issue-tracker-asana typecheck`, `vp lint packages/issue-tracker-asana/src/server`, and `vp fmt --check packages/issue-tracker-asana/src/server`; fix failures.
    - Commit per the protocol, staging `AsanaApi.ts` and `AsanaIssueTracker.test.ts`: `feat(issue-tracker-asana): add the Asana REST client`.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.3, 13.4, 13.10, 14.2, 14.4, 14.5, 22.1, 22.7_

  - [ ] 4.3 Write property test for error mapping without retry
    - **Property 11: Every Asana failure maps to one error and no retry**
    - **Validates: Requirements 2.7, 3.6, 7.6, 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8, 13.9, 13.10, 14.5**
    - Add to `AsanaIssueTracker.test.ts`: generate a status from 400 to 599, a `Retry-After` value (absent, whole seconds, malformed), a body (Asana error body, empty, non-JSON), and a request with or without `offset`; assert exactly one request, the table's reason and detail, `retryAt` equal to the `TestClock` time plus seconds × 1,000 exactly for 429 with a whole-number header, and no `cause`.
    - Run `vp test run packages/issue-tracker-asana/src/server/AsanaIssueTracker.test.ts`, `vp lint packages/issue-tracker-asana/src/server`, and `vp fmt --check packages/issue-tracker-asana/src/server`; fix failures.
    - Commit per the protocol, staging the test file: `test(issue-tracker-asana): property-test Asana error mapping`.

  - [ ] 4.4 Write property test for token redaction
    - **Property 12: No error carries any part of the token**
    - **Validates: Requirements 14.3**
    - Add to `AsanaIssueTracker.test.ts`: generate a token of 8 to 128 printable characters and an Asana error message embedding the whole token, a prefix, or substrings of 8 or more characters at random positions; serve it as an error body and assert the resulting error's `detail` and `message` contain no token substring of 8 or more characters.
    - Run `vp test run packages/issue-tracker-asana/src/server/AsanaIssueTracker.test.ts`, `vp lint packages/issue-tracker-asana/src/server`, and `vp fmt --check packages/issue-tracker-asana/src/server`; fix failures.
    - Commit per the protocol, staging the test file: `test(issue-tracker-asana): property-test token redaction`.

- [ ] 5. Implement the Asana tracker's connect flow, listing, and reads
  - [ ] 5.1 Add the descriptor, capabilities, mapping helpers, probe, and viewer
    - Create `packages/issue-tracker-asana/src/server/AsanaIssueTracker.ts` exporting `make: Effect<StandaloneIssueTrackerApi, never, AsanaApi>` with the design's constants (`DESCRIPTOR`, `CAPABILITIES`, `VIEWER_PERMISSIONS`, `OPEN_STATE`, `CLOSED_STATE`, `STATES`, page sizes, `TAG_PAGES`, `isGid`), the helpers `login`, `toActor`, `toSummary`, `toComment` (no `reactions` key), `toEvent` per the subtype table, and `hexOf` per the colour table.
    - Implement `kind`, `capabilities`, `standalone`, `parseIssueUrl: parseAsanaTaskUrl`, `probeCredential` (`me(token)`, then `listProjects` per workspace with concurrency 4, workspace-prefixed names when the Viewer has more than one workspace, `workspace: ASANA_WORKSPACE`), and `getViewer`. Leave the remaining port methods to tasks 5.4, 5.7, 6.1, and 6.5; if the port type requires them now, stub each with a `failed` "not implemented" error that those tasks replace.
    - Add example tests to `AsanaIssueTracker.test.ts`: descriptor and capabilities; probe with a submitted token; a 401 probe fails `unauthenticated`.
    - Run `vp test run packages/issue-tracker-asana/src/server/AsanaIssueTracker.test.ts`, `vp run --filter @t3tools/issue-tracker-asana typecheck`, `vp lint packages/issue-tracker-asana/src/server`, and `vp fmt --check packages/issue-tracker-asana/src/server`; fix failures.
    - Commit per the protocol, staging `AsanaIssueTracker.ts` and `AsanaIssueTracker.test.ts`: `feat(issue-tracker-asana): describe the tracker and probe Asana tokens`.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 6.12, 6.13, 6.14, 11.4, 12.1, 12.2, 19.4_

  - [ ] 5.2 Write property test for summary mapping
    - **Property 8: A task maps to a summary field for field**
    - **Validates: Requirements 6.12, 6.13, 8.3, 8.4**
    - Add to `AsanaIssueTracker.test.ts`: generate decoded Asana tasks (blank and non-blank names, with and without assignee, tags with known, unknown, and null colours) and assert each `toSummary` field the property names. Export `toSummary` only if no other route lets the test reach it; prefer driving it through `listIssues` once 5.4 lands, otherwise through the module's existing exports.
    - Run `vp test run packages/issue-tracker-asana/src/server/AsanaIssueTracker.test.ts`, `vp lint packages/issue-tracker-asana/src/server`, and `vp fmt --check packages/issue-tracker-asana/src/server`; fix failures.
    - Commit per the protocol, staging the changed files: `test(issue-tracker-asana): property-test task summaries`.

  - [ ] 5.3 Write property test for the credential probe
    - **Property 6: A probe reports every live project of every workspace**
    - **Validates: Requirements 3.2, 3.3, 3.4, 3.5**
    - Add to `AsanaIssueTracker.test.ts`: generate a Viewer with 1 to 4 workspaces, each with 0 to 250 projects served in pages of random size, and assert one scope per project with the right key and name, `account` equal to the Viewer's name, and `workspace` equal to `ASANA_WORKSPACE`.
    - Run `vp test run packages/issue-tracker-asana/src/server/AsanaIssueTracker.test.ts`, `vp lint packages/issue-tracker-asana/src/server`, and `vp fmt --check packages/issue-tracker-asana/src/server`; fix failures.
    - Commit per the protocol, staging the test file: `test(issue-tracker-asana): property-test the credential probe`.

  - [ ] 5.4 Implement `listIssues`
    - In `AsanaIssueTracker.ts`, implement the design's five steps: decode the cursor (failure is `failed` with the reload detail and no request); reject a non-gid scope with `failed` "Asana projects are named by gid." and no request; call `listProjectTasks` with `limit = min(limit, 100)`, `incompleteOnly` for `open`, and `withFollowers` for `mentioned`, reading `me()` concurrently when involvement is not `all`; filter by top level, closed state, involvement (gid or login), assignee login or gid, and labels case-insensitively; sort newest first by `modified_at` or `created_at`; return `nextCursor` from `encodeCursor(next_page.offset)`, failing with "Asana returned a page token T3 Code cannot carry." when the offset cannot be carried, and returning the cursor even when filters left fewer items.
    - Add example tests to `AsanaIssueTracker.test.ts`: `opt_fields` on the list read, an expired offset (400 with `offset`) fails with the reload detail.
    - Run `vp test run packages/issue-tracker-asana/src/server/AsanaIssueTracker.test.ts`, `vp run --filter @t3tools/issue-tracker-asana typecheck`, `vp lint packages/issue-tracker-asana/src/server`, and `vp fmt --check packages/issue-tracker-asana/src/server`; fix failures.
    - Commit per the protocol, staging `AsanaIssueTracker.ts` and `AsanaIssueTracker.test.ts`: `feat(issue-tracker-asana): list an Asana project's tasks`.
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11, 6.15, 7.1, 7.2, 7.3, 7.5, 7.6, 7.7_

  - [ ] 5.5 Write property test for cursors
    - **Property 4: Cursors round-trip, stay bounded, and reject anything foreign**
    - **Validates: Requirements 7.1, 7.4, 7.5, 7.7**
    - Add to `AsanaIssueTracker.test.ts`: for any 1 to 4,093 printable ASCII offset, `decodeCursor(encodeCursor(o)) === o` and the cursor is at most 4,096 characters; for any string that is not `a1.` plus such an offset, `decodeCursor` is null, and `listIssues` and `getComments` given it fail `failed` after the fake receives no request. Until task 5.7 implements `getComments`, cover `listIssues` only and extend this test in 5.7.
    - Run `vp test run packages/issue-tracker-asana/src/server/AsanaIssueTracker.test.ts`, `vp lint packages/issue-tracker-asana/src/server`, and `vp fmt --check packages/issue-tracker-asana/src/server`; fix failures.
    - Commit per the protocol, staging the test file: `test(issue-tracker-asana): property-test Asana cursors`.

  - [ ] 5.6 Write model-based property test for listing pages
    - **Property 5: Listing pages concatenate to exactly the filtered task set**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11, 6.15, 7.1, 7.2, 7.3**
    - Add to `AsanaIssueTracker.test.ts`: generate a project of tasks (random `completed`, `parent`, `assignee`, `created_by`, `followers`, `tags`, `created_at`, `modified_at`), a fake page size, a Viewer, and a listing input (`state`, `involvement`, `assignee`, `labels`, `sort`, `limit` 1 to 200); follow `nextCursor` to null and assert each task the reference filter keeps appears exactly once, each page is sorted newest first by the requested date, and each request carries `limit = min(limit, 100)`, `completed_since=now` exactly for `open`, and the previous page's offset.
    - Run `vp test run packages/issue-tracker-asana/src/server/AsanaIssueTracker.test.ts`, `vp lint packages/issue-tracker-asana/src/server`, and `vp fmt --check packages/issue-tracker-asana/src/server`; fix failures.
    - Commit per the protocol, staging the test file: `test(issue-tracker-asana): property-test task listing pages`.

  - [ ] 5.7 Implement `getIssue`, `getIssueLink`, and `getComments`
    - In `AsanaIssueTracker.ts`, implement `getIssue` as the design's four concurrent GETs (task detail, newest 50 comment stories, newest 100 stories, `me()`); a non-gid key fails `not-found` with no request; a null task fails `not-found`; a viewer failure becomes `viewer: null`. Reverse comments to oldest first, map system stories to events oldest first, return `STATES`, `VIEWER_PERMISSIONS`, an empty linked pull request list, notes as the body, and `commentsCursor` from the comment page's offset.
    - Implement `getIssueLink` with `getTask(key, "link")` and `getComments` (decode cursor, one `listStories` comments page of 50, reversed).
    - Extend the Property 4 test to cover `getComments` with a foreign cursor.
    - Add example tests to `AsanaIssueTracker.test.ts`: detail body, states, permissions, empty linked pull requests, no reactions key on comments, 404 read fails `not-found`, non-gid key sends no request, `opt_fields` on the detail and story reads.
    - Run `vp test run packages/issue-tracker-asana/src/server/AsanaIssueTracker.test.ts`, `vp run --filter @t3tools/issue-tracker-asana typecheck`, `vp lint packages/issue-tracker-asana/src/server`, and `vp fmt --check packages/issue-tracker-asana/src/server`; fix failures.
    - Commit per the protocol, staging `AsanaIssueTracker.ts` and `AsanaIssueTracker.test.ts`: `feat(issue-tracker-asana): read Asana task details and comments`.
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9, 8.10, 8.11, 8.12, 8.13, 8.14, 8.15, 9.1, 9.2, 12.3, 22.3_

  - [ ] 5.8 Write model-based property test for comment paging
    - **Property 7: Detail and older comment pages reassemble the conversation**
    - **Validates: Requirements 8.5, 8.6, 8.7, 9.1, 9.2, 9.3**
    - Add to `AsanaIssueTracker.test.ts`: generate a task with 0 to 300 comment stories; take the detail's comments, prepend each `getComments` page until the cursor is null, and assert the result equals the task's comments in chronological order, each exactly once, every page holds at most 50 in chronological order, and a cursor is null exactly when no older comment remains.
    - Run `vp test run packages/issue-tracker-asana/src/server/AsanaIssueTracker.test.ts`, `vp lint packages/issue-tracker-asana/src/server`, and `vp fmt --check packages/issue-tracker-asana/src/server`; fix failures.
    - Commit per the protocol, staging the test file: `test(issue-tracker-asana): property-test comment paging`.

  - [ ] 5.9 Write property test for story-to-event mapping
    - **Property 9: System stories map to events by the subtype table**
    - **Validates: Requirements 8.8, 8.9, 8.10, 8.11**
    - Add to `AsanaIssueTracker.test.ts`: generate up to 100 stories with random `type` and `resource_subtype` (mapped and unmapped subtypes, blank and non-blank subjects) and assert the detail's events are, oldest first, exactly the mapped system stories with the table's kind and a non-blank-or-null `detail`.
    - Run `vp test run packages/issue-tracker-asana/src/server/AsanaIssueTracker.test.ts`, `vp lint packages/issue-tracker-asana/src/server`, and `vp fmt --check packages/issue-tracker-asana/src/server`; fix failures.
    - Commit per the protocol, staging the test file: `test(issue-tracker-asana): property-test task events`.

- [ ] 6. Implement the Asana tracker's writes and pickers
  - [ ] 6.1 Implement the write guards, `create`, `comment`, `update`, and `setState`
    - In `AsanaIssueTracker.ts`, implement `requireScopedTask` (non-gid key is `not-found`, null task is `not-found`, scope outside `memberships` is `failed` "Asana task {key} is not in project {scope}."), `assigneeFor` (zero, one gid or email, more than one fails "An Asana task has one assignee at most.", other names fail "Name an Asana user by gid or email."), and `tagGidsFor` (case-insensitive trimmed match, "Asana has no tag named "{name}" in this workspace.", plus "among the first 500 tags." when truncated).
    - Implement `create` (`getProject`, null fails with the design's detail; non-gid scope fails before any request; resolve tags; validate the assignee; `createTask`; return gid as key and Display_Key, and `permalink_url`), `comment`, `update` (only present fields in one PUT, empty assignee list sends `assignee: null`, then `addTag` and `removeTag` one at a time by gid difference), and `setState` (state name must be `Incomplete` or `Completed`, checked before any request). Every refusing check runs before the first write.
    - Add example tests to `AsanaIssueTracker.test.ts`: create body and result; assignee by gid and by email; empty assignees sends `assignee: null`; comment; set state both ways; a write to a task in two projects succeeds through either project.
    - Run `vp test run packages/issue-tracker-asana/src/server/AsanaIssueTracker.test.ts`, `vp run --filter @t3tools/issue-tracker-asana typecheck`, `vp lint packages/issue-tracker-asana/src/server`, and `vp fmt --check packages/issue-tracker-asana/src/server`; fix failures.
    - Commit per the protocol, staging `AsanaIssueTracker.ts` and `AsanaIssueTracker.test.ts`: `feat(issue-tracker-asana): create, edit, comment on, and complete Asana tasks`.
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.10, 10.11, 10.12, 10.13, 22.6_

  - [ ] 6.2 Write property test for write guards
    - **Property 14: A refused write sends no write**
    - **Validates: Requirements 8.15, 10.3, 10.5, 10.11, 10.12, 10.13**
    - Add to `AsanaIssueTracker.test.ts`: for `comment`, `update`, and `setState` over a task with a random set of project memberships, assert the write reaches Asana exactly when the scope is a membership; for each guard-refused input (scope outside memberships, non-gid key, unknown state name, two or more assignees, an assignee that is neither gid nor email, an unmatched label), assert `failed` or `not-found` and that the fake received no POST or PUT.
    - Run `vp test run packages/issue-tracker-asana/src/server/AsanaIssueTracker.test.ts`, `vp lint packages/issue-tracker-asana/src/server`, and `vp fmt --check packages/issue-tracker-asana/src/server`; fix failures.
    - Commit per the protocol, staging the test file: `test(issue-tracker-asana): property-test write guards`.

  - [ ] 6.3 Write property test for label resolution
    - **Property 15: Labels resolve to workspace tags and change by difference**
    - **Validates: Requirements 10.2**
    - Add to `AsanaIssueTracker.test.ts`: generate a workspace tag set, current task tags, and requested names that each match a tag ignoring case; assert `update` calls `addTag` for exactly the missing matched tags and `removeTag` for exactly the unrequested current tags, and `create` sends exactly the matched gids in `tags`.
    - Run `vp test run packages/issue-tracker-asana/src/server/AsanaIssueTracker.test.ts`, `vp lint packages/issue-tracker-asana/src/server`, and `vp fmt --check packages/issue-tracker-asana/src/server`; fix failures.
    - Commit per the protocol, staging the test file: `test(issue-tracker-asana): property-test label resolution`.

  - [ ] 6.4 Write round-trip property test for title and body writes
    - **Property 16: Only named fields are written, and they read back**
    - **Validates: Requirements 10.8, 10.14**
    - Add to `AsanaIssueTracker.test.ts`: for any subset of `{ title, body }` with generated text (blank lines, Unicode, markdown), assert the PUT's `data` holds exactly the named fields as `name` and `notes`, and a following `getIssue` against the stateful fake returns the written title and body.
    - Run `vp test run packages/issue-tracker-asana/src/server/AsanaIssueTracker.test.ts`, `vp lint packages/issue-tracker-asana/src/server`, and `vp fmt --check packages/issue-tracker-asana/src/server`; fix failures.
    - Commit per the protocol, staging the test file: `test(issue-tracker-asana): property-test the title and body round trip`.

  - [ ] 6.5 Implement `listCandidates`
    - In `AsanaIssueTracker.ts`, implement `listCandidates` with `getProject(scope)` and `listWorkspaceTags(workspace, TAG_PAGES)`: labels as `{ name, color: hexOf(color), description: null }`, assignees as `{ ...toActor(user), id: user.gid }`, and `truncated` from the tag read. A non-gid scope fails before any request. Remove any stub left from task 5.1.
    - Add example tests to `AsanaIssueTracker.test.ts`: candidates with colours and members, and `truncated` true past five tag pages.
    - Run `vp test run packages/issue-tracker-asana/src/server/AsanaIssueTracker.test.ts`, `vp run --filter @t3tools/issue-tracker-asana typecheck`, `vp lint packages/issue-tracker-asana/src/server`, and `vp fmt --check packages/issue-tracker-asana/src/server`; fix failures.
    - Commit per the protocol, staging `AsanaIssueTracker.ts` and `AsanaIssueTracker.test.ts`: `feat(issue-tracker-asana): offer Asana tags and members in pickers`.
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

  - [ ] 6.6 Write property test for consistent logins
    - **Property 10: One user has one login everywhere**
    - **Validates: Requirements 11.4, 6.8, 8.12**
    - Add to `AsanaIssueTracker.test.ts`: for any Asana user with or without an email, assert the same login in a summary's author and assignees, a comment's author, an event's actor, an assignee candidate, and the detail's `viewer`, and that the listing's `assignee` filter given that login keeps exactly that user's tasks.
    - Run `vp test run packages/issue-tracker-asana/src/server/AsanaIssueTracker.test.ts`, `vp lint packages/issue-tracker-asana/src/server`, and `vp fmt --check packages/issue-tracker-asana/src/server`; fix failures.
    - Commit per the protocol, staging the test file: `test(issue-tracker-asana): property-test user logins`.

  - [ ] 6.7 Write property test for Bearer auth on every request
    - **Property 13: Every request carries the token as a Bearer credential**
    - **Validates: Requirements 2.2, 2.3, 22.5**
    - Add to `AsanaIssueTracker.test.ts`: for any generated token and any tracker operation run against the fake, assert every recorded request carries `authorization: Bearer <token>`, using the submitted token for `probeCredential` and the stored token otherwise.
    - Run `vp test run packages/issue-tracker-asana/src/server/AsanaIssueTracker.test.ts`, `vp lint packages/issue-tracker-asana/src/server`, and `vp fmt --check packages/issue-tracker-asana/src/server`; fix failures.
    - Commit per the protocol, staging the test file: `test(issue-tracker-asana): property-test Bearer auth`.

- [ ] 7. Register the Asana tracker on the server
  - [ ] 7.1 Add the driver and register it after Linear
    - Create `packages/issue-tracker-asana/src/server/driver.ts` as the design shows (`AsanaIssueTracker.make` with `AsanaApi.make` provided), and add the `./server/driver` export to `packages/issue-tracker-asana/package.json`.
    - Add `"@t3tools/issue-tracker-asana": "workspace:*"` to `apps/server/package.json`, import `AsanaDriver` in `apps/server/src/issue/IssueTrackerRegistry.ts`, and set `STANDALONE_TRACKERS = [LinearDriver.make, AsanaDriver.make]`. Change no other server file.
    - Run `vp i`; `git diff pnpm-lock.yaml` shows only the new workspace link. Run `vp run --filter @t3tools/issue-tracker-asana typecheck`, `vp run --filter t3 typecheck`, `vp test run apps/server/src/issue/IssueService.test.ts apps/server/src/issue/IssueTrackerConnections.test.ts packages/issue-tracker-asana/src/server/AsanaIssueTracker.test.ts`, `vp lint packages/issue-tracker-asana/src/server apps/server/src/issue/IssueTrackerRegistry.ts`, and `vp fmt --check` on the changed files; fix failures.
    - Commit per the protocol, staging `driver.ts`, `packages/issue-tracker-asana/package.json`, `apps/server/package.json`, `apps/server/src/issue/IssueTrackerRegistry.ts`, and `pnpm-lock.yaml`: `feat(server): register the Asana issue tracker`.
    - _Requirements: 1.2, 3.7, 14.6, 15.1, 15.2, 15.3, 15.4, 15.5, 21.3_

- [ ] 8. Checkpoint - Ensure all tests pass
  - Run `vp test run packages/issue-tracker-asana/src/shared/issueUrl.test.ts packages/issue-tracker-asana/src/server/AsanaIssueTracker.test.ts`, `vp run --filter @t3tools/issue-tracker-asana typecheck`, and `vp run --filter t3 typecheck`.
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. Wire Asana into the shared client runtime
  - [ ] 9.1 Resolve Asana task links in `issueLinks.ts`
    - Add `"@t3tools/issue-tracker-asana": "workspace:*"` to `packages/client-runtime/package.json` and run `vp i`; `git diff pnpm-lock.yaml` shows only the new workspace link.
    - In `packages/client-runtime/src/issueLinks.ts`, add `parseAsanaTaskUrl` to `parseStandaloneIssueLink` and `ASANA_HOST` to `mayContainStandaloneIssueLink`, as the design shows.
    - Extend the Linear block of `packages/client-runtime/src/issueLinks.test.ts`: an Asana V0 link and a V1 link resolve to the bound project; a link to an unbound project and a project-less link resolve read-only through the lender with scope `0`; `app.asana.com.evil.example` stays an ordinary link; `mayContainStandaloneIssueLink` finds `app.asana.com/`.
    - Run `vp test run packages/client-runtime/src/issueLinks.test.ts`, `vp run --filter @t3tools/client-runtime typecheck`, `vp lint packages/client-runtime/src/issueLinks.ts packages/client-runtime/src/issueLinks.test.ts`, and `vp fmt --check` on the changed files; fix failures.
    - Commit per the protocol, staging `packages/client-runtime/package.json`, `pnpm-lock.yaml`, `issueLinks.ts`, and `issueLinks.test.ts`: `feat(client-runtime): resolve Asana task links`.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 18.3, 21.2, 21.3, 22.8_

  - [ ] 9.2 Prefix `#` only for git-host keys in workflow labels
    - In `packages/client-runtime/src/workflows.ts` near line 924, prefix `#` only when `sourceControlClients.find(issue.tracker) !== undefined` and the key is numeric; import `sourceControlClients` from `./sourceControlClients.ts`.
    - Add one row to the `workflowReferenceLabel` table in `packages/client-runtime/src/workflows.test.ts`: an `asana` issue with key `1203456789012345` reads as the bare key.
    - Run `vp test run packages/client-runtime/src/workflows.test.ts packages/client-runtime/src/issueLinks.test.ts`, `vp run --filter @t3tools/client-runtime typecheck`, `vp lint packages/client-runtime/src/workflows.ts packages/client-runtime/src/workflows.test.ts`, and `vp fmt --check` on the changed files; fix failures.
    - Commit per the protocol, staging the two files: `fix(client-runtime): keep the # prefix for git-host issue keys only`.
    - _Requirements: 17.5_

- [ ] 10. Show Asana on the web and desktop clients
  - [ ] 10.1 Add the Asana icon, presentation entries, and right-panel tab label
    - Add `AsanaIcon` to `apps/web/src/components/Icons.tsx` (`viewBox="0 0 100 100"`, three `currentColor` circles at `(50,27)`, `(23,69)`, `(77,69)` with radius 21, shaped like `LinearIcon`).
    - Add `asana: { providerName: "Asana", Icon: AsanaIcon }` to `apps/web/src/components/issue/issuePresentation.tsx` and `asana: AsanaIcon` to `TRACKER_ICONS` in `apps/web/src/components/settings/IssueTrackerSettings.tsx`.
    - In `apps/web/src/components/RightPanelTabs.tsx` near line 622, apply the git-host `#` rule to `surface.tracker` and `surface.key`, and update the comment above it to say a git host numbers its issues and standalone trackers use their own keys.
    - Run `vp run --filter @t3tools/web typecheck`, `vp lint apps/web/src/components/Icons.tsx apps/web/src/components/RightPanelTabs.tsx apps/web/src/components/issue/issuePresentation.tsx apps/web/src/components/settings/IssueTrackerSettings.tsx`, and `vp fmt --check` on the same files; fix failures.
    - Commit per the protocol, staging the four files: `feat(web): show Asana as an issue tracker`.
    - _Requirements: 17.1, 17.2, 17.3, 17.5, 17.6_

  - [ ] 10.2 Find the issue tracker settings by searching `asana`, with regenerated catalogs
    - In `apps/web/src/components/settings/settingsSearch.ts` near line 1272, change the keywords to `msg("asana linear jira issues tracker team api key connect bind project")`.
    - Run `vp run i18n:generate` in `apps/web`; it replaces key `f6c5ffe0b40ce8e2` with the new hash in all 10 catalogs under `apps/web/src/i18n/translations/`. Then set each non-English value by hand to its previous value with `asana ` in front, keeping `asana` in English.
    - Run `vp run i18n:check` at the root, `vp run --filter @t3tools/web typecheck`, `vp lint apps/web/src/components/settings/settingsSearch.ts`, and `vp fmt --check` on the changed files; fix failures.
    - Commit per the protocol, staging `settingsSearch.ts` and each changed file under `apps/web/src/i18n/translations/`: `feat(web): find issue tracker settings by searching asana`.
    - _Requirements: 17.4, 19.1, 19.3_

- [ ] 11. Show Asana on the mobile client
  - Add `asana:` path data for the same three circles in the existing 100×100 `viewBox` of `apps/mobile/src/features/settings/components/IssueTrackerSection.tsx`.
  - In `apps/mobile/src/features/issues/IssueListRow.tsx` near line 80, prefix the scope only when `item.displayKey.startsWith("#")`.
  - Add no user-facing copy, so the mobile catalogs stay unchanged.
  - Run `vp run --filter @t3tools/mobile typecheck`, `vp run lint:mobile`, and `vp fmt --check` on the two files; fix failures.
  - Commit per the protocol, staging the two files: `feat(mobile): show Asana tasks in Settings and Issues`.
  - _Requirements: 18.1, 18.2, 18.3, 19.2_

- [ ] 12. Document connecting Asana
  - In `docs/user/source-control.md`, after the Linear paragraph near line 421, add the design's paragraph: connect Asana under Settings → Source control & issues with a personal access token from Asana's developer console, pick one or more Asana projects for a T3 Code project, and add another account to connect another Asana user. Add the sentence on Incomplete and Completed, no reactions, templates, linked pull requests, or tracker-side search, and that each Load more page follows the project's own order. Leave `docs/internals/` unchanged.
  - Run `vp fmt --check docs/user/source-control.md`; fix failures.
  - Commit per the protocol, staging `docs/user/source-control.md`: `docs: describe connecting Asana as an issue tracker`.
  - _Requirements: 20.1, 20.2, 20.3_

- [ ] 13. Add the Asana package to the release smoke list
  - In `scripts/release-smoke.ts`, add `"packages/issue-tracker-asana/package.json"` after the Linear entry near line 43. Leave `knip.jsonc`, `scripts/check-changed.ts`, and `.github/workflows/ci.yml` unchanged.
  - Run `vp fmt --check scripts/release-smoke.ts` and `vp lint scripts/release-smoke.ts`; fix failures.
  - Commit per the protocol, staging `scripts/release-smoke.ts`: `chore: add the Asana package to release smoke`.
  - _Requirements: 21.1, 21.5_

- [ ] 14. Final checkpoint - Ensure all tests pass
  - Run `vp run check:changed`, `vp run knip:check`, `vp test run` on every added or changed test file (`packages/issue-tracker-asana/src/shared/issueUrl.test.ts`, `packages/issue-tracker-asana/src/server/AsanaIssueTracker.test.ts`, `packages/client-runtime/src/issueLinks.test.ts`, `packages/client-runtime/src/workflows.test.ts`), `vp run --filter @t3tools/issue-tracker-asana typecheck`, `vp run i18n:check`, and `rg -nP "asana_pat_(?!test)" packages/issue-tracker-asana` (expect no match).
  - Fix any failure in a new commit scoped to the area it touches, following the protocol. Report each command and its result.
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 14.1, 14.2, 21.4, 23.1, 23.2, 23.3, 23.6, 23.8_

## Notes

- No task is optional: every test the design requires is part of Linear parity.
- Every wave holds one task. All leaf tasks share one worktree and one git index, so parallel tasks could sweep each other's staged paths into a commit or typecheck each other's half-written files. Most tasks also edit `AsanaIssueTracker.ts` or `AsanaIssueTracker.test.ts`.
- All tracker and client property tests live in `packages/issue-tracker-asana/src/server/AsanaIssueTracker.test.ts`, as the design's test table assigns; URL properties live in `packages/issue-tracker-asana/src/shared/issueUrl.test.ts`.
- Pushing, opening the draft PR, screenshots, and review rounds belong to the orchestrator (Requirements 14.7, 23.4, 23.5, 23.7) and have no task.
- The live `permalink_url` form `https://app.asana.com/1/<workspace>/project/<project>/task/<task>` is covered by task 3.1 and Property 1. The accepted Q1 workspace identity stays; `Eng. ID` as a Display_Key stays deferred.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2"] },
    { "id": 2, "tasks": ["3.1"] },
    { "id": 3, "tasks": ["3.2"] },
    { "id": 4, "tasks": ["3.3"] },
    { "id": 5, "tasks": ["3.4"] },
    { "id": 6, "tasks": ["4.1"] },
    { "id": 7, "tasks": ["4.2"] },
    { "id": 8, "tasks": ["4.3"] },
    { "id": 9, "tasks": ["4.4"] },
    { "id": 10, "tasks": ["5.1"] },
    { "id": 11, "tasks": ["5.2"] },
    { "id": 12, "tasks": ["5.3"] },
    { "id": 13, "tasks": ["5.4"] },
    { "id": 14, "tasks": ["5.5"] },
    { "id": 15, "tasks": ["5.6"] },
    { "id": 16, "tasks": ["5.7"] },
    { "id": 17, "tasks": ["5.8"] },
    { "id": 18, "tasks": ["5.9"] },
    { "id": 19, "tasks": ["6.1"] },
    { "id": 20, "tasks": ["6.2"] },
    { "id": 21, "tasks": ["6.3"] },
    { "id": 22, "tasks": ["6.4"] },
    { "id": 23, "tasks": ["6.5"] },
    { "id": 24, "tasks": ["6.6"] },
    { "id": 25, "tasks": ["6.7"] },
    { "id": 26, "tasks": ["7.1"] },
    { "id": 27, "tasks": ["8"] },
    { "id": 28, "tasks": ["9.1"] },
    { "id": 29, "tasks": ["9.2"] },
    { "id": 30, "tasks": ["10.1"] },
    { "id": 31, "tasks": ["10.2"] },
    { "id": 32, "tasks": ["11"] },
    { "id": 33, "tasks": ["12"] },
    { "id": 34, "tasks": ["13"] },
    { "id": 35, "tasks": ["14"] }
  ]
}
```
