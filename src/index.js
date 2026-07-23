import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';

const resolver = new Resolver();

async function jiraGet(path, params = {}) {
  const keys = Object.keys(params);
  if (keys.length === 0) {
    const url = route`${path}`;
    const res = await api.asUser().requestJira(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Jira ${res.status} on ${path}: ${await res.text()}`);
    return res.json();
  }
  const strings = [];
  const values = [];
  strings.push(`${path}?${keys[0]}=`);
  values.push(params[keys[0]]);
  for (let i = 1; i < keys.length; i++) {
    strings.push(`&${keys[i]}=`);
    values.push(params[keys[i]]);
  }
  strings.push('');
  const url = route(strings, ...values);
  const res = await api.asUser().requestJira(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Jira ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}

async function jiraPost(path, body) {
  const url = route([path]);
  const res = await api.asUser().requestJira(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Jira ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}

resolver.define('getProjects', async () => {
  const data = await jiraGet('/rest/api/3/project/search', {
    maxResults: '50',
    orderBy: 'name',
    expand: 'description,lead',
  });
  return (data.values || []).map((p) => ({
    id: p.id,
    key: p.key,
    name: p.name,
    lead: p.lead?.displayName ?? null,
    leadAccountId: p.lead?.accountId ?? null,
    avatarUrl: p.avatarUrls?.['32x32'] ?? null,
  }));
});

resolver.define('getProjectStats', async ({ payload }) => {
  const { projectKey } = payload;
  const base = `project = "${projectKey}"`;
  const [all, done, inProgress, overdueEpics, blockedData, earliestEpic, latestEpic] = await Promise.all([
    jiraPost('/rest/api/3/search/approximate-count', { jql: base }),
    jiraPost('/rest/api/3/search/approximate-count', { jql: `${base} AND statusCategory = Done` }),
    jiraPost('/rest/api/3/search/approximate-count', { jql: `${base} AND statusCategory = "In Progress"` }),
    jiraPost('/rest/api/3/search/approximate-count', {
      jql: `${base} AND issuetype = Epic AND duedate < now() AND statusCategory != Done`,
    }),
    jiraGet('/rest/api/3/search/jql', { jql: base, maxResults: '100', fields: 'status,issuelinks' }),
    jiraGet('/rest/api/3/search/jql', {
      jql: `${base} AND issuetype = Epic AND cf[10015] is not EMPTY ORDER BY cf[10015] ASC`,
      maxResults: '1',
      fields: 'customfield_10015',
    }),
    jiraGet('/rest/api/3/search/jql', {
      jql: `${base} AND issuetype = Epic AND duedate is not EMPTY ORDER BY duedate DESC`,
      maxResults: '1',
      fields: 'duedate',
    }),
  ]);
  const total = all.count ?? 0;
  const blockedCount = (blockedData.issues || []).filter((issue) =>
    (issue.fields.issuelinks || []).some(
      (l) =>
        l.type?.name === 'Blocks' &&
        l.inwardIssue &&
        l.inwardIssue.fields?.status?.statusCategory?.key !== 'done'
    )
  ).length;
  const overdueCount = overdueEpics.count ?? 0;
  const blockedRatio = total > 0 ? blockedCount / total : 0;
  const overdueComponent = Math.min(overdueCount, 3) / 3;
  const riskScore = Math.round(100 * (0.5 * blockedRatio + 0.5 * overdueComponent));
  return {
    total,
    done: done.count ?? 0,
    blocked: blockedCount,
    inProgress: inProgress.count ?? 0,
    overdueEpics: overdueCount,
    riskScore,
    startDate: earliestEpic.issues?.[0]?.fields?.customfield_10015 ?? null,
    dueDate: latestEpic.issues?.[0]?.fields?.duedate ?? null,
  };
});

resolver.define('getIssueDependencies', async ({ payload }) => {
  const { projectKeys } = payload;
  if (!projectKeys?.length) return [];
  const data = await jiraGet('/rest/api/3/search/jql', {
    jql: `project in (${projectKeys.join(',')}) ORDER BY created DESC`,
    maxResults: '100',
    fields: 'summary,status,issuetype,project,issuelinks,assignee,priority',
  });
  return (data.issues || []).map((issue) => ({
    id: issue.key,
    title: issue.fields.summary,
    project: issue.fields.project.key,
    type: issue.fields.issuetype.name.toLowerCase(),
    statusCategory: issue.fields.status.statusCategory.key,
    statusName: issue.fields.status.name,
    assignee: issue.fields.assignee?.displayName ?? null,
    priority: issue.fields.priority?.name ?? 'Medium',
    links: (issue.fields.issuelinks || []).map((l) => ({
      type: l.type.name,
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
  const data = await jiraGet('/rest/api/3/search/jql', {
    jql: `project in (${projectKeys.join(',')}) AND issuetype = Epic ORDER BY duedate ASC`,
    maxResults: '100',
    fields: 'summary,status,project,duedate,customfield_10015,assignee',
  });
  return (data.issues || []).map((issue) => ({
    id: issue.key,
    title: issue.fields.summary,
    project: issue.fields.project.key,
    statusCategory: issue.fields.status.statusCategory.key,
    startDate: issue.fields.customfield_10015 ?? null,
    dueDate: issue.fields.duedate ?? null,
    assignee: issue.fields.assignee?.displayName ?? null,
  }));
});

const BPMN_INDEX_KEY = 'bpmn:index';
const bpmnDiagramKey = (id) => `bpmn:diagram:${id}`;

async function getProjectLeadAccountId(projectKey) {
  const project = await jiraGet(`/rest/api/3/project/${projectKey}`, { expand: 'lead' });
  return project.lead?.accountId ?? null;
}

resolver.define('getCurrentUser', async ({ context }) => ({ accountId: context?.accountId ?? null }));
resolver.define('getBpmnDiagrams', async () => (await kvs.get(BPMN_INDEX_KEY)) || []);
resolver.define('getBpmnDiagram', async ({ payload }) => {
  const diagram = await kvs.get(bpmnDiagramKey(payload.diagramId));
  if (!diagram) throw new Error(`Diagram ${payload.diagramId} not found`);
  return diagram;
});

// Single definition. version + lastEditedBy let the UI poll for changes.
resolver.define('saveBpmnDiagram', async ({ payload, context }) => {
  const { diagramId, name, projectKey, xml } = payload;
  const accountId = context?.accountId ?? null;
  const leadAccountId = await getProjectLeadAccountId(projectKey);
  if (!accountId || accountId !== leadAccountId) {
    throw new Error('Only the project lead can edit this diagram.');
  }
  const id = diagramId || `bpmn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const existing = diagramId ? await kvs.get(bpmnDiagramKey(id)) : null;
  const version = (existing?.version || 0) + 1;
  const record = {
    id,
    name,
    projectKey,
    xml,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    version,
    lastEditedBy: accountId,
  };
  await kvs.set(bpmnDiagramKey(id), record);
  const index = (await kvs.get(BPMN_INDEX_KEY)) || [];
  const meta = { id, name, projectKey, updatedAt: now, lastEditedBy: accountId, version };
  const nextIndex = diagramId ? index.map((d) => (d.id === id ? meta : d)) : [...index, meta];
  await kvs.set(BPMN_INDEX_KEY, nextIndex);
  return record;
});

resolver.define('deleteBpmnDiagram', async ({ payload, context }) => {
  const { diagramId } = payload;
  const accountId = context?.accountId ?? null;
  const diagram = await kvs.get(bpmnDiagramKey(diagramId));
  if (!diagram) return { deleted: false };
  const leadAccountId = await getProjectLeadAccountId(diagram.projectKey);
  if (!accountId || accountId !== leadAccountId) {
    throw new Error('Only the project lead can delete this diagram.');
  }
  await kvs.delete(bpmnDiagramKey(diagramId));
  const index = (await kvs.get(BPMN_INDEX_KEY)) || [];
  await kvs.set(BPMN_INDEX_KEY, index.filter((d) => d.id !== diagramId));
  return { deleted: true };
});

export const handler = resolver.getDefinitions();