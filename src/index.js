import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { emit } from '@forge/realtime';

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
    // Needed (not just the display name) to check who's allowed to edit a
    // project's BPMN diagrams — accountId is what actually identifies a
    // user, display names aren't guaranteed unique or stable.
    leadAccountId: p.lead?.accountId ?? null,
    avatarUrl: p.avatarUrls?.['32x32'] ?? null,
  }));
});

resolver.define('getProjectStats', async ({ payload }) => {
  const { projectKey } = payload;
  const base = `project = "${projectKey}"`;

  // The legacy /rest/api/3/search endpoint (and its "total" field) has been
  // removed by Atlassian. Counts now come from the approximate-count endpoint,
  // and we no longer get a free "total" back from a plain issue search.
  const [all, done, inProgress, overdueEpics, blockedData, earliestEpic, latestEpic] = await Promise.all([
    jiraPost('/rest/api/3/search/approximate-count', { jql: base }),
    jiraPost('/rest/api/3/search/approximate-count', { jql: `${base} AND statusCategory = Done` }),
    jiraPost('/rest/api/3/search/approximate-count', { jql: `${base} AND statusCategory = "In Progress"` }),
    // Epics past their due date that aren't done yet — feeds the risk score.
    jiraPost('/rest/api/3/search/approximate-count', {
      jql: `${base} AND issuetype = Epic AND duedate < now() AND statusCategory != Done`,
    }),
    // "Blocked" = has an inward "Blocks" link to another issue that isn't
    // Done yet. Deliberately NOT `status = "Blocked"` — plenty of real
    // Jira workflows (verified against this exact site) never add that
    // status at all, and represent blocking purely through issue links
    // instead, which is the same signal the Dependencies tab visualizes.
    // There's no single JQL clause for "has an unresolved blocking link"
    // without a marketplace scripting app, so this fetches issues with
    // their links and counts client-side. Capped at 100 issues per
    // project — larger projects will undercount until this is paginated.
    jiraGet('/rest/api/3/search/jql', {
      jql: base,
      maxResults: '100',
      fields: 'status,issuelinks',
    }),
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

  const total = all.count ?? 0;
  const blockedCount = (blockedData.issues || []).filter(issue =>
    (issue.fields.issuelinks || []).some(l =>
      l.type?.name === 'Blocks' &&
      l.inwardIssue &&
      l.inwardIssue.fields?.status?.statusCategory?.key !== 'done'
    )
  ).length;
  const overdueCount = overdueEpics.count ?? 0;

  // Risk score (0-100), documented so it's easy to audit and adjust:
  //   - 50% weight: share of this project's issues currently blocked by an
  //     unresolved dependency.
  //   - 50% weight: overdue epics, capped at 3 (a 4th+ overdue epic doesn't
  //     make the project meaningfully riskier for scoring purposes, it's
  //     already maxed out that component).
  // This is a heuristic, not a statistically validated model — it's meant to
  // give a quick at-a-glance signal, not a precise prediction.
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

// ─── BPMN diagram library ───────────────────────────────────────────────
// A standalone library of BPMN process diagrams (not tied to any one issue
// or epic), stored in Forge app storage. Each diagram is associated with
// one project; only that project's Lead can edit it, everyone else who can
// open this app gets a read-only view. Permission is always re-checked
// server-side on write — the client's opinion of who's allowed to edit is
// never trusted, since it's trivial to forge a client-side check.

const BPMN_INDEX_KEY = 'bpmn:index';
const bpmnDiagramKey = (id) => `bpmn:diagram:${id}`;

// Looks up a project's lead accountId directly from Jira (not from
// whatever the client sent), so permission checks can't be spoofed by a
// crafted payload.
async function getProjectLeadAccountId(projectKey) {
  const project = await jiraGet(`/rest/api/3/project/${projectKey}`, { expand: 'lead' });
  return project.lead?.accountId ?? null;
}

resolver.define('getCurrentUser', async ({ context }) => {
  return { accountId: context?.accountId ?? null };
});

resolver.define('getBpmnDiagrams', async () => {
  const index = (await kvs.get(BPMN_INDEX_KEY)) || [];
  return index;
});

resolver.define('getBpmnDiagram', async ({ payload }) => {
  const { diagramId } = payload;
  const diagram = await kvs.get(bpmnDiagramKey(diagramId));
  if (!diagram) throw new Error(`Diagram ${diagramId} not found`);
  return diagram;
});

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
  };
  await kvs.set(bpmnDiagramKey(id), record);
  const index = (await kvs.get(BPMN_INDEX_KEY)) || [];
  const meta = { id, name, projectKey, updatedAt: now, lastEditedBy: accountId, version };
  const nextIndex = diagramId
    ? index.map(d => (d.id === id ? meta : d))
    : [...index, meta];
  await kvs.set(BPMN_INDEX_KEY, nextIndex);

  // Emit event so frontend polling/listeners can react
  await emit('diagram-updated', { diagramId: id, version });

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
  await kvs.set(BPMN_INDEX_KEY, index.filter(d => d.id !== diagramId));

  return { deleted: true };
});

// Backend: add locking
resolver.define('lockDiagram', async ({ payload, context }) => {
  const { diagramId } = payload;
  const accountId = context?.accountId;
  const lockKey = `bpmn:lock:${diagramId}`;
  const existingLock = await kvs.get(lockKey);

  if (existingLock && existingLock.accountId !== accountId) {
    // Check if lock is stale (older than 5 minutes)
    const lockAge = Date.now() - new Date(existingLock.lockedAt).getTime();
    if (lockAge < 5 * 60 * 1000) {
      return { locked: true, lockedBy: existingLock.accountId };
    }
  }

  await kvs.set(lockKey, {
    diagramId,
    accountId,
    lockedAt: new Date().toISOString(),
  });
  return { locked: false };
});

resolver.define('unlockDiagram', async ({ payload, context }) => {
  const { diagramId } = payload;
  const accountId = context?.accountId;
  const lockKey = `bpmn:lock:${diagramId}`;
  const existingLock = await kvs.get(lockKey);

  if (existingLock?.accountId === accountId) {
    await kvs.delete(lockKey);
  }
  return { unlocked: true };
});

export const handler = resolver.getDefinitions();