<!-- CONTRIBUTING.md has the rules this checklist refers to. -->

## What changes, and why

## Evidence

- Failing test first: the test path and the first red line it printed before the change
  ```
  ```
- The commands run after the change, each with its exit code
  ```
  ```

## Checklist

- [ ] A failing test was written first and watched fail for the reason this change is about
- [ ] `scripts/dev/isolate.sh <tests> -- <files>` printed `ISOLATED rc=0`
- [ ] `npx vitest run apps/cli/src/commands/__tests__/docs-truth.test.ts` is green, and the docs
      changed in this PR match the behaviour it changes
- [ ] Every touched file is under 500 lines
- [ ] Files were staged by explicit path, not `git add .`
- [ ] No secret, key, token or personal path is in the diff, the tests or the output pasted above
- [ ] `apps/web/` is untouched, or the change is one deliberate bug fix with its own test
