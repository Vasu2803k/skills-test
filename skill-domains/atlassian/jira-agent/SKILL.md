---
name: jira-agent
description: 'Search, create, update, and triage Jira issues using Atlassian MCP workflows. Use for issue lookup, bug tracking, sprint reporting, assignment, status changes, and JQL-driven operational summaries.'
metadata:
  author: teradata
  version: "1.0"
---

# Jira Agent

Use this skill when the user needs help working with Atlassian Jira through an MCP server. It covers issue discovery, creation, updates, assignment, triage, sprint monitoring, and operational reporting.

## When to use

- User asks for Jira issue search or filtering
- User wants a new bug, task, story, epic, or subtask created
- User wants to update priority, assignee, labels, description, or status
- User needs a sprint summary or blocker report
- User wants a JQL-based analysis for engineering or ops work
- User asks for incident, release, or support issue tracking

## Core behaviors

1. Read and validate before writing.
2. Confirm project key, issue key, issue type, and field values before mutation.
3. Prefer narrow JQL filters over broad queries.
4. Never create duplicate issues when an existing match is likely.
5. Keep responses concise and action-oriented.
6. Report the exact issue key and relevant status or summary after each action.

## Common Jira tasks

### Search and lookup

Use JQL or issue-key lookups for:

- open issues by project and priority
- blocked or stale tasks
- issues assigned to current user
- issues by label, component, or fix version
- sprint or epic summaries

Example queries:

```text
project = OPS AND status = Open AND priority in (High, Critical) ORDER BY updated DESC
project = PROJ AND labels = regression AND fixVersion is EMPTY AND status != Done
assignee = currentUser() AND status != Done AND due < now() ORDER BY due ASC
```

### Create an issue

Before creating a ticket, confirm:

- project
- issue type
- summary
- priority
- assignee if required
- description and reproduction steps

Suggested output after creation:

- issue key
- summary
- status
- priority
- assignee

### Update an issue

Common updates include:

- priority
- assignee
- labels
- description
- due date
- components
- status
- sprint assignment

When updating multiple fields, keep the edit focused and preserve unrelated values.

### Sprint and planning support

Use sprint context for:

- comparing active sprint scope
- identifying blockers and unresolved dependencies
- summarizing team progress by assignee or status
- detecting stale in-progress items

### Incident and support triage

For outage or customer-impact requests, prefer:

- exact incident keyword searches
- current status checks
- owner and blocker identification
- concise impact summaries with the issue key

## Safe operation checklist

Before any write action:

- confirm the project is correct
- verify the issue key or parent issue key
- confirm the issue type and required fields
- validate assignee name and priority
- check whether the user requested a summary instead of a mutation

## Typical fields

- project
- summary
- description
- issuetype
- priority
- status
- assignee
- reporter
- labels
- components
- fixVersions
- due date
- sprint

## Example prompts

### Example 1

User: Create a Jira bug for the login API returning 500 for MFA-enabled users after deployment 2.4.1.

Expected behavior:

- confirm project and severity
- create a bug issue with reproduction details and environment notes
- return the created issue key and summary

### Example 2

User: Find all open high-priority OPS issues and summarize the top 3.

Expected behavior:

- query Jira with project OPS, status Open, and priority High
- sort by updated date descending
- summarize top 3 by title, assignee, and recency

### Example 3

User: Set OPS-1842 to High priority and assign it to alice.

Expected behavior:

- validate the issue exists
- update priority and assignee
- confirm the final values

## References

See [references/jira-reference.md](references/jira-reference.md) for quick JQL patterns and operational guidance.
