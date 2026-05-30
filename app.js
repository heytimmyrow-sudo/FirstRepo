const threads = [];

let activeThread = null;
let quotesCleaned = false;
let topicsSplit = false;
let showAllMessages = false;
let settings = JSON.parse(localStorage.getItem("threadlineSettings") || "{}");

const $ = (selector) => document.querySelector(selector);

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
  list.innerHTML = threads
    .map(
      (thread) => `
        <button class="thread-card ${thread.id === activeThread.id ? "active" : ""}" data-id="${thread.id}">
          <strong>${thread.title}</strong>
          <span>${thread.summary}</span>
          <span class="thread-meta"><span>${thread.people}</span><span>${thread.urgency}</span></span>
        </button>
      `,
    )
    .join("");

  list.querySelectorAll(".thread-card").forEach((button) => {
    button.addEventListener("click", () => {
      activeThread = threads.find((thread) => thread.id === Number(button.dataset.id));
      quotesCleaned = false;
      topicsSplit = false;
      showAllMessages = false;
      render();
    });
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
              <strong>${sender}</strong>
              <span class="thread-meta">${time}</span>
            </div>
            <button class="collapse-button">${index === 0 ? "Collapse" : "Expand"}</button>
          </div>
          ${topicsSplit ? `<span class="topic-tag">${topic}</span>` : ""}
          <p class="message-body ${body.includes(">") && !quotesCleaned ? "quote" : ""}">${cleanBody}</p>
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
  $("#profileEmail").value = settings.profile?.email || "";
  $("#profileWorkspace").value = settings.profile?.workspace || "";
  openSettingsDialog($("#profileDialog"));
});
$("#profileForm").addEventListener("submit", (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  settings.profile = {
    name: $("#profileName").value.trim(),
    email: $("#profileEmail").value.trim(),
    workspace: $("#profileWorkspace").value.trim(),
  };
  saveSettings();
  $("#profileDialog").close();
  toast("Profile saved.");
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
  $("#composeDialog").showModal();
  $("#composeTo").focus();
}

$("#composeButton").addEventListener("click", openCompose);
$("#emptyComposeButton").addEventListener("click", openCompose);
$("#composeForm").addEventListener("submit", (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  const recipient = $("#composeTo").value.trim();
  const subject = $("#composeSubject").value.trim();
  const body = $("#composeMessage").value.trim();
  threads.unshift({
    id: Date.now(),
    title: subject,
    people: recipient,
    status: "Open",
    labels: "Sent",
    urgency: "Normal",
    receipt: "Pending",
    summary: "A newly sent conversation. AI summary will appear after replies arrive.",
    changed: "This conversation was just created.",
    actions: [],
    messages: [["You", "Just now", body, "Sent"]],
  });
  activeThread = threads[0];
  event.currentTarget.reset();
  $("#composeDialog").close();
  render();
  toast("Message sent and thread created.");
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
