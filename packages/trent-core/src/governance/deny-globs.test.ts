/**
 * A2.2 — `approvals.deny` globs. A user rule, so it must name itself when it fires: a refusal
 * that does not say which glob caused it is a refusal the user cannot edit.
 */
import { describe, expect, it } from "vitest";
import { denyMatch, globToRegExp } from "./deny-globs.js";

const HOME = "/home/founder";

describe("globToRegExp", () => {
  it("anchors the whole subject and keeps regex metacharacters literal", () => {
    expect(globToRegExp("git push*").test("git push --force")).toBe(true);
    expect(globToRegExp("git push*").test("echo git push")).toBe(false);
    expect(globToRegExp("a.b").test("a.b")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
    expect(globToRegExp("cost$(x)").test("cost$(x)")).toBe(true);
  });

  it("lets * and ** cross directory separators, and ? match one character", () => {
    expect(globToRegExp("*/secrets/*").test("/srv/app/secrets/prod.yaml")).toBe(true);
    expect(globToRegExp("**/secrets/**").test("/srv/app/secrets/nested/prod.yaml")).toBe(true);
    expect(globToRegExp("v?.yaml").test("v1.yaml")).toBe(true);
    expect(globToRegExp("v?.yaml").test("v12.yaml")).toBe(false);
  });
});

describe("denyMatch", () => {
  it("returns null when nothing is configured or nothing matches", () => {
    expect(denyMatch([], ["rm -rf build"], HOME)).toBeNull();
    expect(denyMatch(["*terraform*"], ["npm test"], HOME)).toBeNull();
  });

  it("names the glob and the subject that matched", () => {
    const hit = denyMatch(["*terraform destroy*"], ["terraform destroy -auto-approve"], HOME);
    expect(hit?.glob).toBe("*terraform destroy*");
    expect(hit?.subject).toBe("terraform destroy -auto-approve");
  });

  it("matches over paths as well as commands, and expands ~ against home", () => {
    expect(denyMatch(["~/Documents/**"], [`${HOME}/Documents/taxes.pdf`], HOME)?.glob).toBe("~/Documents/**");
    expect(denyMatch(["~/Documents/**"], ["/srv/app/Documents/taxes.pdf"], HOME)).toBeNull();
  });

  it("ignores case, so a shouted command cannot walk past a user rule", () => {
    expect(denyMatch(["*drop table*"], ["psql -c 'DROP TABLE users'"], HOME)).not.toBeNull();
  });

  it("returns the first configured glob that matches, so the report is stable", () => {
    const hit = denyMatch(["*push*", "*force*"], ["git push --force"], HOME);
    expect(hit?.glob).toBe("*push*");
  });
});
