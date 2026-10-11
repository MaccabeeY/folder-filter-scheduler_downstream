/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { evaluateRule, requiresFullMessage, FIELDS } from './matcher.js';
import { runAction } from './actions.js';
import { getsendNotifications } from '../options/options.js';

/**
 * Background engine.
 *
 * Why a self-contained rule engine instead of re-running Thunderbird's built-in
 * filters? Because the WebExtension/MailExtension API exposes no hook to invoke
 * the legacy message-filter engine on demand against an arbitrary folder. So we
 * reimplement the matching (see matcher.js) and the actions here, and drive them
 * from the `alarms` API to get the periodic-on-any-folder behaviour that stock
 * Thunderbird only offers for the Inbox.
 */

const ALARM_NAME = 'folder-filter-scheduler.tick';
const DEFAULT_INTERVAL_MINUTES = 10;

const log = (...args) => console.log('[FolderFilterScheduler]', ...args);
const warn = (...args) => console.warn('[FolderFilterScheduler]', ...args);

/** @returns {Promise<{intervalMinutes:number, rules:Array}>} */
async function loadConfig() {
  const { config } = await messenger.storage.local.get({ config: null });
  return {
    intervalMinutes: config?.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES,
    rules: Array.isArray(config?.rules) ? config.rules : [],
  };
}

async function ensureAlarm() {
  const { intervalMinutes } = await loadConfig();
  const minutes = Math.max(1, Number(intervalMinutes) || DEFAULT_INTERVAL_MINUTES);
  await messenger.alarms.clear(ALARM_NAME);
  messenger.alarms.create(ALARM_NAME, { periodInMinutes: minutes });
  log(`scheduled every ${minutes} min`);
}

/**
 * Build the normalized `{ fields }` object matcher.js expects from a message.
 *
 * When `fetchFull` is false (the rule only needs from/to/cc/subject) we read
 * everything from the lightweight MessageHeader — no network, works offline,
 * irrespective of whether the folder is stored locally. Only when a rule needs
 * a non-indexed header (reply-to, list-id, …) do we pay for `getFull()`, which
 * fetches the message on demand on a non-offline IMAP folder.
 */
async function normalize(messageHeader, fetchFull) {
  const fields = {};
  const push = (name, value) => {
    if (value == null || value === '') return;
    const key = name.toLowerCase();
    (fields[key] ??= []).push(String(value));
  };

  if (fetchFull) {
    try {
      const full = await messenger.messages.getFull(messageHeader.id);
      for (const [name, values] of Object.entries(full?.headers ?? {})) {
        for (const v of values) push(name, v);
      }
    } catch (e) {
      warn('getFull failed', messageHeader.id, e);
    }
  }

  // Cheap fields from the indexed header — the only source when fetchFull is
  // false, and a fallback for anything getFull happened to omit.
  if (!fields.from && messageHeader.author) push('from', messageHeader.author);
  if (!fields.subject && messageHeader.subject) push('subject', messageHeader.subject);
  if (!fields.to) for (const r of messageHeader.recipients ?? []) push('to', r);
  if (!fields.cc) for (const c of messageHeader.ccList ?? []) push('cc', c);

  return { fields, _header: messageHeader };
}

async function getFiltaQuillaMessagesByRawHeaders(uriString) {
  let parts = uriString.split("://");
  let accountId = parts[0];
  let targetPath = "/" + parts[1];
  let targetFolder = await messenger.folders.query({ accountId: accountId, path: targetPath });

/*  // Force Thunderbird to background-sync and index the unclicked folder.
  // This updates the local cache without changing your tabs or opening windows.
  if (targetFolder && targetFolder.length > 0) {
    await messenger.folders.update(targetFolder[0].id, {isFavorite: false}); // this need "accountsFolders" permission
    // Give the file indexer a quick 300ms window to parse the data streams
    await new Promise(resolve => setTimeout(resolve, 300));
  }*/

  // Explicitly pass an empty matching array using "any" mode
  // This forces the query indexer to scan the specific folder path silently.
  let page = await messenger.messages.list(targetFolder[0].id);

  let subjectsList = [];

  // Paginate through the newly unhidden message results
  while (page) {
    for (let msgSummary of page.messages) {
      // Read the raw text block directly from storage disk paths
      let rawMimeStream = await messenger.messages.getRaw(msgSummary.id);

      // Convert the File object stream into a readable text block string
      let textContent = await rawMimeStream.text();

      let subjectLine = textContent.split("\n")
        .find(line => line.toLowerCase().startsWith("subject:"));

      if (subjectLine) {
        let parsedSubject = subjectLine.replace(/^subject:\s*/i, "").trim();
        subjectsList.push(parsedSubject);
      }

      // Read the live, modified message metadata directly from the database cache.
      // This exposes the Subject prepend added by FiltaQuilla.
      let fullMessageInfo = await messenger.messages.get(msgSummary.id);

      if (fullMessageInfo && fullMessageInfo.subject) {
        subjectsList.push(fullMessageInfo.subject);
      }
    }

    // Advance to next 100 entries if a trailing list pointer exists
    if (page.id) {
        page = await messenger.messages.continueList(page.id);
    } else {
        page = null; // Cleanly break the loop when finished
    }
  }

  return subjectsList;
}


/** Iterate every message in a folder, transparently following pagination. */
async function messagesInFolder(folderId, callback) {
/*  await getFiltaQuillaMessagesByRawHeaders(folderId).then(subjects => {
    if (subjects.length > 0) console.log("Subjects fetched directly from raw streams:", subjects);
  });*/

//  let page = await messenger.messages.query({ folderId, autoPaginationTimeout: 0 });
  let page = await messenger.messages.list(folderId);

  while (page) {
    for (const m of page.messages) {
      await callback(m);
    }
    if (!page.id) break;
    page = await messenger.messages.continueList(page.id);
  }
}

/** Run one rule across all its source folders. Returns count of affected messages. */
async function runRule(rule) {
  if (rule.enabled === false) return 0;
  const fetchFull = requiresFullMessage(rule);
  let affected = 0;

  for (const folderId of rule.folderIds ?? []) {
    const matchedIds = [];
    try {
      // we are merely processing 'headers' ourselves via callback instead of the debugger-breaking black box of 'yield' generator
      await messagesInFolder(folderId, async (header) => {
        const message = await normalize(header, fetchFull);
        if (evaluateRule(message, rule)) matchedIds.push(header.id);
      });
    } catch (e) {
      warn(`scan failed for folder ${folderId} in rule "${rule.name}"`, e);
      continue;
    }
    try {
      await runAction(messenger, matchedIds, rule.action);
      affected += matchedIds.length;
    } catch (e) {
      warn(`action failed for rule "${rule.name}"`, e);
    }
  }
  return affected;
}

/** Run every enabled rule. Exposed to the options page via runtime messaging. */
async function runAllRules(reason = 'manual') {
  const { rules } = await loadConfig();
  let total = 0;
  for (const rule of rules) {
    const n = await runRule(rule);
    if (n) log(`rule "${rule.name}" affected ${n} message(s)`);
    total += n;
  }
  let msg = `run (${reason}) complete — ${total} message(s) affected across ${rules.length} rule(s)`;
  log(msg);
  if (total > 0) sendBalloon(msg, `Folder Filter Scheduler processed ${total} message(s)`);
  return total;
}

messenger.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) runAllRules('scheduled');
});

// Listen for the main window toolbar button click
messenger.action.onClicked.addListener(async (tab) => {
    return runAllRules('manual').then((affected) => ({ ok: true, affected }));
});

messenger.runtime.onMessage.addListener((msg) => {
  if (msg?.command === 'runNow') {
    return runAllRules('manual').then((affected) => ({ ok: true, affected }));
  }
  if (msg?.command === 'reschedule') {
    return ensureAlarm().then(() => ({ ok: true }));
  }
  return undefined;
});

messenger.runtime.onInstalled.addListener(ensureAlarm);
messenger.runtime.onStartup.addListener(ensureAlarm);
ensureAlarm();

// Register the content script dynamically upon installation/startup
messenger.runtime.onInstalled.addListener(async () => {
  try {
    await messenger.scripting.messageDisplay.registerScripts([{
      id: "status-banner",
      js: ["banner.js"],
      css: ["banner.css"]
    }]);
  } catch (error) {
    // Suppressed to prevent system console log tracking noise
  }
});

/**
 * Triggers a balloon/toast notification in the lower right corner of the screen.
 * @param {string} titleText - The bold heading of the balloon.
 * @param {string} bodyText - The description message underneath.
 */
async function sendBalloon(bodyText, titleText = "Folder Filter Scheduler") {
  if (await getsendNotifications() === "1")
    messenger.notifications.create({
      type: "basic",
      iconUrl: "icons/icon.svg",
      title: titleText,
      message: bodyText
    });
}

// Re-exported so the options UI can render the supported field list from one source of truth.
export { FIELDS };
