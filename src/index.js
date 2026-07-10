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

  const [all, done, blocked, inProgress] = await Promise.all([
    jiraGet('/rest/api/3/search', { jql: base, maxResults: '0' }),
    jiraGet('/rest/api/3/search', { jql: `${base} AND statusCategory = Done`, maxResults: '0' }),
    jiraGet('/rest/api/3/search', { jql: `${base} AND status = "Blocked"`, maxResults: '0' }),
    jiraGet('/rest/api/3/search', { jql: `${base} AND statusCategory = "In Progress"`, maxResults: '0' }),
  ]);

  return {
    total: all.total ?? 0,
    done: done.total ?? 0,
    blocked: blocked.total ?? 0,
    inProgress: inProgress.total ?? 0,
  };
});

resolver.define('getIssueDependencies', async ({ payload }) => {
  const { projectKeys } = payload;
  if (!projectKeys?.length) return [];

  const jql = `project in (${projectKeys.join(',')}) AND issuetype in (Epic, Story) ORDER BY created DESC`;
  const data = await jiraGet('/rest/api/3/search', {
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
      inward: l.inwardIssue?.key ?? null,
      outward: l.outwardIssue?.key ?? null,
    })),
  }));
});

resolver.define('getRoadmapEpics', async ({ payload }) => {
  const { projectKeys } = payload;
  if (!projectKeys?.length) return [];

  const jql = `project in (${projectKeys.join(',')}) AND issuetype = Epic ORDER BY duedate ASC`;
  const data = await jiraGet('/rest/api/3/search', {
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