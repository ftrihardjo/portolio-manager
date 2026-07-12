import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import App from './App';
import { invoke, router } from '@forge/bridge';

jest.mock('@forge/bridge', () => ({
  invoke: jest.fn(),
  router: {
    open: jest.fn().mockResolvedValue(undefined),
    navigate: jest.fn().mockResolvedValue(undefined),
    getUrl: jest.fn().mockResolvedValue(new URL('https://example.atlassian.net/')),
    reload: jest.fn(),
  },
}));

// Suppress expected React warnings in tests
const originalError = console.error;
console.error = (...args) => {
  if (/Warning:.*act\(\)/.test(args[0]) || /validateDOMNesting/.test(args[0])) return;
  originalError.call(console, ...args);
};

function mockInvoke(resolvers) {
  invoke.mockImplementation(async (key, payload) => {
    if (resolvers[key]) {
      if (typeof resolvers[key] === 'function') {
        return resolvers[key](payload);
      }
      return resolvers[key];
    }
    throw new Error(`Unknown resolver: ${key}`);
  });
}

describe('App', () => {
  beforeEach(() => {
    invoke.mockClear();
  });

  // ──────────────────────────────────────────────────────────────────────
  // BASIC RENDERING TESTS
  // ──────────────────────────────────────────────────────────────────────
  it('renders header and three tabs', () => {
    render(<App />);
    expect(screen.getByText('Portfolio Manager')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Projects/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Dependencies/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Roadmap/i })).toBeInTheDocument();
  });

  it('renders with correct ARIA attributes for accessibility', () => {
    render(<App />);
    
    // Tablist should have proper ARIA roles
    const tablist = screen.getByRole('tablist');
    expect(tablist).toHaveAttribute('aria-label', 'Portfolio Views');
    
    // Each tab should have aria-controls and aria-selected
    const projectsTab = screen.getByRole('tab', { name: /Projects/i });
    expect(projectsTab).toHaveAttribute('aria-controls', 'panel-projects');
    expect(projectsTab).toHaveAttribute('aria-selected', 'true');
  });

  // ──────────────────────────────────────────────────────────────────────
  // PROJECTS TAB TESTS
  // ──────────────────────────────────────────────────────────────────────
  describe('Projects tab', () => {
    const projectsMock = [
      { id: 1, key: 'PROJ1', name: 'Alpha', lead: 'John Doe', avatarUrl: 'avatar1.png', startDate: '2024-01-01', dueDate: '2024-06-01' },
      { id: 2, key: 'PROJ2', name: 'Beta', lead: null, avatarUrl: null, startDate: '2024-03-01', dueDate: '2024-09-01' },
    ];
    const statsMock = {
      PROJ1: { total: 10, done: 5, blocked: 1, inProgress: 4 },
      PROJ2: { total: 3, done: 0, blocked: 0, inProgress: 3 },
    };

    beforeEach(() => {
      mockInvoke({
        getProjects: projectsMock,
        getProjectStats: (payload) => statsMock[payload.projectKey],
      });
    });

    it('fetches and displays projects with stats', async () => {
      render(<App />);
      await waitFor(() => screen.getByText('10'));

      expect(screen.getByRole('cell', { name: 'John Doe' })).toBeInTheDocument();
      
      // Verify stats are displayed
      expect(screen.getByText('10')).toBeInTheDocument(); // Total
      expect(screen.getByText('4')).toBeInTheDocument();  // In Progress
      expect(screen.getByText('5')).toBeInTheDocument();  // Done
      expect(screen.getByText('1')).toBeInTheDocument();  // Blocked
    });

    it('displays avatar when available', async () => {
      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));
      expect(screen.getByAltText('')).toHaveAttribute('src', 'avatar1.png');
    });

    it('shows placeholder when avatarUrl is null', async () => {
      render(<App />);
      await waitFor(() => screen.getByText('Beta'));
      const betaRow = screen.getAllByRole('row')[2];
      expect(betaRow.children[0].querySelector('img')).toBeNull();
    });

    it('shows blocked count with flag style', async () => {
      render(<App />);
      const blocked = await screen.findByTestId('stats-blocked-PROJ1');
      expect(blocked).toHaveClass('blocked-flag');
      expect(blocked).toHaveStyle({ background: '#ffe380' });
    });

    it('handles error when fetching projects fails', async () => {
      mockInvoke({ getProjects: () => { throw new Error('API error'); } });
      render(<App />);
      await waitFor(() => {
        expect(screen.getByText(/Failed to load projects/i)).toBeInTheDocument();
      }, { timeout: 3500 });
    });

    // ── NEW: Sorting Tests ─────────────────────────────────────────────
    it('sorts projects by key ascending by default', async () => {
      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));
      
      const rows = screen.getAllByRole('row').slice(1); // Skip header
      expect(rows[0]).toHaveTextContent(/PROJ1/);
      expect(rows[1]).toHaveTextContent(/PROJ2/);
    });

    it('toggles sort order when clicking column header', async () => {
      render(<App />);
      await waitFor(() => screen.getByText('10'));

      // Click 1: Change sort to Total (defaults to Ascending ▲)
      fireEvent.click(screen.getByTitle('Sort by Total'));
      await waitFor(() => {
        // ✅ Query inside waitFor to get the updated DOM node
        const totalHeader = screen.getByTitle('Sort by Total');
        expect(totalHeader.textContent).toContain('▲'); 
        const cells = screen.getAllByTestId(/stats-total-/);
        expect(cells[0]).toHaveTextContent('3');  // Beta (3) comes first in Ascending
        expect(cells[1]).toHaveTextContent('10'); // Alpha (10) comes second
      });

      // Click 2: Toggle to Descending (▼)
      fireEvent.click(screen.getByTitle('Sort by Total'));
      await waitFor(() => {
        // ✅ Query inside waitFor again
        const totalHeader = screen.getByTitle('Sort by Total');
        expect(totalHeader.textContent).toContain('▼');
        const cells = screen.getAllByTestId(/stats-total-/);
        expect(cells[0]).toHaveTextContent('10'); // Alpha (10) comes first in Descending
        expect(cells[1]).toHaveTextContent('3');  // Beta (3) comes second
      });
    });

    it('displays sort indicator icons correctly', async () => {
      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));

      // Default is ascending ▲
      await waitFor(() => {
        const projectHeader = screen.getByTitle('Sort by Project');
        expect(projectHeader.textContent).toContain('▲');
      });

      // Click to toggle to descending ▼
      fireEvent.click(screen.getByTitle('Sort by Project'));
      await waitFor(() => {
        // ✅ Query inside waitFor to get the updated DOM node
        const projectHeader = screen.getByTitle('Sort by Project');
        expect(projectHeader.textContent).toContain('▼');
      });
    });

    // ── NEW: Pagination Tests ──────────────────────────────────────────
    it('disables Prev button on first page', async () => {
      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));
      
      const prevBtn = screen.getByText('Prev');
      expect(prevBtn).toBeDisabled();
    });

    it('disables Next button when all projects fit on one page', async () => {
      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));
      
      const nextBtn = screen.getByTestId('pagination-next');
      expect(nextBtn).toBeDisabled();
    });

    // ── NEW: Project Navigation Click Tests ────────────────────────────
    it('navigates to the Jira project page when clicking project name', async () => {
      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));
      
      // ✅ Query by visible text, not title attribute
      const projectBtn = screen.getByRole('button', { name: /Alpha \(PROJ1\)/i });
      fireEvent.click(projectBtn);
      
      expect(router.open).toHaveBeenCalledWith(
        `/issues/?jql=${encodeURIComponent('project = "PROJ1"')}`
      );
    });

    it('announces navigation via ARIA live region', async () => {
      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));
      
      const projectBtn = screen.getByRole('button', { name: /Alpha \(PROJ1\)/i });
      fireEvent.click(projectBtn);
      
      await waitFor(() => {
        expect(screen.getByText('Navigated to Alpha')).toBeInTheDocument();
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // DEPENDENCIES TAB TESTS
  // ──────────────────────────────────────────────────────────────────────
  describe('Dependencies tab', () => {
    const projectsMock = [
      { id: 1, key: 'PROJ1', name: 'Alpha', lead: 'John', avatarUrl: null },
      { id: 2, key: 'PROJ2', name: 'Beta', lead: 'Jane', avatarUrl: null },
    ];
    const depsMock = [
      {
        id: 'PROJ1-1',
        title: 'Story A',
        project: 'PROJ1',
        type: 'story',
        statusCategory: 'indeterminate',
        statusName: 'In Progress',
        assignee: 'Alice',
        priority: 'High',
        links: [{ type: 'Blocks', inward: 'PROJ2-1', outward: null }],
      },
    ];

    beforeEach(() => {
      mockInvoke({
        getProjects: projectsMock,
        getIssueDependencies: () => depsMock,
      });
    });

    it('loads dependencies when tab is clicked', async () => {
      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));

      fireEvent.click(screen.getByRole('tab', { name: /Dependencies/i }));

      await waitFor(() => {
        expect(screen.getByText(/Story A/)).toBeInTheDocument();
        expect(screen.getByText(/Blocks:/)).toBeInTheDocument();
      });
    });

    it('filters by project checkboxes', async () => {
      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));

      fireEvent.click(screen.getByRole('tab', { name: /Dependencies/i }));
      await waitFor(() => screen.getByText(/Story A/));

      fireEvent.click(screen.getByLabelText('Alpha'));
      await waitFor(() => {
        expect(invoke).toHaveBeenCalledWith('getIssueDependencies', { projectKeys: ['PROJ1'] });
      });
    });

    it('displays error on fetch failure', async () => {
      mockInvoke({
        getProjects: projectsMock,
        getIssueDependencies: () => { throw new Error('fail'); },
      });
      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));

      fireEvent.click(screen.getByRole('tab', { name: /Dependencies/i }));

      await waitFor(() => {
        expect(screen.getByText(/Dependency load error/i)).toBeInTheDocument();
      }, { timeout: 3500 });
    });

    // ── NEW: Link Type Filter Tests ────────────────────────────────────
    it('populates link type filter dropdown with unique types', async () => {
      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));
      fireEvent.click(screen.getByRole('tab', { name: /Dependencies/i }));
      await waitFor(() => screen.getByText(/Story A/));

      const filterSelect = screen.getByTestId('filter-dependency-type');
      expect(filterSelect).toHaveValue('');
      expect(screen.getByRole('option', { name: 'Blocks' })).toBeInTheDocument();
    });

    it('filters dependencies by selected link type', async () => {
      const depsWithMultipleTypes = [
        { id: 'T1', title: 'Task A', project: 'PROJ1', type: 'task', statusCategory: 'indeterminate', statusName: 'In Progress', assignee: 'Alice', priority: 'High', links: [{ type: 'Blocks', inward: 'PROJ2-1' }] },
        { id: 'T2', title: 'Task B', project: 'PROJ1', type: 'task', statusCategory: 'done', statusName: 'Done', assignee: 'Bob', priority: 'Medium', links: [{ type: 'Relates', outward: 'PROJ3-1' }] },
      ];
      mockInvoke({
        getProjects: projectsMock,
        getIssueDependencies: () => depsWithMultipleTypes,
        getProjectStats: () => ({ total: 0, done: 0, blocked: 0, inProgress: 0 }) // Add this to prevent retry delays
      });

      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));
      fireEvent.click(screen.getByRole('tab', { name: /Dependencies/i }));
      
      // Wait for data to load
      await waitFor(() => screen.getByText(/Task A/i), { timeout: 3000 });

      const filterSelect = screen.getByTestId('filter-dependency-type');
      fireEvent.change(filterSelect, { target: { value: 'Blocks' } });

      // Wait for filter to apply
      await waitFor(() => {
        expect(screen.getByText(/Task A/i)).toBeInTheDocument();
        expect(screen.queryByText(/Task B/i)).not.toBeInTheDocument();
      }, { timeout: 3000 });
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // ROADMAP TAB TESTS
  // ──────────────────────────────────────────────────────────────────────
  describe('Roadmap tab', () => {
    const projectsMock = [{ id: 1, key: 'PROJ1', name: 'Alpha', lead: 'John', avatarUrl: null }];
    const epicsMock = [
      {
        id: 'EPIC-1',
        title: 'Epic A',
        project: 'PROJ1',
        statusCategory: 'done',
        startDate: '2025-01-01',
        dueDate: '2025-02-01',
        assignee: 'Bob',
      },
    ];

    beforeEach(() => {
      mockInvoke({ getProjects: projectsMock, getRoadmapEpics: () => epicsMock });
    });

    it('loads roadmap when tab is clicked', async () => {
      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));

      fireEvent.click(screen.getByRole('tab', { name: /Roadmap/i }));

      await waitFor(() => {
        expect(screen.getByText('Epic A')).toBeInTheDocument();
        expect(screen.getByText(/Start:\s*Jan 1, 2025/i)).toBeInTheDocument();
        expect(screen.getByText(/Due:\s*Feb 1, 2025/i)).toBeInTheDocument();
      });
    });

    it('shows error banner on failure', async () => {
      mockInvoke({
        getProjects: projectsMock,
        getRoadmapEpics: () => { throw new Error('fail'); },
      });
      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));

      fireEvent.click(screen.getByRole('tab', { name: /Roadmap/i }));

      await waitFor(() => {
        expect(screen.getByText(/Roadmap load error/i)).toBeInTheDocument();
      }, { timeout: 3500 });
    });

    // ── NEW: Overlapping Epic Detection Tests ──────────────────────────
    it('highlights overlapping epics with visual indicator', async () => {
      const overlappingEpics = [
        { id: 'E1', title: 'Epic 1', project: 'PROJ1', statusCategory: 'indeterminate', startDate: '2025-01-01', dueDate: '2025-03-01', assignee: 'Alice' },
        { id: 'E2', title: 'Epic 2', project: 'PROJ1', statusCategory: 'done', startDate: '2025-02-01', dueDate: '2025-04-01', assignee: 'Bob' }, // Overlaps E1
      ];
      mockInvoke({ getProjects: projectsMock, getRoadmapEpics: () => overlappingEpics });

      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));
      fireEvent.click(screen.getByRole('tab', { name: /Roadmap/i }));
      await waitFor(() => screen.getByText('Epic 1'));

      // Epic 1 should have overlapping class and orange border
      const epic1 = screen.getByText('Epic 1').closest('.timeline-item');
      expect(epic1).toHaveClass('overlapping');
      expect(epic1).toHaveStyle({ borderLeft: '4px solid #ff9900' });
    });

    it('does not highlight non-overlapping epics', async () => {
      const nonOverlappingEpics = [
        { id: 'E1', title: 'Epic 1', project: 'PROJ1', statusCategory: 'indeterminate', startDate: '2025-01-01', dueDate: '2025-02-01', assignee: 'Alice' },
        { id: 'E2', title: 'Epic 2', project: 'PROJ1', statusCategory: 'done', startDate: '2025-03-01', dueDate: '2025-04-01', assignee: 'Bob' }, // No overlap
      ];
      mockInvoke({ getProjects: projectsMock, getRoadmapEpics: () => nonOverlappingEpics });

      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));
      fireEvent.click(screen.getByRole('tab', { name: /Roadmap/i }));
      await waitFor(() => screen.getByText('Epic 1'));

      const epic1 = screen.getByText('Epic 1').closest('.timeline-item');
      expect(epic1).not.toHaveClass('overlapping');
      expect(epic1).toHaveStyle({ borderLeft: '4px solid #0052cc' });
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // ERROR HANDLING & RETRY TESTS
  // ──────────────────────────────────────────────────────────────────────
  it('clears error when switching tabs', async () => {
    mockInvoke({ getProjects: () => { throw new Error('fail'); } });
    render(<App />);
    await waitFor(() => screen.getByText(/Failed to load projects/i), { timeout: 2000 });

    mockInvoke({
      getProjects: [{ id: 1, key: 'TEST', name: 'Test', lead: 'A', avatarUrl: null }],
      getIssueDependencies: () => [],
    });

    fireEvent.click(screen.getByRole('tab', { name: /Dependencies/i }));

    await waitFor(() => {
      expect(screen.queryByText(/Failed to load projects/i)).not.toBeInTheDocument();
    }, { timeout: 3500 });
  });

  it('allows manual retry after error', async () => {
    let shouldFail = true;
    
    // ✅ Set up mock BEFORE render
    invoke.mockImplementation((key) => {
      if (key === 'getProjects') {
        if (shouldFail) throw new Error('API error');
        return Promise.resolve([{ id: 1, key: 'PROJ1', name: 'Alpha', lead: 'John', avatarUrl: null }]);
      }
      return Promise.resolve([]);
    });

    render(<App />);
    
    await waitFor(() => screen.getByText(/Failed to load/i), { timeout: 3000 });

    shouldFail = false;
    fireEvent.click(screen.getByText('Retry'));

    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.queryByText(/Failed to load/i)).not.toBeInTheDocument();
    }, { timeout: 3000 });
  });

  // ──────────────────────────────────────────────────────────────────────
  // ADVANCED FEATURES TESTS
  // ──────────────────────────────────────────────────────────────────────
  describe('Advanced Features', () => {
    it('should visually highlight overlapping epics', async () => {
      mockInvoke({
        getProjects: [{ id: 1, key: 'PROJ1', name: 'Alpha' }],
        getRoadmapEpics: () => [
          { id: 'E1', title: 'Epic 1', startDate: '2025-01-01', dueDate: '2025-03-01' },
          { id: 'E2', title: 'Epic 2', startDate: '2025-02-01', dueDate: '2025-04-01' },
        ]
      });

      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));
      fireEvent.click(screen.getByRole('tab', { name: /Roadmap/i }));

      await waitFor(() => {
        const epic1Container = screen.getByText('Epic 1').closest('.timeline-item');
        expect(epic1Container).toHaveClass('overlapping');
      });
    });

    it('should support keyboard navigation between tabs', async () => {
      mockInvoke({ getProjects: [{ id: 1, key: 'PROJ1', name: 'Alpha' }] });
      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));

      const projTab = screen.getByRole('tab', { name: /Projects/i });
      projTab.focus();

      fireEvent.keyDown(projTab, { key: 'ArrowRight', code: 'ArrowRight' });

      expect(screen.getByRole('tab', { name: /Dependencies/i })).toHaveClass('active');
      expect(screen.getByRole('tab', { name: /Dependencies/i })).toHaveAttribute('aria-selected', 'true');
    });

    it('should reflect Jira issue status changes via WebSockets', async () => {
      invoke.mockResolvedValueOnce([{ id: 1, key: 'PROJ1', name: 'Alpha' }]);
      invoke
        .mockResolvedValueOnce({ total: 10, done: 0, blocked: 0, inProgress: 0 })
        .mockResolvedValue({ total: 15, done: 0, blocked: 0, inProgress: 0 });

      invoke.mockImplementation((key) => {
        if (key === 'getProjects') return Promise.resolve([{ id: 1, key: 'PROJ1', name: 'Alpha' }]);
        if (key === 'getProjectStats') return invoke();
        return Promise.reject(new Error(`Unknown: ${key}`));
      });

      render(<App />);
      await waitFor(() => screen.queryByText('10'), { timeout: 5000 });

      act(() => {
        window.dispatchEvent(new CustomEvent('forge:data:update'));
      });

      await waitFor(() => screen.queryByText('15'), { timeout: 5000 });
    });

    it('should have proper ARIA live regions for screen readers', async () => {
      mockInvoke({
        getProjects: [{ id: 1, key: 'PROJ1', name: 'Alpha' }],
        getIssueDependencies: () => [
          { id: '1', title: 'Task', links: [] }, { id: '2', title: 'Task', links: [] }
        ]
      });
      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));

      fireEvent.click(screen.getByRole('tab', { name: /Dependencies/i }));

      await waitFor(() => {
        expect(screen.getByText(/Showing 2 dependencies/i)).toBeInTheDocument();
      });
    });

    it('should allow filtering by dependency link type', async () => {
      mockInvoke({
        getProjects: [{ id: 1, key: 'PROJ1', name: 'Alpha' }],
        getProjectStats: () => ({ total: 0, done: 0, blocked: 0, inProgress: 0 }), // Crucial fix
        getIssueDependencies: () => [
          { id: 'T1', title: 'Task Blocked', links: [{ type: 'Blocks' }] },
          { id: 'T2', title: 'Task Relates', links: [{ type: 'Relates' }] }
        ]
      });

      render(<App />);
      await waitFor(() => screen.getByText('Alpha'), { timeout: 3000 });
      
      fireEvent.click(screen.getByRole('tab', { name: 'Dependencies' }));
      
      // Wait for loading to finish
      await waitFor(() => screen.queryByText(/Task Blocked/i), { timeout: 3000 });

      expect(screen.getByText(/Task Blocked/i)).toBeInTheDocument();
      expect(screen.getByText(/Task Relates/i)).toBeInTheDocument();

      const filterSelect = screen.getByTestId('filter-dependency-type');
      fireEvent.change(filterSelect, { target: { value: 'Blocks' } });

      await waitFor(() => {
        expect(screen.getByText(/Task Blocked/i)).toBeInTheDocument();
        expect(screen.queryByText(/Task Relates/i)).not.toBeInTheDocument();
      }, { timeout: 3000 });
    });

    it('matches projects table snapshot', async () => {
      // ✅ Define the mocks locally so they are accessible in this scope
      const projectsMock = [
        { id: 1, key: 'PROJ1', name: 'Alpha', lead: 'John Doe', avatarUrl: 'avatar1.png', startDate: '2024-01-01', dueDate: '2024-06-01' },
        { id: 2, key: 'PROJ2', name: 'Beta', lead: null, avatarUrl: null, startDate: '2024-03-01', dueDate: '2024-09-01' },
      ];
      const statsMock = {
        PROJ1: { total: 10, done: 5, blocked: 1, inProgress: 4 },
        PROJ2: { total: 3, done: 0, blocked: 0, inProgress: 3 },
      };

      mockInvoke({
        getProjects: projectsMock,
        getProjectStats: (payload) => statsMock[payload.projectKey],
      });
      
      const { container } = render(<App />);
      await waitFor(() => screen.getByText('10'));
      
      expect(container.querySelector('.projects-table')).toMatchSnapshot();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // ADVANCED SEARCH & FILTERING TESTS
  // ──────────────────────────────────────────────────────────────────────
  describe('Advanced Search & Filtering', () => {
    const projectsMock = [
      { id: 1, key: 'PROJ1', name: 'Alpha', lead: 'John Doe', startDate: '2024-01-01', dueDate: '2024-06-01' },
      { id: 2, key: 'PROJ2', name: 'Beta', lead: 'Jane Smith', startDate: '2024-03-01', dueDate: '2024-09-01' },
      { id: 3, key: 'PROJ3', name: 'Gamma', lead: 'John Doe', startDate: '2024-02-01', dueDate: '2024-08-01' },
    ];
    
    const statsMock = {
      PROJ1: { total: 10, done: 5, blocked: 1, inProgress: 4 },
      PROJ2: { total: 3, done: 3, blocked: 0, inProgress: 0 },
      PROJ3: { total: 7, done: 2, blocked: 2, inProgress: 3 },
    };

    beforeEach(() => {
      mockInvoke({
        getProjects: projectsMock,
        getProjectStats: (payload) => statsMock[payload.projectKey],
      });
    });

    it('should filter projects by lead search', async () => {
      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));
      
      const leadSearch = screen.getByPlaceholderText('Search by lead...');
      fireEvent.change(leadSearch, { target: { value: 'John' } });
      
      await waitFor(() => {
        expect(screen.getByText('Alpha')).toBeInTheDocument();
        expect(screen.getByText('Gamma')).toBeInTheDocument();
        expect(screen.queryByText('Beta')).not.toBeInTheDocument();
      });
    });

    it('should debounce project search input', async () => {
      jest.useFakeTimers();
      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));

      // Type into the debounced search input ("Search projects...")
      const projectSearch = screen.getByPlaceholderText('Search projects...');
      fireEvent.change(projectSearch, { target: { value: 'Beta' } });

      // Should not filter immediately because of the 300ms debounce
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Beta')).toBeInTheDocument();

      // Advance timer wrapped in act()
      act(() => {
        jest.advanceTimersByTime(300);
      });

      // After debounce, filter applies
      await waitFor(() => {
        expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
        expect(screen.getByText('Beta')).toBeInTheDocument();
      });

      jest.useRealTimers();
    });

    it('should sort projects by key ascending', async () => {
      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));
      
      const rows = screen.getAllByRole('row').slice(1);
      expect(rows[0]).toHaveTextContent(/PROJ1/);
      expect(rows[1]).toHaveTextContent(/PROJ2/);
      expect(rows[2]).toHaveTextContent(/PROJ3/);
    });

    it('should make lead names clickable to filter', async () => {
      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));
      
      const johnLinks = screen.getAllByRole('button', { name: /John Doe/i });
      fireEvent.click(johnLinks[0]);
      
      await waitFor(() => {
        expect(screen.getByText('Alpha')).toBeInTheDocument();
        expect(screen.getByText('Gamma')).toBeInTheDocument();
        expect(screen.queryByText('Beta')).not.toBeInTheDocument();
      });
    });

    it('should make stats numbers clickable and navigate to the issue navigator', async () => {
      render(<App />);
      await waitFor(() => screen.getByTestId('stats-total-PROJ1'));
      
      fireEvent.click(screen.getByTestId('stats-total-PROJ1'));
      
      expect(router.open).toHaveBeenCalledWith(
        `/issues/?jql=${encodeURIComponent('project = "PROJ1"')}`
      );
    });

    it('should filter by status: blocked', async () => {
      render(<App />);
      await waitFor(() => screen.getByTestId('stats-blocked-PROJ1'));
      
      const statusFilter = screen.getByLabelText('Filter by project status');
      fireEvent.change(statusFilter, { target: { value: 'blocked' } });
      
      await waitFor(() => {
        expect(screen.getByText('Alpha')).toBeInTheDocument();
        expect(screen.getByText('Gamma')).toBeInTheDocument();
        expect(screen.queryByText('Beta')).not.toBeInTheDocument();
      });
    });

    it('should filter by date range with overlap logic', async () => {
      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));
      
      // Set date range: March 1 to August 31
      fireEvent.change(screen.getByLabelText('Filter by start date from'), { target: { value: '2024-03-01' } });
      fireEvent.change(screen.getByLabelText('Filter by start date to'), { target: { value: '2024-08-31' } });
      
      // All three projects overlap this range
      await waitFor(() => {
        expect(screen.getByText('Alpha')).toBeInTheDocument();
        expect(screen.getByText('Beta')).toBeInTheDocument();
        expect(screen.getByText('Gamma')).toBeInTheDocument();
      });
    });

    it('should exclude projects outside date range', async () => {
      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));
      
      // Set date range that only Beta overlaps: Sep 1 - Dec 31
      fireEvent.change(screen.getByLabelText('Filter by start date from'), { target: { value: '2024-09-01' } });
      fireEvent.change(screen.getByLabelText('Filter by start date to'), { target: { value: '2024-12-31' } });
      
      await waitFor(() => {
        expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
        expect(screen.getByText('Beta')).toBeInTheDocument();
        expect(screen.queryByText('Gamma')).not.toBeInTheDocument();
      });
    });

    it('should clear all filters with clear button', async () => {
      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));
      
      // Apply filters
      fireEvent.change(screen.getByPlaceholderText('Search by lead...'), { target: { value: 'John' } });
      fireEvent.change(screen.getByLabelText('Filter by project status'), { target: { value: 'blocked' } });
      
      await waitFor(() => expect(screen.queryByText('Beta')).not.toBeInTheDocument());
      
      // Clear filters
      fireEvent.click(screen.getByText('Clear Filters'));
      
      // All projects should be visible again
      await waitFor(() => {
        expect(screen.getByText('Alpha')).toBeInTheDocument();
        expect(screen.getByText('Beta')).toBeInTheDocument();
        expect(screen.getByText('Gamma')).toBeInTheDocument();
      });
    });

    // ── NEW: Combined Filter Tests ─────────────────────────────────────
    it('should apply multiple filters simultaneously', async () => {
      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));
      
      fireEvent.change(screen.getByPlaceholderText('Search by lead...'), { target: { value: 'John' } });
      fireEvent.change(screen.getByLabelText('Filter by project status'), { target: { value: 'blocked' } });
      
      // ✅ Both Alpha and Gamma match: lead=John AND blocked>0
      await waitFor(() => {
        expect(screen.getByText('Alpha')).toBeInTheDocument();
        expect(screen.getByText('Gamma')).toBeInTheDocument();
        expect(screen.queryByText('Beta')).not.toBeInTheDocument();
      });
    });

    it('should persist filter state across tab switches', async () => {
      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));
      
      fireEvent.change(screen.getByPlaceholderText('Search by lead...'), { target: { value: 'John' } });
      await waitFor(() => expect(screen.queryByText('Beta')).not.toBeInTheDocument());
      
      // ✅ Scope to tab role to avoid heading conflict
      fireEvent.click(screen.getByRole('tab', { name: 'Dependencies' }));
      await waitFor(() => screen.getByRole('heading', { name: 'Dependencies' }));
      fireEvent.click(screen.getByRole('tab', { name: 'Projects' }));
      
      await waitFor(() => {
        expect(screen.getByText('Alpha')).toBeInTheDocument();
        expect(screen.queryByText('Beta')).not.toBeInTheDocument();
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // ACCESSIBILITY & RTL TESTS
  // ──────────────────────────────────────────────────────────────────────
  describe('Accessibility & RTL', () => {
    it('should toggle RTL layout direction', async () => {
      mockInvoke({ getProjects: [{ id: 1, key: 'PROJ1', name: 'Alpha', lead: 'John' }] });
      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));
      
      expect(document.body).toHaveAttribute('dir', 'ltr');
      
      fireEvent.click(screen.getByText('Toggle Language Direction'));
      expect(document.body).toHaveAttribute('dir', 'rtl');
      
      fireEvent.click(screen.getByText('Toggle Language Direction'));
      expect(document.body).toHaveAttribute('dir', 'ltr');
    });

    it('should announce tab switches via ARIA live region', async () => {
      mockInvoke({ getProjects: [{ id: 1, key: 'PROJ1', name: 'Alpha' }] });
      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));
      
      fireEvent.click(screen.getByRole('tab', { name: /Dependencies/i }));
      await waitFor(() => expect(screen.getByText('Switched to dependencies tab')).toBeInTheDocument());
    });

    it('should have proper keyboard focus management', async () => {
      mockInvoke({ getProjects: [{ id: 1, key: 'PROJ1', name: 'Alpha' }] });
      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));
      
      const projTab = screen.getByRole('tab', { name: /Projects/i });
      projTab.focus();
      
      // Arrow right should move focus to Dependencies tab
      fireEvent.keyDown(projTab, { key: 'ArrowRight' });
      expect(screen.getByRole('tab', { name: /Dependencies/i })).toHaveFocus();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // CIRCULAR DEPENDENCY DETECTION TESTS
  // ──────────────────────────────────────────────────────────────────────
  describe('Circular Dependency Detection', () => {
    it('should display warning when circular dependency detected', async () => {
      const circularDeps = [
        { id: 'PROJ1-1', title: 'Task A', project: 'PROJ1', type: 'task', statusCategory: 'indeterminate', statusName: 'In Progress', links: [{ type: 'Blocks', inward: 'PROJ2-1' }] },
        { id: 'PROJ2-1', title: 'Task B', project: 'PROJ2', type: 'task', statusCategory: 'indeterminate', statusName: 'To Do', links: [{ type: 'Blocks', outward: 'PROJ1-1' }] },
      ];
      
      mockInvoke({
        getProjects: [{ id: 1, key: 'PROJ1', name: 'Alpha' }, { id: 2, key: 'PROJ2', name: 'Beta' }],
        getIssueDependencies: () => circularDeps,
      });
      
      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));
      fireEvent.click(screen.getByRole('tab', { name: /Dependencies/i }));
      
      await waitFor(() => {
        expect(screen.getByTestId('dependency-warning')).toBeInTheDocument();
        expect(screen.getByText('Circular dependency detected')).toBeInTheDocument();
      });
    });

    it('should not display warning when no circular dependency', async () => {
      const linearDeps = [
        { id: 'PROJ1-1', title: 'Task A', project: 'PROJ1', type: 'task', statusCategory: 'indeterminate', statusName: 'In Progress', links: [{ type: 'Blocks', inward: 'PROJ2-1' }] },
      ];
      
      mockInvoke({
        getProjects: [{ id: 1, key: 'PROJ1', name: 'Alpha' }],
        getIssueDependencies: () => linearDeps,
      });
      
      render(<App />);
      await waitFor(() => screen.getByText('Alpha'));
      fireEvent.click(screen.getByRole('tab', { name: /Dependencies/i }));
      
      expect(screen.queryByTestId('dependency-warning')).not.toBeInTheDocument();
    });
  });
});