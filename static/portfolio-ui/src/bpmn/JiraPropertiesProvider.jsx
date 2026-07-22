import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
  isTextFieldEntryEdited,
  TextAreaEntry,
  TextFieldEntry,
} from '@bpmn-io/properties-panel';
import { getBusinessObject } from 'bpmn-js/lib/util/ModelUtil';

// Validates a Jira issue key: project key (letters + digits, must start
// with a letter) + dash + numeric issue id, e.g. PROJ-123. The BPMN
// element's bpmn:id is auto-generated and unconstrained, so this lives
// in its own field rather than replacing the bpmn:id.
const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;

// Reads the (at most one) jira:LinkedResources extension on an element.
// We only ever write one per element, but a hand-edited file could
// contain duplicates — taking the first match keeps the rest of the
// code from having to pick a winner every time.
function getLinkedResources(businessObject) {
  const extElements = businessObject.get('extensionElements');
  if (!extElements) return null;
  const values = extElements.get('values') || [];
  return values.find((v) => v.$type === 'jira:LinkedResources') || null;
}

// Edits the jira:LinkedResources extension on an element, creating the
// extension and the wrapping extensionElements container if either is
// missing. Empty string clears the property (otherwise the empty value
// would persist in the XML indefinitely). Pulls modeling + moddle off
// the modeler instance exposed by the BpmnDiagramView parent — the
// provider is constructed once and would otherwise have to be wired
// through a stack of closures to know which modeler it's editing.
function setLinkedResourceProperty(modeler, element, propertyName, value) {
  const modeling = modeler.get('modeling');
  const moddle = modeler.get('moddle');

  const businessObject = getBusinessObject(element);
  let extension = getLinkedResources(businessObject);
  let extensionElements = businessObject.get('extensionElements');

  if (!extension) {
    extension = moddle.create('jira:LinkedResources');
    if (extensionElements) {
      modeling.updateModdleProperties(element, extensionElements, {
        values: [...(extensionElements.get('values') || []), extension],
      });
    } else {
      extensionElements = moddle.create('bpmn:ExtensionElements', {
        values: [extension],
      });
      modeling.updateProperties(element, { extensionElements });
    }
  }

  const nextValue = value === '' ? undefined : value;
  modeling.updateModdleProperties(element, extension, { [propertyName]: nextValue });
}

function Field({ label, value, link, multiline }) {
  if (!value) return null;
  if (link) {
    return h('div', { style: { marginBottom: '6px' } },
      h('div', { style: { fontSize: '11px', color: '#5e6c84', marginBottom: '2px' } }, label),
      h('a', { href: value, target: '_blank', rel: 'noopener noreferrer', style: { fontSize: '12px', color: '#0052cc' } }, value),
    );
  }
  if (multiline) {
    return h('div', { style: { marginBottom: '6px' } },
      h('div', { style: { fontSize: '11px', color: '#5e6c84', marginBottom: '2px' } }, label),
      h('div', { style: { fontSize: '12px', whiteSpace: 'pre-wrap' } }, value),
    );
  }
  return h('div', { style: { marginBottom: '6px' } },
    h('div', { style: { fontSize: '11px', color: '#5e6c84', marginBottom: '2px' } }, label),
    h('div', { style: { fontSize: '12px' } }, value),
  );
}

function GroupShell({ label, children }) {
  return h('div', { style: { padding: '10px 12px', borderBottom: '1px solid #eee' } },
    h('h3', { style: { fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase', margin: '0 0 8px', color: '#42526e' } }, label),
    children,
  );
}

// Editable group — used in the Modeler. Reads + writes the extension
// through the modeler instance so the change flows back into the XML
// the same way any other property edit would.
function LinkedResourcesGroup({ element, modeler }) {
  //  Remove this line:
  // const translate = useService('translate');

  const bo = getBusinessObject(element);
  const ext = getLinkedResources(bo);
  const issueKey = ext?.issueKey || '';
  const confluencePage = ext?.confluencePage || '';
  const documentation = ext?.documentation || '';

  const openInJira = () => {
    if (ISSUE_KEY_PATTERN.test(issueKey)) {
      window.__openIssueInJira?.(issueKey);
    }
  };

  const openInConfluence = () => {
    if (confluencePage) window.__routerOpen?.(confluencePage);
  };

  return h(GroupShell, {
    // ✅ Use plain string instead of translate('Linked Resources')
    label: 'Linked Resources'
  },
    h('div', { style: { display: 'flex', gap: '6px', marginBottom: '10px' } },
      h('button', {
        type: 'button',
        onClick: openInJira,
        disabled: !ISSUE_KEY_PATTERN.test(issueKey),
        title: ISSUE_KEY_PATTERN.test(issueKey)
          ? `Open ${issueKey} in Jira`
          : 'Enter a valid Jira issue key first (e.g. PROJ-123)',
        style: { fontSize: '11px', padding: '4px 8px' },
      }, 'Open in Jira'),
      h('button', {
        type: 'button',
        onClick: openInConfluence,
        disabled: !confluencePage,
        title: confluencePage
          ? 'Open the linked Confluence page'
          : 'Enter a Confluence page URL first',
        style: { fontSize: '11px', padding: '4px 8px' },
      }, 'Open in Confluence'),
    ),
    h(TextFieldEntry, {
      id: 'jiraIssueKey',
      element,
      // ✅ Use plain string
      label: 'Issue Key',
      getValue: () => issueKey,
      setValue: (value) => setLinkedResourceProperty(modeler, element, 'issueKey', value),
      validate: (value) => {
        if (!value) return;
        if (!ISSUE_KEY_PATTERN.test(value)) {
          return 'Must look like PROJ-123 (letters + digits, dash, digits)';
        }
      },
      debounce: 300,
    }),
    h(TextFieldEntry, {
      id: 'jiraConfluencePage',
      element,
      // ✅ Use plain string
      label: 'Confluence URL',
      getValue: () => confluencePage,
      setValue: (value) => setLinkedResourceProperty(modeler, element, 'confluencePage', value),
      debounce: 300,
    }),
    h(TextAreaEntry, {
      id: 'jiraDocumentation',
      element,
      // ✅ Use plain string
      label: 'Documentation',
      getValue: () => documentation,
      setValue: (value) => setLinkedResourceProperty(modeler, element, 'documentation', value),
      debounce: 300,
    }),
  );
}

// Read-only group — used in the Viewer. Same data, no modeler, no
// editing. The Viewer mounts the properties panel as a static
// observer only, which is why the open buttons still work (they go
// through window globals) but the inputs are absent.
function ReadOnlyLinkedResourcesGroup({ element }) {
  const bo = getBusinessObject(element);
  const ext = getLinkedResources(bo);
  const issueKey = ext?.issueKey || '';
  const confluencePage = ext?.confluencePage || '';
  const documentation = ext?.documentation || '';

  const openInJira = () => {
    if (ISSUE_KEY_PATTERN.test(issueKey)) window.__openIssueInJira?.(issueKey);
  };
  const openInConfluence = () => {
    if (confluencePage) window.__routerOpen?.(confluencePage);
  };

  return h(GroupShell, { label: 'Linked Resources' },
    h(Field, { label: 'Issue Key', value: issueKey }),
    h(Field, { label: 'Confluence URL', value: confluencePage, link: true }),
    h(Field, { label: 'Documentation', value: documentation, multiline: true }),
    h('div', { style: { display: 'flex', gap: '6px', marginTop: '8px' } },
      h('button', {
        type: 'button',
        onClick: openInJira,
        disabled: !ISSUE_KEY_PATTERN.test(issueKey),
        style: { fontSize: '11px', padding: '4px 8px' },
      }, 'Open in Jira'),
      h('button', {
        type: 'button',
        onClick: openInConfluence,
        disabled: !confluencePage,
        style: { fontSize: '11px', padding: '4px 8px' },
      }, 'Open in Confluence'),
    ),
  );
}

// Default export is the Provider class. The Viewer pulls in the
// read-only group component separately (see BpmnDiagramView), so it
// doesn't need a Provider instance — just the renderer.
export default class JiraPropertiesProvider {
  constructor(propertiesPanel) {
    propertiesPanel.registerProvider(500, this);
  }

  getGroups(element) {
    // Hide the group for non-element selections (diagram background,
    // pool labels) — otherwise the panel would show empty rows that
    // don't do anything useful.
    if (!element || element.type === 'label' || element.type === 'root') {
      return [];
    }
    return (groups) => {
      groups.push({
        id: 'jira-linked-resources',
        component: LinkedResourcesGroup,
        element,
      });
      return groups;
    };
  }
}

// Exposed for the Viewer to mount in its static panel. The Viewer
// never runs the modeling service, so the editable form would no-op
// anyway — better to show the read-only variant than render inputs
// that look editable but silently drop changes.
export { ReadOnlyLinkedResourcesGroup };

// isTextFieldEntryEdited is part of the standard entry toolkit; kept
// imported so future enhancements (e.g. a "copy issue key" affordance
// that needs to know when the field has been edited) don't have to
// re-import it. Suppresses the unused-var warning without a noisy
// eslint-disable comment.
void isTextFieldEntryEdited;
