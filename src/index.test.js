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

import { handler } from './index';
import api, { route } from '@forge/api';

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

beforeEach(() => {
  requestJiraMock = jest.fn();
  api.asUser.mockReturnValue({ requestJira: requestJiraMock });
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
          lead: { displayName: 'John' },
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
        avatarUrl: 'https://avatar.url',
      },
    ]);
  });

  it('handles missing lead and avatar URLs', async () => {
    mockJiraResponse({
      values: [{ id: 2, key: 'PROJ', name: 'Proj', lead: null, avatarUrls: {} }],
    });
    const result = await getResolver('getProjects')();
    expect(result[0]).toMatchObject({ lead: null, avatarUrl: null });
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

  it('returns stats from five approximate-count calls plus epic date range, and computes a risk score', async () => {
    // Order matches the Promise.all in getProjectStats: all, done, blocked,
    // inProgress, overdueEpics (approximate-count POSTs), then earliestEpic,
    // latestEpic (GETs).
    [
      { count: 10 },
      { count: 5 },
      { count: 2 },
      { count: 3 },
      { count: 1 },
      { issues: [{ fields: { customfield_10015: '2024-01-01' } }] },
      { issues: [{ fields: { duedate: '2024-12-31' } }] },
    ].forEach(mockJiraResponse);

    const result = await getResolver('getProjectStats')({ payload });

    expect(requestJiraMock).toHaveBeenCalledTimes(7);
    const calls = requestJiraMock.mock.calls;

    // The five count calls should hit approximate-count via POST with the JQL in the body.
    for (const [url, options] of calls.slice(0, 5)) {
      expect(url).toBe('/rest/api/3/search/approximate-count');
      expect(options.method).toBe('POST');
    }
    const bodies = calls.slice(0, 5).map(([, options]) => JSON.parse(options.body).jql);
    expect(bodies[0]).toBe('project = "TEST"');
    expect(bodies[1]).toContain('statusCategory = Done');
    expect(bodies[2]).toContain('status = "Blocked"');
    expect(bodies[3]).toContain('statusCategory = "In Progress"');
    expect(bodies[4]).toContain('issuetype = Epic AND duedate < now() AND statusCategory != Done');

    // The date-range calls should hit the new search/jql endpoint.
    expect(calls[5][0]).toContain('/rest/api/3/search/jql');
    expect(calls[5][0]).toContain('cf%5B10015%5D');
    expect(calls[6][0]).toContain('/rest/api/3/search/jql');
    expect(calls[6][0]).toContain('duedate');

    // riskScore = round(100 * (0.5 * blockedRatio + 0.5 * overdueComponent))
    //           = round(100 * (0.5 * (2/10) + 0.5 * min(1,3)/3))
    //           = round(100 * (0.10 + 0.1667)) = round(26.67) = 27
    expect(result).toEqual({
      total: 10,
      done: 5,
      blocked: 2,
      inProgress: 3,
      overdueEpics: 1,
      riskScore: 27,
      startDate: '2024-01-01',
      dueDate: '2024-12-31',
    });
  });

  it('defaults missing counts and dates to 0/null, with a zero risk score', async () => {
    for (let i = 0; i < 5; i++) mockJiraResponse({});
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
      { count: 0 },   // blocked
      { count: 0 },   // inProgress
      { count: 10 },  // overdueEpics (way past the cap of 3)
      { issues: [] },
      { issues: [] },
    ].forEach(mockJiraResponse);

    const result = await getResolver('getProjectStats')({ payload });

    // blockedRatio = 0, overdueComponent = min(10,3)/3 = 1 -> riskScore = round(100*0.5) = 50
    expect(result.riskScore).toBe(50);
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