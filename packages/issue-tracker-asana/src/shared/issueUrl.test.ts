import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ASANA_HOST, ASANA_NO_PROJECT, ASANA_WORKSPACE, parseAsanaTaskUrl } from "./issueUrl.ts";

const parse = (href: string) => parseAsanaTaskUrl(new URL(href));
const link = (scope: string, key: string) => ({
  host: ASANA_HOST,
  workspace: ASANA_WORKSPACE,
  scope,
  key,
});

describe("parseAsanaTaskUrl", () => {
  it("accepts the legacy project forms", () => {
    expect(parse("https://app.asana.com/0/111/222")).toEqual(link("111", "222"));
    expect(parse("https://app.asana.com/0/111/222/f")).toEqual(link("111", "222"));
    expect(parse("https://app.asana.com/0/111/222/")).toEqual(link("111", "222"));
    expect(parse("https://APP.ASANA.COM/0/111/222?focus=true#x")).toEqual(link("111", "222"));
  });

  it("accepts the current permalink form Asana returns", () => {
    expect(parse("https://app.asana.com/1/999/project/111/task/222")).toEqual(link("111", "222"));
    expect(parse("https://app.asana.com/1/999/project/111/task/222?focus=true")).toEqual(
      link("111", "222"),
    );
  });

  it("scopes a link that names no project to 0", () => {
    expect(parse("https://app.asana.com/0/0/222")).toEqual(link(ASANA_NO_PROJECT, "222"));
    expect(parse("https://app.asana.com/1/999/task/222")).toEqual(link(ASANA_NO_PROJECT, "222"));
  });

  it("rejects pages that are not a task", () => {
    for (const path of [
      "/0/111/list",
      "/0/portfolio/111/list",
      "/0/inbox/111",
      "/0/home/111",
      "/1/999/project/111",
      "/1/999/project/111/task/222/comment/333",
      "/1/999/home/task/222",
      "/",
      "/0/111/222/g",
      "/0//222",
    ]) {
      expect(parse(`https://app.asana.com${path}`), path).toBeNull();
    }
  });

  it("rejects other hosts, schemes, credentials, and ports", () => {
    for (const href of [
      "https://app.asana.com.example.net/0/111/222",
      "https://evil-app.asana.com/0/111/222",
      "https://asana.com/0/111/222",
      "https://sub.app.asana.com/0/111/222",
      "http://app.asana.com/0/111/222",
      "https://user@app.asana.com/0/111/222",
      "https://user:pw@app.asana.com/0/111/222",
      "https://app.asana.com:8443/0/111/222",
      `https://app.asana.com/0/111/${"9".repeat(33)}`,
    ]) {
      expect(parse(href), href).toBeNull();
    }
  });
});

const Gid = Schema.String.check(Schema.isPattern(/^\d{1,32}$/));
const Suffix = Schema.String.check(Schema.isPattern(/^[a-z0-9=&]{0,16}$/));
const runs = { arbitrary: { runs: 100 } };

describe("Asana task URL properties", () => {
  it.prop(
    "Feature: asana-issue-tracker, Property 1: Accepted Task URLs parse to their project and task",
    { w: Gid, p: Gid, t: Gid, query: Suffix, fragment: Suffix },
    ({ w, p, t, query, fragment }) => {
      const tail = `?${query}#${fragment}`;
      const projectForms = [
        `https://app.asana.com/0/${p}/${t}${tail}`,
        `https://app.asana.com/0/${p}/${t}/f${tail}`,
        `https://app.asana.com/1/${w}/project/${p}/task/${t}${tail}`,
      ];
      for (const href of projectForms) expect(parse(href)).toEqual(link(p, t));
      for (const href of [
        `https://app.asana.com/0/0/${t}${tail}`,
        `https://app.asana.com/1/${w}/task/${t}${tail}`,
      ]) {
        expect(parse(href)).toEqual(link(ASANA_NO_PROJECT, t));
      }
    },
    runs,
  );

  it.prop(
    "Feature: asana-issue-tracker, Property 2: Formatting then parsing a link is the identity",
    { w: Gid, p: Gid, t: Gid },
    ({ w, p, t }) => {
      const format = (scope: string, key: string) => `https://app.asana.com/0/${scope}/${key}`;
      for (const href of [
        `https://app.asana.com/0/${p}/${t}`,
        `https://app.asana.com/1/${w}/project/${p}/task/${t}`,
        `https://app.asana.com/1/${w}/task/${t}`,
      ]) {
        const parsed = parse(href);
        expect(parsed).not.toBeNull();
        if (parsed === null) return;
        expect(parse(format(parsed.scope, parsed.key))).toEqual(parsed);
      }
    },
    runs,
  );

  it.prop(
    "Feature: asana-issue-tracker, Property 3: Only exact, credential-free Asana task URLs are accepted",
    {
      p: Gid,
      t: Gid,
      junk: Schema.String.check(Schema.isPattern(/^[a-z]{1,8}$/)),
      mutation: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 })),
    },
    ({ p, t, junk, mutation }) => {
      const mutated = [
        `http://app.asana.com/0/${p}/${t}`,
        `https://${junk}app.asana.com/0/${p}/${t}`,
        `https://app.asana.com.${junk}.test/0/${p}/${t}`,
        `https://${junk}.app.asana.com/0/${p}/${t}`,
        `https://app.asana.co/0/${p}/${t}`,
        `https://${junk}@app.asana.com/0/${p}/${t}`,
        `https://${junk}:${junk}@app.asana.com/0/${p}/${t}`,
        `https://app.asana.com:444/0/${p}/${t}`,
        `https://app.asana.com/0/${p}x/${junk}`,
      ];
      expect(parse(mutated[mutation] ?? "")).toBeNull();
    },
    runs,
  );
});
