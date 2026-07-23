import {
  isTextFieldEntryEdited,
  TextAreaEntry,
  TextFieldEntry,
} from '@bpmn-io/properties-panel';
// ✅ Correct package. Importing useService from '@bpmn-io/properties-panel'
//    yields `undefined`, which made the group throw on every selection and
//    aborted element creation (the red canvas). See bpmn-js-examples.
import { useService } from 'bpmn-js-properties-panel';

export const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;

// With the attribute-based descriptor the values live straight on the
// business object — no extensionElements indirection to manage.
export function getJiraValues(element) {
  const bo = element && element.businessObject;
  const read = (name) => (bo && typeof bo.get === 'function' ? bo.get(name) : bo && bo[name]) || '';
  return {
    issueKey: read('issueKey'),
    confluencePage: read('confluencePage'),
    documentation: read('documentation'),
  };
}

function GroupShell({ label, children }) {
  return (
    <div style={{ padding: '10px 12px', borderBottom: '1px solid #eee' }}>
      <h3 style={{ fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase', margin: '0 0 8px', color: '#42526e' }}>
        {label}
      </h3>
      {children}
    </div>
  );
}

// Editable group (Modeler). Pulls modeling/debounce from the panel's own
// DI container via useService — never from props (the panel doesn't pass a
// `modeler` prop, which is why the old code's edits silently no-op'd).
function LinkedResourcesGroup({ element }) {
  const modeling = useService('modeling');
  const debounce = useService('debounceInput');
  const { issueKey, confluencePage, documentation } = getJiraValues(element);

  const set = (name, value) =>
    modeling.updateProperties(element, { [name]: value || undefined });

  const openInJira = () => {
    if (ISSUE_KEY_PATTERN.test(issueKey)) window.__openIssueInJira?.(issueKey);
  };
  const openInConfluence = () => {
    if (confluencePage) window.__routerOpen?.(confluencePage);
  };

  return (
    <GroupShell label="Linked Resources">
      <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
        <button
          type="button"
          onClick={openInJira}
          disabled={!ISSUE_KEY_PATTERN.test(issueKey)}
          title={ISSUE_KEY_PATTERN.test(issueKey) ? `Open ${issueKey} in Jira` : 'Enter a valid Jira issue key first (e.g. PROJ-123)'}
          style={{ fontSize: '11px', padding: '4px 8px' }}
        >
          Open in Jira
        </button>
        <button
          type="button"
          onClick={openInConfluence}
          disabled={!confluencePage}
          title={confluencePage ? 'Open the linked Confluence page' : 'Enter a Confluence page URL first'}
          style={{ fontSize: '11px', padding: '4px 8px' }}
        >
          Open in Confluence
        </button>
      </div>

      <TextFieldEntry
        id="jiraIssueKey"
        element={element}
        label="Issue Key"
        description="PROJ-123"
        getValue={() => issueKey}
        setValue={(v) => set('issueKey', v)}
        validate={(v) => (v && !ISSUE_KEY_PATTERN.test(v) ? 'Must look like PROJ-123' : undefined)}
        debounce={debounce}
      />
      <TextFieldEntry
        id="jiraConfluencePage"
        element={element}
        label="Confluence URL"
        getValue={() => confluencePage}
        setValue={(v) => set('confluencePage', v)}
        debounce={debounce}
      />
      <TextAreaEntry
        id="jiraDocumentation"
        element={element}
        label="Documentation"
        getValue={() => documentation}
        setValue={(v) => set('documentation', v)}
        debounce={debounce}
      />
    </GroupShell>
  );
}

export default class JiraPropertiesProvider {
  constructor(propertiesPanel) {
    propertiesPanel.registerProvider(500, this);
  }
  getGroups(element) {
    if (!element || element.type === 'label' || element.type === 'root') return [];
    return (groups) => {
      groups.push({ id: 'jira-linked-resources', component: LinkedResourcesGroup, element });
      return groups;
    };
  }
}

// Kept only so nothing that imported it breaks; the Viewer no longer uses it
// (rendering Preact vnodes inside the React tree was the blank-screen bug).
void isTextFieldEntryEdited;