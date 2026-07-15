import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke, router } from '@forge/bridge';
import { Network, DataSet } from 'vis-network/standalone';
import { jsPDF } from 'jspdf';
import 'vis-network/styles/vis-network.css';
import './App.css';

const TABS = ['projects', 'dependencies', 'roadmap', 'summary'];

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

// Opens a single issue in the Jira issue view. Unlike project-level URLs
// (which vary by project type — see openIssuesInJira's comment), /browse/
// is a universal permalink that works for every issue and project type.
function openIssueInJira(issueKey) {
  router.open(`/browse/${encodeURIComponent(issueKey)}`);
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

// Builds a one-page (or more, if content overflows) executive PDF from the
// same deterministic summary data already shown in the Summary tab. Pure
// client-side generation via jsPDF — no server round-trip, no AI API cost.
function exportSummaryAsPDF(summary) {
  const doc = new jsPDF();
  const marginX = 15;
  const pageBottom = 280;
  let y = 20;

  const ensureRoom = (lineHeight) => {
    if (y + lineHeight > pageBottom) {
      doc.addPage();
      y = 20;
    }
  };

  doc.setFontSize(18);
  doc.text('Portfolio Summary', marginX, y);
  y += 7;
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Generated ${new Date().toLocaleDateString()}`, marginX, y);
  doc.setTextColor(0);
  y += 12;

  // Key numbers
  doc.setFontSize(12);
  const stats = [
    ['Projects', summary.totalProjects],
    ['Total Issues', summary.totalIssues],
    ['Complete', `${summary.overallCompletionPct}%`],
    ['Blocked', summary.totalBlocked],
    ['Overdue Epics', summary.totalOverdueEpics],
  ];
  stats.forEach(([label, value]) => {
    ensureRoom(7);
    doc.text(`${label}: ${value}`, marginX, y);
    y += 7;
  });
  y += 6;

  // Narrative — same deterministic sentences shown on screen
  doc.setFontSize(11);
  summary.paragraphs.forEach(para => {
    const lines = doc.splitTextToSize(para, 180);
    lines.forEach(line => {
      ensureRoom(6);
      doc.text(line, marginX, y);
      y += 6;
    });
    y += 3;
  });

  // Highest-risk projects
  if (summary.topRisks.length > 0) {
    y += 4;
    ensureRoom(9);
    doc.setFontSize(13);
    doc.text('Highest-Risk Projects', marginX, y);
    y += 8;
    doc.setFontSize(11);
    summary.topRisks.forEach(p => {
      ensureRoom(7);
      doc.text(`${p.name} (${p.key}) - risk ${p.riskScore}/100`, marginX, y);
      y += 7;
    });
  }

  doc.save(`portfolio-summary-${new Date().toISOString().slice(0, 10)}.pdf`);
}

// Visual node-edge diagram of dependency relationships, built with
// vis-network (already a project dependency, previously unused). A flat
// list of cards is functionally correct but doesn't answer the actual
// question a "Dependencies" view exists to answer at a glance: which
// issues are blocking chains, and where. A diagram does that directly.
//
// This is purely additive — the existing card list stays right below it
// as the accessible, screen-reader-friendly detail view; the graph is a
// visual overview layered on top, not a replacement.
function DependencyGraph({ issues, circularPath, onNodeClick }) {
  const containerRef = useRef(null);
  const networkRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current || issues.length === 0) return undefined;

    const cycleIds = new Set(circularPath || []);
    const issueIds = new Set(issues.map(i => i.id));

    const statusColor = (statusCategory) => {
      if (statusCategory === 'done') return '#36B37E';
      if (statusCategory === 'indeterminate') return '#0052CC';
      return '#97A0AF'; // 'new' / anything else
    };

    const nodes = new DataSet(
      issues.map(issue => {
        const inCycle = cycleIds.has(issue.id);
        const color = statusColor(issue.statusCategory);
        const shortTitle = issue.title && issue.title.length > 24
          ? `${issue.title.slice(0, 24)}…`
          : issue.title;
        return {
          id: issue.id,
          label: `${issue.id}\n${shortTitle || ''}`,
          shape: 'box',
          color: {
            background: color,
            border: inCycle ? '#DE350B' : color,
            highlight: { background: color, border: '#091E42' },
          },
          borderWidth: inCycle ? 3 : 1,
          font: { color: '#fff', size: 12, multi: false, align: 'center' },
          margin: 8,
        };
      })
    );

    // Only outward links, and only between issues actually in this view —
    // same outward-only convention used by the cycle detector, so the
    // diagram never double-draws a single relationship as two edges.
    const edgeList = [];
    issues.forEach(issue => {
      (issue.links || []).forEach(link => {
        if (link.outward && issueIds.has(link.outward)) {
          const inCycleEdge = cycleIds.has(issue.id) && cycleIds.has(link.outward);
          edgeList.push({
            from: issue.id,
            to: link.outward,
            label: link.outwardLabel || link.type,
            arrows: 'to',
            color: { color: inCycleEdge ? '#DE350B' : '#97A0AF', highlight: '#091E42' },
            width: inCycleEdge ? 2.5 : 1,
            font: { size: 10, align: 'top', color: '#666' },
            smooth: { type: 'cubicBezier', roundness: 0.4 },
          });
        }
      });
    });

    const data = { nodes, edges: new DataSet(edgeList) };
    const options = {
      layout: {
        hierarchical: {
          enabled: true,
          direction: 'LR',
          sortMethod: 'directed',
          levelSeparation: 180,
          nodeSpacing: 110,
        },
      },
      physics: false,
      interaction: { hover: true, tooltipDelay: 200, dragNodes: true, zoomView: true },
      nodes: { shape: 'box', margin: 8 },
    };

    networkRef.current = new Network(containerRef.current, data, options);
    networkRef.current.on('click', (params) => {
      if (params.nodes.length > 0) {
        onNodeClick(params.nodes[0]);
      }
    });

    return () => {
      networkRef.current?.destroy();
      networkRef.current = null;
    };
  }, [issues, circularPath, onNodeClick]);

  if (issues.length === 0) return null;

  return (
    <div style={{ padding: '0 20px' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '6px' }}>
        <button
          onClick={() => networkRef.current?.fit({ animation: { duration: 300, easingFunction: 'easeInOutQuad' } })}
          style={{ fontSize: '12px' }}
          aria-label="Fit graph to screen"
        >
          Fit to Screen
        </button>
      </div>
      <div
        ref={containerRef}
        data-testid="dependency-graph-canvas"
        style={{ height: '360px', border: '1px solid #ddd', borderRadius: '4px', marginBottom: '10px', background: '#fafbfc' }}
        role="img"
        aria-label="Dependency graph diagram showing blocking relationships between issues. See the list below for an accessible, text-based view of the same relationships."
      />
      <div style={{ display: 'flex', gap: '16px', fontSize: '12px', color: '#666', marginBottom: '20px', flexWrap: 'wrap', alignItems: 'center' }}>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#36B37E', marginRight: 4, borderRadius: 2 }} />Done</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#0052CC', marginRight: 4, borderRadius: 2 }} />In Progress</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#97A0AF', marginRight: 4, borderRadius: 2 }} />To Do</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, border: '2px solid #DE350B', marginRight: 4, borderRadius: 2 }} />In a circular dependency</span>
        <span>Arrows follow each link's direction (label shows the relationship)</span>
        <span>Click a node to open that issue</span>
      </div>
    </div>
  );
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
  const [depSearchQuery, setDepSearchQuery] = useState('');
  const [depStatusFilter, setDepStatusFilter] = useState('');
  const [depOnlyLinked, setDepOnlyLinked] = useState(false);
  const [roadmapSearchQuery, setRoadmapSearchQuery] = useState('');
  const [depCurrentPage, setDepCurrentPage] = useState(1);
  const [roadmapCurrentPage, setRoadmapCurrentPage] = useState(1);
  const [roadmapDateFilter, setRoadmapDateFilter] = useState({ start: '', end: '' });
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

  // The Summary tab synthesizes both dependency and roadmap data, so it
  // fetches both in parallel rather than reusing loadDependencies/loadEpics
  // sequentially (which would each toggle the shared `loading` flag
  // independently and cause a flicker when one finishes before the other).
  async function loadSummaryData() {
    setLoading(true);
    try {
      const keys = selectedProjects.length > 0 ? selectedProjects : projects.map(p => p.key);
      if (keys.length === 0) {
        setDependencies([]);
        setEpics([]);
        return;
      }
      const [depsData, epicsData] = await Promise.all([
        invokeWithRetry('getIssueDependencies', { projectKeys: keys }),
        invokeWithRetry('getRoadmapEpics', { projectKeys: keys }),
      ]);
      setDependencies(depsData || []);
      setEpics(epicsData || []);
    } catch (e) {
      setError('Summary load error: ' + e.message);
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
    } else if (activeTab === 'summary') {
      loadSummaryData();
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
    if (activeTab === 'summary') loadSummaryData();
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
        
        // Normalize in case the user (or a date-input quirk) picked an
        // inverted range (end before start) — without this, the two
        // one-sided overlap checks below become strictly weaker than
        // intended and let projects through that shouldn't match.
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
        case 'riskScore':
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
    let result = dependencies;

    if (depTypeFilter) {
      result = result.filter(d => d.links?.some(l => l.type === depTypeFilter));
    }

    if (depSearchQuery) {
      const q = depSearchQuery.toLowerCase();
      result = result.filter(d =>
        d.id.toLowerCase().includes(q) || (d.title && d.title.toLowerCase().includes(q))
      );
    }

    if (depStatusFilter) {
      result = result.filter(d => d.statusCategory === depStatusFilter);
    }

    if (depOnlyLinked) {
      result = result.filter(d => d.links && d.links.length > 0);
    }

    return result;
  }, [dependencies, depTypeFilter, depSearchQuery, depStatusFilter, depOnlyLinked]);

  // Paginates the accessible card list only — the graph above it keeps
  // seeing the full filtered set, since cutting a dependency graph off at
  // a page boundary would silently hide real edges to issues on other
  // pages, which defeats the point of a dependency diagram.
  const paginatedDependencies = useMemo(() => {
    const startIndex = (depCurrentPage - 1) * 10;
    return filteredDependencies.slice(startIndex, startIndex + 10);
  }, [filteredDependencies, depCurrentPage]);

  useEffect(() => {
    setDepCurrentPage(1);
  }, [depTypeFilter, depSearchQuery, depStatusFilter, depOnlyLinked, selectedProjects]);

  // Distinct status categories actually present, for the Dependencies status filter.
  const uniqueDepStatusCategories = useMemo(() => {
    return [...new Set(dependencies.map(d => d.statusCategory).filter(Boolean))];
  }, [dependencies]);

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

  // Which projects have at least one issue in the detected cycle. Only
  // known once dependency data has been fetched (i.e. after visiting the
  // Dependencies tab) — this progressively enhances the Risk column rather
  // than requiring an extra full-graph fetch just for the Projects tab.
  const projectsInCircularDependency = useMemo(() => {
    if (!circularDependencyPath) return new Set();
    const cycleIds = new Set(circularDependencyPath);
    const projectKeys = dependencies
      .filter(issue => cycleIds.has(issue.id))
      .map(issue => issue.project);
    return new Set(projectKeys);
  }, [circularDependencyPath, dependencies]);

  const processedEpics = useMemo(() => {
    return epics.map((epic, i, arr) => {
       const isOverlapping = arr.some((other, j) => {
          if (i === j || !epic.startDate || !epic.dueDate || !other.startDate || !other.dueDate) return false;
          return (epic.startDate <= other.dueDate) && (epic.dueDate >= other.startDate);
       });
       return { ...epic, isOverlapping };
    });
  }, [epics]);

  // Search/date filters for what's actually *displayed* in the Roadmap tab.
  // Deliberately kept separate from processedEpics itself — the overlap
  // detection above (and the portfolio summary's overlap count) need to see
  // every epic regardless of what the user currently has filtered in view,
  // or a "hide the other overlapping epic" filter would silently make a
  // real overlap invisible instead of just decluttering the timeline.
  const filteredRoadmapEpics = useMemo(() => {
    let result = processedEpics;

    if (roadmapSearchQuery) {
      const q = roadmapSearchQuery.toLowerCase();
      result = result.filter(e =>
        e.id.toLowerCase().includes(q) || (e.title && e.title.toLowerCase().includes(q))
      );
    }

    if (roadmapDateFilter.start && roadmapDateFilter.end) {
      const rawStart = new Date(roadmapDateFilter.start);
      const rawEnd = new Date(roadmapDateFilter.end);
      const filterStart = rawStart <= rawEnd ? rawStart : rawEnd;
      const filterEnd = rawStart <= rawEnd ? rawEnd : rawStart;
      result = result.filter(e => {
        if (!e.startDate && !e.dueDate) return true;
        const eStart = e.startDate ? new Date(e.startDate) : null;
        const eEnd = e.dueDate ? new Date(e.dueDate) : null;
        if (eEnd && eEnd < filterStart) return false;
        if (eStart && eStart > filterEnd) return false;
        return true;
      });
    }

    return result;
  }, [processedEpics, roadmapSearchQuery, roadmapDateFilter]);

  const paginatedRoadmapEpics = useMemo(() => {
    const startIndex = (roadmapCurrentPage - 1) * 10;
    return filteredRoadmapEpics.slice(startIndex, startIndex + 10);
  }, [filteredRoadmapEpics, roadmapCurrentPage]);

  useEffect(() => {
    setRoadmapCurrentPage(1);
  }, [roadmapSearchQuery, roadmapDateFilter, selectedProjects]);

  // ── Portfolio Summary ────────────────────────────────────────────────
  // Deterministic, template-based text generation from data already in
  // state — no external AI API call (and therefore no per-request cost).
  // Every clause is conditional on the underlying data actually being
  // present, so the summary reads naturally whether the portfolio is
  // healthy or has multiple issues flagged.
  const portfolioSummary = useMemo(() => {
    const totalProjects = projectStats.length;
    const totalIssues = projectStats.reduce((sum, p) => sum + (p.total || 0), 0);
    const totalDone = projectStats.reduce((sum, p) => sum + (p.done || 0), 0);
    const totalBlocked = projectStats.reduce((sum, p) => sum + (p.blocked || 0), 0);
    const totalOverdueEpics = projectStats.reduce((sum, p) => sum + (p.overdueEpics || 0), 0);
    const overallCompletionPct = totalIssues > 0 ? Math.round((100 * totalDone) / totalIssues) : 0;
    const overlappingEpicsCount = processedEpics.filter(e => e.isOverlapping).length;

    const topRisks = projectStats
      .filter(p => typeof p.riskScore === 'number' && p.riskScore > 0)
      .sort((a, b) => b.riskScore - a.riskScore)
      .slice(0, 3);

    const paragraphs = [];

    paragraphs.push(
      totalProjects === 0
        ? 'No projects were found in this portfolio.'
        : `Across ${totalProjects} project${totalProjects === 1 ? '' : 's'}, the portfolio has ${totalIssues} tracked issue${totalIssues === 1 ? '' : 's'}, ${overallCompletionPct}% complete (${totalDone} done). ${totalBlocked} issue${totalBlocked === 1 ? ' is' : 's are'} currently blocked.`
    );

    if (topRisks.length > 0) {
      const [top, ...rest] = topRisks;
      const topClauses = [];
      if (top.overdueEpics > 0) topClauses.push(`${top.overdueEpics} overdue epic${top.overdueEpics === 1 ? '' : 's'}`);
      if (top.blocked > 0) topClauses.push(`${top.blocked} blocked issue${top.blocked === 1 ? '' : 's'}`);
      const topClauseText = topClauses.length > 0 ? ` (driven by ${topClauses.join(' and ')})` : '';
      const restText = rest.length > 0
        ? ` Other elevated-risk projects: ${rest.map(p => `${p.name} (${p.riskScore})`).join(', ')}.`
        : '';
      paragraphs.push(
        `The highest-risk project is ${top.name} (${top.key}) with a risk score of ${top.riskScore}/100${topClauseText}.${restText}`
      );
    } else if (totalProjects > 0) {
      paragraphs.push('No projects are currently flagged as high risk.');
    }

    if (hasCircularDependency) {
      paragraphs.push(
        `A circular dependency was detected: ${circularDependencyPath.join(' → ')}. None of the issues in this cycle can be completed first — it should be resolved by removing or re-scoping one of the links.`
      );
    }

    if (totalOverdueEpics > 0) {
      paragraphs.push(
        `${totalOverdueEpics} epic${totalOverdueEpics === 1 ? ' is' : 's are'} past due and not yet complete across the portfolio.`
      );
    }

    if (overlappingEpicsCount > 0) {
      paragraphs.push(
        `${overlappingEpicsCount} epic${overlappingEpicsCount === 1 ? '' : 's'} have overlapping timelines, which may indicate scheduling conflicts or resource contention.`
      );
    }

    return {
      paragraphs,
      totalProjects,
      totalIssues,
      totalDone,
      totalBlocked,
      totalOverdueEpics,
      overallCompletionPct,
      overlappingEpicsCount,
      topRisks,
    };
  }, [projectStats, processedEpics, hasCircularDependency, circularDependencyPath]);

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

      <div className="global-filters" style={{ display: 'flex', gap: '15px', padding: '10px 20px' }}>
        {activeTab === 'projects' && (
          <>
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
          </>
        )}
        <button onClick={() => setLayoutDir(prev => prev === 'ltr' ? 'rtl' : 'ltr')} style={{ fontSize: '11px' }}>
          Toggle Language Direction
        </button>
      </div>

      {activeTab === 'projects' && (
        <div className="advanced-filters" style={{ display: 'flex', gap: '10px', padding: '0 20px 10px', flexWrap: 'wrap' }}>
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
            onChange={(e) => setDateFilter(prev => ({ ...prev, start: e.target.value }))}
            placeholder="Start date"
            aria-label="Filter by start date from"
            max={dateFilter.end || undefined}
          />
          <span style={{ alignSelf: 'center' }}>to</span>
          <input
            type="date"
            value={dateFilter.end}
            onChange={(e) => setDateFilter(prev => ({ ...prev, end: e.target.value }))}
            placeholder="End date"
            aria-label="Filter by start date to"
            min={dateFilter.start || undefined}
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
        </div>
      )}

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
                    <SortableHeader label="Risk"        sortKey="riskScore"  currentSort={sortBy} order={sortOrder} onSort={handleSort} />
                  </tr>
                </thead>
                <tbody>
                  {paginatedProjects.map(p => (
                    <tr key={p.key}>
                      <td className="project-cell">
                        {p.avatarUrl && <img src={p.avatarUrl} alt="" className="avatar" />}
                        <button
                          onClick={() => {
                            // Open this project's issues in the Jira issue
                            // navigator. (A generic "project summary" URL
                            // varies by project type — software/business/
                            // service-desk/product-discovery projects all
                            // use different paths — and Forge's router
                            // doesn't expose a NavigationLocation target for
                            // it, so we route to the one destination that's
                            // guaranteed to exist for every project type.)
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

                      {/* ── Risk Cell ── */}
                      <td className="stats-cell" data-testid={`risk-${p.key}`}>
                        {typeof p.riskScore === 'number' ? (
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                              padding: '4px 8px',
                              borderRadius: '3px',
                              fontWeight: 'bold',
                              fontSize: '12px',
                              background: p.riskScore >= 67 ? '#ffebe6' : p.riskScore >= 34 ? '#fff8e6' : '#e3fcef',
                              color: p.riskScore >= 67 ? '#bf2600' : p.riskScore >= 34 ? '#974f0c' : '#006644',
                            }}
                            title={`Risk score ${p.riskScore}/100 — based on blocked-issue ratio and overdue epics (${p.overdueEpics ?? 0} overdue)${projectsInCircularDependency.has(p.key) ? '. This project has issues in a circular dependency.' : ''}`}
                          >
                            {p.riskScore}
                            {projectsInCircularDependency.has(p.key) && (
                              <span aria-label="Involved in a circular dependency">⚠</span>
                            )}
                          </span>
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
            <div className="filter-bar" style={{ display: 'flex', gap: '15px', alignItems: 'center', padding: '0 20px 10px', flexWrap: 'wrap' }}>
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

              {/* Search by issue key or title */}
              <input
                type="text"
                data-testid="search-dependencies"
                placeholder="Search issues…"
                value={depSearchQuery}
                onChange={(e) => setDepSearchQuery(e.target.value)}
                aria-label="Search dependencies by issue key or title"
              />

              {/* Status Filter */}
              <select
                data-testid="filter-dependency-status"
                value={depStatusFilter}
                onChange={(e) => setDepStatusFilter(e.target.value)}
                aria-label="Filter by issue status"
              >
                <option value="">All Statuses</option>
                {uniqueDepStatusCategories.map(s => (
                  <option key={s} value={s}>{s === 'indeterminate' ? 'In Progress' : s === 'new' ? 'To Do' : s === 'done' ? 'Done' : s}</option>
                ))}
              </select>

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

              {/* Only issues with dependencies — cuts noise on the graph/list */}
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={depOnlyLinked}
                  onChange={(e) => setDepOnlyLinked(e.target.checked)}
                  data-testid="filter-only-linked"
                /> Only show issues with dependencies
              </label>
            </div>

            {/* Loading / Empty / Content States */}
            {loading ? (
              <p style={{ padding: '0 20px' }}>Loading dependencies…</p>
            ) : (
              <>
                <DependencyGraph
                  issues={filteredDependencies}
                  circularPath={circularDependencyPath}
                  onNodeClick={openIssueInJira}
                />
                <div className="dependency-graph" style={{ padding: '0 20px' }}>
                {filteredDependencies.length === 0 ? (
                  <p>No issues found.</p>
                ) : (
                  paginatedDependencies.map(issue => (
                    <div key={issue.id} className="dependency-node" style={{ 
                      border: '1px solid #ddd', 
                      padding: '10px', 
                      marginBottom: '10px',
                      borderRadius: '4px'
                    }}>
                      <button
                        onClick={() => openIssueInJira(issue.id)}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: '#0052cc',
                          cursor: 'pointer',
                          textDecoration: 'underline',
                          padding: 0,
                          font: 'inherit',
                          fontWeight: 'bold',
                        }}
                        aria-label={`Open ${issue.id} in Jira`}
                      >
                        {issue.id}
                      </button> — {issue.title}
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
                                  {link.outwardLabel || link.type}:{' '}
                                  <button
                                    onClick={() => openIssueInJira(link.outward)}
                                    style={{ background: 'none', border: 'none', color: '#0052cc', cursor: 'pointer', textDecoration: 'underline', padding: 0, font: 'inherit' }}
                                    aria-label={`Open ${link.outward} in Jira`}
                                  >
                                    {link.outward}
                                  </button>
                                  <span className="dependency-arrow" style={{ padding: '0 5px', color: '#0052cc' }}>→</span>
                                </span>
                              )}
                              {link.inward && (
                                <span>
                                  {link.inwardLabel || link.type}:{' '}
                                  <button
                                    onClick={() => openIssueInJira(link.inward)}
                                    style={{ background: 'none', border: 'none', color: '#0052cc', cursor: 'pointer', textDecoration: 'underline', padding: 0, font: 'inherit' }}
                                    aria-label={`Open ${link.inward} in Jira`}
                                  >
                                    {link.inward}
                                  </button>
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
                {filteredDependencies.length > 10 && (
                  <div style={{ padding: '10px 20px', display: 'flex', gap: '10px', alignItems: 'center' }}>
                    <button disabled={depCurrentPage === 1} onClick={() => setDepCurrentPage(p => p - 1)}>Prev</button>
                    <span style={{ fontSize: '12px', color: '#666' }}>
                      Page {depCurrentPage} of {Math.ceil(filteredDependencies.length / 10)}
                    </span>
                    <button
                      disabled={filteredDependencies.length <= depCurrentPage * 10}
                      onClick={() => setDepCurrentPage(p => p + 1)}
                    >
                      Next
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {activeTab === 'roadmap' && (
          <section className="roadmap-section" id="panel-roadmap" role="tabpanel">
            <h2>Roadmap</h2>
            
            {/* Project Filter */}
            <div className="filter-bar" style={{ padding: '0 20px 10px', display: 'flex', gap: '15px', alignItems: 'center', flexWrap: 'wrap' }}>
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

              {/* Search by epic key or title */}
              <input
                type="text"
                data-testid="search-roadmap"
                placeholder="Search epics…"
                value={roadmapSearchQuery}
                onChange={(e) => setRoadmapSearchQuery(e.target.value)}
                aria-label="Search roadmap by epic key or title"
              />

              {/* Date range — the one filter that's genuinely core to a
                  roadmap/timeline view, unlike the Projects tab's version
                  of this control which doesn't apply here at all. */}
              <input
                type="date"
                value={roadmapDateFilter.start}
                onChange={(e) => setRoadmapDateFilter(prev => ({ ...prev, start: e.target.value }))}
                aria-label="Filter roadmap by start date from"
                max={roadmapDateFilter.end || undefined}
              />
              <span>to</span>
              <input
                type="date"
                value={roadmapDateFilter.end}
                onChange={(e) => setRoadmapDateFilter(prev => ({ ...prev, end: e.target.value }))}
                aria-label="Filter roadmap by start date to"
                min={roadmapDateFilter.start || undefined}
              />
              {(roadmapSearchQuery || roadmapDateFilter.start || roadmapDateFilter.end) && (
                <button
                  onClick={() => {
                    setRoadmapSearchQuery('');
                    setRoadmapDateFilter({ start: '', end: '' });
                  }}
                  style={{ fontSize: '12px' }}
                >
                  Clear Filters
                </button>
              )}
            </div>
            
            {/* Loading / Empty / Content States */}
            {loading ? (
              <p style={{ padding: '0 20px' }}>Loading roadmap…</p>
            ) : (
              <div className="timeline-container" style={{ padding: '0 20px', maxHeight: '400px', overflowY: 'auto' }}>
                <div className="timeline">
                  {filteredRoadmapEpics.length === 0 ? (
                    <p>No epics with dates found.</p>
                  ) : (
                    paginatedRoadmapEpics.map(epic => (
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
                          <button
                            onClick={() => openIssueInJira(epic.id)}
                            style={{
                              background: 'none',
                              border: 'none',
                              color: '#0052cc',
                              cursor: 'pointer',
                              textDecoration: 'underline',
                              padding: 0,
                              font: 'inherit',
                              fontWeight: 'bold',
                            }}
                            aria-label={`Open ${epic.id} in Jira`}
                          >
                            {epic.id}
                          </button> {epic.title}
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
                {filteredRoadmapEpics.length > 10 && (
                  <div style={{ padding: '10px 20px', display: 'flex', gap: '10px', alignItems: 'center' }}>
                    <button disabled={roadmapCurrentPage === 1} onClick={() => setRoadmapCurrentPage(p => p - 1)}>Prev</button>
                    <span style={{ fontSize: '12px', color: '#666' }}>
                      Page {roadmapCurrentPage} of {Math.ceil(filteredRoadmapEpics.length / 10)}
                    </span>
                    <button
                      disabled={filteredRoadmapEpics.length <= roadmapCurrentPage * 10}
                      onClick={() => setRoadmapCurrentPage(p => p + 1)}
                    >
                      Next
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {activeTab === 'summary' && (
          <section className="summary-section" id="panel-summary" role="tabpanel">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 20px' }}>
              <h2 style={{ margin: 0 }}>Portfolio Summary</h2>
              <button
                onClick={() => exportSummaryAsPDF(portfolioSummary)}
                disabled={loading || portfolioSummary.totalProjects === 0}
                data-testid="export-summary-pdf"
              >
                Export as PDF
              </button>
            </div>

            {loading ? (
              <p style={{ padding: '0 20px' }}>Loading summary…</p>
            ) : (
              <div style={{ padding: '0 20px', maxWidth: '760px' }}>
                {/* Key numbers at a glance */}
                <div
                  data-testid="summary-stat-grid"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
                    gap: '12px',
                    marginBottom: '24px',
                  }}
                >
                  {[
                    { label: 'Projects', value: portfolioSummary.totalProjects },
                    { label: 'Total Issues', value: portfolioSummary.totalIssues },
                    { label: 'Complete', value: `${portfolioSummary.overallCompletionPct}%` },
                    { label: 'Blocked', value: portfolioSummary.totalBlocked },
                    { label: 'Overdue Epics', value: portfolioSummary.totalOverdueEpics },
                  ].map(stat => (
                    <div key={stat.label} style={{ border: '1px solid #ddd', borderRadius: '4px', padding: '10px', textAlign: 'center' }}>
                      <div style={{ fontSize: '22px', fontWeight: 'bold', color: '#0052cc' }}>{stat.value}</div>
                      <div style={{ fontSize: '12px', color: '#666' }}>{stat.label}</div>
                    </div>
                  ))}
                </div>

                {/* Narrative summary — deterministic, template-generated from
                    the same data already on screen elsewhere in the app.
                    No external AI call, so no per-request cost. */}
                <div data-testid="summary-narrative">
                  {portfolioSummary.paragraphs.map((para, idx) => (
                    <p key={idx} style={{ lineHeight: 1.6, marginBottom: '12px' }}>{para}</p>
                  ))}
                </div>

                {/* Top-risk projects, each clickable through to its issues */}
                {portfolioSummary.topRisks.length > 0 && (
                  <div style={{ marginTop: '20px' }}>
                    <h3 style={{ fontSize: '14px', marginBottom: '8px' }}>Highest-Risk Projects</h3>
                    <ul style={{ paddingLeft: '20px' }}>
                      {portfolioSummary.topRisks.map(p => (
                        <li key={p.key} style={{ marginBottom: '4px' }}>
                          <button
                            onClick={() => openIssuesInJira(p.key, 'all')}
                            style={{ background: 'none', border: 'none', color: '#0052cc', cursor: 'pointer', textDecoration: 'underline', padding: 0, font: 'inherit' }}
                          >
                            {p.name} ({p.key})
                          </button>
                          {' — risk '}{p.riskScore}/100
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}