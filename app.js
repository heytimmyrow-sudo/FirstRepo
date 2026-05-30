const SUPABASE_URL = "https://jbljqusdpifdyewlenun.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_RYq_rDXqj_Ate8B66PcJEQ_a6yv1YUl";
const MESSAGES_TABLE = "threadmail_messages";
const GAME_PREFIX = "THREADLINE_GAME::";
const AI_HANDLE = "threadai";
let threads = [];

let activeThread = null;
let quotesCleaned = false;
let topicsSplit = false;
let showAllMessages = false;
let pendingGameType = "";
let settings = loadSettings();
let tutorialIndex = 0;
let showAllThreads = false;
let appUnlocked = false;

const $ = (selector) => document.querySelector(selector);

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem("threadlineSettings") || "{}");
  } catch {
    return {};
  }
}

function normalizeHandle(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 24);
}

function isValidHandle(value) {
  return /^[a-z0-9_]{3,24}$/.test(value);
}

function encodePasscode(value) {
  return btoa(unescape(encodeURIComponent(String(value || ""))));
}

function escapeHtml(value) {
  const el = document.createElement("div");
  el.textContent = String(value ?? "");
  return el.innerHTML;
}

function getHeaders(extra = {}) {
  return { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, ...extra };
}

function getGameTitle(type) {
  return {
    tic_tac_toe: "Tic-Tac-Toe",
    connect_four: "Connect Four",
    battleship: "Battleship",
    word_chain: "Word Chain",
  }[type] || "";
}

function getGameRules(type) {
  if (type === "connect_four") return "Players take turns dropping discs into columns. First to connect four wins.";
  if (type === "battleship") return "Fire at enemy waters on your turn. Sink every enemy ship to win.";
  if (type === "word_chain") return "Each new word must start with the last letter of the previous word.";
  return "Players take turns placing marks. First to get three in a row wins.";
}

function unpackBody(body) {
  const match = String(body || "").match(/^THREADLINE_GAME::([a-z_]+)\n?/);
  return { body: String(body || "").replace(/^THREADLINE_GAME::[a-z_]+\n?/, ""), game: match?.[1] || "" };
}

async function createGame(sender, recipient, type) {
  const board = type === "connect_four"
    ? Array(42).fill("")
    : type === "battleship"
      ? { size: 5, ships: { x: [0, 1, 2, 10, 11], o: [3, 4, 5, 20, 21] }, shots: { x: [], o: [] } }
      : type === "word_chain"
        ? []
        : Array(9).fill("");
  const response = await fetch(`${SUPABASE_URL}/rest/v1/threadmail_games`, {
    method: "POST",
    headers: getHeaders({ "Content-Type": "application/json", Prefer: "return=representation" }),
    body: JSON.stringify([{ type, x_handle: sender, o_handle: recipient, turn_handle: sender, board, status: "active" }]),
  });
  const payload = await response.json().catch(() => []);
  if (!response.ok || !payload[0]?.id) throw new Error("Game could not be created.");
  return payload[0].id;
}

async function sendRemoteMessage(recipient, subject, body, options = {}) {
  const sender = normalizeHandle(options.sender || settings.profile?.handle || "");
  if (!isValidHandle(sender)) throw new Error("Add a 3-24 character Threadline handle in Profile first.");
  const normalizedRecipient = normalizeHandle(recipient);
  if (!isValidHandle(normalizedRecipient)) throw new Error("Use a valid 3-24 character recipient handle.");
  const gameId = options.gameType ? await createGame(sender, normalizedRecipient, options.gameType) : null;
  const message = { sender_handle: sender, recipient_handle: normalizedRecipient, subject, body };
  if (gameId) message.game_id = gameId;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${MESSAGES_TABLE}`, {
    method: "POST",
    headers: getHeaders({ "Content-Type": "application/json", Prefer: "return=representation" }),
    body: JSON.stringify([message]),
  });
  if (!response.ok) throw new Error("Message could not be sent. Check your connection and try again.");
}

async function fetchMessages() {
  const handle = normalizeHandle(settings.profile?.handle || "");
  if (!isValidHandle(handle) || (settings.passcodeHash && !appUnlocked)) return;
  try {
    const query = `or=(sender_handle.eq.${handle},recipient_handle.eq.${handle})&order=created_at.desc&limit=200`;
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${MESSAGES_TABLE}?${query}`, { headers: getHeaders() });
    if (!response.ok) throw new Error();
    const rows = await response.json();
    const groups = new Map();
    rows.forEach((row) => {
      const other = row.sender_handle === handle ? row.recipient_handle : row.sender_handle;
      const key = `${other}|${row.subject}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    });
    threads = [...groups.entries()].map(([key, rows]) => {
      rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      const [other, title] = key.split("|");
      const latest = rows[rows.length - 1];
      const decoded = unpackBody(latest.body);
      return {
        id: key,
        title,
        people: other,
        status: "Open",
        labels: decoded.game ? `Game: ${getGameTitle(decoded.game)}` : "Live",
        urgency: "Normal",
        receipt: "Synced",
        summary: decoded.game ? `${other} shared a ${getGameTitle(decoded.game)} game.` : decoded.body.slice(0, 120),
        changed: "Synced from live messaging.",
        actions: [],
        messages: rows.map((row) => {
          const unpacked = unpackBody(row.body);
          const game = unpacked.game ? `\n\nGame invite: ${getGameTitle(unpacked.game)}` : "";
          return [row.sender_handle === handle ? "You" : row.sender_handle, new Date(row.created_at).toLocaleString(), `${unpacked.body}${game}`, unpacked.game ? "Game" : "Message"];
        }),
      };
    });
    activeThread = activeThread ? threads.find((thread) => thread.id === activeThread.id) || null : threads[0] || null;
    render();
  } catch {
    toast("Could not refresh live messages.");
  }
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  window.setTimeout(() => el.classList.remove("show"), 2200);
}

function saveSettings() {
  localStorage.setItem("threadlineSettings", JSON.stringify(settings));
  renderSettings();
}

function renderSettings() {
  const initials = settings.profile?.name
    ?.split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
  $("#profileMark").textContent = initials || "";
  if (!initials) $("#profileMark").innerHTML = '<i data-lucide="user"></i>';
  $("#emptyReaderText").textContent = settings.inbox
    ? `${settings.inbox.provider} inbox ${settings.inbox.email} is labeled as connected. Compose a message to start your first thread.`
    : "Connect an inbox or compose a message to start your first thread.";
  $("#connectInboxButton").innerHTML = settings.inbox
    ? '<i data-lucide="plug-zap"></i> Inbox connected'
    : '<i data-lucide="plug-zap"></i> Connect inbox';
  $("#themeToggle").checked = Boolean(settings.darkMode);
  document.body.classList.toggle("dark", Boolean(settings.darkMode));
  $("#appLock").hidden = !settings.passcodeHash || appUnlocked;
  if (window.lucide) window.lucide.createIcons();
}

function renderThreads() {
  const list = $("#threadList");
  if (!threads.length) {
    list.innerHTML = `<div class="thread-list-empty">
      <i data-lucide="inbox"></i>
      <strong>Your inbox is clear</strong>
      <span>New conversations will appear here.</span>
    </div>`;
    return;
  }
  const visibleThreads = showAllThreads ? threads : threads.slice(0, 4);
  const hiddenThreadCount = threads.length - visibleThreads.length;
  list.innerHTML = visibleThreads
    .map(
      (thread) => `
        <button class="thread-card ${thread.id === activeThread?.id ? "active" : ""}" data-id="${escapeHtml(thread.id)}">
          <strong>${escapeHtml(thread.title)}</strong>
          <span>${escapeHtml(thread.summary)}</span>
          <span class="thread-meta"><span>${escapeHtml(thread.people)}</span><span>${escapeHtml(thread.urgency)}</span></span>
        </button>
      `,
    )
    .join("");
  if (threads.length > 4) {
    list.insertAdjacentHTML(
      "beforeend",
      `<button class="show-more-button" id="showMoreThreadsButton">
        ${showAllThreads ? "Hide extra threads" : `Show ${hiddenThreadCount} more thread${hiddenThreadCount === 1 ? "" : "s"}`}
      </button>`,
    );
  }

  list.querySelectorAll(".thread-card").forEach((button) => {
    button.addEventListener("click", () => {
      activeThread = threads.find((thread) => String(thread.id) === button.dataset.id);
      quotesCleaned = false;
      topicsSplit = false;
      showAllMessages = false;
      render();
    });
  });
  $("#showMoreThreadsButton")?.addEventListener("click", () => {
    showAllThreads = !showAllThreads;
    renderThreads();
  });
}

function renderMessages() {
  const stack = $("#messageStack");
  const shouldCollapseThread = activeThread.messages.length >= 4;
  const visibleIndexes = showAllMessages || !shouldCollapseThread
    ? activeThread.messages.map((_, index) => index)
    : [0, 1, activeThread.messages.length - 1];
  const hiddenCount = activeThread.messages.length - visibleIndexes.length;

  const renderMessage = (index) => {
      const [sender, time, body, topic] = activeThread.messages[index];
      const cleanBody = quotesCleaned ? body.replace(/>.*$/, "").trim() : body;
      return `
        <article class="message" data-index="${index}">
          <div class="message-head">
            <div>
              <strong>${escapeHtml(sender)}</strong>
              <span class="thread-meta">${escapeHtml(time)}</span>
            </div>
            <button class="collapse-button">${index === 0 ? "Collapse" : "Expand"}</button>
          </div>
          ${topicsSplit ? `<span class="topic-tag">${escapeHtml(topic)}</span>` : ""}
          <p class="message-body ${body.includes(">") && !quotesCleaned ? "quote" : ""}">${escapeHtml(cleanBody)}</p>
        </article>
      `;
    };

  const messageMarkup = visibleIndexes.map(renderMessage);
  if (shouldCollapseThread) {
    const insertionIndex = showAllMessages ? messageMarkup.length : 2;
    messageMarkup.splice(
      insertionIndex,
      0,
      `<button class="show-more-button" id="showMoreButton">
        ${showAllMessages ? "Hide earlier messages" : `Show ${hiddenCount} more message${hiddenCount === 1 ? "" : "s"}`}
      </button>`,
    );
  }
  stack.innerHTML = messageMarkup.join("");

  stack.querySelectorAll(".message").forEach((message) => {
    if (Number(message.dataset.index) !== 0) message.classList.add("collapsed");
    message.querySelector(".collapse-button").addEventListener("click", () => {
      message.classList.toggle("collapsed");
      message.querySelector(".collapse-button").textContent = message.classList.contains("collapsed") ? "Expand" : "Collapse";
    });
  });

  $("#showMoreButton")?.addEventListener("click", () => {
    showAllMessages = !showAllMessages;
    renderMessages();
  });
}

function renderActions() {
  $("#actionItems").innerHTML = activeThread.actions
    .map((item, index) => `<label><input type="checkbox" ${index === 2 ? "checked" : ""} /> ${item}</label>`)
    .join("");
}

function renderReader() {
  const reader = document.querySelector(".reader-panel");
  const inspector = document.querySelector(".inspector-panel");
  reader.classList.toggle("is-empty", !activeThread);
  inspector.classList.toggle("is-empty", !activeThread);
  if (!activeThread) {
    $("#threadTitle").textContent = "";
    $("#threadSubtitle").textContent = "";
    $("#threadLabels").textContent = "";
    $("#summaryText").textContent = "";
    $("#messageStack").innerHTML = "";
    $("#actionItems").innerHTML = "";
    return;
  }
  $("#threadTitle").textContent = activeThread.title;
  $("#threadSubtitle").textContent = `${activeThread.people} · ${activeThread.messages.length} message${activeThread.messages.length === 1 ? "" : "s"} · read receipt ${activeThread.receipt}`;
  $("#threadLabels").textContent = activeThread.labels;
  $("#summaryText").textContent = activeThread.summary;
  const status = $("#threadStatus");
  status.textContent = activeThread.status;
  status.className = `status-pill ${activeThread.status.toLowerCase()}`;
  $("#statusSelect").value = activeThread.status;
  renderMessages();
  renderActions();
}

function render() {
  renderThreads();
  renderReader();
  $("#inboxCount").textContent = String(threads.length);
  $("#dashboardSummary").textContent = threads.length
    ? `${threads.length} active conversation${threads.length === 1 ? "" : "s"}`
    : "No inbox activity yet";
  $("#readHealth").textContent = threads.length ? "100%" : "--";
  renderSettings();
  if (window.lucide) window.lucide.createIcons();
}

function aiAction(action) {
  const responses = {
    summary: activeThread.summary,
    actions: `Found ${activeThread.actions.length} action items and synced them to the inspector.`,
    questions: "No unanswered questions found in this thread.",
    tasklist: "Converted this thread into assignable tasks with owners, due dates, and waiting-on status.",
    rewrite: "Draft rewritten as concise, warm, and direct.",
    labels: `Applied labels: ${activeThread.labels}, ${activeThread.urgency} Priority.`,
  };
  toast(responses[action]);
}

document.addEventListener("click", (event) => {
  const button = event.target.closest(".quick-actions button");
  if (button && activeThread) aiAction(button.dataset.action);
});

$("#themeToggle").addEventListener("change", (event) => {
  settings.darkMode = event.target.checked;
  saveSettings();
});

$("#changedButton").addEventListener("click", () => activeThread && toast(activeThread.changed));
$("#splitButton").addEventListener("click", () => {
  if (!activeThread) return;
  topicsSplit = !topicsSplit;
  renderMessages();
  if (window.lucide) window.lucide.createIcons();
  toast(topicsSplit ? "Thread split into topic lanes." : "Topic split hidden.");
});
$("#mergeButton").addEventListener("click", () => toast("No related conversations found."));
$("#quoteButton").addEventListener("click", () => {
  if (!activeThread) return;
  quotesCleaned = !quotesCleaned;
  renderMessages();
  toast(quotesCleaned ? "Quoted text cleaned from the conversation." : "Original quoted text restored.");
});
$("#pinButton").addEventListener("click", () => toast("Pinned the selected message to the top of the thread."));
$("#snoozeButton").addEventListener("click", () => toast("Thread snoozed until Friday morning."));
$("#approvalButton").addEventListener("click", () => toast("Approval request created."));
$("#undoSendButton").addEventListener("click", () => toast("Last send canceled. Draft restored."));
$("#shortcutButton").addEventListener("click", () => toast("Shortcuts: C compose, E resolve, S snooze, / search."));
$("#readerToolsButton").addEventListener("click", () => {
  const panel = $("#readerToolsPanel");
  panel.hidden = !panel.hidden;
  $("#readerToolsButton").setAttribute("aria-expanded", String(!panel.hidden));
});

const tutorialSteps = [
  { selector: "#composeButton", title: "Compose", text: "Start a live message to any handle. You can attach a game before sending." },
  { selector: "#semanticSearch", title: "Search", text: "Find conversations quickly as your inbox fills up." },
  { selector: "#threadAiButton", title: "ThreadAI", text: "Ask for reply help, rewrites, summaries, and ideas. Answers appear as a conversation." },
  { selector: "#profileButton", title: "Profile and passcode", text: "Set your handle here. You can also add a passcode that locks Threadline on this device." },
  { selector: ".thread-list-panel", title: "Conversations", text: "Your live messages appear here. Pick one to read it and send a reply." },
  { selector: "#readerToolsButton", title: "Extra tools", text: "Open this only when you need summaries, tasks, topic splitting, or quote cleanup." },
];

function renderTutorial() {
  document.querySelector(".tutorial-focus")?.classList.remove("tutorial-focus");
  const step = tutorialSteps[tutorialIndex];
  const target = document.querySelector(step.selector);
  target?.classList.add("tutorial-focus");
  $("#tutorialStep").textContent = `Tutorial ${tutorialIndex + 1} of ${tutorialSteps.length}`;
  $("#tutorialTitle").textContent = step.title;
  $("#tutorialText").textContent = step.text;
  $("#tutorialBackButton").hidden = tutorialIndex === 0;
  $("#tutorialNextButton").textContent = tutorialIndex === tutorialSteps.length - 1 ? "Done" : "Next";
}

function closeTutorial() {
  document.querySelector(".tutorial-focus")?.classList.remove("tutorial-focus");
  $("#tutorialLayer").hidden = true;
}

$("#tutorialButton").addEventListener("click", () => {
  tutorialIndex = 0;
  $("#tutorialLayer").hidden = false;
  renderTutorial();
});
$("#tutorialCloseButton").addEventListener("click", closeTutorial);
$("#tutorialBackButton").addEventListener("click", () => {
  tutorialIndex -= 1;
  renderTutorial();
});
$("#tutorialNextButton").addEventListener("click", () => {
  if (tutorialIndex === tutorialSteps.length - 1) {
    closeTutorial();
    return;
  }
  tutorialIndex += 1;
  renderTutorial();
});

function openSettingsDialog(dialog) {
  dialog.showModal();
  dialog.querySelector("input")?.focus();
}

document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});

document.querySelectorAll("dialog").forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
});

$("#profileButton").addEventListener("click", () => {
  $("#profileName").value = settings.profile?.name || "";
  $("#profileHandle").value = settings.profile?.handle || "";
  $("#profileEmail").value = settings.profile?.email || "";
  $("#profileWorkspace").value = settings.profile?.workspace || "";
  $("#profilePasscode").value = "";
  openSettingsDialog($("#profileDialog"));
});
$("#profileForm").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  const handle = normalizeHandle($("#profileHandle").value);
  if (!isValidHandle(handle)) {
    toast("Handle must be 3-24 letters, numbers, or underscores.");
    return;
  }
  const passcode = $("#profilePasscode").value.trim();
  const passcodeHash = passcode ? encodePasscode(passcode) : settings.passcodeHash || "";
  settings.profile = {
    name: $("#profileName").value.trim(),
    handle,
    email: $("#profileEmail").value.trim(),
    workspace: $("#profileWorkspace").value.trim(),
  };
  if (passcode) {
    settings.passcodeHash = passcodeHash;
    appUnlocked = true;
  }
  saveSettings();
  $("#profileDialog").close();
  toast("Profile saved.");
  fetchMessages();
});

$("#notificationButton").addEventListener("click", () => {
  $("#notifyReplies").checked = Boolean(settings.notifications?.replies);
  $("#notifyMentions").checked = Boolean(settings.notifications?.mentions);
  $("#notifyFollowups").checked = Boolean(settings.notifications?.followups);
  openSettingsDialog($("#notificationDialog"));
});
$("#notificationForm").addEventListener("submit", (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  settings.notifications = {
    replies: $("#notifyReplies").checked,
    mentions: $("#notifyMentions").checked,
    followups: $("#notifyFollowups").checked,
  };
  saveSettings();
  $("#notificationDialog").close();
  toast("Notification rules saved.");
});

$("#connectInboxButton").addEventListener("click", () => {
  $("#inboxEmail").value = settings.inbox?.email || settings.profile?.email || "";
  $("#inboxProvider").value = settings.inbox?.provider || "Gmail";
  openSettingsDialog($("#inboxDialog"));
});
$("#inboxForm").addEventListener("submit", (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  settings.inbox = {
    email: $("#inboxEmail").value.trim(),
    provider: $("#inboxProvider").value,
  };
  saveSettings();
  $("#inboxDialog").close();
  toast("Inbox label connected locally.");
});
document.querySelector('[title="Filters"]').addEventListener("click", () => toast(threads.length ? "Choose a filter below." : "There are no conversations to filter yet."));
function openCompose() {
  pendingGameType = "";
  $("#gameAttachLabel").textContent = "None";
  $("#composeDialog").showModal();
  $("#composeTo").focus();
}

$("#composeButton").addEventListener("click", openCompose);
$("#emptyComposeButton").addEventListener("click", openCompose);
$("#composeForm").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  const recipient = normalizeHandle($("#composeTo").value);
  const subject = $("#composeSubject").value.trim();
  const message = $("#composeMessage").value.trim();
  const body = pendingGameType ? `${GAME_PREFIX}${pendingGameType}\n${message}\n\n${getGameRules(pendingGameType)}` : message;
  try {
    await sendRemoteMessage(recipient, subject, body, { gameType: pendingGameType });
    event.currentTarget.reset();
    $("#composeDialog").close();
    pendingGameType = "";
    toast("Message sent.");
    await fetchMessages();
  } catch (error) {
    toast(error.message);
  }
});
document.querySelectorAll("[data-game]").forEach((button) => {
  button.addEventListener("click", () => {
    pendingGameType = button.dataset.game;
    $("#gameAttachLabel").textContent = getGameTitle(pendingGameType) || "None";
    if (pendingGameType && !$("#composeSubject").value.trim()) $("#composeSubject").value = `${getGameTitle(pendingGameType)} challenge`;
  });
});
$("#sendReplyButton").addEventListener("click", async () => {
  if (!activeThread || !$("#replyBox").value.trim()) return;
  try {
    await sendRemoteMessage(activeThread.people, activeThread.title, $("#replyBox").value.trim());
    $("#replyBox").value = "";
    toast("Reply sent.");
    await fetchMessages();
  } catch (error) {
    toast(error.message);
  }
});
$("#refreshButton").addEventListener("click", fetchMessages);
$("#threadAiButton").addEventListener("click", () => openSettingsDialog($("#aiDialog")));
function getBasicAiReply(prompt) {
  const text = prompt.toLowerCase();
  if (text.includes("rewrite")) return "Paste the message you want rewritten and tell me whether you want it warmer, shorter, or more direct.";
  if (text.includes("summar")) return "Open the conversation you want summarized and ask me for the key points and next steps.";
  if (text.includes("reply") || text.includes("say")) return "Paste the message you are answering and I will draft a natural reply.";
  return "I can help write replies, rewrite messages, summarize conversations, and brainstorm ideas. Tell me what you are working on.";
}

$("#aiForm").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  try {
    const prompt = $("#aiPrompt").value.trim();
    await sendRemoteMessage(AI_HANDLE, "ThreadAI", prompt);
    let reply = "";
    try {
      const response = await fetch(`${SUPABASE_URL}/functions/v1/threadmail-ai`, {
        method: "POST",
        headers: getHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ handle: settings.profile.handle, subject: "ThreadAI", message: prompt, recent: [] }),
      });
      const payload = await response.json().catch(() => ({}));
      reply = response.ok ? String(payload.reply || "") : "";
    } catch {
      reply = "";
    }
    await sendRemoteMessage(settings.profile.handle, "ThreadAI", reply || getBasicAiReply(prompt), { sender: AI_HANDLE });
    event.currentTarget.reset();
    $("#aiDialog").close();
    toast("Sent to ThreadAI.");
    await fetchMessages();
  } catch (error) {
    toast(error.message);
  }
});
$("#unlockForm").addEventListener("submit", (event) => {
  event.preventDefault();
  if (encodePasscode($("#unlockCode").value) !== settings.passcodeHash) {
    $("#lockStatus").textContent = "Wrong passcode.";
    return;
  }
  appUnlocked = true;
  $("#unlockCode").value = "";
  saveSettings();
  toast("Threadline unlocked.");
  fetchMessages();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden || !settings.passcodeHash) return;
  appUnlocked = false;
  renderSettings();
});
$("#toneButton").addEventListener("click", () => {
  $("#replyBox").value = "Thanks for the update. I will follow up with the next step shortly.";
});
$("#templateSelect").addEventListener("change", (event) => {
  if (!event.target.value) return;
  $("#replyBox").value = `Template: ${event.target.value}\n\nThanks, I have this and will follow up with the next step shortly.`;
});
$("#statusSelect").addEventListener("change", (event) => {
  if (!activeThread) return;
  activeThread.status = event.target.value;
  renderReader();
  toast(`Thread marked ${activeThread.status}.`);
});
$("#semanticSearch").addEventListener("input", (event) => {
  if (event.target.value.length > 2) toast(threads.length ? `Searching for "${event.target.value}".` : "There are no conversations to search yet.");
});

document.querySelectorAll(".nav-list button, .folder, .saved-search, .chip").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.matches(".nav-list button, .chip")) {
      button.parentElement.querySelectorAll("button").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
    }
    if (!threads.length) toast("There are no conversations here yet.");
  });
});

render();
fetchMessages();
window.setInterval(fetchMessages, 15000);
