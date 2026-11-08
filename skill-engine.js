/* ULTRON Skill Engine 2.0 — browser engine and UI.
 *
 * Depends on skill-rules.js (window.ULTRONSkillRules) and builtin-skills.js.
 * The chat pipeline calls:
 *   SkillEngineUI.parseCommands(text)
 *   SkillEngineUI.activateForTurn({ message, explicitSkills })
 * Skills are always rendered as text. No skill content is ever evaluated.
 */
(function () {
  "use strict";

  var Rules = window.ULTRONSkillRules;
  if (!Rules) {
    console.warn("Skill Engine 2.0: skill-rules.js failed to load.");
    return;
  }

  var BUILTINS = Array.isArray(window.ULTRON_BUILTIN_SKILLS) ? window.ULTRON_BUILTIN_SKILLS : [];
  // Bump when stored skill records need rebuilding from the bundled files.
  var STORAGE_VERSION = 3;
  var BUILTIN_COMMANDS = [
    { name: "help", description: "Show all commands" },
    { name: "new", description: "Start a new conversation" },
    { name: "clear", description: "Clear the current conversation" },
    { name: "model", description: "Show or change the model" },
    { name: "settings", description: "Open settings" },
    { name: "skills", description: "Manage skills" },
    { name: "export", description: "Export your workspace" }
  ];

  var app = null;
  var stripTimer = null;
  var noticeTimer = null;
  var lastRun = null;
  var editorOpen = false;

  /* ------------------------------------------------------------------ *
   * State helpers
   * ------------------------------------------------------------------ */

  function getState() {
    return app && app.getState ? app.getState() : {};
  }

  function save() {
    if (app && app.save) {
      try { app.save(); } catch (error) { console.warn("Skill Engine could not save:", error); }
    }
  }

  function clamp(value, min, max, fallback) {
    var n = parseInt(value, 10);
    if (!isFinite(n)) n = fallback;
    return Math.min(max, Math.max(min, n));
  }

  function settings() {
    var state = getState();
    if (!state.skillSettings || typeof state.skillSettings !== "object") {
      state.skillSettings = {
        maxActive: Rules.DEFAULT_SETTINGS.maxActive,
        autoDetect: Rules.DEFAULT_SETTINGS.autoDetect,
        budgetTokens: Rules.DEFAULT_SETTINGS.budgetTokens
      };
    }
    var s = state.skillSettings;
    s.maxActive = clamp(s.maxActive, 1, 5, Rules.DEFAULT_SETTINGS.maxActive);
    s.budgetTokens = clamp(s.budgetTokens, 300, 4000, Rules.DEFAULT_SETTINGS.budgetTokens);
    s.autoDetect = s.autoDetect !== false;
    return s;
  }

  // Records store the instruction body, not the front matter. Re-scan the body
  // on load (so new rules apply) but keep the parsed triggers, priority, tools,
  // and description. Re-parsing only the body would silently drop all of them.
  function normalizeRecord(record) {
    if (!record || typeof record !== "object" || typeof record.content !== "string" || !record.content.trim()) return null;
    var isBuiltin = Boolean(record.builtin) || record.trust === "builtin";
    var command = Rules.normalizeCommand(record.command || record.name);
    if (!command) return null;
    var content = record.content.trim();
    var scan = Rules.scanSkill(content);
    var findings = scan.findings.slice();
    var verdict = scan.verdict;
    var lineCount = content.split("\n").length;
    if (lineCount > Rules.RECOMMENDED_LINES) {
      findings.push({
        code: "heavy-skill",
        severity: "warn",
        message: "The skill is over 200 lines. Split it into sub-skills to keep context light.",
        line: null
      });
      if (verdict === "safe") verdict = "review";
    }
    var requested = Array.isArray(record.requestedTools)
      ? record.requestedTools.filter(function (tool) { return Boolean(Rules.TOOL_CATALOG[tool]); })
      : [];
    var granted = Array.isArray(record.grantedTools)
      ? record.grantedTools.filter(function (tool) { return Boolean(Rules.TOOL_CATALOG[tool]) && Rules.TOOL_CATALOG[tool].available; })
      : [];
    var priorityOverride = record.priorityOverride == null || record.priorityOverride === ""
      ? null
      : clamp(record.priorityOverride, 0, 100, 50);
    var priority = clamp(priorityOverride == null ? record.priority : priorityOverride, 0, 100, 50);

    return {
      id: record.id || "sk_" + command + "_" + String(record.createdAt || Date.now()),
      command: command,
      name: Rules.clean(record.name, 80) || command,
      description: record.description || "No description provided.",
      triggers: Array.isArray(record.triggers) ? record.triggers.slice(0, 12) : [],
      priority: priority,
      priorityOverride: priorityOverride,
      requestedTools: requested,
      unknownTools: Array.isArray(record.unknownTools) ? record.unknownTools.slice(0, 8) : [],
      grantedTools: granted,
      conflicts: Array.isArray(record.conflicts) ? record.conflicts.slice(0, 8) : [],
      always: Boolean(record.always),
      trust: isBuiltin ? "builtin" : "community",
      builtin: isBuiltin,
      enabled: record.enabled !== false,
      content: content,
      bytes: record.bytes || content.length,
      lineCount: lineCount,
      tokens: Rules.estimateTokens(content),
      findings: findings,
      verdict: verdict,
      source: record.source || record.fileName || (record.name || command) + ".md",
      createdAt: record.createdAt || Date.now(),
      addedAt: record.addedAt || record.createdAt || Date.now()
    };
  }

  function ensure() {
    var state = getState();
    var changed = false;
    if (!Array.isArray(state.skills)) state.skills = [];

    // Migrate the pre-2.0 "customSkills" list once.
    if (Array.isArray(state.customSkills) && state.customSkills.length) {
      state.customSkills.forEach(function (old) {
        var text = String(old && (old.content || old.text) || "");
        if (!text) return;
        try {
          var parsed = Rules.parseSkill(text, {
            fileName: old.name || old.fileName || "imported-skill.md",
            trust: "community",
            enabled: old.enabled !== false
          });
          if (!state.skills.some(function (skill) { return skill.command === parsed.command; })) {
            state.skills.push(parsed);
          }
        } catch (error) { /* skip unreadable legacy entry */ }
      });
      state.customSkills = [];
      changed = true;
    }

    if (Number(state.skillEngineVersion) < STORAGE_VERSION) {
      BUILTINS.forEach(function (builtin) {
        var fresh = Rules.parseSkill(builtin.text, {
          fileName: builtin.fileName,
          trust: "builtin",
          enabled: true
        });
        var index = state.skills.findIndex(function (skill) { return skill.command === fresh.command; });
        if (index < 0) {
          state.skills.push(fresh);
          return;
        }
        // Refresh bundled instructions on a schema bump while preserving the
        // user's enable state, priority override, and approved tools.
        var old = state.skills[index];
        fresh.enabled = old.enabled !== false;
        fresh.priorityOverride = old.priorityOverride == null || old.priorityOverride === ""
          ? null
          : clamp(old.priorityOverride, 0, 100, fresh.priority);
        if (fresh.priorityOverride !== null) fresh.priority = fresh.priorityOverride;
        if (Array.isArray(old.grantedTools)) {
          fresh.grantedTools = old.grantedTools.filter(function (tool) {
            return fresh.requestedTools.indexOf(tool) >= 0 && Rules.TOOL_CATALOG[tool] && Rules.TOOL_CATALOG[tool].available;
          });
        }
        fresh.addedAt = old.addedAt || old.createdAt || fresh.createdAt;
        state.skills[index] = fresh;
      });
      state.skillEngineVersion = STORAGE_VERSION;
      changed = true;
    }

    var normalized = state.skills.map(normalizeRecord).filter(Boolean);
    // Drop records that now fail to parse, keep everything else untouched.
    if (normalized.length !== state.skills.length) changed = true;
    state.skills = normalized;

    if (!state.skillSettings) {
      state.skillSettings = {
        maxActive: Rules.DEFAULT_SETTINGS.maxActive,
        autoDetect: Rules.DEFAULT_SETTINGS.autoDetect,
        budgetTokens: Rules.DEFAULT_SETTINGS.budgetTokens
      };
      changed = true;
    }
    if (changed) save();
  }

  function records() {
    var state = getState();
    if (!Array.isArray(state.skills) || Number(state.skillEngineVersion) < STORAGE_VERSION) ensure();
    return Array.isArray(getState().skills) ? getState().skills : [];
  }

  function recordById(id) {
    return records().find(function (record) { return record.id === id; }) || null;
  }

  function findRecord(command) {
    var normalized = Rules.normalizeCommand(command);
    return records().find(function (record) { return record.command === normalized; }) || null;
  }

  /* ------------------------------------------------------------------ *
   * Commands and activation
   * ------------------------------------------------------------------ */

  function parseCommands(text) {
    var rest = String(text == null ? "" : text).trim();
    var result = { builtin: null, argText: "", skills: [], unknown: [], disabled: [], blocked: [], rest: rest };
    var guard = 0;
    while (rest.charAt(0) === "/" && guard < 12) {
      guard++;
      var match = rest.match(/^\/([A-Za-z0-9_-]+)(?:\s+|$)/);
      if (!match) break;
      var raw = match[1].toLowerCase();
      if (raw === "?") raw = "help";
      var command = Rules.normalizeCommand(raw);
      var consumed = match[0].length;
      var builtin = BUILTIN_COMMANDS.find(function (item) { return item.name === command; });
      if (builtin) {
        result.builtin = builtin.name;
        result.argText = rest.slice(consumed).trim();
        result.rest = "";
        return result;
      }
      var skill = findRecord(command);
      if (skill) {
        if (skill.verdict === "blocked") result.blocked.push(skill);
        else if (skill.enabled === false) result.disabled.push(skill);
        else result.skills.push(skill);
        rest = rest.slice(consumed).trim();
        continue;
      }
      result.unknown.push(raw);
      rest = rest.slice(consumed).trim();
    }
    result.rest = rest;
    return result;
  }

  function getSlashMenu(value) {
    var text = String(value == null ? "" : value);
    var match = text.match(/(?:^|\s)\/([a-z0-9_-]*)$/i);
    if (!match) return null;
    var query = match[1].toLowerCase();
    var replaceStart = match.index + (match[0].charAt(0) === "/" ? 0 : 1);
    var used = {};
    (text.match(/(?:^|\s)\/([a-z0-9_-]+)/gi) || []).forEach(function (token) {
      used[token.trim().slice(1).toLowerCase()] = true;
    });

    var items = [];
    BUILTIN_COMMANDS.forEach(function (command) {
      if (used[command.name]) return;
      if (!command.name.startsWith(query)) return;
      items.push({ name: "/" + command.name, description: command.description, skill: false, command: command.name });
    });
    records().forEach(function (skill) {
      if (used[skill.command]) return;
      if (!skill.command.startsWith(query)) return;
      items.push({
        name: "/" + skill.command,
        description: "P" + skill.priority + " · " + skill.description + (skill.verdict === "blocked" ? " · blocked" : skill.enabled === false ? " · disabled" : ""),
        skill: true,
        command: skill.command,
        disabled: skill.enabled === false,
        blocked: skill.verdict === "blocked"
      });
    });
    if (!items.length) return null;
    return { query: query, replaceStart: replaceStart, items: items.slice(0, 8) };
  }

  function activateForTurn(options) {
    var opts = options || {};
    var config = settings();
    var explicitSkills = Array.isArray(opts.explicitSkills) ? opts.explicitSkills : [];
    var activation = Rules.activate({
      skills: records(),
      message: opts.message || "",
      explicit: explicitSkills.map(function (skill) { return skill.command; }),
      autoDetect: opts.autoDetect == null ? config.autoDetect : Boolean(opts.autoDetect),
      maxActive: config.maxActive
    });
    var context = Rules.buildContext(activation.entries, { budgetTokens: config.budgetTokens });
    var active = activation.active;
    // With no skill active, keep the owner's existing read-only tool access.
    // Once any skill is active, only its approved tools remain available.
    var tools = active.length ? Rules.unionTools(active) : ["web.read", "github.read"];
    var manifest = Rules.manifestFor(active);
    lastRun = {
      commands: active.map(function (skill) { return skill.command; }),
      tokens: context.tokens,
      at: Date.now(),
      included: context.included
    };
    renderPanelStats();
    return {
      activeSkills: active,
      entries: activation.entries,
      context: context,
      tools: tools,
      manifest: manifest,
      skipped: activation.skipped,
      budget: context.budget || config.budgetTokens
    };
  }

  function buildSystemMessage(activation) {
    return activation && activation.context ? activation.context.text : "";
  }

  function serializeSkill(record) {
    var lines = ["---", "name: " + record.name];
    if (record.description) lines.push("description: " + record.description);
    if (record.triggers.length) lines.push("triggers: " + record.triggers.join(", "));
    lines.push("priority: " + record.priority);
    if (record.requestedTools.length) lines.push("tools: " + record.requestedTools.join(", "));
    if (record.conflicts.length) lines.push("conflicts: " + record.conflicts.join(", "));
    if (record.always) lines.push("always: true");
    lines.push("---", "", record.content);
    return lines.join("\n");
  }

  var TEMPLATE = [
    "---",
    "name: My Skill",
    "description: One sentence describing the outcome this skill produces.",
    "triggers: phrase one, phrase two, phrase three",
    "priority: 50",
    "---",
    "# My Skill",
    "",
    "## When to use",
    "- The request that should activate this skill.",
    "",
    "## Steps",
    "1. First action.",
    "2. Second action.",
    "",
    "## Output",
    "- The shape of the answer.",
    "",
    "## Never",
    "- Never invent facts or sources.",
    ""
  ].join("\n");

  /* ------------------------------------------------------------------ *
   * UI helpers
   * ------------------------------------------------------------------ */

  function notify(message) {
    var text = String(message || "");
    var el = document.getElementById("skillEngineNotice");
    if (el) {
      el.textContent = text;
      el.hidden = false;
      clearTimeout(noticeTimer);
      noticeTimer = setTimeout(function () { el.hidden = true; }, 7000);
    }
    if (app && app.status) {
      try { app.status(text); } catch (error) { /* ignore */ }
    }
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function badge(text, tone) {
    return el("span", "skill-badge" + (tone ? " skill-badge-" + tone : ""), text);
  }

  function blockedMessage(skill) {
    var first = (skill.findings || []).find(function (finding) { return finding.severity === "block"; });
    return first ? first.message : "This skill failed the security check.";
  }

  function renderPanelStats() {
    var box = document.getElementById("skillEngineStats");
    if (!box) return;
    var list = records();
    var enabled = list.filter(function (skill) { return skill.enabled !== false && skill.verdict !== "blocked"; }).length;
    var config = settings();
    var run = lastRun && Date.now() - lastRun.at < 120000
      ? " · last context: " + (lastRun.commands.length ? lastRun.commands.length + " skill" + (lastRun.commands.length === 1 ? "" : "s") + " · ~" + lastRun.tokens + " tok" : "no skills")
      : "";
    box.textContent = list.length + " skill" + (list.length === 1 ? "" : "s") + " · " + enabled + " enabled · " + config.budgetTokens + " tok budget" + run;
  }

  function renderPanel() {
    records();
    var listBox = document.getElementById("skillList");
    if (!listBox) return;
    listBox.innerHTML = "";
    var list = records();
    renderPanelStats();

    if (!list.length) {
      listBox.appendChild(el("p", "skill-empty", "No skills yet. Upload a Markdown file, paste one, or restore the built-ins."));
      return;
    }

    var sorted = list.slice().sort(function (a, b) {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.command.localeCompare(b.command);
    });

    sorted.forEach(function (skill) {
      listBox.appendChild(skillCard(skill));
    });
  }

  function skillCard(skill) {
    var card = el("div", "skill-card" + (skill.verdict === "blocked" ? " skill-card-blocked" : ""));
    card.dataset.skillId = skill.id;

    var head = el("div", "skill-card-head");
    var label = el("label", "skill-toggle");
    var check = document.createElement("input");
    check.type = "checkbox";
    check.checked = skill.enabled !== false && skill.verdict !== "blocked";
    check.disabled = skill.verdict === "blocked";
    check.setAttribute("aria-label", "Enable /" + skill.command);
    check.addEventListener("change", function () {
      if (skill.verdict === "blocked") {
        check.checked = false;
        notify("Blocked: " + blockedMessage(skill));
        return;
      }
      if (check.checked && skill.verdict === "review") {
        if (!window.confirm("This skill has security warnings. Enable it anyway?\n\n" + (skill.findings[0] ? skill.findings[0].message : ""))) {
          check.checked = false;
          return;
        }
      }
      skill.enabled = check.checked;
      save();
      renderPanel();
      scheduleStrip();
      notify((check.checked ? "Enabled" : "Disabled") + " /" + skill.command);
    });
    label.appendChild(check);
    label.appendChild(el("span", "skill-name", "/" + skill.command));
    head.appendChild(label);

    var badges = el("div", "skill-badges");
    badges.appendChild(badge("P" + skill.priority, "priority"));
    badges.appendChild(badge(skill.trust === "builtin" ? "built-in" : "community", skill.trust === "builtin" ? "builtin" : "community"));
    if (skill.verdict === "blocked") badges.appendChild(badge("blocked", "danger"));
    else if (skill.verdict === "review") badges.appendChild(badge("review", "warn"));
    if (skill.lineCount > Rules.RECOMMENDED_LINES) badges.appendChild(badge("heavy", "warn"));
    if (skill.always) badges.appendChild(badge("always", "always"));
    head.appendChild(badges);

    var actions = el("div", "skill-card-actions");
    var detailsBtn = el("button", "skill-mini-btn", "Details");
    detailsBtn.type = "button";
    detailsBtn.setAttribute("aria-expanded", "false");
    var removeBtn = el("button", "skill-mini-btn skill-remove-btn", "Remove");
    removeBtn.type = "button";
    actions.appendChild(detailsBtn);
    actions.appendChild(removeBtn);
    head.appendChild(actions);
    card.appendChild(head);

    card.appendChild(el("p", "skill-desc", skill.description));

    var details = el("div", "skill-details");
    details.hidden = true;

    var meta = el("div", "skill-meta");
    meta.textContent = [
      skill.triggers.length ? "Auto triggers: " + skill.triggers.join(" · ") : "No auto triggers (invoke with /" + skill.command + ")",
      skill.lineCount + " lines · ~" + skill.tokens + " tokens",
      skill.source
    ].join("  |  ");
    details.appendChild(meta);

    if (skill.verdict !== "safe") {
      var findingsBox = el("div", "skill-findings");
      findingsBox.appendChild(el("strong", "", skill.verdict === "blocked" ? "Blocked by the security check" : "Security review"));
      var ul = el("ul", "");
      skill.findings.slice(0, 8).forEach(function (finding) {
        var li = el("li", finding.severity === "block" ? "finding-block" : "finding-warn", finding.message + (finding.line ? " (line " + finding.line + ")" : ""));
        ul.appendChild(li);
      });
      findingsBox.appendChild(ul);
      details.appendChild(findingsBox);
    } else {
      details.appendChild(el("p", "skill-ok", "No security findings. This skill cannot access secrets, authentication, or code execution."));
    }

    var toolsBox = el("div", "skill-tools");
    toolsBox.appendChild(el("span", "skill-tools-label", "Tool permissions"));
    if (!skill.requestedTools.length && !skill.unknownTools.length) {
      toolsBox.appendChild(el("span", "skill-tools-none", "None requested"));
    }
    skill.requestedTools.forEach(function (tool) {
      var meta = Rules.TOOL_CATALOG[tool];
      var toolLabel = el("label", "skill-tool");
      var toolCheck = document.createElement("input");
      toolCheck.type = "checkbox";
      toolCheck.checked = (skill.grantedTools || []).indexOf(tool) >= 0;
      toolCheck.disabled = !meta.available || skill.verdict === "blocked";
      toolCheck.addEventListener("change", function () {
        var granted = Array.isArray(skill.grantedTools) ? skill.grantedTools.slice() : [];
        if (toolCheck.checked) {
          if (granted.indexOf(tool) < 0) granted.push(tool);
        } else {
          granted = granted.filter(function (item) { return item !== tool; });
        }
        skill.grantedTools = granted;
        save();
        scheduleStrip();
        notify(toolCheck.checked ? "/" + skill.command + " may now use " + tool : "/" + skill.command + " can no longer use " + tool);
      });
      toolLabel.appendChild(toolCheck);
      toolLabel.appendChild(el("span", "", tool + (meta.available ? "" : " (not available)")));
      toolsBox.appendChild(toolLabel);
    });
    if (skill.unknownTools.length) {
      toolsBox.appendChild(el("span", "skill-tools-none", "Denied unknown tools: " + skill.unknownTools.join(", ")));
    }
    details.appendChild(toolsBox);

    var priorityRow = el("label", "skill-priority");
    priorityRow.appendChild(el("span", "", "Priority"));
    var priorityInput = document.createElement("input");
    priorityInput.type = "number";
    priorityInput.min = "0";
    priorityInput.max = "100";
    priorityInput.step = "5";
    priorityInput.value = String(skill.priority);
    priorityInput.disabled = skill.verdict === "blocked";
    priorityInput.addEventListener("change", function () {
      var value = clamp(priorityInput.value, 0, 100, skill.priority);
      priorityInput.value = String(value);
      skill.priorityOverride = value === skill.priority ? null : value;
      skill.priority = value;
      save();
      renderPanel();
      scheduleStrip();
      notify("/" + skill.command + " priority set to " + value);
    });
    priorityRow.appendChild(priorityInput);
    priorityRow.appendChild(el("span", "skill-priority-hint", "Higher wins conflicts and runs first."));
    details.appendChild(priorityRow);

    var preview = document.createElement("details");
    preview.className = "skill-preview";
    preview.appendChild(el("summary", "", "Preview instructions"));
    var pre = el("pre", "", skill.content);
    preview.appendChild(pre);
    details.appendChild(preview);

    card.appendChild(details);

    detailsBtn.addEventListener("click", function () {
      details.hidden = !details.hidden;
      detailsBtn.setAttribute("aria-expanded", String(!details.hidden));
      detailsBtn.textContent = details.hidden ? "Details" : "Hide";
    });

    removeBtn.addEventListener("click", function () {
      if (!window.confirm("Remove /" + skill.command + " from this browser?")) return;
      var state = getState();
      state.skills = records().filter(function (item) { return item.id !== skill.id; });
      save();
      renderPanel();
      scheduleStrip();
      notify("Removed /" + skill.command);
    });

    return card;
  }

  /* ------------------------------------------------------------------ *
   * Composer chips
   * ------------------------------------------------------------------ */

  function renderStrip() {
    var strip = document.getElementById("skillStrip");
    if (!strip) return;
    var input = document.getElementById("promptInput");
    var value = input ? input.value.trim() : "";
    if (!value) {
      strip.hidden = true;
      strip.innerHTML = "";
      return;
    }
    var parsed = parseCommands(value);
    var activation = activateForTurn({ message: parsed.rest || value, explicitSkills: parsed.skills });
    if (!activation.activeSkills.length) {
      strip.hidden = true;
      strip.innerHTML = "";
      return;
    }
    strip.innerHTML = "";
    strip.appendChild(el("span", "skill-strip-label", "Skills"));
    activation.activeSkills.forEach(function (skill) {
      var reason = parsed.skills.some(function (item) { return item.id === skill.id; })
        ? "invoked with /" + skill.command
        : (skill.always ? "always-on" : "auto-detected");
      var chip = el("button", "skill-chip" + (skill.trust === "builtin" ? " skill-chip-builtin" : ""));
      chip.type = "button";
      chip.title = reason + " · priority " + skill.priority + " · " + (Rules.toolsFor(skill).join(", ") || "no tools");
      chip.appendChild(el("span", "skill-chip-name", "/" + skill.command));
      chip.appendChild(el("span", "skill-chip-meta", reason.indexOf("invoked") === 0 ? "manual" : "auto"));
      chip.addEventListener("click", function () { notify("/" + skill.command + " — " + reason); });
      strip.appendChild(chip);
    });
    if (activation.context.tokens) {
      strip.appendChild(el("span", "skill-chip-total", "~" + activation.context.tokens + " tok"));
    }
    strip.hidden = false;
  }

  function scheduleStrip() {
    clearTimeout(stripTimer);
    stripTimer = setTimeout(renderStrip, 140);
  }

  /* ------------------------------------------------------------------ *
   * Import / export
   * ------------------------------------------------------------------ */

  function addSkillRecord(parsed, options) {
    var state = getState();
    if (!Array.isArray(state.skills)) state.skills = [];
    var existing = state.skills.find(function (skill) { return skill.command === parsed.command; });
    if (existing) return { status: "duplicate", skill: existing };
    if (parsed.verdict === "blocked") return { status: "rejected", skill: parsed };
    // Community skills start paused when they carry warnings, and never start
    // with tool access. The user grants tools explicitly in Details.
    parsed.grantedTools = [];
    parsed.enabled = parsed.verdict === "safe";
    state.skills.push(parsed);
    return { status: parsed.verdict === "review" ? "paused" : "added", skill: parsed };
  }

  function importText(text, fileName) {
    var parsed = Rules.parseSkill(text, { fileName: fileName || "pasted-skill.md", trust: "community" });
    return addSkillRecord(parsed);
  }

  async function importFiles(files) {
    var list = Array.from(files || []);
    var summary = { added: 0, paused: 0, duplicates: 0, rejected: [], failed: 0, oversized: 0 };
    for (var i = 0; i < list.length && i < 20; i++) {
      var file = list[i];
      if (!/\.(md|txt)$/i.test(file.name)) {
        summary.failed++;
        continue;
      }
      if (file.size > Rules.MAX_SKILL_BYTES) {
        summary.oversized++;
        continue;
      }
      var text;
      try { text = await file.text(); }
      catch (error) { summary.failed++; continue; }
      var result;
      try { result = importText(text, file.name); }
      catch (error) { summary.failed++; continue; }
      if (result.status === "added") summary.added++;
      else if (result.status === "paused") summary.paused++;
      else if (result.status === "duplicate") summary.duplicates++;
      else summary.rejected.push(file.name + ": " + blockedMessage(result.skill));
    }
    if (summary.added || summary.paused) save();
    renderPanel();
    scheduleStrip();

    var message = [];
    if (summary.added) message.push(summary.added + " skill" + (summary.added === 1 ? "" : "s") + " added");
    if (summary.paused) message.push(summary.paused + " added but paused for review");
    if (summary.duplicates) message.push(summary.duplicates + " duplicate" + (summary.duplicates === 1 ? "" : "s") + " skipped");
    if (summary.oversized) message.push(summary.oversized + " over 200 KB skipped");
    if (summary.failed) message.push(summary.failed + " unreadable or unsupported file" + (summary.failed === 1 ? "" : "s"));
    if (summary.rejected.length) message.push("Blocked: " + summary.rejected.join(" | "));
    notify(message.length ? message.join(" · ") : "No skills imported");
  }

  function exportPack() {
    if (!app || !app.download) { notify("Export is unavailable in this browser."); return; }
    var pack = {
      format: "ultron-skill-pack",
      version: 2,
      exportedAt: new Date().toISOString(),
      skills: records().map(function (skill) {
        return {
          fileName: Rules.normalizeCommand(skill.name) + ".md",
          content: serializeSkill(skill)
        };
      })
    };
    app.download(JSON.stringify(pack, null, 2), "ultron-skill-pack.json", "application/json");
    notify("Exported " + pack.skills.length + " skill" + (pack.skills.length === 1 ? "" : "s"));
  }

  async function importPack(file) {
    if (!file) return;
    var raw;
    try { raw = await file.text(); }
    catch (error) { notify("Could not read that pack."); return; }
    var data;
    try { data = JSON.parse(raw); }
    catch (error) { notify("That file is not a valid skill pack."); return; }
    var list = Array.isArray(data) ? data : data && Array.isArray(data.skills) ? data.skills : null;
    if (!list) { notify("That file is not a valid skill pack."); return; }
    var summary = { added: 0, paused: 0, duplicates: 0, rejected: [] };
    list.slice(0, 40).forEach(function (entry) {
      if (!entry) return;
      var text = typeof entry === "string" ? entry : entry.content || entry.text || "";
      if (!text) return;
      var fileName = typeof entry === "string" ? "community-skill.md" : String(entry.fileName || entry.name || "community-skill.md");
      if (!/\.(md|txt)$/i.test(fileName)) {
        summary.rejected.push(fileName + ": only .md and .txt skill files are supported");
        return;
      }
      var parsed;
      try {
        parsed = Rules.parseSkill(text, {
          fileName: fileName,
          trust: "community"
        });
      } catch (error) { return; }
      var result = addSkillRecord(parsed);
      if (result.status === "added") summary.added++;
      else if (result.status === "paused") summary.paused++;
      else if (result.status === "duplicate") summary.duplicates++;
      else summary.rejected.push(parsed.name + ": " + blockedMessage(parsed));
    });
    if (summary.added || summary.paused) save();
    renderPanel();
    scheduleStrip();
    var message = [];
    if (summary.added) message.push(summary.added + " added");
    if (summary.paused) message.push(summary.paused + " paused for review");
    if (summary.duplicates) message.push(summary.duplicates + " duplicate" + (summary.duplicates === 1 ? "" : "s") + " skipped");
    if (summary.rejected.length) message.push("Blocked: " + summary.rejected.join(" | "));
    notify(message.length ? message.join(" · ") : "No skills imported");
  }

  function restoreBuiltins() {
    var state = getState();
    var added = 0;
    BUILTINS.forEach(function (builtin) {
      var parsed = Rules.parseSkill(builtin.text, { fileName: builtin.fileName, trust: "builtin", enabled: true });
      if (!state.skills.some(function (skill) { return skill.command === parsed.command; })) {
        state.skills.push(parsed);
        added++;
      }
    });
    save();
    renderPanel();
    scheduleStrip();
    notify(added ? "Restored " + added + " built-in skill" + (added === 1 ? "" : "s") : "Built-in skills are already installed");
  }

  /* ------------------------------------------------------------------ *
   * Paste editor
   * ------------------------------------------------------------------ */

  function openEditor(prefill) {
    var box = document.getElementById("skillEditor");
    var textarea = document.getElementById("skillEditorText");
    var notice = document.getElementById("skillEditorNotice");
    if (!box || !textarea) return;
    editorOpen = true;
    box.hidden = false;
    textarea.value = prefill || TEMPLATE;
    if (notice) { notice.hidden = true; notice.textContent = ""; }
    textarea.focus();
  }

  function closeEditor() {
    var box = document.getElementById("skillEditor");
    if (box) box.hidden = true;
    editorOpen = false;
  }

  function saveEditor() {
    var textarea = document.getElementById("skillEditorText");
    var notice = document.getElementById("skillEditorNotice");
    if (!textarea) return;
    var text = textarea.value.trim();
    if (!text) { notify("Paste a skill before saving."); return; }
    var parsed;
    try { parsed = Rules.parseSkill(text, { fileName: "pasted-skill.md", trust: "community" }); }
    catch (error) { notify("Could not read that skill."); return; }
    if (parsed.verdict === "blocked") {
      if (notice) {
        notice.hidden = false;
        notice.textContent = "Blocked — " + blockedMessage(parsed) + (parsed.findings.length > 1 ? " (" + parsed.findings.length + " findings)" : "");
      }
      notify("That skill is blocked by the security check.");
      return;
    }
    var result = addSkillRecord(parsed);
    if (result.status === "duplicate") {
      if (notice) { notice.hidden = false; notice.textContent = "A skill already uses /" + parsed.command + ". Remove it first to replace it."; }
      return;
    }
    save();
    closeEditor();
    renderPanel();
    scheduleStrip();
    notify(parsed.verdict === "review"
      ? "Added /" + parsed.command + " but paused it: review the warnings before enabling."
      : "Added /" + parsed.command);
  }

  /* ------------------------------------------------------------------ *
   * Bindings
   * ------------------------------------------------------------------ */

  function bind() {
    var uploadBtn = document.getElementById("uploadSkillBtn");
    var fileInput = document.getElementById("skillFileInput");
    if (uploadBtn && fileInput) {
      uploadBtn.addEventListener("click", function () { fileInput.click(); });
      fileInput.addEventListener("change", function (event) {
        var files = event.target.files;
        fileInput.value = "";
        void importFiles(files);
      });
    }

    var packBtn = document.getElementById("importSkillPackBtn");
    var packInput = document.getElementById("skillPackInput");
    if (packBtn && packInput) {
      packBtn.addEventListener("click", function () { packInput.click(); });
      packInput.addEventListener("change", function (event) {
        var file = event.target.files && event.target.files[0];
        packInput.value = "";
        void importPack(file);
      });
    }

    var exportBtn = document.getElementById("exportSkillsBtn");
    if (exportBtn) exportBtn.addEventListener("click", exportPack);

    var restoreBtn = document.getElementById("restoreBuiltinsBtn");
    if (restoreBtn) restoreBtn.addEventListener("click", restoreBuiltins);

    var pasteBtn = document.getElementById("pasteSkillBtn");
    if (pasteBtn) pasteBtn.addEventListener("click", function () { openEditor(); });

    var templateBtn = document.getElementById("skillTemplateBtn");
    if (templateBtn) templateBtn.addEventListener("click", function () { openEditor(TEMPLATE); });

    var saveBtn = document.getElementById("skillEditorSave");
    if (saveBtn) saveBtn.addEventListener("click", saveEditor);
    var cancelBtn = document.getElementById("skillEditorCancel");
    if (cancelBtn) cancelBtn.addEventListener("click", closeEditor);
    var closeBtn = document.getElementById("skillEditorClose");
    if (closeBtn) closeBtn.addEventListener("click", closeEditor);

    var autoDetect = document.getElementById("skillAutoDetect");
    if (autoDetect) {
      autoDetect.addEventListener("change", function () {
        settings().autoDetect = autoDetect.checked;
        save();
        renderPanel();
        scheduleStrip();
        notify(autoDetect.checked ? "Automatic skill detection is on" : "Automatic skill detection is off; use /skill-name");
      });
    }

    var maxSelect = document.getElementById("skillMaxActive");
    if (maxSelect) {
      maxSelect.addEventListener("change", function () {
        settings().maxActive = clamp(maxSelect.value, 1, 5, 3);
        save();
        scheduleStrip();
        notify("Up to " + settings().maxActive + " skills per reply");
      });
    }

    var budget = document.getElementById("skillBudget");
    var budgetLabel = document.getElementById("skillBudgetLabel");
    if (budget) {
      budget.value = String(settings().budgetTokens);
      if (budgetLabel) budgetLabel.textContent = settings().budgetTokens + " tokens";
      budget.addEventListener("input", function () {
        if (budgetLabel) budgetLabel.textContent = clamp(budget.value, 300, 4000, 1200) + " tokens";
      });
      budget.addEventListener("change", function () {
        settings().budgetTokens = clamp(budget.value, 300, 4000, 1200);
        save();
        renderPanel();
        scheduleStrip();
      });
    }

    var autoBox = document.getElementById("skillAutoDetect");
    if (autoBox) autoBox.checked = settings().autoDetect;
    var maxBox = document.getElementById("skillMaxActive");
    if (maxBox) maxBox.value = String(settings().maxActive);
  }

  /* ------------------------------------------------------------------ *
   * Lifecycle
   * ------------------------------------------------------------------ */

  function init(options) {
    app = options || {};
    ensure();
    bind();
    // Keep the composer chips in sync with typing and with programmatic clears.
    var input = document.getElementById("promptInput");
    if (input) {
      input.addEventListener("input", scheduleStrip);
      input.addEventListener("focus", function () { if (editorOpen) closeEditor(); });
    }
    renderPanel();
    renderStrip();
  }

  window.SkillEngineUI = {
    init: init,
    refresh: function () { ensure(); renderPanel(); renderStrip(); },
    renderPanel: renderPanel,
    renderStrip: renderStrip,
    scheduleStrip: scheduleStrip,
    getSlashMenu: getSlashMenu,
    parseCommands: parseCommands,
    activateForTurn: activateForTurn,
    buildSystemMessage: buildSystemMessage,
    settings: settings,
    records: records,
    serializeSkill: serializeSkill,
    version: Rules.VERSION
  };
})();
