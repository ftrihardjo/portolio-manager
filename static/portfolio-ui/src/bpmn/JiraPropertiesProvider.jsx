import { h } from 'preact';
import {
  isTextFieldEntryEdited,
  TextAreaEntry,
  TextFieldEntry,
} from '@bpmn-io/properties-panel';
// useService resolves against the modeler's injector that the properties
// panel is mounted into — this is the documented way for a group/entry to
// reach modeling/moddle. (Importing it from '@bpmn-io/properties-panel'
// yields undefined; it must come from 'bpmn-js-properties-panel'.)
import { useService } from 'bpmn-js-properties-panel';
import { getBusinessObject } from 'bpmn-js/lib/util/ModelUtil';

export const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;

const shellStyle = { padding: '10px 12px', borderBottom: '1px solid #eee' };
const headStyle = { fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase', margin: '0 0 8px', color: '#42526e' };
const btnStyle = { fontSize: '11px', padding: '4px 8px' };

// Stable per-field debounce. The entries expect a *function*
// (fn) => debouncedFn — passing a number (e.g. 300) silently breaks them.
const _debounceCache = {};
function debounceFor(id) {
  if (!_debounceCache[id]) {
    let t;
    _debounceCache[id] = (fn) => (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), 300);
    };
  }
  return _debounceCache[id];
}

// Read the (at most one) jira:LinkedResources extension. Exported because
// the Viewer's read-only panel and the editor both need it.
export function getLinkedResources(bo) {
  if (!bo || typeof bo.get !== 'function') return null;
  const ext = bo.get('extensionElements');
  const values = (ext && typeof ext.get === 'function' ? ext.get('values') : null) || [];
  return values.find((v) => v.$type === 'jira:LinkedResources') || null;
}

// Create the extension + its extensionElements wrapper if missing, then
// write one property. Empty string clears it (otherwise "" persists forever).
function setLinkedResourceProperty(modeling, moddle, element, name, value) {
  const bo = getBusinessObject(element);
  let ext = getLinkedResources(bo);
  let extEls = bo.get('extensionElements');
  if (!ext) {
    ext = moddle.create('jira:LinkedResources');
    if (extEls) {
      modeling.updateModdleProperties(element, extEls, {
        values: [...(extEls.get('values') || []), ext],
      });
    } else {
      extEls = moddle.create('bpmn:ExtensionElements', { values: [ext] });
      modeling.updateProperties(element, { extensionElements: extEls });
    }
  }
  modeling.updateModdleProperties(element, ext, {
    [name]: value === '' ? undefined : value,
  });
}

// Editable group (Modeler). Pulls modeling/moddle from the panel's DI so the
// write actually flows into the XML — the previous version had no handle on
// the modeler, so edits never persisted.
function LinkedResourcesGroup({ element }) {
  const modeling = useService('modeling');
  const moddle = useService('moddle');
  const ext = getLinkedResources(getBusinessObject(element)) || {};
  const issueKey = ext.issueKey || '';
  const confluencePage = ext.confluencePage || '';
  const documentation = ext.documentation || '';
  const set = (n, v) => setLinkedResourceProperty(modeling, moddle, element, n, v);

  return h('div', { style: shellStyle },
    h('h3', { style: headStyle }, 'Linked Resources'),
    h('div', { style: { display: 'flex', gap: '6px', marginBottom: '10px' } },
      h('button', {
        type: 'button',
        onClick: () => { if (ISSUE_KEY_PATTERN.test(issueKey)) window.__openIssueInJira?.(issueKey); },
        disabled: !ISSUE_KEY_PATTERN.test(issueKey),
        style: btnStyle,
        title: ISSUE_KEY_PATTERN.test(issueKey) ? `Open ${issueKey} in Jira` : 'Enter a valid issue key first (e.g. PROJ-123)',
      }, 'Open in Jira'),
      h('button', {
        type: 'button',
        onClick: () => { if (confluencePage) window.__routerOpen?.(confluencePage); },
        disabled: !confluencePage,
        style: btnStyle,
        title: confluencePage ? 'Open the linked Confluence page' : 'Enter a Confluence page URL first',
      }, 'Open in Confluence'),
    ),
    h(TextFieldEntry, {
      id: 'jiraIssueKey', element, label: 'Issue Key', description: 'PROJ-123',
      getValue: () => issueKey,
      setValue: (v) => set('issueKey', v),
      validate: (v) => (v && !ISSUE_KEY_PATTERN.test(v)) ? 'Must look like PROJ-123' : undefined,
      debounce: debounceFor('jiraIssueKey'),
    }),
    h(TextFieldEntry, {
      id: 'jiraConfluencePage', element, label: 'Confluence URL',
      getValue: () => confluencePage,
      setValue: (v) => set('confluencePage', v),
      debounce: debounceFor('jiraConfluencePage'),
    }),
    h(TextAreaEntry, {
      id: 'jiraDocumentation', element, label: 'Documentation',
      getValue: () => documentation,
      setValue: (v) => set('documentation', v),
      debounce: debounceFor('jiraDocumentation'),
    }),
  );
}

function Field({ label, value, link, multiline }) {
  if (!value) return null;
  return h('div', { style: { marginBottom: '6px' } },
    h('div', { style: { fontSize: '11px', color: '#5e6c84', marginBottom: '2px' } }, label),
    link
      ? h('a', { href: value, target: '_blank', rel: 'noopener noreferrer', style: { fontSize: '12px', color: '#0052cc' } }, value)
      : h('div', { style: { fontSize: '12px', whiteSpace: multiline ? 'pre-wrap' : 'normal' } }, value),
  );
}

// Read-only group (Viewer). No modeling service exists there, so we render
// the same data statically. Open-buttons still work via the window bridge.
export function ReadOnlyLinkedResourcesGroup({ element }) {
  const ext = getLinkedResources(getBusinessObject(element)) || {};
  const issueKey = ext.issueKey || '';
  const confluencePage = ext.confluencePage || '';
  const documentation = ext.documentation || '';
  return h('div', { style: shellStyle },
    h('h3', { style: headStyle }, 'Linked Resources'),
    h(Field, { label: 'Issue Key', value: issueKey }),
    h(Field, { label: 'Confluence URL', value: confluencePage, link: true }),
    h(Field, { label: 'Documentation', value: documentation, multiline: true }),
    h('div', { style: { display: 'flex', gap: '6px', marginTop: '8px' } },
      h('button', {
        type: 'button',
        onClick: () => { if (ISSUE_KEY_PATTERN.test(issueKey)) window.__openIssueInJira?.(issueKey); },
        disabled: !ISSUE_KEY_PATTERN.test(issueKey), style: btnStyle,
      }, 'Open in Jira'),
      h('button', {
        type: 'button',
        onClick: () => { if (confluencePage) window.__routerOpen?.(confluencePage); },
        disabled: !confluencePage, style: btnStyle,
      }, 'Open in Confluence'),
    ),
  );
}

export default class JiraPropertiesProvider {
  constructor(propertiesPanel) {
    propertiesPanel.registerProvider(500, this); // after the default Id/Name groups
  }
  getGroups(element) {
    if (!element || element.type === 'label' || element.type === 'root') return [];
    return (groups) => {
      groups.push({ id: 'jira-linked-resources', component: LinkedResourcesGroup, element });
      return groups;
    };
  }
}

// Kept imported so an unused-var lint doesn't fire; reserved for future
// "copy issue key" affordances that need to know a field was edited.
void isTextFieldEntryEdited;