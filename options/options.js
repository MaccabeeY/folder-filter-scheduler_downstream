/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { FIELDS } from '../src/matcher.js';
import { ACTIONS, ACTIONS_BY_ID } from '../src/actions.js';
import { buildExport, exportFilename, sanitizeImport } from '../src/rules.js';
import { folderDepth, folderMatchesFilter, resolveRuleFolders, treeGuides } from '../src/folders.js';

const $ = (sel, root = document) => root.querySelector(sel);
const rulesEl = $('#rules');
const statusEl = $('#status');
const isUIContext = rulesEl !== null && statusEl !== null;

let folders = []; // [{ id, label }]
let guides = new Map(); // folder id -> treeGuides() entry, rebuilt with `folders`
/** One picker entry. `label` is the full "Account: /path" form, for tooltips. */
function folderEntry(folder, accountName) {
  const path = folder.path;
  return {
    id: folder.id,
    label: `${accountName}: ${path}`,
    accountId: folder.accountId,
    accountName,
    path,
    name: decodeImapUtf7(folder.name || path.split('/').filter(Boolean).pop() || path),
    depth: folderDepth(path),
    specialUse: folder.specialUse ?? [],
  };
}

/** Build a flat, labelled folder list for the <select>s, across all accounts. */
async function loadFolders() {
  const accounts = await messenger.accounts.list();
  const nameByAccount = new Map(accounts.map((a) => [a.id, decodeImapUtf7(a.name)]));
  const flat = [];

  // Preferred path: the flat folder query (Thunderbird 121+). One call, every folder.
  if (messenger.folders?.query) {
    try {
      const all = await messenger.folders.query({});
      for (const f of all) {
        if (!f.id || !f.path || f.path === '/') continue;
        flat.push(folderEntry(f, nameByAccount.get(f.accountId) ?? ''));
      }
      if (flat.length) {
        // Grouped by account in the account list's order; the query keeps each
        // account's folders in tree order, and a stable sort preserves that.
        const rank = new Map(accounts.map((a, i) => [a.id, i]));
        folders = flat.sort((a, b) => (rank.get(a.accountId) ?? 0) - (rank.get(b.accountId) ?? 0));
        guides = treeGuides(folders);
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
      flat.push(folderEntry(folder, accountName));
    }
    for (const child of folder.subFolders ?? []) walk(child, accountName);
  };
  for (const account of withSubs) {
    walk(account.rootFolder ?? account, account.name);
  }
  folders = flat;
  guides = treeGuides(folders);
}

const INDENT_EM = 1.25;
const GUIDE = 'color-mix(in srgb, currentColor 65%, transparent)';
const DASH_DOWN = `repeating-linear-gradient(to bottom, ${GUIDE} 0 2px, transparent 2px 4px)`;
const DASH_RIGHT = `repeating-linear-gradient(to right, ${GUIDE} 0 2px, transparent 2px 4px)`;

/**
 * Dashed tree lines for one option, as background layers.
 *
 * A native <option> holds text only, so the lines are gradients: one vertical
 * dash per level the tree passes through, and an elbow into this folder. The
 * option stays a real option, so keyboard and screen reader behaviour is the
 * same as any other <select>.
 */
function guideBackground(guide) {
  const layers = [];
  const x = (level) => `${level * INDENT_EM + 0.75}em`;
  guide.through.forEach((through, level) => {
    const own = level === guide.through.length - 1;
    if (own) {
      // The elbow: down from the top (to the middle when this is the last
      // child), then right towards the name.
      layers.push({ image: DASH_DOWN, size: `1px ${guide.last ? '50%' : '100%'}`, position: `${x(level)} 0` });
      layers.push({ image: DASH_RIGHT, size: '0.6em 1px', position: `${x(level)} 50%` });
    } else if (through) {
      layers.push({ image: DASH_DOWN, size: '1px 100%', position: `${x(level)} 0` });
    }
  });
  return {
    backgroundImage: layers.map((l) => l.image).join(', '),
    backgroundSize: layers.map((l) => l.size).join(', '),
    backgroundPosition: layers.map((l) => l.position).join(', '),
  };
}

/**
 * Write one folder option. Indentation is CSS padding, so levels line up and a
 * screen reader hears the name rather than blank space. While filtering, the
 * tree is gone, so the option shows the whole path and no lines.
 */
function paintFolderOption(opt, folder, { filtering = false, covered = false } = {}) {
  const depth = Math.max(1, folder.depth);
  const name = filtering ? folder.path.replace(/^\//, '') : folder.name;
  const note = covered ? ' · included as a subfolder' : '';
  opt.textContent = decodeImapUtf7(`${name}${note}`);
  opt.setAttribute('aria-label', `${name}${note}`);
  opt.style.paddingInlineStart = filtering ? '' : `${(depth - 1) * INDENT_EM + 0.4}em`;
  const guide = guides.get(folder.id);
  const lines = !filtering && guide && guide.through.length > 0 ? guideBackground(guide) : null;
  opt.style.backgroundImage = lines?.backgroundImage ?? '';
  opt.style.backgroundSize = lines?.backgroundSize ?? '';
  opt.style.backgroundPosition = lines?.backgroundPosition ?? '';
  opt.classList.toggle('covered', covered);
  opt.classList.toggle('top-level', !filtering && depth === 1);
}

/**
 * One <optgroup> per account, each folder indented under its parent.
 *
 * Still a native <select>, so arrow keys, Shift+arrow, type-ahead and screen
 * readers work as they do everywhere else in Thunderbird.
 */
function fillFolderSelect(select, selectedIds = []) {
  select.innerHTML = '';
  let group = null;
  for (const f of folders) {
    if (!group || group.dataset.accountId !== f.accountId) {
      group = document.createElement('optgroup');
      group.label = f.accountName || 'Account';
      group.dataset.accountId = f.accountId ?? '';
      select.append(group);
    }
    const opt = document.createElement('option');
    opt.value = f.id;
    paintFolderOption(opt, f);
    opt.title = f.label;
    opt.selected = selectedIds.includes(f.id);
    group.append(opt);
  }
}

/**
 * Filter box, "Select all matching", and the selection count for one rule.
 *
 * Filtering only hides options. A hidden option keeps its selected state, so a
 * folder picked earlier stays in the rule while you search for another, and the
 * count says how many of the selected folders the filter hides.
 */
function wireFolderPicker(node) {
  const filter = $('.folder-filter', node);
  const select = $('.rule-folders', node);
  const selectMatching = $('.folder-select-matching', node);
  const count = $('.folder-count', node);
  const byId = new Map(folders.map((f) => [f.id, f]));

  const subfolders = $('.rule-subfolders', node);

  /**
   * Folders the rule scans without being picked. Worked out by the engine's own
   * `resolveRuleFolders`, so a Trash folder or a move destination the engine
   * skips is not marked here either.
   */
  const coveredIds = () => {
    if (!subfolders.checked) return new Set();
    const chosen = [...select.selectedOptions].map((o) => o.value);
    const actions = [...node.querySelectorAll('.action')].map((row) => ({
      type: $('.action-type', row).value,
      folderId: $('.action-folder', row).value,
    }));
    const scanned = resolveRuleFolders({ folderIds: chosen, includeSubfolders: true, actions }, folders);
    return new Set(scanned.filter((id) => !chosen.includes(id)));
  };

  const updateCount = () => {
    const selected = [...select.selectedOptions];
    const hidden = selected.filter((o) => o.hidden).length;
    const covered = coveredIds();
    count.textContent =
      `${selected.length} selected` +
      (covered.size ? `, ${covered.size} more as subfolders` : '') +
      (hidden ? `, ${hidden} hidden by the filter` : '');
    return covered;
  };
  const applyFilter = () => {
    const text = filter.value;
    const filtering = text.trim() !== '';
    const covered = updateCount();
    for (const group of select.querySelectorAll('optgroup')) {
      let visible = 0;
      for (const opt of group.children) {
        const folder = byId.get(opt.value);
        opt.hidden = !folderMatchesFilter(folder, text);
        if (!opt.hidden) visible += 1;
        if (folder) paintFolderOption(opt, folder, { filtering, covered: covered.has(folder.id) });
      }
      group.hidden = visible === 0;
    }
    // With no filter, "all matching" would be every folder in every account.
    selectMatching.disabled = !filtering;
  };

  filter.addEventListener('input', applyFilter);
  filter.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown') return;
    e.preventDefault();
    select.focus();
  });
  selectMatching.addEventListener('click', () => {
    for (const opt of select.options) if (!opt.hidden) opt.selected = true;
    applyFilter();
  });
  // Repainted on each change, because the covered marks follow the selection,
  // the checkbox, and any move or copy destination among the actions.
  select.addEventListener('change', applyFilter);
  subfolders.addEventListener('change', applyFilter);
  node.addEventListener('change', (e) => {
    if (e.target.closest?.('.actions')) applyFilter();
  });
  applyFilter();
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

  const actionContainer = $('.actions', node);

  wireFolderPicker(node);

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
  return {
    intervalMinutes: Math.max(1, Number($('#interval').value) || 10), rules,
    sendNotifications: $('#send-notifications').checked ? "1" : "0"
  };
}

function flash(message, isError = false) {
  if (!isUIContext) return; 
  statusEl.textContent = message;
  statusEl.style.color = isError ? 'var(--danger)' : 'var(--accent)';
}

async function save() {
  const config = collectConfig();
  await messenger.storage.local.set({ config });
  await messenger.runtime.sendMessage({ command: 'reschedule' });
  flash('Saved. Options updated.');
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
    // knownAddressBookIds: bookAccess ? addressBooks.map((b) => b.id) : undefined,
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

  for (const rule of rules) rule.action = rule.actions[0];

  for (const rule of rules) renderRule(rule);
//  if (allowlist?.length) $('#allowlist').value = allowlist.join('\n');
  if (intervalMinutes) $('#interval').value = intervalMinutes;
//  if (advanced) fillAdvanced(advanced);
  if (data?.sendNotifications !== undefined) {
    $('#send-notifications').checked = data.sendNotifications === "1";
  }
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
  $('#send-notifications').checked = config?.sendNotifications === "1";
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

export async function getsendNotifications() {
  const { config } = await messenger.storage.local.get({ config: null });
  return config?.sendNotifications;
}

/**
 * UTF-8 encoding for Thunderbird 128 non-UTF-8 encoding.
 * Reconstructs raw byte streams and cleanly parses them into correct Unicode.
 */
function utf8String(str) {
  if (!str) return '';
  
  if (!/[^\x00-\x7F]/.test(str) && !str.includes('&')) {
    return str;
  }

  try {
    const buf = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      buf[i] = str.charCodeAt(i) & 0xff;
    }
    
    return new TextDecoder('utf-8').decode(buf);
  } catch (e) {
    return str;
  }
}

/**
 * Decodes Modified IMAP UTF-7 folder paths commonly returned by Thunderbird 128.
 * Automatically translates strings like "&ALc-" into "·" and handles all other special characters.
 */
function decodeImapUtf7(str) {
  if (!str) return '';
  
  // If there's no IMAP UTF-7 marker (&), return early for lightning-fast performance
  if (!str.includes('&')) return str;

  // Regular expression to find any IMAP UTF-7 encoded blocks (e.g., &ALc-)
  return str.replace(/&([A-Za-z0-9+,/]*)-/g, (match, g1) => {
    // An empty marker "&-" means a literal "&" character in IMAP
    if (g1 === '') return '&';

    try {
      // 1. Convert IMAP's modified Base64 comma (,) back to standard Base64 slash (/)
      const base64 = g1.replaceAll(',', '/');
      
      // 2. Decode the Base64 string into binary data
      const binary = atob(base64);
      
      // 3. IMAP UTF-7 encodes characters in UTF-16BE (2 bytes per character)
      let decoded = '';
      for (let i = 0; i < binary.length; i += 2) {
        const charCode = (binary.charCodeAt(i) << 8) | binary.charCodeAt(i + 1);
        decoded += String.fromCharCode(charCode);
      }
      return decoded;
    } catch (e) {
      // If decoding fails, return the original match safely
      return match;
    }
  });
}

if (isUIContext) {
 init().catch((e) => console.log(e.message));
}
