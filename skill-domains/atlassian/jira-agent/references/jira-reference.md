# Jira Agent Reference

This reference captures common Jira operations and JQL patterns used by Atlassian MCP agents.

## 1. Typical actions

- Search issues by key, text, label, assignee, project, or status
- Create bug, task, story, epic, or subtask
- Update issue details such as priority, assignee, labels, and description
- Transition issue workflow states
- Add status or blocker comments
- Summarize sprint or backlog health
- Track customer-impact or incident work

## 2. Common JQL patterns

### Open high-priority work

```text
project = OPS AND status = Open AND priority in (High, Critical) ORDER BY updated DESC
```

### Bugs without fix version

```text
project = PROJ AND issuetype = Bug AND labels = regression AND fixVersion is EMPTY AND status != Done
```

### My overdue work

```text
assignee = currentUser() AND status != Done AND due < now() ORDER BY due ASC
```

### Active sprint deliverables

```text
project = PROJ AND sprint in openSprints() ORDER BY priority DESC, updated DESC
```

## 3. Preferred mutation safety rules

- Validate the project before create or update.
- Use exact issue keys when editing existing items.
- Confirm assignee and priority before writing.
- Prefer read-only query when the request is informational.
- Avoid closing or deleting issues without explicit instruction.

## 4. Useful issue fields

- summary
- description
- issue type
- priority
- status
- assignee
- labels
- components
- fixVersions
- due date
- reporter
- project
- sprint

## 5. Good prompt examples

- Find all open high-priority OPS issues and summarize the top 3.
- Create a Jira bug in ENG for the login API returning 500 for MFA-enabled users after deployment 2.4.1.
- Set OPS-1842 to High priority and assign it to alice.
- List all open blockers in DEV grouped by team.

## 6. Output style

Good results should include:

- issue key
- title or summary
- current status
- assignee or owner when relevant
- short rationale or context

## 7. Operational guidance

When working with Jira through MCP, the agent should behave like a careful operations assistant:

- keep output concise
- avoid guessing when the project or issue is ambiguous
- ask for missing fields instead of inventing them
- provide exact issue keys and updated status after mutation
