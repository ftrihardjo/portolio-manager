import { useEffect, useMemo, useState } from 'react';
import { invoke, router } from '@forge/bridge';
import './App.css';

const TABS = ['projects', 'dependencies', 'roadmap'];

// Builds the JQL used to open the Jira issue navigator for a given
// project + status filter combo (mirrors the JQL used by getProjectStats).
function jqlForProjectStatus(projectKey, status) {
  const base = `project = "${projectKey}"`;
  switch (status) {
    case 'blocked':
      return `${base} AND status = "Blocked"`;
    case 'done':
      return `${base} AND statusCategory = Done`;
    case 'inProgress':
      return `${base} AND statusCategory = "In Progress"`;
    default:
      return base;
  }
}

// Opens the Jira issue navigator, pre-filtered by the given JQL, in a new tab.
function openIssuesInJira(projectKey, status) {
  const jql = jqlForProjectStatus(projectKey, status);
  router.open(`/jira/issues/?jql=${encodeURIComponent(jql)}`);
}

async function invokeWithRetry(cmd, payload = {}, retries = 3, delay = 150) {
  try {
    return await invoke(cmd, payload);
  } catch (e) {
    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
      return invokeWithRetry(cmd, payload, retries - 1, delay * 2);
    }
    throw e;
  }
}

export default function App() {
  const [projects, setProjects] = useState([]);
  const [stats, setStats] = useState({});
  const [dependencies, setDependencies] = useState([]);
  const [epics, setEpics] = useState([]);
  const [activeTab, setActiveTab] = useState('projects');
  const [selectedProjects, setSelectedProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Advanced Filtering, Interactions, & Accessibility State
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedLead, setSelectedLead] = useState('');
  const [depTypeFilter, setDepTypeFilter] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [layoutDir, setLayoutDir] = useState('ltr');
  const [srAnnouncement, setSrAnnouncement] = useState('');
  const [sortBy, setSortBy] = useState('key');
  const [sortOrder, setSortOrder] = useState('asc');
  const [dateFilter, setDateFilter] = useState({ start: '', end: '' });
  const [statusFilter, setStatusFilter] = useState('');
  const [leadSearch, setLeadSearch] = useState('');

  // Debounce search query
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => clearTimeout(handler);
  }, [searchQuery]);

  useEffect(() => {
    document.body.setAttribute('dir', layoutDir);
  }, [layoutDir]);

  // Core Data Fetch Operations
  async function loadProjects() {
    try {
      const data = await invokeWithRetry('getProjects');
      setProjects(Array.isArray(data) ? data : []);
      return data;
    } catch (e) {
      setError('Failed to load projects: ' + e.message);
    }
  }

  async function loadDependencies() {
    setLoading(true);
    try {
      const keys = selectedProjects.length > 0 ? selectedProjects : projects.map(p => p.key);
      if (keys.length === 0) {
        setDependencies([]);
        return;
      }
      const data = await invokeWithRetry('getIssueDependencies', { projectKeys: keys });
      setDependencies(data || []);
    } catch (e) {
      setError('Dependency load error: ' + e.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadEpics() {
    setLoading(true);
    try {
      const keys = selectedProjects.length > 0 ? selectedProjects : projects.map(p => p.key);
      if (keys.length === 0) {
        setEpics([]);
        return;
      }
      const data = await invokeWithRetry('getRoadmapEpics', { projectKeys: keys });
      setEpics(data || []);
    } catch (e) {
      setError('Roadmap load error: ' + e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadProjects();
  }, []);

  // Poll for updates & Support WebSockets/Custom Events
  useEffect(() => {
    if (projects.length === 0) return;

    async function fetchStats() {
      const statsMap = {};
      await Promise.all(projects.map(async (p) => {
        try {
          statsMap[p.key] = await invokeWithRetry('getProjectStats', { projectKey: p.key });
        } catch (e) {
          statsMap[p.key] = { total: 0, done: 0, blocked: 0, inProgress: 0, error: true };
        }
      }));
      setStats(statsMap);
    }

    fetchStats();
    const interval = setInterval(fetchStats, 12000);

    const handleRealTimeUpdate = () => fetchStats();
    window.addEventListener('forge:data:update', handleRealTimeUpdate);

    return () => {
      clearInterval(interval);
      window.removeEventListener('forge:data:update', handleRealTimeUpdate);
    };
  }, [projects]);

  useEffect(() => {
    setError(null);
    if (activeTab === 'dependencies') {
      loadDependencies();
    } else if (activeTab === 'roadmap') {
      loadEpics();
    }
    setSrAnnouncement(`Switched to ${activeTab} tab`);
  }, [activeTab, selectedProjects]);

  function toggleProject(key) {
    setSelectedProjects(prev =>
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
    );
  }

  function handleManualRetry() {
    setError(null);
    loadProjects();
    if (activeTab === 'dependencies') loadDependencies();
    if (activeTab === 'roadmap') loadEpics();
  }

  const handleTabKeyDown = (e, index) => {
    let newIndex = index;
    if (e.key === 'ArrowRight') newIndex = (index + 1) % TABS.length;
    if (e.key === 'ArrowLeft') newIndex = (index - 1 + TABS.length) % TABS.length;

    if (newIndex !== index) {
      setActiveTab(TABS[newIndex]);
      document.querySelector(`[data-tab="${TABS[newIndex]}"]`)?.focus();
    }
  };

  // ✅ Helper: Handle sort toggle
  const handleSort = (key) => {
    if (sortBy === key) {
      setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(key);
      setSortOrder('asc');
    }
  };

  // Helpers & Computed Values
  const projectStats = useMemo(() => {
    return projects.map(p => ({ ...p, ...stats[p.key] }));
  }, [projects, stats]);

  const uniqueLeads = useMemo(() => {
    return [...new Set(projects.map(p => p.lead).filter(Boolean))];
  }, [projects]);

  const uniqueDepTypes = useMemo(() => {
    const types = new Set();
    dependencies.forEach(d => d.links?.forEach(l => types.add(l.type)));
    return Array.from(types);
  }, [dependencies]);

  // ✅ Enhanced filter + sort logic
  const filteredAndSortedProjects = useMemo(() => {
    let result = [...projectStats];

    // 1. Multi-field text search
    if (debouncedSearch || leadSearch) {
      result = result.filter(p => {
        const searchLower = debouncedSearch.toLowerCase();
        const leadLower = leadSearch.toLowerCase();
        const matchesName = !debouncedSearch || p.name.toLowerCase().includes(searchLower);
        const matchesKey = !debouncedSearch || p.key.toLowerCase().includes(searchLower);
        const matchesLead = !leadSearch || (p.lead && p.lead.toLowerCase().includes(leadLower));
        return (matchesName || matchesKey) && matchesLead;
      });
    }

    // 2. Filter by lead dropdown
    if (selectedLead) {
      result = result.filter(p => p.lead === selectedLead);
    }

    // 3. Filter by status
    if (statusFilter) {
      result = result.filter(p => {
        // 1. Look up the specific stats for this project key
        const projectStats = stats[p.key] || { total: 0, done: 0, blocked: 0, inProgress: 0 };
        
        // 2. Evaluate using the projectStats object instead of the base project 'p'
        if (statusFilter === 'blocked') return projectStats.blocked > 0;
        if (statusFilter === 'done') return projectStats.done === projectStats.total && projectStats.total > 0;
        if (statusFilter === 'inProgress') return projectStats.inProgress > 0 && projectStats.done < projectStats.total; 
        
        return true;
      });
    }

    // 4. Filter by date range
    if (dateFilter.start && dateFilter.end) {
      result = result.filter(p => {
        // Projects without dates: include them when filter is active
        // (or change to `return false` if you want to exclude them)
        if (!p.startDate && !p.dueDate) return true; 
        
        const rawStart = new Date(dateFilter.start);
        const rawEnd = new Date(dateFilter.end);
        const filterStart = rawStart <= rawEnd ? rawStart : rawEnd;
        const filterEnd = rawStart <= rawEnd ? rawEnd : rawStart;
        const pStart = p.startDate ? new Date(p.startDate) : null;
        const pEnd = p.dueDate ? new Date(p.dueDate) : null;
        
        // Check overlap: project range intersects filter range
        if (pEnd && pEnd < filterStart) return false; // Project ends before filter starts
        if (pStart && pStart > filterEnd) return false; // Project starts after filter ends
        return true;
      });
    }

    // 5. Sorting
    result.sort((a, b) => {
      let comparison = 0;
      switch (sortBy) {
        case 'name':
        case 'key':
          comparison = (a[sortBy] || '').localeCompare(b[sortBy] || '');
          break;
        case 'lead':
          comparison = (a.lead || '').localeCompare(b.lead || '');
          break;
        case 'startDate':
        case 'dueDate':
          comparison = new Date(a[sortBy] || 0) - new Date(b[sortBy] || 0);
          break;
        case 'total':
        case 'done':
        case 'blocked':
        case 'inProgress':
          comparison = (a[sortBy] || 0) - (b[sortBy] || 0);
          break;
        default:
          comparison = 0;
      }
      return sortOrder === 'asc' ? comparison : -comparison;
    });

    return result;
  }, [projectStats, debouncedSearch, leadSearch, selectedLead, statusFilter, dateFilter, sortBy, sortOrder]);

  // ✅ Updated pagination to use filteredAndSortedProjects
  const paginatedProjects = useMemo(() => {
    const startIndex = (currentPage - 1) * 10;
    return filteredAndSortedProjects.slice(startIndex, startIndex + 10);
  }, [filteredAndSortedProjects, currentPage]);

  const filteredDependencies = useMemo(() => {
    if (!depTypeFilter) return dependencies;
    return dependencies.filter(d => d.links?.some(l => l.type === depTypeFilter));
  }, [dependencies, depTypeFilter]);

  useEffect(() => {
    if (activeTab === 'dependencies' && !loading) {
      setSrAnnouncement(`Showing ${filteredDependencies.length} dependencies`);
    }
  }, [filteredDependencies.length, activeTab, loading]);

  const circularDependencyPath = useMemo(() => {
    // Build the graph using only `outward` links. Each real link between two
    // fetched issues appears TWICE in the raw data — once as `outward` on
    // the source issue, once as `inward` on the target issue (that's just
    // Jira reciprocally recording the same relationship on both sides).
    // Adding edges for both directions from every issue turns every single
    // link into a fake 2-node cycle (A→B via outward, B→A via inward for
    // the very same relationship). Using outward-only gives each real
    // relationship exactly one directed edge.
    const adj = {};
    dependencies.forEach(issue => {
      adj[issue.id] = adj[issue.id] || [];
      (issue.links || []).forEach(l => {
        if (l.outward) adj[issue.id].push(l.outward);
      });
    });

    const visited = {};
    const recStack = {};
    const pathStack = [];

    function dfs(node) {
      visited[node] = true;
      recStack[node] = true;
      pathStack.push(node);

      for (const neighbor of (adj[node] || [])) {
        if (!visited[neighbor]) {
          const cycle = dfs(neighbor);
          if (cycle) return cycle;
        } else if (recStack[neighbor]) {
          const cycleStart = pathStack.indexOf(neighbor);
          return [...pathStack.slice(cycleStart), neighbor];
        }
      }

      pathStack.pop();
      recStack[node] = false;
      return null;
    }

    for (const node in adj) {
      if (!visited[node]) {
        const cycle = dfs(node);
        if (cycle) return cycle;
      }
    }
    return null;
  }, [dependencies]);

  const hasCircularDependency = circularDependencyPath !== null;

  const processedEpics = useMemo(() => {
    return epics.map((epic, i, arr) => {
       const isOverlapping = arr.some((other, j) => {
          if (i === j || !epic.startDate || !epic.dueDate || !other.startDate || !other.dueDate) return false;
          return (epic.startDate <= other.dueDate) && (epic.dueDate >= other.startDate);
       });
       return { ...epic, isOverlapping };
    });
  }, [epics]);

  function formatDate(dateStr) {
    if (!dateStr) return '';
    const parts = dateStr.split('-');
    if (parts.length === 3) {
      const date = new Date(parts[0], parts[1] - 1, parts[2]);
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function SortableHeader({ label, sortKey, currentSort, order, onSort }) {
    const isActive = currentSort === sortKey;
    const icon = isActive ? (order === 'asc' ? ' ▲' : ' ▼') : ' ⇅';
    return (
      <th
        onClick={() => onSort(sortKey)}
        style={{ cursor: 'pointer', userSelect: 'none' }}
        title={`Sort by ${label}`}
      >
        {label}{isActive ? icon : ''}
      </th>
    );
  }

  return (
    <div className="app" dir={layoutDir}>
      <div aria-live="polite" className="sr-only" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}>
        {srAnnouncement}
      </div>

      <header className="app-header">
        <h1>Portfolio Manager</h1>
        <nav className="tabs" role="tablist" aria-label="Portfolio Views">
          {TABS.map((tab, idx) => (
            <button
              key={tab}
              role="tab"
              aria-selected={activeTab === tab}
              aria-controls={`panel-${tab}`}
              data-tab={tab}
              className={`tab-button ${activeTab === tab ? 'active' : ''}`}
              onClick={() => setActiveTab(tab)}
              onKeyDown={(e) => handleTabKeyDown(e, idx)}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </nav>
      </header>

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button onClick={handleManualRetry} style={{ marginLeft: '10px' }}>Retry</button>
        </div>
      )}

      {hasCircularDependency && (
        <div className="error-banner circular-warning" data-testid="dependency-warning" style={{ backgroundColor: '#fff3cd', color: '#856404' }}>
          Circular dependency detected: {circularDependencyPath.join(' → ')}
        </div>
      )}

      {activeTab === 'projects' && (<div className="global-filters" style={{ display: 'flex', gap: '15px', padding: '10px 20px' }}>
            <input
              type="text"
              data-testid="search-projects"
              placeholder="Search projects..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <select
              data-testid="filter-lead"
              value={selectedLead}
              onChange={(e) => setSelectedLead(e.target.value)}
            >
              <option value="">All Leads</option>
              {uniqueLeads.map(lead => (
                <option key={lead} value={lead}>{lead}</option>
              ))}
            </select>
            <button onClick={() => setLayoutDir(prev => prev === 'ltr' ? 'rtl' : 'ltr')} style={{ fontSize: '11px' }}>
              Toggle Language Direction
            </button>
          </div>)}

          {activeTab === 'projects' && (<div className="advanced-filters" style={{ display: 'flex', gap: '10px', padding: '0 20px 10px', flexWrap: 'wrap' }}>
                 <input
                   type="text"
                   placeholder="Search by lead..."
                   value={leadSearch}
                   onChange={(e) => setLeadSearch(e.target.value)}
                   style={{ minWidth: '150px' }}
                   aria-label="Search projects by lead name"
                 />
                 <select
                   value={statusFilter}
                   onChange={(e) => setStatusFilter(e.target.value)}
                   aria-label="Filter by project status"
                 >
                   <option value="">All Statuses</option>
                   <option value="done">Completed</option>
                   <option value="inProgress">In Progress</option>
                   <option value="blocked">Has Blocked Items</option>
                 </select>
                 <input
                   type="date"
                   value={dateFilter.start}
                   max={dateFilter.end || undefined}
                   onChange={(e) => setDateFilter(prev => ({ ...prev, start: e.target.value }))}
                   placeholder="Start date"
                   aria-label="Filter by start date from"
                 />
                 <span style={{ alignSelf: 'center' }}>to</span>
                 <input
                   type="date"
                   min={dateFilter.start || undefined}
                   value={dateFilter.end}
                   onChange={(e) => setDateFilter(prev => ({ ...prev, end: e.target.value }))}
                   placeholder="End date"
                   aria-label="Filter by start date to"
                 />
                 <button
                   onClick={() => {
                     setLeadSearch('');
                     setStatusFilter('');
                     setDateFilter({ start: '', end: '' });
                     setSrAnnouncement('Filters cleared');
                   }}
                   style={{ fontSize: '12px' }}
                 >
                   Clear Filters
                 </button>
    </div>)}

      <main className="app-content">
        {activeTab === 'projects' && (
          <section className="projects-section" id="panel-projects" role="tabpanel">
            <h2>Projects</h2>
            <div className="table-container" style={{ overflowY: 'auto', maxHeight: '450px', border: '1px solid #ddd' }}>
              <table className="projects-table" style={{ width: '100%', display: 'table' }}>
                <thead>
                  <tr>
                    <SortableHeader label="Project"     sortKey="key"        currentSort={sortBy} order={sortOrder} onSort={handleSort} />
                    <SortableHeader label="Lead"        sortKey="lead"       currentSort={sortBy} order={sortOrder} onSort={handleSort} />
                    <SortableHeader label="Start"       sortKey="startDate"  currentSort={sortBy} order={sortOrder} onSort={handleSort} />
                    <SortableHeader label="Due"         sortKey="dueDate"    currentSort={sortBy} order={sortOrder} onSort={handleSort} />
                    <SortableHeader label="Total"       sortKey="total"      currentSort={sortBy} order={sortOrder} onSort={handleSort} />
                    <SortableHeader label="In Progress" sortKey="inProgress" currentSort={sortBy} order={sortOrder} onSort={handleSort} />  {/* ← ADD THIS */}
                    <SortableHeader label="Done"        sortKey="done"       currentSort={sortBy} order={sortOrder} onSort={handleSort} />
                    <SortableHeader label="Blocked"     sortKey="blocked"    currentSort={sortBy} order={sortOrder} onSort={handleSort} />
                  </tr>
                </thead>
                <tbody>
                  {paginatedProjects.map(p => (
                    <tr key={p.key}>
                      <td className="project-cell">
                        {p.avatarUrl && <img src={p.avatarUrl} alt="" className="avatar" />}
                        <button
                          onClick={() => {
                            // Navigate to the project's summary page in Jira.
                            openIssuesInJira(p.key, 'all');
                            setSrAnnouncement(`Navigated to ${p.name}`);
                          }}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: '#0052cc',
                            cursor: 'pointer',
                            textDecoration: 'underline',
                            padding: 0,
                            font: 'inherit',
                            fontSize: 'inherit'
                          }}
                          title={`View ${p.name} details`}
                        >
                          {p.name} <small>({p.key})</small>
                        </button>
                      </td>
                      <td>
                        {p.lead ? (
                          <button
                            className="lead-link"
                            onClick={() => {
                              setLeadSearch(p.lead);
                              setSrAnnouncement(`Filtered projects by lead: ${p.lead}`);
                            }}
                            style={{ background: 'none', border: 'none', color: '#0052cc', cursor: 'pointer', textDecoration: 'underline', padding: 0, font: 'inherit' }}
                            title={`Filter projects by ${p.lead}`}
                          >
                            {p.lead}
                          </button>
                        ) : 'Unassigned'}
                      </td>

                      <td>{p.startDate ? formatDate(p.startDate) : '—'}</td>
                      <td>{p.dueDate ? formatDate(p.dueDate) : '—'}</td>

                      {/* ── Total Cell ── */}
                      <td className="stats-cell">
                        <button
                          data-testid={`stats-total-${p.key}`}
                          onClick={() => {
                            openIssuesInJira(p.key, 'all');
                            setSrAnnouncement(`Viewing all issues for ${p.key}`);
                          }}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}
                          title={`View all ${p.total ?? 0} issues for ${p.key}`}
                          aria-label={`View all ${p.total ?? 0} issues for ${p.key}`}
                        >
                          {p.total ?? '…'}
                        </button>
                      </td>

                      {/* ── In Progress Cell ── */}
                      <td className="stats-cell">
                        <button
                          data-testid={`stats-inprogress-${p.key}`}
                          onClick={() => {
                            openIssuesInJira(p.key, 'inProgress');
                            setSrAnnouncement(`Viewing in-progress issues for ${p.key}`);
                          }}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}
                          title={`View ${p.inProgress ?? 0} in-progress issues for ${p.key}`}
                          aria-label={`View ${p.inProgress ?? 0} in-progress issues for ${p.key}`}
                        >
                          {p.inProgress ?? '…'}
                        </button>
                      </td>

                      {/* ── Done Cell ── */}
                      <td className="stats-cell">
                        <button
                          data-testid={`stats-done-${p.key}`}
                          onClick={() => {
                            openIssuesInJira(p.key, 'done');
                            setSrAnnouncement(`Viewing done issues for ${p.key}`);
                          }}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}
                          title={`View ${p.done ?? 0} done issues for ${p.key}`}
                          aria-label={`View ${p.done ?? 0} done issues for ${p.key}`}
                        >
                          {p.done ?? '…'}
                        </button>
                      </td>

                      {/* ── Blocked Cell ── */}
                      <td className="stats-cell" data-testid={`blocked-${p.key}`}>
                        {p.blocked > 0 ? (
                          <button
                            data-testid={`stats-blocked-${p.key}`}
                            onClick={() => {
                              openIssuesInJira(p.key, 'blocked');
                              setSrAnnouncement(`Viewing blocked issues for ${p.key}`);
                            }}
                            className="blocked-flag"
                            style={{
                              background: '#ffe380',
                              color: '#172b4d',
                              border: 'none',
                              cursor: 'pointer',
                              padding: '4px 8px',
                              borderRadius: '3px',
                              fontWeight: 'bold',
                              fontSize: '12px'
                            }}
                            title={`View ${p.blocked} blocked issues for ${p.key}`}
                          >
                            {p.blocked}
                          </button>
                        ) : (
                          <span style={{ color: '#ccc' }}>—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="pagination" style={{ marginTop: '10px', display: 'flex', gap: '5px' }}>
              <button disabled={currentPage === 1} onClick={() => setCurrentPage(p => p - 1)}>Prev</button>
              <button 
                data-testid="pagination-next" 
                disabled={filteredAndSortedProjects.length <= currentPage * 10} 
                onClick={() => setCurrentPage(p => p + 1)}
              >
              Next
            </button>
            </div>
          </section>
        )}

        {activeTab === 'dependencies' && (
          <section className="dependencies-section" id="panel-dependencies" role="tabpanel">
            <h2>Dependencies</h2>
            
            {/* Filter Bar */}
            <div className="filter-bar" style={{ display: 'flex', gap: '15px', alignItems: 'center', padding: '0 20px 10px' }}>
              <div>
                <span>Filter by project:</span>
                {projects.map(p => (
                  <label key={p.key} className="checkbox-label" style={{ marginLeft: '10px' }}>
                    <input
                      type="checkbox"
                      checked={selectedProjects.includes(p.key)}
                      onChange={() => toggleProject(p.key)}
                    /> {p.name}
                  </label>
                ))}
              </div>
              
              {/* Link Type Filter */}
              <select
                data-testid="filter-dependency-type"
                value={depTypeFilter}
                onChange={(e) => setDepTypeFilter(e.target.value)}
                aria-label="Filter by dependency link type"
              >
                <option value="">All Link Types</option>
                {uniqueDepTypes.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>

            {/* Loading / Empty / Content States */}
            {loading ? (
              <p style={{ padding: '0 20px' }}>Loading dependencies…</p>
            ) : (
              <div className="dependency-graph" style={{ padding: '0 20px' }}>
                {filteredDependencies.length === 0 ? (
                  <p>No issues found.</p>
                ) : (
                  filteredDependencies.map(issue => (
                    <div key={issue.id} className="dependency-node" style={{ 
                      border: '1px solid #ddd', 
                      padding: '10px', 
                      marginBottom: '10px',
                      borderRadius: '4px'
                    }}>
                      <strong>{issue.id}</strong> — {issue.title}
                      <div className="node-meta" style={{ fontSize: '12px', color: '#666', marginTop: '5px' }}>
                        <span className={`type-badge ${issue.type}`}>{issue.type}</span>
                        <span className={`status-badge ${issue.statusCategory}`} style={{ marginLeft: '10px' }}>
                          {issue.statusName}
                        </span>
                      </div>
                      {issue.links && issue.links.length > 0 && (
                        <ul className="links-list" style={{ marginTop: '8px', paddingLeft: '20px' }}>
                          {issue.links.map((link, idx) => (
                            <li key={idx}>
                              {link.outward && (
                                <span>
                                  {link.outwardLabel || link.type}: {link.outward}
                                  <span className="dependency-arrow" style={{ padding: '0 5px', color: '#0052cc' }}>→</span>
                                </span>
                              )}
                              {link.inward && (
                                <span>
                                  {link.inwardLabel || link.type}: {link.inward}
                                  <span className="dependency-arrow" style={{ padding: '0 5px', color: '#0052cc' }}>←</span>
                                </span>
                              )}
                              {!link.outward && !link.inward && '—'}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
          </section>
        )}

        {activeTab === 'roadmap' && (
          <section className="roadmap-section" id="panel-roadmap" role="tabpanel">
            <h2>Roadmap</h2>
            
            {/* Project Filter */}
            <div className="filter-bar" style={{ padding: '0 20px 10px' }}>
              <span>Filter by project:</span>
              {projects.map(p => (
                <label key={p.key} className="checkbox-label" style={{ marginLeft: '10px' }}>
                  <input
                    type="checkbox"
                    checked={selectedProjects.includes(p.key)}
                    onChange={() => toggleProject(p.key)}
                  /> {p.name}
                </label>
              ))}
            </div>
            
            {/* Loading / Empty / Content States */}
            {loading ? (
              <p style={{ padding: '0 20px' }}>Loading roadmap…</p>
            ) : (
              <div className="timeline-container" style={{ padding: '0 20px', maxHeight: '400px', overflowY: 'auto' }}>
                <div className="timeline">
                  {processedEpics.length === 0 ? (
                    <p>No epics with dates found.</p>
                  ) : (
                    processedEpics.map(epic => (
                      <div 
                        key={epic.id} 
                        className={`timeline-item epic-bar ${epic.isOverlapping ? 'overlapping' : ''}`} 
                        style={{ 
                          position: 'relative', 
                          margin: '10px 0',
                          padding: '10px',
                          borderLeft: epic.isOverlapping ? '4px solid #ff9900' : '4px solid #0052cc',
                          backgroundColor: epic.isOverlapping ? '#fff8e6' : '#f4f5f7',
                          borderRadius: '4px'
                        }}
                      >
                        <div className="timeline-content">
                          <strong>{epic.id}</strong> {epic.title}
                          <div className="dates" style={{ fontSize: '12px', color: '#666', marginTop: '5px' }}>
                            {epic.startDate && <span>Start: {formatDate(epic.startDate)}</span>}
                            {epic.dueDate && <span style={{ marginLeft: '15px' }}>Due: {formatDate(epic.dueDate)}</span>}
                          </div>
                          <div className="meta" style={{ marginTop: '5px', fontSize: '12px' }}>
                            <span className="project-badge" style={{ 
                              background: '#deebff', color: '#0052cc', 
                              padding: '2px 6px', borderRadius: '3px', marginRight: '8px'
                            }}>
                              {epic.project}
                            </span>
                            <span className={`status-badge ${epic.statusCategory}`} style={{ 
                              background: epic.statusCategory === 'done' ? '#e3fcef' : '#ffe380',
                              color: epic.statusCategory === 'done' ? '#006644' : '#172b4d',
                              padding: '2px 6px', borderRadius: '3px', marginRight: '8px'
                            }}>
                              {epic.statusCategory}
                            </span>
                            {epic.assignee && <span>— {epic.assignee}</span>}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}