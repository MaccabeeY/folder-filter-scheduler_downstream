/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { FIELDS } from '../src/matcher.js';
import { ACTIONS, ACTIONS_BY_ID } from '../src/actions.js';
import { buildExport, exportFilename, sanitizeImport } from '../src/rules.js';

const $ = (sel, root = document) => root.querySelector(sel);
const rulesEl = $('#rules');
const statusEl = $('#status');

let folders = []; // [{ id, label }]

/** Build a flat, labelled folder list for the <select>s, across all accounts. */
async function loadFolders() {
  const accounts = await messenger.accounts.list();
  const nameByAccount = new Map(accounts.map((a) => [a.id, a.name]));
  const flat = [];

  // Preferred path: the flat folder query (Thunderbird 121+). One call, every folder.
  if (messenger.folders?.query) {
    try {
      const all = await messenger.folders.query({});
      for (const f of all) {
        if (!f.id || !f.path || f.path === '/') continue;
        flat.push({ id: f.id, label: `${nameByAccount.get(f.accountId) ?? ''}: ${f.path}` });
      }
      if (flat.length) {
        folders = flat;
        return;
      }
    } catch (e) {
      console.warn('[FolderFilterScheduler] folders.query failed, falling back', e);
    }
  }

  // Fallback: walk each account's tree, explicitly requesting subfolders.
  const withSubs = await messenger.accounts.list(true);
  const walk = (folder, accountName) => {
    if (folder.id && folder.path && folder.path !== '/') {
      flat.push({ id: folder.id, label: `${accountName}: ${folder.path}` });
    }
    for (const child of folder.subFolders ?? []) walk(child, accountName);
  };
  for (const account of withSubs) {
    walk(account.rootFolder ?? account, account.name);
  }
  folders = flat;
}

function fillFolderSelect(select, selectedIds = []) {
  select.innerHTML = '';
  for (const f of folders) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.label;
    opt.selected = selectedIds.includes(f.id);
    select.append(opt);
  }
}

function fillFieldSelect(select, value) {
  select.innerHTML = '';
  for (const field of FIELDS) {
    const opt = document.createElement('option');
    opt.value = field;
    opt.textContent = field;
    opt.selected = field === value;
    select.append(opt);
  }
}

function renderCondition(container, cond = {}) {
  const node = $('#condition-template').content.firstElementChild.cloneNode(true);
  fillFieldSelect($('.cond-field', node), cond.field ?? 'reply-to');
  $('.cond-op', node).value = cond.operator ?? 'contains';
  $('.cond-negate', node).checked = !!cond.negate;
  $('.cond-value', node).value = cond.value ?? '';
  $('.del-cond', node).addEventListener('click', () => node.remove());
  container.append(node);
}

function renderRule(rule = {}) {
  const node = $('#rule-template').content.firstElementChild.cloneNode(true);
  $('.rule-name', node).value = rule.name ?? 'New rule';
  $('.rule-enabled', node).checked = rule.enabled !== false;
  $('.rule-match', node).value = rule.match ?? 'any';
  fillFolderSelect($('.rule-folders', node), rule.folderIds ?? []);

  const condContainer = $('.conditions', node);
  const conds = rule.conditions?.length ? rule.conditions : [{}];
  for (const c of conds) renderCondition(condContainer, c);
  $('.add-cond', node).addEventListener('click', () => renderCondition(condContainer, {}));

  const actionType = $('.rule-action-type', node);
  const actionFolder = $('.rule-action-folder', node);
  const actionHint = $('.action-hint', node);

  // Populate the action dropdown from the registry — UI stays in lockstep with the engine.
  for (const def of ACTIONS) {
    const opt = document.createElement('option');
    opt.value = def.id;
    opt.textContent = def.label;
    actionType.append(opt);
  }
  fillFolderSelect(actionFolder, rule.action?.folderId ? [rule.action.folderId] : []);

  const syncAction = () => {
    const def = ACTIONS_BY_ID[actionType.value];
    actionFolder.classList.toggle('hidden', !def?.needsFolder);
    actionHint.textContent = def?.hint ?? '';
    actionHint.classList.toggle('danger', !!def?.danger);
  };
  actionType.value = rule.action?.type ?? 'trash';
  actionType.addEventListener('change', syncAction);
  syncAction();

  $('.del-rule', node).addEventListener('click', () => node.remove());
  rulesEl.append(node);
}

/** Read the DOM back into a config object. */
function collectConfig() {
  const rules = [...rulesEl.querySelectorAll('.rule')].map((node) => {
    const actionType = $('.rule-action-type', node).value;
    const action = { type: actionType };
    if (actionType === 'move' || actionType === 'copy') {
      action.folderId = $('.rule-action-folder', node).value;
    }
    return {
      name: $('.rule-name', node).value.trim() || 'Untitled rule',
      enabled: $('.rule-enabled', node).checked,
      match: $('.rule-match', node).value,
      folderIds: [...$('.rule-folders', node).selectedOptions].map((o) => o.value),
      conditions: [...node.querySelectorAll('.condition')].map((c) => ({
        field: $('.cond-field', c).value,
        operator: $('.cond-op', c).value,
        value: $('.cond-value', c).value,
        negate: $('.cond-negate', c).checked,
      })),
      action,
    };
  });
  return { intervalMinutes: Math.max(1, Number($('#interval').value) || 10), rules };
}

function flash(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? 'var(--danger)' : 'var(--accent)';
}

async function save() {
  const config = collectConfig();
  await messenger.storage.local.set({ config });
  await messenger.runtime.sendMessage({ command: 'reschedule' });
  flash('Saved. Schedule updated.');
}

function exportRules() {
  const now = new Date();
  const blob = new Blob([JSON.stringify(buildExport(collectConfig(), { exportedAt: now }), null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = exportFilename(now);
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  flash(`Exported to ${exportFilename(now)}. Unsaved edits on this page are included.`);
}

/**
 * Import is deliberately staged: rules are validated and rendered into the page,
 * but nothing is stored until the user presses Save. So a bad file can be
 * abandoned by reloading, and can never start deleting mail on its own.
 */
async function importRules(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    flash(`Could not read ${file.name}: ${e.message}`, true);
    return;
  }

  const { rules, duplicates, allowlist, intervalMinutes, advanced, problems } = sanitizeImport(data, {
    knownFolderIds: folders.map((f) => f.id),
    // Only checkable with access; otherwise ids are kept and checked on use.
//    knownAddressBookIds: bookAccess ? addressBooks.map((b) => b.id) : undefined,
    // Compare against what is on the page, including unsaved edits, so
    // re-importing the same file does not pile up duplicate rules.
    existingRules: collectConfig().rules,
  });

  const dupeNote = duplicates.length
    ? ` Already present, skipped: ${duplicates
        .map((d) => `“${d.name}” (${d.hash}, same as “${d.matches}”)`)
        .join(', ')}.`
    : '';

  if (rules.length === 0) {
    const why = problems.join('; ') || (duplicates.length ? '' : 'The file contained no usable rules.');
    flash(`Nothing new to import.${why ? ` ${why}.` : ''}${dupeNote}`, !duplicates.length);
    return;
  }

  for (const rule of rules) renderRule(rule);
//  if (allowlist?.length) $('#allowlist').value = allowlist.join('\n');
  if (intervalMinutes) $('#interval').value = intervalMinutes;
//  if (advanced) fillAdvanced(advanced);

  const skipped = problems.length > 0 ? ` Skipped: ${problems.join('; ')}.` : '';
  flash(
    `Imported ${rules.length} rule(s) — review them, then press Save to keep them.${skipped}${dupeNote}`,
    problems.length > 0,
  );
}

async function runNow() {
  flash('Running…');
  try {
    const res = await messenger.runtime.sendMessage({ command: 'runNow' });
    flash(`Done — ${res?.affected ?? 0} message(s) affected.`);
  } catch (e) {
    flash(`Run failed: ${e.message}`, true);
  }
}

async function init() {
  await loadFolders();
  const { config } = await messenger.storage.local.get({ config: null });
  $('#interval').value = config?.intervalMinutes ?? 10;
  const rules = config?.rules?.length ? config.rules : [{}];
  for (const r of rules) renderRule(r);

  $('#add-rule').addEventListener('click', () => renderRule({}));
  $('#save').addEventListener('click', () => save().catch((e) => flash(e.message, true)));
  $('#run-now').addEventListener('click', runNow);
  $('#export').addEventListener('click', () => {
    try {
      exportRules();
    } catch (e) {
      flash(`Export failed: ${e.message}`, true);
    }
  });
  $('#import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (event) => {
    const [file] = event.target.files ?? [];
    // Reset so re-picking the same file fires change again.
    event.target.value = '';
    if (file) importRules(file).catch((e) => flash(`Import failed: ${e.message}`, true));
  });

  if (folders.length === 0) {
    flash('No folders found — check the “accountsRead” permission and reload the add-on.', true);
  }
}

init().catch((e) => flash(e.message, true));
