---
name: gh-cli
description: Use when working with GitHub from the command line: repositories, issues, pull requests, Actions, releases, projects, gists, codespaces, or GitHub CLI automation.
---

# GitHub CLI

Use `gh` for GitHub operations when the repository and user permissions allow it. Prefer read-only inspection before mutation, and keep all write operations aligned with repo contribution rules and approval gates.

## When to Use

- Inspect repository, issue, pull request, release, workflow, or Actions state
- Create or update GitHub issues and pull requests
- Check CI status, workflow runs, job logs, and release metadata
- Script repeatable GitHub operations with auditable commands

## Safety Rules

- Never expose tokens, secrets, environment variables, or credential files.
- Confirm the target repo and branch before writes.
- Use `gh auth status` only to verify auth state; do not print tokens.
- Prefer `--json` output for structured reads.
- For writes, describe the intended effect before running the command when the action is approval-gated.

## Common Commands

```bash
gh repo view OWNER/REPO --json name,description,defaultBranchRef
gh issue list --repo OWNER/REPO --state open --json number,title,labels,assignees
gh issue view NUMBER --repo OWNER/REPO --json title,body,comments
gh pr list --repo OWNER/REPO --state open --json number,title,headRefName,statusCheckRollup
gh pr view NUMBER --repo OWNER/REPO --json title,body,files,reviewDecision,statusCheckRollup
gh run list --repo OWNER/REPO --limit 10
gh run view RUN_ID --repo OWNER/REPO --log-failed
```

## Write Patterns

```bash
gh issue create --repo OWNER/REPO --title "..." --body-file issue.md
gh pr create --repo OWNER/REPO --base main --head feature-branch --title "..." --body-file pr.md
gh pr comment NUMBER --repo OWNER/REPO --body-file comment.md
```

When creating issues, PRs, or comments, write the body to a local file first so it can be reviewed and avoids shell quoting mistakes.
