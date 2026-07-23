import { h } from 'preact';
import {
  isTextFieldEntryEdited,
  TextAreaEntry,
  TextFieldEntry,
} from '@bpmn-io/properties-panel';
import { getBusinessObject } from 'bpmn-js/lib/util/ModelUtil';

export const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;

// --- modeling/moddle bridge ----------------------------------------------
// The properties panel renders our custom group/entries with Preact and does
// NOT hand us the modeler, and `useService` is not reliably importable in
// this project's dependency tree. So we capture modeling + moddle once (from
// the modeler instance, in BpmnDiagramView) into module scope and read them
// back here. Safe because only one editor is mounted at a time.
let _modeling = null;
let _moddle = null;
export function setModelerServices(modeling, moddle) {
  _modeling = modeling;
  _moddle = moddle;
}

// --- plain reader (used by BOTH the editable entries and the React viewer) -
export function getLinkedResources(businessObject) {
  if (!businessObject || typeof businessObject.get !== 'function') {
    return { issueKey: '', confluencePage: '', documentation: '' };
  }
  const extElements = businessObject.get('extensionElements');
  const values = (extElements && extElements.get && extElements.get('values')) || [];
  const ext = values.find((v) => v.$type === 'jira:LinkedResources');
  return {
    issueKey: ext?.issueKey || '',
    confluencePage: ext?.confluencePage || '',
    documentation: ext?.documentation || '',
  };
}

function setLinkedResourceProperty(element, propertyName, value) {
  if (!_modeling || !_moddle) return; // editor not wired yet → no-op
  const bo = getBusinessObject(element);
  let ext = getLinkedResources(bo) && _findExt(bo);
  let extElements = bo.get('extensionElements');
  if (!ext) {
    ext = _moddle.create('jira:LinkedResources');
    if (extElements) {
      _modeling.updateModdleProperties(element, extElements, {
        values: [...(extElements.get('values') || []), ext],
      });
    } else {
      extElements = _moddle.create('bpmn:ExtensionElements', { values: [ext] });
      _modeling.updateProperties(element, { extensionElements: extElements });
    }
  }
  _modeling.updateModdleProperties(element, ext, {
    [propertyName]: value === '' ? undefined : value,
  });
}
function _findExt(bo) {
  const extElements = bo.get('extensionElements');
  const values = (extElements && extElements.get && extElements.get('values')) || [];
  return values.find((v) => v.$type === 'jira:LinkedResources') || null;
}

// --- per-field debounce (stable per id, no hooks needed) -----------------
const _debounceCache = {};
function debounceFor(id) {
  if (!_debounceCache[id]) {
    let timer;
    _debounceCache[id] = (fn) => (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), 300);
    };
  }
  return _debounceCache[id];
}

// --- defensive wrappers: a property-panel quirk must NEVER crash the canvas
function safeText(props) { try { return TextFieldEntry(props); } catch (e) { return null; } }
function safeArea(props) { try { return TextAreaEntry(props); } catch (e) { return null; } }

function OpenButtonsEntry(props) {
  try {
    const element = props.element;
    if (!element) return null;
    const { issueKey, confluencePage } = getLinkedResources(getBusinessObject(element));
    return h('div', { style: { display: 'flex', gap: '6px', padding: '4px 0' } },
      h('button', {
        type: 'button',
        onClick: () => { if (ISSUE_KEY_PATTERN.test(issueKey)) window.__openIssueInJira?.(issueKey); },
        disabled: !ISSUE_KEY_PATTERN.test(issueKey),
        style: { fontSize: '11px', padding: '4px 8px' },
      }, 'Open in Jira'),
      h('button', {
        type: 'button',
        onClick: () => { if (confluencePage) window.__routerOpen?.(confluencePage); },
        disabled: !confluencePage,
        style: { fontSize: '11px', padding: '4px 8px' },
      }, 'Open in Confluence'),
    );
  } catch (e) { return null; }
}

function IssueKeyEntry(props) {
  try {
    const element = props.element;
    if (!element) return null;
    const { issueKey } = getLinkedResources(getBusinessObject(element));
    return safeText({
      element, id: 'jiraIssueKey', label: 'Issue Key', description: 'PROJ-123',
      getValue: () => issueKey,
      setValue: (v) => setLinkedResourceProperty(element, 'issueKey', v),
      validate: (v) => (v && !ISSUE_KEY_PATTERN.test(v)) ? 'Must look like PROJ-123' : undefined,
      debounce: debounceFor('jiraIssueKey'),
    });
  } catch (e) { return null; }
}

function ConfluenceEntry(props) {
  try {
    const element = props.element;
    if (!element) return null;
    const { confluencePage } = getLinkedResources(getBusinessObject(element));
    return safeText({
      element, id: 'jiraConfluencePage', label: 'Confluence URL',
      getValue: () => confluencePage,
      setValue: (v) => setLinkedResourceProperty(element, 'confluencePage', v),
      debounce: debounceFor('jiraConfluencePage'),
    });
  } catch (e) { return null; }
}

function DocEntry(props) {
  try {
    const element = props.element;
    if (!element) return null;
    const { documentation } = getLinkedResources(getBusinessObject(element));
    return safeArea({
      element, id: 'jiraDocumentation', label: 'Documentation',
      getValue: () => documentation,
      setValue: (v) => setLinkedResourceProperty(element, 'documentation', v),
      debounce: debounceFor('jiraDocumentation'),
    });
  } catch (e) { return null; }
}

// Group factory — documented "entries" pattern.
function LinkedResourcesGroup(element) {
  return {
    id: 'jira-linked-resources',
    label: 'Linked Resources',
    entries: [
      { id: 'jiraOpenButtons', component: OpenButtonsEntry },
      { id: 'jiraIssueKey', component: IssueKeyEntry, isEdited: isTextFieldEntryEdited },
      { id: 'jiraConfluencePage', component: ConfluenceEntry, isEdited: isTextFieldEntryEdited },
      { id: 'jiraDocumentation', component: DocEntry, isEdited: isTextFieldEntryEdited },
    ],
  };
}

export default class JiraPropertiesProvider {
  constructor(propertiesPanel) {
    propertiesPanel.registerProvider(500, this);
  }
  getGroups(element) {
    if (!element || element.type === 'label' || element.type === 'root') return [];
    return (groups) => groups.concat([LinkedResourcesGroup(element)]);
  }
}