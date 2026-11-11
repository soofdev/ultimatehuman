# Jira: file accepted findings as Jira issues

The Jira output plugin turns a finding you **Accept** in Review into an issue in one Jira Cloud
project. Nothing is filed without that human click. It starts in dry run: the issue is rendered
and previewed, and no write reaches Jira until you set `dryRun: false`.

## What it does

| When | Jira call |
| --- | --- |
| You click **Accept** on a finding | Searches the project for the finding's `uh-<fingerprint>` label, then creates the issue (`POST /rest/api/3/issue`) if none exists. Accepting twice never makes two issues. |
| Duplicate check (`listCandidates`) | Read-only JQL search (`POST /rest/api/3/search/jql`) for issues carrying the configured labels |
| Recurrence (`comment`) | Adds a comment to an issue it filed |
| Connection check (`probe`) | `GET /rest/api/3/myself` and the project's issue types |

Each issue gets:
- **Summary:** the finding title
- **Description:** impact, symptom, root cause with linked evidence, code pointers, reproduction,
  suggested direction and open questions, in Atlassian Document Format (ADF)
- **Labels:** your configured labels (spaces become dashes), `uh-<fingerprint>` and `severity-<level>`

Writes are pinned to your Jira site. The engine only gives the plugin a POST channel when
`dryRun` is `false`, and that channel refuses every host except the one in `baseUrl`.

Once live, finding content (code excerpts, evidence, error text) is sent to Atlassian.

## Setup

1. Create an API token at <https://id.atlassian.com/manage-profile/security/api-tokens>. Prefer a
   dedicated account that can only browse and create issues in the one project.
   - **Classic token** ("Create API token"): no extra setting needed.
   - **Scoped token** ("Create API token with scopes", recommended): choose the Classic scopes
     `read:jira-work`, `write:jira-work` and `read:jira-user`. Scoped tokens only work through
     Atlassian's gateway, so also set `apiUrl` (below) to
     `https://api.atlassian.com/ex/jira/<cloudId>`. Your `cloudId` is the value shown at
     `https://<your-site>.atlassian.net/_edge/tenant_info`.
2. Save it for the engine, without echoing it or putting it in the config:

   ```sh
   ultimatehuman key JIRA_API_TOKEN
   ```

3. Add the plugin to `~/.ultimatehuman/config.json5`:

   ```json5
   plugins: {
     jira: {
       credentials: {
         baseUrl: 'https://your-team.atlassian.net',
         // apiUrl: 'https://api.atlassian.com/ex/jira/<cloudId>',  // scoped tokens only
         email: 'bot@your-company.com',
         apiToken: '${JIRA_API_TOKEN}',
         projectKey: 'WOD',
       },
       options: {
         issueType: 'Task',        // must exist in the project, e.g. Bug or Task
         labels: ['ultimatehuman'],
         dryRun: true,             // set false to create real issues
       },
     },
   },
   ```

4. Restart the engine (`ultimatehuman stop`, then `ultimatehuman`). Accept a finding in Review:
   in dry run the receipt says "dry run - would create issue in WOD".
5. When the preview looks right, set `dryRun: false` and restart. Accepting a finding now
   answers "Filed as WOD-123 in Jira." and the finding records the issue link.

If Jira refuses (bad token, missing permission, unknown issue type), Accept reports Jira's
error and the finding stays unfiled, so you can fix the setting and accept again.

## Issue type rules

`issueType` is the default. `issueTypeRules` picks a type per finding: rules are checked top to
bottom and the first match wins. A rule matches when every condition it sets matches.

```json5
options: {
  issueType: 'Task',
  issueTypeRules: [
    { issueType: 'Bug', pipeline: 'security-check' },        // pipeline id, or its template name
    { issueType: 'Bug', severity: ['critical', 'high'] },
    { issueType: 'Story', repo: 'wodworx-flutter-app', severity: 'low' },
  ],
}
```

| Condition | Matches |
| --- | --- |
| `pipeline` | The finding's pipeline id (`security-check-1cf0db2d`), or its template name (`security-check`, `bug-radar`) |
| `severity` | `critical`, `high`, `medium`, `low` |
| `repo` | A configured repo name |

Each condition takes one value or a list. The connection check confirms that every type named in
`issueType` and `issueTypeRules` exists in the project, and lists the valid ones when not.

## Limits

- **Jira Cloud only.** It uses REST API v3 and ADF; Jira Data Center/Server is not supported.
- **One output at a time.** If both GitHub and Jira are configured, the first enabled one is
  used. Set `enabled: false` on the one you do not want.
- **No chat setup yet.** The chat's connection form covers data sources only, so Jira is set up
  in the config file as above.
- **Fields.** Priority, assignee, components and sprint are not set; severity is a label.
