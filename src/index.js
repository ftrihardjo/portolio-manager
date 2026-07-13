import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';

const resolver = new Resolver();

/**
 * Helper: makes an authenticated GET request to Jira API.
 * Builds the URL using route`...` with raw (un‑encoded) parameters.
 */
async function jiraGet(path, params = {}) {
  const keys = Object.keys(params);
  if (keys.length === 0) {
    const url = route`${path}`;
    const res = await api.asUser().requestJira(url, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Jira ${res.status} on ${path}: ${body}`);
    }
    return res.json();
  }

  // Build the tagged template components correctly
  const strings = [];
  const values = [];

  // First key
  const firstKey = keys[0];
  strings.push(`${path}?${firstKey}=`);
  values.push(params[firstKey]);

  // Remaining keys
  for (let i = 1; i < keys.length; i++) {
    strings.push(`&${keys[i]}=`);
    values.push(params[keys[i]]);
  }
  strings.push(''); // end with an empty string

  const url = route(strings, ...values);
  const res = await api.asUser().requestJira(url, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira ${res.status} on ${path}: ${body}`);
  }
  return res.json();
}

/**
 * Helper: makes an authenticated POST request to Jira API with a JSON body.
 * Used for endpoints like /rest/api/3/search/approximate-count that don't
 * take query params.
 */
async function jiraPost(path, body) {
  // Pass `path` as a literal template string segment (not a substitution
  // value), so `route` doesn't URL-encode the slashes in the path itself.
  const url = route([path]);
  const res = await api.asUser().requestJira(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const responseBody = await res.text();
    throw new Error(`Jira ${res.status} on ${path}: ${responseBody}`);
  }
  return res.json();
}

// ── Resolvers ────────────────────────────────────────────────────────────

resolver.define('getProjects', async () => {
  const data = await jiraGet('/rest/api/3/project/search', {
    maxResults: '50',
    orderBy: 'name',
    expand: 'description,lead'  // commas are allowed, route will encode them safely
  });
  return (data.values || []).map(p => ({
    id: p.id,
    key: p.key,
    name: p.name,
    lead: p.lead?.displayName ?? null,
    avatarUrl: p.avatarUrls?.['32x32'] ?? null,
  }));
});

resolver.define('getProjectStats', async ({ payload }) => {
  const { projectKey } = payload;
  const base = `project = "${projectKey}"`;

  // The legacy /rest/api/3/search endpoint (and its "total" field) has been
  // removed by Atlassian. Counts now come from the approximate-count endpoint,
  // and we no longer get a free "total" back from a plain issue search.
  const [all, done, blocked, inProgress, earliestEpic, latestEpic] = await Promise.all([
    jiraPost('/rest/api/3/search/approximate-count', { jql: base }),
    jiraPost('/rest/api/3/search/approximate-count', { jql: `${base} AND statusCategory = Done` }),
    jiraPost('/rest/api/3/search/approximate-count', { jql: `${base} AND status = "Blocked"` }),
    jiraPost('/rest/api/3/search/approximate-count', { jql: `${base} AND statusCategory = "In Progress"` }),
    // Earliest epic start date for this project, used to power the Projects
    // table's Start column and the date-range filter (previously always
    // empty because getProjects never returned any date fields).
    jiraGet('/rest/api/3/search/jql', {
      jql: `${base} AND issuetype = Epic AND cf[10015] is not EMPTY ORDER BY cf[10015] ASC`,
      maxResults: '1',
      fields: 'customfield_10015',
    }),
    // Latest epic due date for this project, used for the Due column / filter.
    jiraGet('/rest/api/3/search/jql', {
      jql: `${base} AND issuetype = Epic AND duedate is not EMPTY ORDER BY duedate DESC`,
      maxResults: '1',
      fields: 'duedate',
    }),
  ]);

  return {
    total: all.count ?? 0,
    done: done.count ?? 0,
    blocked: blocked.count ?? 0,
    inProgress: inProgress.count ?? 0,
    startDate: earliestEpic.issues?.[0]?.fields?.customfield_10015 ?? null,
    dueDate: latestEpic.issues?.[0]?.fields?.duedate ?? null,
  };
});

resolver.define('getIssueDependencies', async ({ payload }) => {
  const { projectKeys } = payload;
  if (!projectKeys?.length) return [];

  const jql = `project in (${projectKeys.join(',')}) ORDER BY created DESC`;
  const data = await jiraGet('/rest/api/3/search/jql', {
    jql,
    maxResults: '100',
    fields: 'summary,status,issuetype,project,issuelinks,assignee,priority'
  });

  return (data.issues || []).map(issue => ({
    id: issue.key,
    title: issue.fields.summary,
    project: issue.fields.project.key,
    type: issue.fields.issuetype.name.toLowerCase(),
    statusCategory: issue.fields.status.statusCategory.key,
    statusName: issue.fields.status.name,
    assignee: issue.fields.assignee?.displayName ?? null,
    priority: issue.fields.priority?.name ?? 'Medium',
    links: (issue.fields.issuelinks || []).map(l => ({
      type: l.type.name,
      // Directional phrases (e.g. "blocks" / "is blocked by") — the generic
      // type.name alone can't distinguish direction, which was causing the
      // UI to always label links with the outward phrase even when this
      // issue was actually on the inward ("is blocked by") side.
      outwardLabel: l.type.outward,
      inwardLabel: l.type.inward,
      inward: l.inwardIssue?.key ?? null,
      outward: l.outwardIssue?.key ?? null,
    })),
  }));
});

resolver.define('getRoadmapEpics', async ({ payload }) => {
  const { projectKeys } = payload;
  if (!projectKeys?.length) return [];

  const jql = `project in (${projectKeys.join(',')}) AND issuetype = Epic ORDER BY duedate ASC`;
  const data = await jiraGet('/rest/api/3/search/jql', {
    jql,
    maxResults: '100',
    fields: 'summary,status,project,duedate,customfield_10015,assignee'
  });

  return (data.issues || []).map(issue => ({
    id: issue.key,
    title: issue.fields.summary,
    project: issue.fields.project.key,
    statusCategory: issue.fields.status.statusCategory.key,
    startDate: issue.fields.customfield_10015 ?? null,
    dueDate: issue.fields.duedate ?? null,
    assignee: issue.fields.assignee?.displayName ?? null,
  }));
});

export const handler = resolver.getDefinitions();