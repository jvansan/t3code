import * as Effect from "effect/Effect";

import * as AsanaApi from "./AsanaApi.ts";
import * as AsanaIssueTracker from "./AsanaIssueTracker.ts";

/**
 * The Asana tracker over its own API client. Needs the platform HttpClient, and the server's
 * `IssueTrackerHost` for the personal access token saved in Settings.
 */
export const make = AsanaIssueTracker.make.pipe(
  Effect.provideServiceEffect(AsanaApi.AsanaApi, AsanaApi.make),
);
