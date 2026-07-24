jest.mock('@forge/resolver', () => {
  const definitions = [];
  return {
    __esModule: true,
    default: class Resolver {
      define(key, resolverFn) {
        definitions.push({ key, resolver: resolverFn });
      }
      getDefinitions() {
        return definitions;
      }
    },
  };
});

jest.mock('@forge/api', () => ({
  __esModule: true,
  default: {
    asUser: jest.fn(),
  },
  route: jest.fn(),
}));

jest.mock('@forge/kvs', () => ({
  kvs: {
    get: jest.fn(),
    set: jest.fn(),
    delete: jest.fn(),
  },
}));

import { handler } from './index';
import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';

// route mock – simply concatenates strings (URLSearchParams is converted to string automatically)
route.mockImplementation((strings, ...values) => {
  let result = '';
  strings.forEach((str, i) => {
    result += str;
    if (i < values.length) {
      result += encodeURIComponent(values[i]);
    }
  });
  return result;
});

let requestJiraMock;

let fakeStorage;

beforeEach(() => {
  requestJiraMock = jest.fn();
  api.asUser.mockReturnValue({ requestJira: requestJiraMock });

  fakeStorage = new Map();
  kvs.get.mockReset().mockImplementation((key) => Promise.resolve(fakeStorage.get(key)));
  kvs.set.mockReset().mockImplementation((key, value) => {
    fakeStorage.set(key, value);
    return Promise.resolve();
  });
  kvs.delete.mockReset().mockImplementation((key) => {
    fakeStorage.delete(key);
    return Promise.resolve();
  });
});

function getResolver(name) {
  const entry = handler.find((def) => def.key === name);
  if (!entry) throw new Error(`Resolver "${name}" not found`);
  return entry.resolver;
}

function mockJiraResponse(body) {
  requestJiraMock.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve(body),
  });
}

function mockJiraError(status, text = 'Error') {
  requestJiraMock.mockResolvedValueOnce({
    ok: false,
    status,
    text: () => Promise.resolve(text),
  });
}

describe('getProjects', () => {
  it('returns formatted project list', async () => {
    mockJiraResponse({
      values: [
        {
          id: 1,
          key: 'TEST',
          name: 'Test Project',
          lead: { displayName: 'John', accountId: 'acc-123' },
          avatarUrls: { '32x32': 'https://avatar.url' },
        },
      ],
    });

    const result = await getResolver('getProjects')();

    // With URLSearchParams, the comma in "description,lead" becomes %2C
    expect(requestJiraMock).toHaveBeenCalledWith(
      '/rest/api/3/project/search?maxResults=50&orderBy=name&expand=description%2Clead',
      { headers: { Accept: 'application/json' } }
    );
    expect(result).toEqual([
      {
        id: 1,
        key: 'TEST',
        name: 'Test Project',
        lead: 'John',
        leadAccountId: 'acc-123',
        avatarUrl: 'https://avatar.url',
      },
    ]);
  });

  it('handles missing lead and avatar URLs', async () => {
    mockJiraResponse({
      values: [{ id: 2, key: 'PROJ', name: 'Proj', lead: null, avatarUrls: {} }],
    });
    const result = await getResolver('getProjects')();
    expect(result[0]).toMatchObject({ lead: null, leadAccountId: null, avatarUrl: null });
  });

  it('handles empty project list', async () => {
    mockJiraResponse({ values: [] });
    const result = await getResolver('getProjects')();
    expect(result).toEqual([]);
  });

  it('throws on non‑ok response', async () => {
    mockJiraError(404, 'Not found');
    // Error message now only contains the path (without query string)
    await expect(getResolver('getProjects')()).rejects.toThrow(
      'Jira 404 on /rest/api/3/project/search: Not found'
    );
  });
});

describe('getProjectStats', () => {
  const payload = { projectKey: 'TEST' };

  it('returns stats from four approximate-count calls, a link-based blocked count, and epic date range', async () => {
    // Order matches the Promise.all in getProjectStats: all, done,
    // inProgress, overdueEpics (approximate-count POSTs), then blockedData,
    // earliestEpic, latestEpic (GETs).
    [
      { count: 10 }, // all
      { count: 5 },  // done
      { count: 3 },  // inProgress
      { count: 1 },  // overdueEpics
      {
        // blockedData: 3 issues, only ISSUE-1 has an unresolved "Blocks" link
        issues: [
          {
            fields: {
              status: { statusCategory: { key: 'new' } },
              issuelinks: [
                { type: { name: 'Blocks' }, inwardIssue: { fields: { status: { statusCategory: { key: 'new' } } } } },
              ],
            },
          },
          {
            // Has a link, but the blocker is already Done — shouldn't count.
            fields: {
              status: { statusCategory: { key: 'new' } },
              issuelinks: [
                { type: { name: 'Blocks' }, inwardIssue: { fields: { status: { statusCategory: { key: 'done' } } } } },
              ],
            },
          },
          {
            // Has a link, but it's "relates to" not "Blocks" — shouldn't count.
            fields: {
              status: { statusCategory: { key: 'new' } },
              issuelinks: [
                { type: { name: 'Relates' }, inwardIssue: { fields: { status: { statusCategory: { key: 'new' } } } } },
              ],
            },
          },
        ],
      },
      { issues: [{ fields: { customfield_10015: '2024-01-01' } }] },
      { issues: [{ fields: { duedate: '2024-12-31' } }] },
    ].forEach(mockJiraResponse);

    const result = await getResolver('getProjectStats')({ payload });

    expect(requestJiraMock).toHaveBeenCalledTimes(7);
    const calls = requestJiraMock.mock.calls;

    // The four count calls should hit approximate-count via POST with the JQL in the body.
    for (const [url, options] of calls.slice(0, 4)) {
      expect(url).toBe('/rest/api/3/search/approximate-count');
      expect(options.method).toBe('POST');
    }
    const bodies = calls.slice(0, 4).map(([, options]) => JSON.parse(options.body).jql);
    expect(bodies[0]).toBe('project = "TEST"');
    expect(bodies[1]).toContain('statusCategory = Done');
    expect(bodies[2]).toContain('statusCategory = "In Progress"');
    expect(bodies[3]).toContain('issuetype = Epic AND duedate < now() AND statusCategory != Done');

    // The blocked-data and date-range calls should hit the new search/jql endpoint.
    expect(calls[4][0]).toContain('/rest/api/3/search/jql');
    expect(calls[4][0]).toContain('maxResults=100');
    expect(calls[5][0]).toContain('/rest/api/3/search/jql');
    expect(calls[5][0]).toContain('cf%5B10015%5D');
    expect(calls[6][0]).toContain('/rest/api/3/search/jql');
    expect(calls[6][0]).toContain('duedate');

    // riskScore = round(100 * (0.5 * blockedRatio + 0.5 * overdueComponent))
    //           = round(100 * (0.5 * (1/10) + 0.5 * min(1,3)/3))
    //           = round(100 * (0.05 + 0.1667)) = round(21.67) = 22
    expect(result).toEqual({
      total: 10,
      done: 5,
      blocked: 1,
      inProgress: 3,
      overdueEpics: 1,
      riskScore: 22,
      startDate: '2024-01-01',
      dueDate: '2024-12-31',
    });
  });

  it('defaults missing counts and dates to 0/null, with a zero risk score', async () => {
    for (let i = 0; i < 4; i++) mockJiraResponse({});
    mockJiraResponse({ issues: [] });
    mockJiraResponse({ issues: [] });
    mockJiraResponse({ issues: [] });
    const result = await getResolver('getProjectStats')({ payload });
    expect(result).toEqual({
      total: 0,
      done: 0,
      blocked: 0,
      inProgress: 0,
      overdueEpics: 0,
      riskScore: 0,
      startDate: null,
      dueDate: null,
    });
  });

  it('caps the overdue-epics risk component at 3 epics', async () => {
    [
      { count: 20 },  // total
      { count: 0 },   // done
      { count: 0 },   // inProgress
      { count: 10 },  // overdueEpics (way past the cap of 3)
      { issues: [] }, // blockedData
      { issues: [] },
      { issues: [] },
    ].forEach(mockJiraResponse);

    const result = await getResolver('getProjectStats')({ payload });

    // blockedRatio = 0, overdueComponent = min(10,3)/3 = 1 -> riskScore = round(100*0.5) = 50
    expect(result.riskScore).toBe(50);
  });

  it('does not count issues whose only links are non-"Blocks" types (e.g. Relates, Duplicates)', async () => {
    [
      { count: 5 }, { count: 0 }, { count: 0 }, { count: 0 },
      {
        issues: [
          {
            fields: {
              status: { statusCategory: { key: 'new' } },
              issuelinks: [
                { type: { name: 'Duplicate' }, inwardIssue: { fields: { status: { statusCategory: { key: 'new' } } } } },
              ],
            },
          },
        ],
      },
      { issues: [] }, { issues: [] },
    ].forEach(mockJiraResponse);

    const result = await getResolver('getProjectStats')({ payload });
    expect(result.blocked).toBe(0);
  });
});

describe('getIssueDependencies', () => {
  it('returns empty array for empty projectKeys', async () => {
    const result = await getResolver('getIssueDependencies')({ payload: { projectKeys: [] } });
    expect(result).toEqual([]);
    expect(requestJiraMock).not.toHaveBeenCalled();
  });

  it('maps issues and link types correctly', async () => {
    mockJiraResponse({
      issues: [
        {
          key: 'TEST-1',
          fields: {
            summary: 'Test issue',
            status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
            issuetype: { name: 'Story' },
            project: { key: 'TEST' },
            assignee: { displayName: 'Alice' },
            priority: { name: 'High' },
            issuelinks: [
              {
                type: { name: 'Blocks' },
                inwardIssue: { key: 'TEST-2' },
                outwardIssue: null,
              },
            ],
          },
        },
      ],
    });

    const result = await getResolver('getIssueDependencies')({ payload: { projectKeys: ['TEST'] } });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'TEST-1',
      title: 'Test issue',
      project: 'TEST',
      type: 'story',
      statusCategory: 'indeterminate',
      statusName: 'In Progress',
      assignee: 'Alice',
      priority: 'High',
      links: [{ type: 'Blocks', inward: 'TEST-2', outward: null }],
    });
  });

  it('defaults assignee to null and priority to Medium', async () => {
    mockJiraResponse({
      issues: [
        {
          key: 'EPIC-1',
          fields: {
            summary: 'Epic',
            status: { name: 'To Do', statusCategory: { key: 'new' } },
            issuetype: { name: 'Epic' },
            project: { key: 'PROJ' },
            assignee: null,
            priority: null,
            issuelinks: [],
          },
        },
      ],
    });

    const [issue] = await getResolver('getIssueDependencies')({ payload: { projectKeys: ['PROJ'] } });
    expect(issue.assignee).toBeNull();
    expect(issue.priority).toBe('Medium');
  });
});

describe('getRoadmapEpics', () => {
  it('returns empty array when projectKeys is empty', async () => {
    const result = await getResolver('getRoadmapEpics')({ payload: { projectKeys: [] } });
    expect(result).toEqual([]);
  });

  it('maps start/due dates and other fields', async () => {
    mockJiraResponse({
      issues: [
        {
          key: 'EPIC-10',
          fields: {
            summary: 'Roadmap Epic',
            status: { name: 'Done', statusCategory: { key: 'done' } },
            project: { key: 'PROJ' },
            duedate: '2024-12-31',
            customfield_10015: '2024-01-01',
            assignee: { displayName: 'Bob' },
          },
        },
      ],
    });

    const [epic] = await getResolver('getRoadmapEpics')({ payload: { projectKeys: ['PROJ'] } });
    expect(epic).toEqual({
      id: 'EPIC-10',
      title: 'Roadmap Epic',
      project: 'PROJ',
      statusCategory: 'done',
      startDate: '2024-01-01',
      dueDate: '2024-12-31',
      assignee: 'Bob',
    });
  });

  it('handles missing start date, due date, and assignee', async () => {
    mockJiraResponse({
      issues: [
        {
          key: 'EPIC-11',
          fields: {
            summary: 'No dates',
            status: { name: 'To Do', statusCategory: { key: 'new' } },
            project: { key: 'PROJ' },
            duedate: null,
            assignee: null,
          },
        },
      ],
    });

    const [epic] = await getResolver('getRoadmapEpics')({ payload: { projectKeys: ['PROJ'] } });
    expect(epic.startDate).toBeNull();
    expect(epic.dueDate).toBeNull();
    expect(epic.assignee).toBeNull();
  });
});

describe('BPMN diagrams (getCurrentUser, getBpmnDiagrams, getBpmnDiagram, saveBpmnDiagram, deleteBpmnDiagram)', () => {
  const LEAD_ACCOUNT_ID = 'lead-acc-1';
  const OTHER_ACCOUNT_ID = 'other-acc-2';

  function mockProjectLead(projectKey, accountId) {
    // getProjectLeadAccountId() calls GET /rest/api/3/project/{key}?expand=lead
    mockJiraResponse({ lead: { accountId } });
  }

  it('returns the calling user\'s accountId from context', async () => {
    const result = await getResolver('getCurrentUser')({ context: { accountId: 'me-123' } });
    expect(result).toEqual({ accountId: 'me-123' });
  });

  it('returns an empty list when no diagrams have been created', async () => {
    const result = await getResolver('getBpmnDiagrams')({});
    expect(result).toEqual([]);
  });

  it('lets the project lead create a new diagram', async () => {
    mockProjectLead('TEST', LEAD_ACCOUNT_ID);

    const result = await getResolver('saveBpmnDiagram')({
      payload: { diagramId: null, name: 'Order Process', projectKey: 'TEST', xml: '<xml/>' },
      context: { accountId: LEAD_ACCOUNT_ID },
    });

    expect(result).toMatchObject({ name: 'Order Process', projectKey: 'TEST', xml: '<xml/>' });
    expect(result.id).toBeTruthy();
    expect(result.createdAt).toBe(result.updatedAt);

    const index = await getResolver('getBpmnDiagrams')({});
    expect(index).toEqual([{ id: result.id, name: 'Order Process', projectKey: 'TEST', updatedAt: result.updatedAt, lastEditedBy: 'lead-acc-1', version: 1 }]);  });

  it('rejects a save from anyone who is not the project lead', async () => {
    mockProjectLead('TEST', LEAD_ACCOUNT_ID);

    await expect(
      getResolver('saveBpmnDiagram')({
        payload: { diagramId: null, name: 'Order Process', projectKey: 'TEST', xml: '<xml/>' },
        context: { accountId: OTHER_ACCOUNT_ID },
      })
    ).rejects.toThrow('Only the project lead can edit this diagram.');

    const index = await getResolver('getBpmnDiagrams')({});
    expect(index).toEqual([]);
  });

  it('rejects a save with no authenticated user at all', async () => {
    mockProjectLead('TEST', LEAD_ACCOUNT_ID);

    await expect(
      getResolver('saveBpmnDiagram')({
        payload: { diagramId: null, name: 'Order Process', projectKey: 'TEST', xml: '<xml/>' },
        context: {},
      })
    ).rejects.toThrow('Only the project lead can edit this diagram.');
  });

  it('updates an existing diagram in place, preserving createdAt', async () => {
    mockProjectLead('TEST', LEAD_ACCOUNT_ID);
    const created = await getResolver('saveBpmnDiagram')({
      payload: { diagramId: null, name: 'v1', projectKey: 'TEST', xml: '<xml v="1"/>' },
      context: { accountId: LEAD_ACCOUNT_ID },
    });

    mockProjectLead('TEST', LEAD_ACCOUNT_ID);
    const updated = await getResolver('saveBpmnDiagram')({
      payload: { diagramId: created.id, name: 'v2', projectKey: 'TEST', xml: '<xml v="2"/>' },
      context: { accountId: LEAD_ACCOUNT_ID },
    });

    expect(updated.id).toBe(created.id);
    expect(updated.name).toBe('v2');
    expect(updated.createdAt).toBe(created.createdAt);

    const index = await getResolver('getBpmnDiagrams')({});
    expect(index).toHaveLength(1);
    expect(index[0].name).toBe('v2');
  });

  it('fetches a single diagram by id, and throws for an unknown id', async () => {
    mockProjectLead('TEST', LEAD_ACCOUNT_ID);
    const created = await getResolver('saveBpmnDiagram')({
      payload: { diagramId: null, name: 'Order Process', projectKey: 'TEST', xml: '<xml/>' },
      context: { accountId: LEAD_ACCOUNT_ID },
    });

    const fetched = await getResolver('getBpmnDiagram')({ payload: { diagramId: created.id } });
    expect(fetched).toEqual(created);

    await expect(
      getResolver('getBpmnDiagram')({ payload: { diagramId: 'does-not-exist' } })
    ).rejects.toThrow('Diagram does-not-exist not found');
  });

  it('lets the project lead delete a diagram', async () => {
    mockProjectLead('TEST', LEAD_ACCOUNT_ID);
    const created = await getResolver('saveBpmnDiagram')({
      payload: { diagramId: null, name: 'Order Process', projectKey: 'TEST', xml: '<xml/>' },
      context: { accountId: LEAD_ACCOUNT_ID },
    });

    mockProjectLead('TEST', LEAD_ACCOUNT_ID);
    const result = await getResolver('deleteBpmnDiagram')({
      payload: { diagramId: created.id },
      context: { accountId: LEAD_ACCOUNT_ID },
    });

    expect(result).toEqual({ deleted: true });
    expect(await getResolver('getBpmnDiagrams')({})).toEqual([]);
    await expect(
      getResolver('getBpmnDiagram')({ payload: { diagramId: created.id } })
    ).rejects.toThrow();
  });

  it('rejects a delete from anyone who is not the project lead', async () => {
    mockProjectLead('TEST', LEAD_ACCOUNT_ID);
    const created = await getResolver('saveBpmnDiagram')({
      payload: { diagramId: null, name: 'Order Process', projectKey: 'TEST', xml: '<xml/>' },
      context: { accountId: LEAD_ACCOUNT_ID },
    });

    mockProjectLead('TEST', LEAD_ACCOUNT_ID);
    await expect(
      getResolver('deleteBpmnDiagram')({
        payload: { diagramId: created.id },
        context: { accountId: OTHER_ACCOUNT_ID },
      })
    ).rejects.toThrow('Only the project lead can delete this diagram.');

    // Still there, since the delete was rejected.
    expect(await getResolver('getBpmnDiagrams')({})).toHaveLength(1);
  });

  it('deleting a diagram that does not exist is a no-op, not an error', async () => {
    const result = await getResolver('deleteBpmnDiagram')({
      payload: { diagramId: 'never-existed' },
      context: { accountId: LEAD_ACCOUNT_ID },
    });
    expect(result).toEqual({ deleted: false });
  });
});