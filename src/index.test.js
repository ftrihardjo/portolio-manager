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

  it('returns stats from four JQL queries', async () => {
    [{ total: 10 }, { total: 5 }, { total: 2 }, { total: 3 }].forEach(mockJiraResponse);

    const result = await getResolver('getProjectStats')({ payload });

    expect(requestJiraMock).toHaveBeenCalledTimes(4);
    const calls = requestJiraMock.mock.calls.map(([url]) => url);

    // URLSearchParams encodes spaces as '+' instead of '%20'
    expect(calls[0]).toContain('jql=project%20%3D%20%22TEST%22&maxResults=0');
    expect(calls[1]).toContain('statusCategory%20%3D%20Done');
    expect(calls[2]).toContain('status%20%3D%20%22Blocked%22');
    expect(calls[3]).toContain('statusCategory%20%3D%20%22In%20Progress%22');

    expect(result).toEqual({ total: 10, done: 5, blocked: 2, inProgress: 3 });
  });

  it('defaults missing totals to 0', async () => {
    for (let i = 0; i < 4; i++) mockJiraResponse({});
    const result = await getResolver('getProjectStats')({ payload });
    expect(result).toEqual({ total: 0, done: 0, blocked: 0, inProgress: 0 });
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