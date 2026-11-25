# Requirements Document

## Introduction

This feature adds Asana as a standalone issue tracker in T3 Code, beside the existing Linear tracker. A user connects Asana in Settings with a personal access token, binds a T3 Code project to one or more Asana projects, and then lists, reads, files, comments on, edits, and completes Asana tasks from the Issues page, the issue detail panel, thread links, and MCP tools, on web, desktop, and mobile.

The work ships as one draft pull request in the fork `jvansan/t3code`, targeting the fork's `main`. It is a contingency for upstream discussion https://github.com/pingdotgg/t3code/discussions/43005. Upstream `CONTRIBUTING.md` lists new providers among the changes it closes, so no upstream PR is planned; the fork PR still follows upstream's PR rules (one problem per PR, real verification evidence, no unrelated refactors).

The Linear tracker (`packages/issue-tracker-linear`) is the reference. The Asana tracker mirrors its structure: a package with a `shared/issueUrl` entry for link parsing and a `server/driver` entry for the tracker, an API client service, a `StandaloneIssueTrackerApi` implementation, and unit tests over a fake `HttpClient`. Linear talks GraphQL through a generated client; Asana talks REST, so the Asana package has no GraphQL schema, generator config, or generated files.

Appendix A lists every touch point found in the worktree at commit `82e6b02980`, including the files the original brief named that need no change. Appendix B lists the Asana API behavior these requirements rely on. Appendix C lists open questions and the default this document assumes for each. Appendix D lists what is out of scope.

## Glossary

- **Asana_Package**: The new workspace package `packages/issue-tracker-asana`, published inside the monorepo as `@t3tools/issue-tracker-asana`.
- **Asana_Api_Client**: The Effect service in the Asana_Package that sends HTTP requests to the Asana REST API and returns decoded Asana resources or an `IssueTrackerError`.
- **Asana_Tracker**: The `StandaloneIssueTrackerApi` implementation in the Asana_Package that maps Asana resources to the neutral issue contract types.
- **Asana_Driver**: The `server/driver` export of the Asana_Package: the Asana_Tracker with the Asana_Api_Client provided, needing only the platform `HttpClient` and the server's `IssueTrackerHost`.
- **Asana_Url_Parser**: The function exported from the Asana_Package's `shared/issueUrl` entry that turns an Asana task URL into an issue link, or into null.
- **Asana_Kind**: The `IssueTrackerKind` value `asana`.
- **Asana_Host**: The host `app.asana.com`, which Asana serves its web app and task links from.
- **Asana_Api_Base_Url**: The URL the Asana_Api_Client sends requests to: `https://app.asana.com/api/1.0` unless the `T3CODE_ASANA_API_URL` environment variable overrides it.
- **PAT**: An Asana personal access token, the credential a user pastes into Settings.
- **Credential_Host**: The server's `IssueTrackerHost` service (`apps/server/src/issue/IssueTrackerHostLive.ts`), which reads a standalone tracker account's stored credential from the server secret store.
- **Issue_Tracker_Registry**: The server service in `apps/server/src/issue/IssueTrackerRegistry.ts` that holds every issue tracker the server offers.
- **Connections_Service**: The server service in `apps/server/src/issue/IssueTrackerConnections.ts` that vets, stores, and removes standalone tracker credentials and project bindings.
- **Issue_Service**: The server service in `apps/server/src/issue/IssueService.ts` that lists, reads, writes, and resolves issue links across trackers.
- **Client_Link_Resolver**: The client-side link logic in `packages/client-runtime/src/issueLinks.ts` that web and mobile use to recognize and open issue links.
- **Web_Client**: The React app in `apps/web`, also embedded by the Electron app in `apps/desktop`.
- **Mobile_Client**: The React Native app in `apps/mobile`.
- **Task**: An Asana task, which T3 Code presents as an issue.
- **Asana_Project**: An Asana project. The Asana_Tracker uses an Asana_Project's gid as the issue scope, and a T3 Code project binds to one or more Asana_Projects.
- **Asana_Workspace**: An Asana workspace or organization, the container that holds Asana_Projects, users, and tags.
- **Bound_Project**: An Asana_Project named in a T3 Code project's `IssueTrackerProjectBinding` for the Asana_Kind, as its `scope` or one of its `additionalScopes`.
- **Gid**: Asana's globally unique string identifier for any resource.
- **Story**: An Asana story on a Task: either a comment a person wrote, or a system story Asana records for a change.
- **Comment_Story**: A Story whose type is `comment`.
- **System_Story**: A Story whose type is `system`, such as a Task being completed, assigned, or renamed.
- **Tag**: An Asana tag, which the Asana_Tracker presents as an issue label.
- **Offset_Token**: The opaque `next_page.offset` value Asana returns with a paginated response.
- **Cursor**: The opaque string the issue contract passes between pages (`nextCursor`, `commentsCursor`, `cursor`).
- **Viewer**: The Asana user a PAT signs in as.
- **Display_Key**: The `displayKey` field of an issue summary: how a tracker writes an issue's key for people.
- **Secret_Value**: A PAT, or any prefix or substring of one that is at least 8 characters long.
- **Fork_PR**: The draft pull request in `jvansan/t3code` that delivers this feature.

## Requirements

### Requirement 1: Package structure

**User Story:** As a T3 Code maintainer, I want Asana in its own package shaped like the Linear package, so that the two trackers are reviewed, tested, and maintained the same way.

#### Acceptance Criteria

1. THE Asana_Package SHALL export a `./shared/issueUrl` entry that provides the Asana_Kind, the Asana_Host, and the Asana_Url_Parser.
2. THE Asana_Package SHALL export a `./server/driver` entry whose `make` effect yields the Asana_Tracker and requires only the platform `HttpClient` and the Credential_Host.
3. THE Asana_Package SHALL declare `@t3tools/contracts`, `@t3tools/source-control-core`, and `effect` as its runtime dependencies, with versions written the way `packages/issue-tracker-linear/package.json` writes them.
4. THE Asana_Package SHALL define `typecheck` and `test` scripts identical to those in `packages/issue-tracker-linear/package.json`.
5. THE `./shared/issueUrl` entry of the Asana_Package SHALL import only `@t3tools/contracts`, so that the Web_Client and the Mobile_Client can bundle the entry without server code.

### Requirement 2: API client and authentication

**User Story:** As a user, I want T3 Code to call Asana with the token I saved, so that Asana answers as my account.

#### Acceptance Criteria

1. WHEN the Asana_Api_Client sends a request for a stored account, THE Asana_Api_Client SHALL read the account's PAT from the Credential_Host at the time of that request.
2. WHEN the Asana_Api_Client sends a request, THE Asana_Api_Client SHALL send the PAT in an `Authorization` header with the `Bearer` scheme.
3. WHEN the Asana_Api_Client vets a PAT that a user submitted, THE Asana_Api_Client SHALL send the submitted PAT instead of any stored PAT.
4. IF the Credential_Host holds no PAT for the account, THEN THE Asana_Api_Client SHALL fail the request with an `IssueTrackerError` whose reason is `unauthenticated` and send no HTTP request.
5. THE Asana_Api_Client SHALL send every request to the Asana_Api_Base_Url, so that a test or scenario can point the client at a fake Asana server through `T3CODE_ASANA_API_URL`.
6. WHEN the Asana_Api_Client sends a request that reads resources, THE Asana_Api_Client SHALL name the response fields the Asana_Tracker uses in the request's `opt_fields` parameter.
7. THE Asana_Api_Client SHALL decode every Asana response body with an Effect `Schema` before the Asana_Tracker reads the body.

### Requirement 3: Connect flow and credential probe

**User Story:** As a user, I want to paste an Asana token in Settings and see which account and projects it reaches, so that I can bind my T3 Code projects to Asana projects.

#### Acceptance Criteria

1. THE Asana_Tracker SHALL describe itself with the display name `Asana`, the host `app.asana.com`, the scope noun `project`, the credential label `Personal access token`, and a credential help URL that opens Asana's page for creating a PAT.
2. WHEN the Asana_Tracker probes a PAT that Asana accepts, THE Asana_Tracker SHALL return the Viewer's name as the account and every non-archived Asana_Project the PAT reaches as the scopes, each with the Asana_Project's gid as the key and its name as the name.
3. WHEN Asana splits the list of Asana_Projects across several pages during a probe, THE Asana_Tracker SHALL follow each Offset_Token until Asana returns no further page.
4. WHERE the Viewer belongs to more than one Asana_Workspace, THE Asana_Tracker SHALL name each probed Asana_Project with its Asana_Workspace's name and the Asana_Project's name, so that projects with equal names in different workspaces read apart.
5. WHEN the Asana_Tracker probes a PAT, THE Asana_Tracker SHALL return a workspace identity that the Asana_Url_Parser also reports for every Task link the PAT can read (see Appendix C, question Q1).
6. IF Asana refuses a probed PAT with HTTP 401, THEN THE Asana_Tracker SHALL fail the probe with an `IssueTrackerError` whose reason is `unauthenticated`.
7. WHEN the Connections_Service connects, disconnects, or adds an Asana account, THE Connections_Service SHALL apply the same storage, account, and binding rules it applies to a Linear account, with no Asana-specific code in the Connections_Service.

### Requirement 4: Task URL parsing

**User Story:** As a user, I want Asana task links in a thread or an MCP call to open as issues, so that I can read and link a task without leaving T3 Code.

#### Acceptance Criteria

1. WHEN the Asana_Url_Parser receives a URL of the form `https://app.asana.com/0/<project_gid>/<task_gid>`, THE Asana_Url_Parser SHALL return a link whose host is the Asana_Host, whose scope is the project gid, and whose key is the task gid.
2. WHEN the Asana_Url_Parser receives a URL of the form `https://app.asana.com/0/<project_gid>/<task_gid>/f`, THE Asana_Url_Parser SHALL return the same link it returns for the URL without the `/f` segment.
3. WHEN the Asana_Url_Parser receives a URL of the form `https://app.asana.com/1/<workspace_gid>/project/<project_gid>/task/<task_gid>`, THE Asana_Url_Parser SHALL return a link whose host is the Asana_Host, whose scope is the project gid, and whose key is the task gid.
4. WHEN the Asana_Url_Parser receives a Task URL that names no Asana_Project, of the form `https://app.asana.com/0/0/<task_gid>` or `https://app.asana.com/1/<workspace_gid>/task/<task_gid>`, THE Asana_Url_Parser SHALL return a link whose key is the task gid and whose scope matches no Bound_Project (see Appendix C, question Q2).
5. WHEN the Asana_Url_Parser receives a Task URL that carries a query string or a fragment, THE Asana_Url_Parser SHALL return the same link it returns for the URL without the query string and fragment.
6. IF a URL's protocol is not `https:`, THEN THE Asana_Url_Parser SHALL return null.
7. IF a URL's host, compared without regard to letter case, is not exactly the Asana_Host, THEN THE Asana_Url_Parser SHALL return null, including for hosts such as `app.asana.com.example.net`, `evil-app.asana.com`, and `asana.com`.
8. IF a URL carries a username, a password, or a port, THEN THE Asana_Url_Parser SHALL return null.
9. IF a gid segment of a URL is not a string of decimal digits of length 1 to 32, THEN THE Asana_Url_Parser SHALL return null.
10. IF a URL's path matches none of the forms in criteria 1 to 4, such as a project list view, a portfolio, an inbox, or a workspace home page, THEN THE Asana_Url_Parser SHALL return null.
11. FOR ALL task gids, project gids, and workspace gids, THE Asana_Url_Parser SHALL return the same task gid from the legacy form and from the newer form of a Task URL built from those gids.
12. FOR ALL links the Asana_Url_Parser returns, formatting the link as a Task URL and parsing that URL SHALL return an equal link (round-trip property).

### Requirement 5: Link resolution

**User Story:** As a user, I want an Asana link to open the task through the T3 Code project bound to that Asana project, so that the task is writable where my binding says it is.

#### Acceptance Criteria

1. WHEN the Client_Link_Resolver checks text for standalone tracker links, THE Client_Link_Resolver SHALL treat text that contains `app.asana.com/` as possibly holding one.
2. WHEN the Client_Link_Resolver resolves a Task URL that the Asana_Url_Parser accepts, THE Client_Link_Resolver SHALL resolve the URL through a T3 Code project bound to the link's Asana_Project, else through any T3 Code project bound to the Asana_Kind, by the same rule it applies to Linear links.
3. WHEN the Issue_Service resolves a Task URL that the Asana_Url_Parser accepts, THE Issue_Service SHALL return the Task through the same project the Client_Link_Resolver chooses for that URL.
4. WHEN a Task URL in the legacy form and a Task URL in the newer form name the same Task, THE Issue_Service SHALL resolve both URLs to the same issue reference.
5. IF no connected Asana account can read the Task a URL names, THEN THE Issue_Service SHALL fail the resolution with an `IssueOperationError` whose reason is `not-found`.
6. WHERE a Task URL names no Asana_Project, THE Issue_Service SHALL open the Task read-only through a T3 Code project bound to the Asana_Kind.

### Requirement 6: Listing tasks

**User Story:** As a user, I want each bound Asana project's tasks in the Issues list, so that I see Asana work beside my repository's issues.

#### Acceptance Criteria

1. WHEN the Issue_Service asks the Asana_Tracker to list a scope, THE Asana_Tracker SHALL return the top-level Tasks of the Asana_Project whose gid is the scope.
2. WHEN a listing asks for `open` Tasks, THE Asana_Tracker SHALL return only Tasks that are not completed.
3. WHEN a listing asks for `closed` Tasks, THE Asana_Tracker SHALL return only Tasks that are completed.
4. WHEN a listing asks for `all` Tasks, THE Asana_Tracker SHALL return completed and incomplete Tasks.
5. WHEN a listing asks for `assigned` involvement, THE Asana_Tracker SHALL return only Tasks whose assignee is the Viewer.
6. WHEN a listing asks for `authored` involvement, THE Asana_Tracker SHALL return only Tasks the Viewer created.
7. WHEN a listing asks for `mentioned` involvement, THE Asana_Tracker SHALL return only Tasks the Viewer follows.
8. WHEN a listing names an assignee, THE Asana_Tracker SHALL return only Tasks assigned to the user with that login.
9. WHEN a listing names labels, THE Asana_Tracker SHALL return only Tasks that carry a Tag with each named label, compared without regard to letter case.
10. WHEN a listing asks for a sort, THE Asana_Tracker SHALL order the Tasks of each page newest first by the requested date: `modified_at` for `updated` and `created_at` for `created`.
11. WHEN a listing asks for a limit above 100, THE Asana_Tracker SHALL request pages of 100 Tasks from Asana.
12. WHEN the Asana_Tracker maps a Task to an issue summary, THE Asana_Tracker SHALL set the key to the task gid, the title to the Task's name (or `Untitled task` when the name is blank, because Asana allows a blank name and the contract does not), the URL to the Task's permalink, the author to the Task's creator, the assignees to the Task's assignee if one exists, the labels to the Task's Tags, the created and updated times to the Task's `created_at` and `modified_at`, and the closed time to the Task's `completed_at`.
13. THE Asana_Tracker SHALL set the comment count of each listed Task to 0, as the Linear tracker does for listings.
14. THE Asana_Tracker SHALL declare the `search` capability as false, so that the Issue_Service and the clients offer no tracker-side text search for Asana.
15. WHEN the Asana_Tracker filters Tasks after Asana returns a page, THE Asana_Tracker SHALL return the page's Cursor even when the filter leaves fewer Tasks than the limit, so that later pages stay reachable.

### Requirement 7: Offset pagination

**User Story:** As a user, I want **Load more** to continue an Asana project's list where it stopped, so that long projects are readable page by page.

#### Acceptance Criteria

1. WHEN Asana returns a page with an Offset_Token, THE Asana_Tracker SHALL return a Cursor that carries that Offset_Token.
2. WHEN Asana returns a page with no further page, THE Asana_Tracker SHALL return a null Cursor.
3. WHEN the Issue_Service passes a Cursor the Asana_Tracker returned, THE Asana_Api_Client SHALL send the Offset_Token that Cursor carries as the request's `offset` parameter.
4. FOR ALL Offset_Tokens, decoding the Cursor the Asana_Tracker builds from an Offset_Token SHALL return the same Offset_Token (round-trip property).
5. THE Asana_Tracker SHALL build Cursors of at most 4,096 characters, the bound the contract sets on cursors.
6. IF Asana rejects an Offset_Token as invalid or expired, THEN THE Asana_Tracker SHALL fail the page with an `IssueTrackerError` whose reason is `failed` and whose detail tells the user to reload the list.
7. IF a Cursor that the Issue_Service passes does not decode, THEN THE Asana_Tracker SHALL fail the page with an `IssueTrackerError` whose reason is `failed` and send no HTTP request.

### Requirement 8: Task detail

**User Story:** As a user, I want to open an Asana task beside the list and see its description, comments, and history, so that I can follow the work without opening Asana.

#### Acceptance Criteria

1. WHEN the Asana_Tracker reads a Task's detail, THE Asana_Tracker SHALL return the issue summary fields of Requirement 6, criterion 12, and the Task's notes as the body.
2. WHEN the Asana_Tracker reads a Task's detail, THE Asana_Tracker SHALL list exactly two states, in this order: an `open` state and a `closed` state whose close reason is `completed`, with the names given in Appendix C, question Q4.
3. WHEN the Asana_Tracker reads a completed Task, THE Asana_Tracker SHALL report the `closed` state as the Task's state.
4. WHEN the Asana_Tracker reads a Task that is not completed, THE Asana_Tracker SHALL report the `open` state as the Task's state.
5. WHEN the Asana_Tracker reads a Task's detail, THE Asana_Tracker SHALL return the Task's most recent Comment_Stories, at most 50, in chronological order from oldest to newest.
6. WHEN a Task has older Comment_Stories than the detail returns, THE Asana_Tracker SHALL return a comments Cursor that leads to those older Comment_Stories.
7. WHEN a Task has no older Comment_Stories than the detail returns, THE Asana_Tracker SHALL return a null comments Cursor.
8. WHEN the Asana_Tracker reads a Task's detail, THE Asana_Tracker SHALL return each System_Story among the Task's 100 most recent Stories that maps to an `IssueEventKind` as an issue event, and drop each System_Story that maps to none.
9. WHEN a System_Story records a Task being marked complete, THE Asana_Tracker SHALL report a `closed` event.
10. WHEN a System_Story records a Task being marked incomplete, THE Asana_Tracker SHALL report a `reopened` event.
11. WHEN a System_Story records a Task's assignee, Tags, or name changing, THE Asana_Tracker SHALL report an `assigned`, `unassigned`, `labeled`, `unlabeled`, or `renamed` event that names the subject of the change where the Story names one (an `unassigned` Story names no user).
12. WHEN the Asana_Tracker reads a Task's detail, THE Asana_Tracker SHALL return the Viewer's login as the viewer, so that the Web_Client and the Mobile_Client offer comment edits only on the Viewer's comments.
13. THE Asana_Tracker SHALL grant every viewer permission in the detail, as the Linear tracker does, so that a refusal comes from Asana with Asana's reason.
14. IF Asana has no Task with the requested gid, or the PAT cannot read the Task, THEN THE Asana_Tracker SHALL fail the read with an `IssueTrackerError` whose reason is `not-found`.
15. IF the requested key is not a gid, THEN THE Asana_Tracker SHALL fail the read with an `IssueTrackerError` whose reason is `not-found` and send no HTTP request.

### Requirement 9: Older comments

**User Story:** As a user, I want to load older comments on a long Asana task, so that I can read the whole conversation.

#### Acceptance Criteria

1. WHEN the Issue_Service passes a comments Cursor the Asana_Tracker returned, THE Asana_Tracker SHALL return the next older group of Comment_Stories, at most 50, in chronological order from oldest to newest.
2. WHEN no Comment_Stories remain older than the group a comments page returns, THE Asana_Tracker SHALL return a null next Cursor.
3. FOR ALL Tasks, joining the detail's comments with every older page in the order the client prepends them SHALL yield each Comment_Story of the Task exactly once, in chronological order (model-based property against the Task's full story list).

### Requirement 10: Writes

**User Story:** As a user or an agent, I want to file, comment on, edit, and complete Asana tasks from T3 Code, so that I can keep Asana current while I work.

#### Acceptance Criteria

1. WHEN the Asana_Tracker creates an issue in a scope, THE Asana_Tracker SHALL create a Task in the Asana_Project whose gid is the scope, with the requested title as the name and the requested body as the notes, and return the new Task's gid as the key, its Display_Key, and its permalink as the URL.
2. WHEN a create or an update names labels, THE Asana_Tracker SHALL set the Task's Tags to the Tags of the Asana_Project's Asana_Workspace whose names match the labels without regard to letter case.
3. IF a create or an update names a label that matches no Tag in the Asana_Workspace, THEN THE Asana_Tracker SHALL fail the write with an `IssueTrackerError` whose reason is `failed` and whose detail names the label, before Asana receives any write.
4. WHEN a create or an update names one assignee, THE Asana_Tracker SHALL assign the Task to the Asana user whose gid, email, or login matches the assignee.
5. IF a create or an update names more than one assignee, THEN THE Asana_Tracker SHALL fail the write with an `IssueTrackerError` whose reason is `failed` and whose detail says an Asana Task has one assignee at most.
6. WHEN an update names an empty assignee list, THE Asana_Tracker SHALL remove the Task's assignee.
7. WHEN the Asana_Tracker comments on a Task, THE Asana_Tracker SHALL add a Comment_Story with the requested body to the Task.
8. WHEN an update names a title or a body, THE Asana_Tracker SHALL write only the named fields to the Task.
9. WHEN the Asana_Tracker moves a Task to the `closed` state, THE Asana_Tracker SHALL mark the Task complete.
10. WHEN the Asana_Tracker moves a Task to the `open` state, THE Asana_Tracker SHALL mark the Task incomplete.
11. IF a state change names a state that the Task's detail does not list, THEN THE Asana_Tracker SHALL fail the change with an `IssueTrackerError` whose reason is `failed` and send no write to Asana.
12. IF a comment, an update, or a state change names a Task that is not a member of the Asana_Project named by the scope, THEN THE Asana_Tracker SHALL fail the write with an `IssueTrackerError` whose reason is `failed` and whose detail names the scope, before Asana receives any write.
13. FOR ALL Tasks that belong to several Asana_Projects, THE Asana_Tracker SHALL accept a write through any one of those Asana_Projects as the scope.
14. FOR ALL titles and bodies, writing a title and a body to a Task and then reading the Task's detail SHALL return the same title and body, with the body compared as plain text (round-trip property over the fake Asana API).

### Requirement 11: Label and assignee pickers

**User Story:** As a user, I want the label and assignee pickers to offer Asana's tags and people, so that I can pick them instead of typing names.

#### Acceptance Criteria

1. WHEN the Asana_Tracker lists candidates for a scope, THE Asana_Tracker SHALL return the Tags of the Asana_Project's Asana_Workspace as label candidates, each with its name and color.
2. WHEN the Asana_Tracker lists candidates for a scope, THE Asana_Tracker SHALL return the members of the Asana_Project as assignee candidates, each with its login, name, avatar URL, and gid as the id.
3. WHEN Asana holds more Tags or members than the Asana_Tracker reads for one candidate list, THE Asana_Tracker SHALL set the candidates' `truncated` flag to true.
4. THE Asana_Tracker SHALL give each Asana user the same login in issue summaries, details, events, candidates, the viewer field, and the assignee filter.

### Requirement 12: Declared capabilities

**User Story:** As a user, I want T3 Code to offer only the Asana actions that work, so that no button leads to a refusal.

#### Acceptance Criteria

1. THE Asana_Tracker SHALL declare the capabilities `create`, `edit`, `comment`, `labels`, `assignees`, and `events` as true.
2. THE Asana_Tracker SHALL declare the capabilities `reactions`, `templates`, `linkedPullRequests`, and `search` as false.
3. WHEN the Asana_Tracker reads a Task's detail, THE Asana_Tracker SHALL return an empty list of linked pull requests and no reactions.

### Requirement 13: Error mapping and rate limits

**User Story:** As a user, I want Asana failures explained in plain words, and T3 Code to back off when Asana says to, so that I know what went wrong and Asana keeps serving my account.

#### Acceptance Criteria

1. IF Asana answers with HTTP 429, THEN THE Asana_Api_Client SHALL fail the request with an `IssueTrackerError` whose reason is `rate-limited`.
2. WHEN Asana answers with HTTP 429 and a `Retry-After` header that holds a non-negative whole number of seconds, THE Asana_Api_Client SHALL set the error's `retryAt` to the current time plus that number of seconds, in epoch milliseconds.
3. IF Asana answers with HTTP 429 and a missing or malformed `Retry-After` header, THEN THE Asana_Api_Client SHALL fail the request with a `rate-limited` error that has no `retryAt`.
4. WHEN Asana answers with HTTP 429, THE Asana_Api_Client SHALL send no further request for that call, leaving the retry decision to the Issue_Service and the clients that read `retryAt`.
5. IF Asana answers with HTTP 401, THEN THE Asana_Api_Client SHALL fail the request with an `IssueTrackerError` whose reason is `unauthenticated`.
6. IF Asana answers with HTTP 403, THEN THE Asana_Api_Client SHALL fail the request with an `IssueTrackerError` whose reason is `failed` and whose detail says the account cannot do this in Asana.
7. IF Asana answers with HTTP 404, THEN THE Asana_Api_Client SHALL fail the request with an `IssueTrackerError` whose reason is `not-found`.
8. IF Asana answers with HTTP 402, THEN THE Asana_Api_Client SHALL fail the request with an `IssueTrackerError` whose reason is `failed` and whose detail says the Asana plan does not include the feature.
9. IF Asana answers with another HTTP error status and an Asana error body, THEN THE Asana_Api_Client SHALL fail the request with an `IssueTrackerError` whose reason is `failed` and whose detail is the first error message in the body.
10. IF Asana cannot be reached, or answers with a body that does not decode, THEN THE Asana_Api_Client SHALL fail the request with an `IssueTrackerError` whose reason is `failed` and whose detail says which of the two happened.

### Requirement 14: Secret hygiene

**User Story:** As a user, I want my Asana token kept out of logs, errors, and the repository, so that nobody who reads them can act as me in Asana.

#### Acceptance Criteria

1. THE Asana_Package SHALL contain no Secret_Value in source code, tests, fixtures, or docs.
2. THE Asana_Package tests SHALL use tokens that are visibly fake, such as `asana_pat_test`.
3. FOR ALL PATs, THE Asana_Api_Client SHALL produce `IssueTrackerError` details, error messages, and span attributes that contain no Secret_Value of that PAT, including when Asana's own error message repeats the PAT (property over generated tokens).
4. WHEN the Asana_Api_Client records a tracing span for a request, THE Asana_Api_Client SHALL record the operation name and leave the `Authorization` header out of every span attribute and log line.
5. WHEN the Asana_Api_Client fails a request, THE Asana_Api_Client SHALL attach as the error's cause no value that holds the request's headers.
6. THE Credential_Host SHALL store the Asana PAT in the server secret store under the name `issueTrackerSecretName` gives the Asana_Kind, as it stores the Linear key.
7. THE Fork_PR and its description SHALL contain no Secret_Value.

### Requirement 15: Server registration

**User Story:** As a user, I want the server to offer Asana wherever it offers Linear, so that the connect flow, listing, links, and MCP tools all reach Asana.

#### Acceptance Criteria

1. THE Issue_Tracker_Registry SHALL list the Asana_Driver in its standalone trackers, after the Linear driver.
2. WHEN the server starts, THE Issue_Tracker_Registry SHALL report the Asana_Kind among its kinds and the Asana_Tracker among its standalone trackers.
3. THE server package `apps/server` SHALL declare `@t3tools/issue-tracker-asana` as a workspace dependency.
4. THE Credential_Host, the Connections_Service, and the Issue_Service SHALL serve the Asana_Tracker with no Asana-specific code, through the `StandaloneIssueTrackerApi` port they already use for Linear.
5. WHEN an agent calls the issue MCP tools on a T3 Code project bound to an Asana_Project, THE Issue_Service SHALL serve the call through the Asana_Tracker with no change to the MCP tool descriptions or schemas.

### Requirement 16: Contracts

**User Story:** As a maintainer, I want the wire contracts to carry Asana without a schema change, so that older clients and servers keep working.

#### Acceptance Criteria

1. THE Asana_Package SHALL define the Asana_Kind with `IssueTrackerKind.make("asana")`, which the existing `IssueTrackerKind` pattern accepts.
2. THE Fork_PR SHALL leave every schema in `packages/contracts/src/issue.ts` unchanged, because `IssueTrackerKind` is a branded string with no list of kinds.

### Requirement 17: Web client surfaces

**User Story:** As a web or desktop user, I want Asana to look like Asana wherever T3 Code shows a tracker, so that I can tell Asana tasks from other issues at a glance.

#### Acceptance Criteria

1. THE Web_Client SHALL provide an `AsanaIcon` in `apps/web/src/components/Icons.tsx`, drawn with `currentColor` the way `LinearIcon` is.
2. THE Web_Client SHALL present the Asana_Kind with the provider name `Asana` and the `AsanaIcon` in the standalone tracker table of `apps/web/src/components/issue/issuePresentation.tsx`.
3. THE Web_Client SHALL show the `AsanaIcon` for the Asana_Kind in the tracker icon table of `apps/web/src/components/settings/IssueTrackerSettings.tsx`.
4. WHEN a user searches Settings for `asana`, THE Web_Client SHALL show the Issue trackers settings entry.
5. WHEN the Web_Client labels the right-panel tab of an Asana Task, or a workflow reference chip names one, THE Web_Client SHALL show the Task's Display_Key without a `#` prefix.
6. WHEN the Web_Client shows an Asana Task in the Issues list, the issue detail panel, the link preview, the thread details rows, or the sidebar issue badge, THE Web_Client SHALL show the Asana_Tracker's Display_Key.

### Requirement 18: Mobile client surfaces

**User Story:** As a mobile user, I want Asana in the app's Settings and Issues screens, so that I can work with Asana tasks from my phone.

#### Acceptance Criteria

1. THE Mobile_Client SHALL draw the Asana mark for the Asana_Kind in the tracker mark table of `apps/mobile/src/features/settings/components/IssueTrackerSection.tsx`.
2. WHEN the Mobile_Client shows an Asana Task in the Issues list, THE Mobile_Client SHALL show the Task's Display_Key without a raw Asana_Project gid in front of the Display_Key.
3. WHEN the Mobile_Client opens an Asana Task link from a thread, THE Mobile_Client SHALL resolve the link through the Client_Link_Resolver by the rules of Requirement 5.

### Requirement 19: Translations

**User Story:** As a user who reads T3 Code in another language, I want any new Asana copy translated, so that the Asana flow reads in my language.

#### Acceptance Criteria

1. WHEN the Fork_PR changes or adds user-facing copy in the Web_Client, THE Fork_PR SHALL include the regenerated catalogs for every locale in `apps/web/src/i18n/translations`, with the word `asana` kept in English as a product name.
2. WHEN the Fork_PR changes or adds user-facing copy in the Mobile_Client, THE Fork_PR SHALL include the regenerated catalogs for every locale in `apps/mobile/src/i18n/translations`.
3. WHEN the Fork_PR is checked, THE `vp run i18n:check` command SHALL pass.
4. THE Asana_Tracker SHALL keep its descriptor strings and error details in English, as the Linear tracker does, because the server stays English.

### Requirement 20: User documentation

**User Story:** As a user, I want the docs to say how to connect Asana and what it supports, so that I can set it up without guessing.

#### Acceptance Criteria

1. THE Fork_PR SHALL add to the Issues section of `docs/user/source-control.md` a paragraph that says how to connect Asana with a PAT, how to bind a T3 Code project to Asana_Projects, and that adding another account connects another Asana user.
2. THE Fork_PR SHALL state in `docs/user/source-control.md` that Asana tasks move between incomplete and completed, and that Asana offers no reactions, templates, linked pull requests, or tracker-side search in T3 Code.
3. THE Fork_PR SHALL leave `docs/internals/` unchanged unless the design records a cross-component constraint that the code cannot show.

### Requirement 21: Repository wiring

**User Story:** As a maintainer, I want the new package wired into the repo's build, release, and check scripts, so that CI and releases treat Asana as they treat Linear.

#### Acceptance Criteria

1. THE Fork_PR SHALL add `packages/issue-tracker-asana/package.json` to the package list in `scripts/release-smoke.ts`, next to the Linear entry.
2. THE `packages/client-runtime` package SHALL declare `@t3tools/issue-tracker-asana` as a workspace dependency.
3. THE Fork_PR SHALL include the `pnpm-lock.yaml` changes that `vp i` produces for the new workspace dependencies, and no other lockfile changes.
4. WHEN `vp run knip:check` runs, THE Asana_Package SHALL report no unused files, exports, or dependencies.
5. THE Fork_PR SHALL leave the GraphQL list in `scripts/check-changed.ts` and the Linear entry in `knip.jsonc` unchanged, because the Asana_Package has no generated GraphQL code.

### Requirement 22: Tests over a fake Asana API

**User Story:** As a maintainer, I want the Asana tracker tested against a fake HTTP client, so that its behavior is checked without a live Asana token.

#### Acceptance Criteria

1. THE Asana_Package SHALL include unit tests that run the Asana_Tracker over a fake `HttpClient` layer and a fake Credential_Host, in the style of `packages/issue-tracker-linear/src/server/LinearIssueTracker.test.ts`.
2. THE Asana_Package tests SHALL cover URL parsing for each accepted and each rejected form in Requirement 4, including the round-trip and cross-form properties.
3. THE Asana_Package tests SHALL cover the Cursor round trip, multi-page probes, and comment paging of Requirements 3, 7, and 9.
4. THE Asana_Package tests SHALL cover each status mapping of Requirement 13, including `Retry-After` present, absent, and malformed.
5. THE Asana_Package tests SHALL assert that the fake `HttpClient` received the `Authorization: Bearer` header on each request, and that no error detail or message contains the PAT.
6. THE Asana_Package tests SHALL cover the write guard of Requirement 10, criteria 12 and 13, including a Task that belongs to two Asana_Projects.
7. THE Asana_Package tests SHALL send no request to a real Asana host.
8. THE Fork_PR SHALL add the Asana_Kind's link cases to `packages/client-runtime/src/issueLinks.test.ts`, covering both URL forms and a lookalike host.

### Requirement 23: Verification and PR discipline

**User Story:** As the fork's owner, I want the PR to carry real evidence and only this feature, so that I can merge the contingency with confidence if upstream declines Asana.

#### Acceptance Criteria

1. WHEN the work is ready for review, THE Fork_PR SHALL have passed `vp run check:changed`, which covers format, lint, knip, affected typechecks, and nearby tests, as `docs/operations/00_development.md` defines it.
2. WHEN the work is ready for review, THE Fork_PR SHALL have passed `vp test run` on every changed or added test file and `vp run --filter @t3tools/issue-tracker-asana typecheck`.
3. THE Fork_PR description SHALL report each command run and its result.
4. WHERE no live Asana PAT is available, THE Fork_PR description SHALL state that the Asana_Tracker was verified only against a fake Asana API, and SHALL list which behaviors that leaves unverified against real Asana.
5. WHEN the Fork_PR changes visible Web_Client or Mobile_Client output, THE Fork_PR description SHALL include before-and-after screenshots uploaded to the PR and kept out of the repository.
6. THE Fork_PR SHALL change only the files this feature needs, with no refactor, rename, or fix outside the Asana feature.
7. THE Fork_PR SHALL be opened as a draft in `jvansan/t3code` with the fork's `main` as its base, with a conventional commit title, and with a body that states the problem, the fix, and the model and harness that did the work.
8. THE Fork_PR SHALL leave the spec files under `.kiro/specs/asana-issue-tracker/` and any other plan or scratch files out of its commits.

## Appendix A: Touch points

Found by reading the files named below and by `rg 'issue-tracker-linear|LINEAR_|linear\.app|"linear"|parseLinear|\bLinear\b'` across the worktree at commit `82e6b02980`, excluding `.repos/`, `node_modules/`, and CSS `linear-gradient` matches.

### A.1 Files to add

| Path                                                                | Purpose                                                                                     | Linear counterpart                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/issue-tracker-asana/package.json`                         | Package manifest with `./shared/issueUrl` and `./server/driver` exports                     | `packages/issue-tracker-linear/package.json`                                            |
| `packages/issue-tracker-asana/tsconfig.json`                        | Extends `../../tsconfig.base.json` with `types: ["node"]`                                   | `packages/issue-tracker-linear/tsconfig.json`                                           |
| `packages/issue-tracker-asana/src/shared/issueUrl.ts`               | `ASANA_KIND`, `ASANA_HOST`, `parseAsanaTaskUrl`                                             | `src/shared/issueUrl.ts`                                                                |
| `packages/issue-tracker-asana/src/server/AsanaApi.ts`               | REST client service, auth, `opt_fields`, decoding, error and 429 mapping, offset pagination | `src/server/LinearApi.ts`                                                               |
| `packages/issue-tracker-asana/src/server/AsanaIssueTracker.ts`      | `StandaloneIssueTrackerApi` implementation                                                  | `src/server/LinearIssueTracker.ts`                                                      |
| `packages/issue-tracker-asana/src/server/driver.ts`                 | Tracker with the API client provided                                                        | `src/server/driver.ts`                                                                  |
| `packages/issue-tracker-asana/src/server/AsanaIssueTracker.test.ts` | Tracker and API tests over a fake `HttpClient`                                              | `src/server/LinearIssueTracker.test.ts`                                                 |
| `packages/issue-tracker-asana/src/shared/issueUrl.test.ts`          | URL parser tests and properties                                                             | Linear has none; its URL cases live in `packages/client-runtime/src/issueLinks.test.ts` |

The Linear package's `graphql.config.ts`, `schema/`, `LinearApi.graphql`, and `LinearApi.graphql.ts` have no Asana counterpart.

### A.2 Files to change

| Path                                                                   | Change                                                                                                                            | Requirement |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `apps/server/src/issue/IssueTrackerRegistry.ts`                        | Import the Asana driver and add it to `STANDALONE_TRACKERS` after Linear                                                          | 15          |
| `apps/server/package.json`                                             | Add `@t3tools/issue-tracker-asana: workspace:*`                                                                                   | 15          |
| `packages/client-runtime/src/issueLinks.ts`                            | Parse Asana links in `parseStandaloneIssueLink`, and check `app.asana.com/` in `mayContainStandaloneIssueLink`                    | 5           |
| `packages/client-runtime/package.json`                                 | Add `@t3tools/issue-tracker-asana: workspace:*`                                                                                   | 21          |
| `packages/client-runtime/src/issueLinks.test.ts`                       | Asana link cases                                                                                                                  | 22          |
| `apps/web/src/components/Icons.tsx`                                    | Add `AsanaIcon`                                                                                                                   | 17          |
| `apps/web/src/components/issue/issuePresentation.tsx`                  | `asana` entry in `STANDALONE_TRACKERS`                                                                                            | 17          |
| `apps/web/src/components/settings/IssueTrackerSettings.tsx`            | `asana` entry in `TRACKER_ICONS`                                                                                                  | 17          |
| `apps/web/src/components/settings/settingsSearch.ts`                   | Add `asana` to the `issue-trackers` search terms (line 1272)                                                                      | 17, 19      |
| `apps/web/src/i18n/translations/*.json` (10 locales)                   | Regenerated catalogs for the changed search-terms string (key `f6c5ffe0b40ce8e2` today)                                           | 19          |
| `apps/web/src/components/RightPanelTabs.tsx`                           | The `issue` tab label (line 622) prefixes `#` to any all-digit key, and an Asana gid is all digits                                | 17          |
| `packages/client-runtime/src/workflows.ts`                             | `workflowReferenceLabel` (line 924) prefixes `#` to any all-digit issue key, the same way                                         | 17          |
| `apps/mobile/src/features/settings/components/IssueTrackerSection.tsx` | `asana` entry in `TRACKER_MARKS` (SVG path data)                                                                                  | 18          |
| `apps/mobile/src/features/issues/IssueListRow.tsx`                     | The row (line 80) prefixes the scope unless the Display_Key starts with `<scope>-`, which would put an Asana_Project gid in front | 18          |
| `docs/user/source-control.md`                                          | Asana paragraph in the Issues section, after the Linear paragraph (line 421)                                                      | 20          |
| `scripts/release-smoke.ts`                                             | Add `packages/issue-tracker-asana/package.json` next to line 43                                                                   | 21          |
| `pnpm-lock.yaml`                                                       | Workspace dependency entries from `vp i`                                                                                          | 21          |

### A.3 Files checked that need no change

| Path                                                                             | Why no change                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/issue.ts`                                                | `IssueTrackerKind` is a branded string checked by `/^[a-z][a-z0-9-]*$/`, with no list of kinds. Linear appears only in doc comments.                                                                                         |
| `apps/server/src/issue/IssueTrackerConnections.ts`                               | Works over `registry.standalone` and `StandaloneIssueTrackerApi`; names no tracker.                                                                                                                                          |
| `apps/server/src/issue/IssueTrackerHostLive.ts`                                  | Derives the secret name from any kind with `issueTrackerSecretName`; names no tracker.                                                                                                                                       |
| `apps/server/src/issue/IssueService.ts`                                          | Resolves standalone links through `registry.standalone` and `parseIssueUrl`; Linear appears only in a comment. Appendix C, question Q1, may change this if the design cannot satisfy Requirement 5 inside the Asana_Package. |
| `apps/server/src/mcp/toolkits/issues/*`                                          | Tool descriptions and schemas name no tracker. The tests use Linear as an example only.                                                                                                                                      |
| `evals/mcp-tool-use/cases/issues.ndjson`                                         | Cases use Linear teams as examples; no model-facing text changes, so `AGENTS.md` asks for no new eval.                                                                                                                       |
| `packages/source-control-core/src/server/IssueTracker.ts`, `IssueTrackerHost.ts` | The port already covers standalone trackers; Linear appears only in doc comments.                                                                                                                                            |
| `packages/client-runtime/src/state/issueTrackers.ts`, `issueList.ts`             | Generic over trackers; Linear appears only in comments.                                                                                                                                                                      |
| `apps/server/src/persistence/Migrations/097_IssueTrackerBindings.ts`             | Bindings store any kind.                                                                                                                                                                                                     |
| `knip.jsonc`                                                                     | The Linear entry exists only to ignore generated GraphQL files.                                                                                                                                                              |
| `scripts/check-changed.ts`                                                       | The Linear entry (line 502) exists only to check generated GraphQL.                                                                                                                                                          |
| `scripts/scenarios/start-app.ts`, `linear-settings-name-another-team.e2e.ts`     | Linear-specific end-to-end scenario. An Asana scenario is out of scope (Appendix D).                                                                                                                                         |
| `apps/mobile/src/i18n/translations/*.json`                                       | No Linear copy exists in mobile catalogs; they change only if mobile copy changes.                                                                                                                                           |

## Appendix B: Asana API behavior relied on

These come from the Asana developer documentation and community forum. The design phase checked each against https://developers.asana.com and the Asana OpenAPI spec on 2026-11-25; `design.md` lists the sources and the facts it could not confirm.

- REST base URL `https://app.asana.com/api/1.0`; a PAT goes in `Authorization: Bearer <PAT>` ([Personal access token](https://developers.asana.com/docs/personal-access-token)). Asana creates PATs in the developer console at `https://app.asana.com/0/my-apps`.
- Responses wrap results in `{ "data": ... }`; paginated lists accept `limit` (1 to 100) and `offset`, and return `next_page: { offset, path, uri }` or `null`. Offset tokens are opaque and expire ([Pagination](https://developers.asana.com/docs/pagination)).
- Errors return `{ "errors": [{ "message": ..., "help": ..., "phrase": ... }] }`, with `phrase` on 500s only. Every rate limiter returns HTTP 429 with a `Retry-After` header in seconds. Limits are per token: 150 requests a minute on a free domain and 1,500 on a paid one, at most 50 concurrent GETs and 15 concurrent writes, plus a cost limit on requests that traverse many objects ([Rate limits](https://developers.asana.com/docs/rate-limits)). Premium-only endpoints return HTTP 402.
- `GET /users/me` returns the Viewer and the Viewer's workspaces. `GET /workspaces/<gid>/projects?archived=false` lists a workspace's live projects. `GET /projects/<gid>/tasks` lists a project's tasks in the project's priority order, with `completed_since=now` limiting the list to incomplete tasks; it has no sort, assignee, or completed-only filter. `GET /tasks?project=<gid>` takes the same filters, and its `assignee` filter needs `workspace` instead of `project`.
- `GET /tasks/<gid>` returns a Task with `name` (which may be blank), `notes`, `completed`, `completed_at`, `created_at`, `modified_at`, `assignee`, `created_by`, `followers`, `tags`, `memberships`, `parent`, `permalink_url`, and `workspace`.
- `GET /tasks/<gid>/stories` lists Stories oldest first by default. `sort_ascending=false` lists them newest first, and `resource_subtype=comment_added` narrows the list to comments ([Get stories from a task](https://developers.asana.com/reference/getstoriesfortask)). Each Story has `type` (`comment` or `system`) and `resource_subtype` (such as `comment_added`, `marked_complete`, `marked_incomplete`, `assigned`, `unassigned`, `name_changed`, `added_to_tag`, `removed_from_tag`); `assigned` carries `assignee`, `name_changed` carries `new_name`, the tag subtypes carry `tag`, and `unassigned` carries no user ([forum: new fields on stories](https://forum.asana.com/t/no-more-parsing-story-text-new-fields-on-stories/42924)). `POST /tasks/<gid>/stories` adds a comment.
- `POST /tasks` creates a Task; its `projects` and `tags` are create-only. `PUT /tasks/<gid>` updates fields including `name`, `notes`, `assignee`, and `completed`; `assignee` accepts a user gid, an email, or `me`. `POST /tasks/<gid>/addTag` and `removeTag` change an existing Task's Tags.
- `GET /workspaces/<gid>/tags` lists a workspace's Tags. A Tag's `color` is a named value such as `dark-pink` or `light-green`, or null, not a hex code. A project's `members` field lists its member users; Asana's forum warns it misses teams added as project members ([forum: changes to stories](https://forum.asana.com/t/change-upcoming-changes-to-stories/727582/2)).
- The workspace task search endpoint (`GET /workspaces/<gid>/tasks/search`) needs a premium account and answers others with HTTP 402 ([Search tasks in a workspace](https://developers.asana.com/reference/searchtasksforworkspace)), which is why Requirement 6, criterion 14, declares `search` false.
- Task URLs: legacy `https://app.asana.com/0/<project_gid>/<task_gid>` (optionally `/f`), `https://app.asana.com/0/0/<task_gid>` for a task outside a project view, and the V1 forms `https://app.asana.com/1/<workspace_gid>/project/<project_gid>/task/<task_gid>` and `https://app.asana.com/1/<workspace_gid>/task/<task_gid>` ([Asana forum: New V1 Asana URL format](https://forum.asana.com/t/upcoming-new-v1-asana-url-format-in-the-browser/1011489)). V1 replaces `/f` with `?focus=true`, and adds comment links (`.../task/<task_gid>/comment/<comment_gid>`) and Home task links (`/home/task/<task_gid>`), which Requirement 4 does not accept. The later forum post the brief cited describes the `/1/<workspace_gid>/task/<task_gid>` form; no form without a workspace segment was found. The API's `permalink_url` uses the V1 forms: the spec's example is `https://app.asana.com/1/12345/task/123456789`, and a session with a live PAT reported the `/project/` form on 2026-11-25 (not checked here).

## Appendix C: Open questions and assumed defaults

- **Q1. Workspace identity.** The server (`IssueService.resolveUrl`) keeps a standalone link only when `parseIssueUrl(<canonical task URL>).workspace` equals the link's `workspace`, and the client (`issueLinks.ts`) needs a connected account whose `workspace` equals the link's. Linear needs this because team keys repeat across workspaces. Asana gids are globally unique, but legacy Asana links name no workspace, and one PAT can reach several Asana_Workspaces while a connection reports one `workspace`. **Assumed default:** the Asana_Package reports a workspace identity that does not depend on the URL form or on which Asana_Workspace holds the task, so that every Asana link matches every connected Asana account and the server's canonical check passes; Asana's gid uniqueness replaces the workspace check. The design confirms that this needs no change to `IssueService.ts` or `issueLinks.ts`; if it does, the change stays the smallest one that keeps Linear's behavior.
- **Q2. Links that name no Asana_Project.** `IssueLink` needs a scope, and these links have none. **Assumed default:** such a link resolves read-only through any T3 Code project bound to Asana (Requirement 5, criterion 6). Making the link writable when the Task belongs to a Bound_Project needs a change to the generic resolvers and is out of scope.
- **Q3. Display_Key.** Asana Tasks have no short human key; the gid is 16 or more digits. **Assumed default:** the Display_Key is the task gid, and the web tab label and the mobile list row change so that the gid shows without `#` and without the Asana_Project gid in front (Requirements 17 and 18). The design may choose a shorter Display_Key if Asana offers one on every plan.
- **Q4. State names.** **Assumed default:** `Incomplete` for the open state and `Completed` for the closed state. Asana project sections as workflow states are out of scope.
- **Q5. User login.** Asana users have a gid, a name, and an email, but no handle. **Assumed default:** the login is the user's email when Asana returns one, else the user's gid, so that the assignee filter and assignee writes accept what the pickers show (Requirement 11, criterion 4).
- **Q6. Sort across pages.** Asana's project task list has no sort parameter. **Assumed default:** each page is sorted by the requested date (Requirement 6, criterion 10), and the Issue_Service's existing sort orders each answer; order across **Load more** pages follows Asana's project order. The Fork_PR description states this limit.
- **Q7. Comment order.** Asana lists Stories oldest first, but the clients expect the detail to hold the newest comments and the Cursor to lead to older ones. **Assumed default:** the design chooses how to read the newest page (for example, reading the story pages and keeping the last 50) and states the cost for Tasks with long histories.

## Appendix D: Out of scope

- An upstream PR to `pingdotgg/t3code`.
- Asana reactions (hearts), task templates, linked pull requests, subtasks, custom fields, sections as workflow states, due dates, attachments, and OAuth sign-in.
- Tracker-side text search through Asana's premium search endpoint.
- An end-to-end scenario under `scripts/scenarios/` with a fake Asana server.
- Testing against a live Asana account, unless the fork's owner provides a PAT for that run outside the repository.
- Doc-comment edits in `packages/contracts`, `packages/source-control-core`, or `packages/client-runtime` that would add Asana beside Linear and Jira as an example.
