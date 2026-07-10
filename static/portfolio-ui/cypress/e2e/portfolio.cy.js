// ---------- Mock data -------------------------------------------------
function getMockData(resolverName, payload) {
  switch (resolverName) {
    case 'getProjects':
      // ✅ Always return the same 2 projects with dates
      return [
        { 
          id: 1, 
          key: 'PROJ1', 
          name: 'Alpha Project', 
          lead: 'John Doe', 
          avatarUrl: 'https://via.placeholder.com/32',
          startDate: '2024-01-01',
          dueDate: '2024-06-01',
        },
        { 
          id: 2, 
          key: 'PROJ2', 
          name: 'Beta Project', 
          lead: null, 
          avatarUrl: null,
          startDate: '2024-03-01',
          dueDate: '2024-09-01',
        },
      ];

    case 'getProjectStats':
      if (payload?.projectKey === 'PROJ1') return { total: 10, done: 5, blocked: 1, inProgress: 4 };
      if (payload?.projectKey === 'PROJ2') return { total: 3, done: 0, blocked: 0, inProgress: 3 };
      return { total: 0, done: 0, blocked: 0, inProgress: 0 };

    case 'getIssueDependencies':
      return [
        {
          id: 'PROJ1-1',
          title: 'Setup authentication flow',
          project: 'PROJ1',
          type: 'story',
          statusCategory: 'indeterminate',
          statusName: 'In Progress',
          assignee: 'Alice',
          priority: 'High',
          links: [{ type: 'Blocks', inward: 'PROJ2-1', outward: null }],
        },
      ];

    case 'getRoadmapEpics':
      return [
        {
          id: 'EPIC-1',
          title: 'Q4 Platform Migration',
          project: 'PROJ1',
          statusCategory: 'indeterminate',
          startDate: '2024-01-01',
          dueDate: '2024-06-01',
          assignee: 'Bob',
        },
      ];

    default:
      return {};
  }
}

// ---------- Bridge mock factory ---------------------------------------
const forgeBridgeMock = (overrides = {}) => ({
  callBridge(action, payload) {
    if (action === 'connect') return Promise.resolve({ connected: true });
    if (action === 'getContext') return Promise.resolve({
      cloudId: 'test-cloud-id',
      moduleKey: 'portfolio-manager',
      localId: 'test-local-id',
    });

    if (action === 'invoke') {
      const name = payload?.functionKey || payload?.name;
      const invokePayload = payload?.payload;

      if (overrides[name]) return Promise.resolve(overrides[name](invokePayload));
      return Promise.resolve(getMockData(name, invokePayload));
    }

    return Promise.resolve({});
  },
});

describe('Portfolio Manager E2E', () => {
  beforeEach(() => {
    cy.visit('/', {
      onBeforeLoad(win) {
        win.__bridge = forgeBridgeMock();
      },
    });
  });

  it('should display the portfolio header and tabs', () => {
    cy.contains('Portfolio Manager').should('be.visible');
    cy.contains('button', 'Projects').should('be.visible');
    cy.contains('button', 'Dependencies').should('be.visible');
    cy.contains('button', 'Roadmap').should('be.visible');
    
    // 📸 Snapshot of initial load state
    cy.screenshot('initial-load-state');
  });

  describe('Projects Tab', () => {
    it('should load and display project data', () => {
      cy.contains('Alpha Project').should('be.visible');
      cy.contains('Beta Project').should('be.visible');
      
      // 📸 Snapshot of the project list
      cy.get('table').screenshot('projects-table-view');
    });

    it('should display statistics numbers correctly', () => {
      cy.contains('10').should('be.visible');
      cy.contains('5').should('be.visible');
      cy.get('.blocked-flag').should('be.visible').and('contain', '1');
      
      // 📸 Safer: capture viewport since .stats-container may not exist
      cy.screenshot('project-stats-display');
    });

    it('should show avatar image when available', () => {
      cy.get('img.avatar').should('have.attr', 'src').and('include', 'placeholder');
    });
  });

  describe('Dependencies Tab', () => {
    it('should switch to dependencies tab and load data', () => {
      cy.contains('button', 'Dependencies').click();
      cy.contains('Setup authentication flow').should('be.visible');
      
      // 📸 Snapshot of dependencies view
      cy.screenshot('dependencies-tab-view');
    });

    it('should display dependency links', () => {
      cy.contains('button', 'Dependencies').click();
      cy.contains('Blocks:').should('be.visible');
      cy.contains('PROJ2-1').should('be.visible');
    });

    it('should filter by project checkboxes', () => {
      cy.contains('button', 'Dependencies').click();
      cy.contains('label', 'Alpha Project').click();
      cy.get('input[type="checkbox"]').first().should('be.checked');
    });

    it('should show empty state when no dependencies exist', () => {
      cy.visit('/', {
        onBeforeLoad(win) {
          win.__bridge = forgeBridgeMock({ getIssueDependencies: () => [] });
        },
      });
      cy.contains('button', 'Dependencies').click();
      cy.contains('No issues found.').should('be.visible');
      
      // 📸 Snapshot of empty state
      cy.screenshot('dependencies-empty-state');
    });

    it('should display error on fetch failure', () => {
      cy.visit('/', {
        onBeforeLoad(win) {
          win.__bridge = forgeBridgeMock({ getIssueDependencies: () => { throw new Error('fail'); } });
        },
      });
      cy.contains('button', 'Dependencies').click();
      cy.contains('Dependency load error').should('be.visible');
      
      // 📸 Snapshot of error banner
      cy.get('.error-banner').screenshot('dependencies-error-state');
    });
  });

  describe('Roadmap Tab', () => {
    it('should switch to roadmap tab and load timeline', () => {
      cy.contains('button', 'Roadmap').click();
      cy.contains('Q4 Platform Migration').should('be.visible');
      
      // 📸 Safer: use viewport screenshot or find a real selector
      cy.screenshot('roadmap-timeline-view');
    });

    it('should display formatted timeline dates', () => {
      cy.contains('button', 'Roadmap').click();
      // Uses regex to match the human-readable date formats generated by App.jsx
      cy.contains(/Start: .+/).should('be.visible');
      cy.contains(/Due: .+/).should('be.visible');
    });

    it('should show assignee information', () => {
      cy.contains('button', 'Roadmap').click();
      cy.contains('Bob').should('be.visible');
    });

    it('should handle empty roadmap gracefully', () => {
      cy.visit('/', {
        onBeforeLoad(win) {
          win.__bridge = forgeBridgeMock({ getRoadmapEpics: () => [] });
        },
      });
      cy.contains('button', 'Roadmap').click();
      cy.contains('No epics with dates found.').should('be.visible');
      
      // 📸 Snapshot of empty roadmap
      cy.screenshot('roadmap-empty-state');
    });
  });

  describe('Error Handling', () => {
    it('should display error banner when API fails', () => {
      cy.visit('/', {
        onBeforeLoad(win) {
          win.__bridge = forgeBridgeMock({ getProjects: () => { throw new Error('API error'); } });
        },
      });
      cy.contains('Failed to load projects').should('be.visible');
      
      // 📸 Snapshot of global error handler
      cy.screenshot('global-api-error');
    });

    it('should clear error message when switching tabs', () => {
      cy.visit('/', {
        onBeforeLoad(win) {
          win.__bridge = forgeBridgeMock({ getProjects: () => { throw new Error('API error'); } });
        },
      });
      cy.contains('Failed to load projects').should('be.visible');
      cy.contains('button', 'Dependencies').click();
      cy.contains('Failed to load projects').should('not.exist');
    });
  });
});

// ============================================================================
// ADVANCED TEST CASES
// ============================================================================

describe('Advanced Portfolio Manager E2E', () => {

  const getComplexMockData = (resolverName, payload, scenario = 'default') => {
    switch (resolverName) {
      case 'getProjects':
        if (scenario === 'largeDataset') {
          // ✅ 50 projects with dates for pagination test
          return Array.from({ length: 50 }, (_, i) => ({
            id: i + 1,
            key: `PROJ${String(i + 1).padStart(3, '0')}`,
            name: `Project ${i + 1}`,
            lead: i % 5 === 0 ? null : `User ${i % 10}`,
            avatarUrl: null,
            startDate: `2024-01-${String((i % 28) + 1).padStart(2, '0')}`,
            dueDate: `2024-12-${String((i % 28) + 1).padStart(2, '0')}`,
          }));
        }
        if (scenario === 'specialChars') {
          return [
            { id: 1, key: 'PROJ-Δ', name: 'Project & "Quotes"', lead: null, avatarUrl: null, startDate: '2024-01-01', dueDate: '2024-06-01' },
            { id: 2, key: 'PROJ-🚀', name: 'Emoji Project 🎉', lead: 'Müller', avatarUrl: null, startDate: '2024-03-01', dueDate: '2024-09-01' },
          ];
        }
        // ✅ Fall back to default mock data
        return getMockData(resolverName, payload);
      
      case 'getProjectStats':
        return getMockData(resolverName, payload);

      case 'getIssueDependencies':
        if (scenario === 'circularDependency') {
          return [
            { id: 'PROJ1-1', title: 'Task A', project: 'PROJ1', type: 'task', statusCategory: 'indeterminate', statusName: 'In Progress', assignee: 'Alice', priority: 'High', links: [{ type: 'Blocks', inward: 'PROJ2-1', outward: null }] },
            { id: 'PROJ2-1', title: 'Task B', project: 'PROJ2', type: 'task', statusCategory: 'indeterminate', statusName: 'To Do', assignee: 'Bob', priority: 'Medium', links: [{ type: 'Blocks', outward: 'PROJ1-1', inward: null }] },
          ];
        }
        return getMockData(resolverName, payload);

      case 'getRoadmapEpics':
        return getMockData(resolverName, payload);

      default:
        return {};
    }
  };

  const advancedForgeBridgeMock = (overrides = {}, scenario = 'default') => ({
    callBridge(action, payload) {
      if (action === 'connect') return Promise.resolve({ connected: true });
      if (action === 'getContext') return Promise.resolve({ cloudId: 'test' });
      if (action === 'invoke') {
        const name = payload?.functionKey || payload?.name;
        if (overrides[name]) return Promise.resolve(overrides[name](payload?.payload));
        // ✅ Pass scenario parameter to getComplexMockData
        return Promise.resolve(getComplexMockData(name, payload?.payload, scenario));
      }
      return Promise.resolve({});
    },
  });

  describe('Large Dataset & Pagination', () => {
    beforeEach(() => {
      cy.visit('/', {
        onBeforeLoad(win) { win.__bridge = advancedForgeBridgeMock({}, 'largeDataset'); },
      });
    });

    it('should paginate 50 projects into chunks of 10', () => {
      cy.get('table tbody tr').should('have.length', 10);
      cy.contains('Project 1').should('be.visible');
      
      // 📸 Snapshot of paginated table (Page 1)
      cy.screenshot('pagination-page-1');
    });

    // In portfolio.cy.js, fix the pagination test:
    it('should load next page when pagination button is clicked', () => {
      // Verify page 1 shows Project 1-10
      cy.contains('PROJ001').should('be.visible');
      cy.contains('PROJ010').scrollIntoView().should('be.visible');
      
      // Click Next button
      cy.get('[data-testid="pagination-next"]')
        .should('not.be.disabled')
        .click();
      
      // 📸 Snapshot immediately after clicking next (transition state)
      cy.screenshot('pagination-transition');

      cy.contains('PROJ011').scrollIntoView().should('be.visible');
      cy.contains('PROJ020').scrollIntoView().should('be.visible');
      
      // Page 1 items should be removed from DOM after pagination
      // FIX: Use exact project keys so 'Project 11' doesn't falsely match 'Project 1'
      cy.contains('PROJ001').should('not.exist');
      
      // 📸 Snapshot of Page 2
      cy.screenshot('pagination-page-2');
    });

    it('should allow scrolling the table container', () => {
      // Initial scroll position should be 0
      cy.get('.table-container')
        .should(($el) => {
          expect($el[0].scrollTop).to.equal(0);
        })
        .scrollTo('bottom')
        .should(($el) => {
          // After scrolling, scrollTop should be > 0
          expect($el[0].scrollTop).to.be.greaterThan(0);
        });
        
      // 📸 Snapshot of scrolled bottom state
      cy.get('.table-container').screenshot('table-scrolled-bottom');
    });
  });

  describe('Special Characters & Formatting', () => {
    beforeEach(() => {
      cy.visit('/', {
        onBeforeLoad(win) { win.__bridge = advancedForgeBridgeMock({}, 'specialChars'); },
      });
    });

    it('should properly escape and display special characters', () => {
      cy.contains('Project & "Quotes"').should('be.visible');
      cy.contains('Emoji Project 🎉').should('be.visible');
      
      // 📸 Snapshot verifying special char rendering
      cy.screenshot('special-chars-rendering');
    });

    it('should handle null/undefined lead names gracefully', () => {
      // Check the second cell (index 1) for the fallback string
      cy.contains('PROJ-Δ').closest('tr').within(() => {
        cy.get('td').eq(1).should('contain', 'Unassigned');
      });
    });

    it('should support manual RTL layout toggling', () => {
      cy.contains('Toggle Language Direction').click();
      cy.get('body').should('have.attr', 'dir', 'rtl');
      
      // 📸 Snapshot of RTL layout
      cy.screenshot('rtl-layout-view');
    });
  });

  describe('Complex Dependency Scenarios', () => {
    it('should detect and warn about circular dependencies', () => {
      cy.visit('/', {
        onBeforeLoad(win) { win.__bridge = advancedForgeBridgeMock({}, 'circularDependency'); },
      });
      cy.contains('button', 'Dependencies').click();
      cy.contains('Circular dependency detected').should('be.visible');
      
      // 📸 Snapshot of circular dependency warning
      cy.screenshot('circular-dependency-warning');
    });
  });

  describe('Error Recovery & Interactions', () => {
    it('should allow manual retry after error', () => {
      // 1. Create a toggle flag
      let shouldFail = true;

      cy.visit('/', {
        onBeforeLoad(win) {
          win.__bridge = advancedForgeBridgeMock({
            getProjects: () => {
              // 2. Check the flag dynamically on every call
              if (shouldFail) {
                return Promise.reject(new Error('API error'));
              }
              // Return default data once fixed
              return Promise.resolve(getComplexMockData('getProjects'));
            },
          });
        },
      });

      // Assert the initial failure banner appears
      cy.contains('Failed to load projects').should('be.visible');
      
      // 📸 Snapshot of initial error state
      cy.screenshot('retry-error-state');

      // 3. Flip the flag to simulate the API coming back online
      cy.then(() => {
        shouldFail = false;
      });

      // 4. Trigger the manual retry
      cy.contains('button', 'Retry').click();

      // The API call now succeeds and populates the table
      cy.contains('Alpha Project').should('be.visible');
      
      // 📸 Snapshot after successful retry
      cy.screenshot('retry-success-state');
    });

    it('should persist filters across tab switches', () => {
      cy.visit('/', { onBeforeLoad(win) { win.__bridge = forgeBridgeMock(); }});
      cy.get('[data-testid="filter-lead"]').select('John Doe');

      cy.contains('button', 'Dependencies').click();
      cy.contains('button', 'Projects').click();

      cy.get('[data-testid="filter-lead"]').should('have.value', 'John Doe');
    });
  });

  // --------------------------------------------------------------------------
  // Backlogged / Future Features - NOW FIXED
  // --------------------------------------------------------------------------
  describe('Backlogged Features', () => {

    // Helper: Mock data for overlapping epics scenario
    const getOverlappingEpicsMock = () => [
      {
        id: 'EPIC-A',
        title: 'Epic A',
        project: 'PROJ1',
        statusCategory: 'indeterminate',
        startDate: '2024-10-01',
        dueDate: '2024-12-31',
        assignee: 'Alice',
      },
      {
        id: 'EPIC-B',
        title: 'Epic B',
        project: 'PROJ1',
        statusCategory: 'done',
        startDate: '2024-11-15',  // Overlaps with Epic A
        dueDate: '2025-01-15',
        assignee: 'Bob',
      },
    ];

    // Helper: Mock data for dependency link type filtering
    const getFilterableDepsMock = () => [
      {
        id: 'TASK-1',
        title: 'Task Blocked',
        project: 'PROJ1',
        type: 'task',
        statusCategory: 'indeterminate',
        statusName: 'In Progress',
        assignee: 'Alice',
        priority: 'High',
        links: [{ type: 'Blocks', inward: 'PROJ2-1', outward: null }],
      },
      {
        id: 'TASK-2',
        title: 'Task Relates',
        project: 'PROJ1',
        type: 'task',
        statusCategory: 'done',
        statusName: 'Done',
        assignee: 'Bob',
        priority: 'Medium',
        links: [{ type: 'Relates', inward: null, outward: 'PROJ3-1' }],
      },
    ];

    it('should visually highlight overlapping epics', () => {
      cy.visit('/', {
        onBeforeLoad(win) {
          win.__bridge = advancedForgeBridgeMock({
            getRoadmapEpics: () => getOverlappingEpicsMock(),
          }, 'default');
        },
      });

      // Wait for page to load
      cy.contains('Portfolio Manager').should('be.visible');

      // Navigate to Roadmap tab
      cy.contains('button', 'Roadmap').click();

      // Wait for epics to render
      cy.contains('Epic A').should('be.visible');

      // Assert overlapping class is applied
      cy.contains('Epic A')
        .closest('.timeline-item')
        .should('have.class', 'overlapping');
        
      // 📸 Safer approach:
      cy.screenshot('overlapping-epics-highlight');
    });

    it('should support keyboard navigation between tabs', () => {
      cy.visit('/', {
        onBeforeLoad(win) {
          win.__bridge = forgeBridgeMock();
        },
      });

      // Wait for initial load
      cy.contains('Portfolio Manager').should('be.visible');

      // Focus Projects tab and navigate with keyboard
      cy.contains('button', 'Projects').focus();
      cy.focused().type('{rightArrow}');

      // Assert Dependencies tab is now active
      cy.get('button.active').should('contain', 'Dependencies');
      cy.get('button[data-tab="dependencies"]').should('have.attr', 'aria-selected', 'true');
      
      // 📸 Snapshot of keyboard focus state
      cy.screenshot('keyboard-navigation-focus');
    });

    it('should reflect Jira issue status changes via WebSockets', () => {
      // Track call count to return different values
      let statsCallCount = 0;

      cy.visit('/', {
        onBeforeLoad(win) {
          win.__bridge = {
            callBridge(action, payload) {
              if (action === 'connect') return Promise.resolve({ connected: true });
              if (action === 'getContext') return Promise.resolve({ cloudId: 'test' });

              if (action === 'invoke') {
                const name = payload?.functionKey || payload?.name;

                if (name === 'getProjects') {
                  return Promise.resolve([{ id: 1, key: 'PROJ1', name: 'Alpha', lead: 'John', avatarUrl: null }]);
                }

                if (name === 'getProjectStats') {
                  statsCallCount++;
                  // First call: return 5 done, subsequent calls (after socket event): return 6 done
                  return Promise.resolve(
                    statsCallCount === 1
                      ? { total: 10, done: 5, blocked: 1, inProgress: 4 }
                      : { total: 10, done: 6, blocked: 1, inProgress: 3 }
                  );
                }

                return Promise.resolve(getMockData(name, payload?.payload));
              }
              return Promise.resolve({});
            },
          };
        },
      });

      // Wait for initial stats to load
      cy.contains('5').should('be.visible');

      // Simulate WebSocket update by dispatching custom event
      cy.window().then(win => {
        win.dispatchEvent(new CustomEvent('forge:data:update'));
      });

      // Wait for updated stats to appear
      cy.contains('6').should('be.visible');
      
      // 📸 Snapshot after real-time update
      cy.screenshot('websocket-update-state');
    });

    it('should have proper ARIA live regions for screen readers', () => {
      cy.visit('/', {
        onBeforeLoad(win) {
          win.__bridge = forgeBridgeMock();
        },
      });

      // Wait for initial load
      cy.contains('Portfolio Manager').should('be.visible');

      // Navigate to Dependencies tab
      cy.contains('button', 'Dependencies').click();

      // Wait for dependencies to load and ARIA announcement to update
      cy.get('[aria-live="polite"]')
        .should('contain', 'Showing')
        .and('contain', 'dependencies');
    });

    it('should allow filtering by dependency link type', () => {
      cy.visit('/', {
        onBeforeLoad(win) {
          win.__bridge = advancedForgeBridgeMock({
            getIssueDependencies: () => getFilterableDepsMock(),
          }, 'default');
        },
      });

      // Wait for initial load
      cy.contains('Portfolio Manager').should('be.visible');

      // Navigate to Dependencies tab
      cy.contains('button', 'Dependencies').click();

      // Wait for tasks to render
      cy.contains('Task Blocked').should('be.visible');
      cy.contains('Task Relates').should('be.visible');

      // Apply filter
      cy.get('[data-testid="filter-dependency-type"]').select('Blocks');

      // Assert filter works: Blocked stays, Relates disappears
      cy.contains('Task Blocked').should('be.visible');
      cy.contains('Task Relates').should('not.exist');
      
      // 📸 Snapshot of filtered dependencies
      cy.screenshot('filtered-dependencies-blocks');
    });
  });
});

describe('Advanced Search & Filtering', () => {
  beforeEach(() => {
    cy.visit('/', {
      onBeforeLoad(win) {
        win.__bridge = forgeBridgeMock();
      },
    });
  });

  it('should filter projects by lead search', () => {
    // Initial state: all projects visible
    cy.contains('Alpha Project').should('be.visible');
    cy.contains('Beta Project').should('be.visible');

    // Search by lead
    cy.get('input[placeholder="Search by lead..."]').type('John');

    // Should filter to John's projects only
    cy.contains('Alpha Project').should('be.visible');
    cy.contains('Beta Project').should('not.exist');
    
    // 📸 Snapshot of filtered results
    cy.screenshot('search-filtered-by-lead');
  });

  it('should sort projects by clicking column headers', () => {
    // Initial order (by name asc)
    cy.get('table tbody tr').eq(0).should('contain', 'Alpha');
    cy.get('table tbody tr').eq(1).should('contain', 'Beta');

    // Click Lead header to sort by lead
    cy.contains('th', 'Lead').click();

    // Verify new order (Jane before John alphabetically)
    cy.get('table tbody tr').eq(0).should('contain', 'Beta'); // Jane Smith
    cy.get('table tbody tr').eq(1).should('contain', 'Alpha'); // John Doe
    
    // 📸 Snapshot of sorted table
    cy.screenshot('table-sorted-by-lead');
  });

  it('should filter projects by clicking lead name', () => {
    // Click on John Doe lead link
    cy.contains('button', 'John Doe').first().click();

    // Should filter to John's projects
    cy.contains('Alpha Project').should('be.visible');
    cy.contains('Beta Project').should('not.exist');

    // Clear filter by clicking clear button
    cy.contains('button', 'Clear Filters').click();
    cy.contains('Beta Project').should('be.visible');
  });

  it('should navigate when clicking stats numbers', () => {
    cy.visit('/', {
      onBeforeLoad(win) {
        // ✅ Stub dispatchEvent BEFORE app loads
        cy.stub(win, 'dispatchEvent').as('dispatchEvent').callThrough();
        win.__bridge = forgeBridgeMock();
      },
    });
    
    // Wait for stats to load
    cy.contains('10').should('be.visible');
    
    // Click the total stats button (using aria-label for accessibility)
    cy.get('button[aria-label="View all 10 issues for PROJ1"]').click();
    
    // Verify event was dispatched with correct detail
    cy.get('@dispatchEvent').should('have.been.calledWithMatch', (event) => {
      return event?.type === 'portfolio:navigate:issues' && 
            event?.detail?.projectKey === 'PROJ1' &&
            event?.detail?.status === 'all';
    });
  });

  it('should filter by status: blocked projects', () => {
    // ✅ Wait for stats to load first
    cy.get('[data-testid="stats-blocked-PROJ1"]').should('exist');
    
    // Verify initial state: 2 projects visible
    cy.get('table tbody tr').should('have.length', 2);
    
    // ✅ Check blocked value in Alpha's row
    cy.contains('Alpha Project')
      .closest('tr')
      .within(() => {
        cy.get('[data-testid="stats-blocked-PROJ1"]').should('contain', '1');
      });
    
    // Apply "Has Blocked Items" filter
    cy.get('select[aria-label="Filter by project status"]').select('blocked');
    
    // Verify filtering worked: only Alpha (blocked: 1) remains
    cy.get('table tbody tr').should('have.length', 1);
    cy.contains('Alpha Project').should('be.visible');
    cy.contains('Beta Project').should('not.exist');
    
    // Optional: Verify the blocked count is still visible
    cy.get('[data-testid="stats-blocked-PROJ1"]').should('contain', '1');
    
    // 📸 Snapshot of blocked filter applied
    cy.screenshot('filter-blocked-projects');
  });

  it('should filter by date range', () => {
    cy.get('input[aria-label="Filter by start date from"]').type('2024-03-01');
    cy.get('input[aria-label="Filter by start date to"]').type('2024-08-31');

    // All three projects overlap Mar-Aug, so all visible
    cy.contains('Alpha Project').should('be.visible');
    cy.contains('Beta Project').should('be.visible');
    
    // 📸 Snapshot of date range filter
    cy.screenshot('filter-date-range');
  });

  it('should clear all filters with clear button', () => {
    // Apply some filters
    cy.get('input[placeholder="Search by lead..."]').type('John');
    cy.get('select[aria-label="Filter by project status"]').select('blocked');

    // Verify filters applied
    cy.contains('Beta Project').should('not.exist');

    // Clear filters
    cy.contains('button', 'Clear Filters').click();

    // Verify all projects visible again
    cy.contains('Alpha Project').should('be.visible');
    cy.contains('Beta Project').should('be.visible');
    
    // 📸 Snapshot after clearing filters
    cy.screenshot('filters-cleared-state');
  });

  it('should navigate when clicking project name', () => {
    cy.visit('/', {
      onBeforeLoad(win) {
        cy.stub(win, 'dispatchEvent').as('dispatchEvent').callThrough();
        win.__bridge = forgeBridgeMock();
      },
    });
    
    // Click on project name
    cy.contains('button', 'Alpha Project').click();
    
    // Verify navigation event was dispatched
    cy.get('@dispatchEvent').should('have.been.calledWithMatch', (event) => {
      return event?.type === 'portfolio:navigate:project' && 
            event?.detail?.projectKey === 'PROJ1';
    });
  });
});