const SUPABASE_URL = "https://jbljqusdpifdyewlenun.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_RYq_rDXqj_Ate8B66PcJEQ_a6yv1YUl";
const MESSAGES_TABLE = "threadmail_messages";
const GAMES_TABLE = "threadmail_games";
const TYPING_TABLE = "threadmail_typing";
const CALLS_TABLE = "threadmail_calls";
const GAME_PREFIX = "THREADLINE_GAME::";
const VOICE_NOTE_PREFIX = "THREADMAIL_VOICE_NOTE::";
const PHOTO_PREFIX = "THREADMAIL_PHOTO::";
const FILE_PREFIX = "THREADLINE_FILE::";
const CALL_LOG_PREFIX = "THREADLINE_CALL_LOG::";
const GROUP_PREFIX = "THREADLINE_GROUP::";
const AI_HANDLE = "threadai";
const ICE_SERVERS = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302", "stun:stun2.l.google.com:19302"] },
  { urls: ["turn:openrelay.metered.ca:80", "turn:openrelay.metered.ca:443", "turn:openrelay.metered.ca:443?transport=tcp"], username: "openrelayproject", credential: "openrelayproject" },
];
let threads = [];
let gameRows = [];
let typingRows = [];
let searchText = "";
let threadFilter = "All";
let initialMessageFetch = true;
let knownUnreadIds = new Set();
let voiceRecorder = null;
let voiceChunks = [];
let typingIdleTimer = null;
let lastTypingSentAt = 0;
let callSession = null;
let knownCallCandidateCounts = { caller: 0, callee: 0 };
let ringtoneAudio = null;
let ringtoneTimer = null;
let ringtoneUnlocked = false;
let serviceWorkerRegistration = null;
let voiceStartedAt = 0;
let voiceTimer = null;
let cancelVoiceNote = false;
let pendingAvatar = "";
let loggedCallIds = new Set();

let activeThread = null;
let quotesCleaned = false;
let topicsSplit = false;
let showAllMessages = false;
let pendingGameType = "";
let settings = loadSettings();
let tutorialIndex = 0;
let showAllThreads = false;
let appUnlocked = localStorage.getItem("threadlineRemembered") === "1";
let pendingResetCode = "";

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

function parsePrefixedJson(body, prefix) {
  if (!String(body || "").startsWith(prefix)) return null;
  try {
    return JSON.parse(String(body).slice(prefix.length).split("\n")[0]);
  } catch {
    return null;
  }
}

function parseRecipients(value) {
  return [...new Set(String(value || "").split(",").map(normalizeHandle).filter(Boolean))];
}

function createGroupId(members, name) {
  const seed = `${[...members].sort().join("_")}|${String(name || "").trim().toLowerCase()}`;
  let hash = 0;
  for (const character of seed) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return `group_${Math.abs(hash)}`;
}

function createMessageId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function packGroupBody(body, group) {
  return `${GROUP_PREFIX}${JSON.stringify(group)}\n${body}`;
}

function unpackGroupBody(body) {
  if (!String(body || "").startsWith(GROUP_PREFIX)) return { body: String(body || ""), group: null };
  const [meta, ...rest] = String(body).slice(GROUP_PREFIX.length).split("\n");
  try {
    return { body: rest.join("\n"), group: JSON.parse(meta) };
  } catch {
    return { body: String(body || ""), group: null };
  }
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
  if (options.gameId) message.game_id = options.gameId;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${MESSAGES_TABLE}`, {
    method: "POST",
    headers: getHeaders({ "Content-Type": "application/json", Prefer: "return=representation" }),
    body: JSON.stringify([message]),
  });
  if (!response.ok) throw new Error("Message could not be sent. Check your connection and try again.");
}

async function sendConversationMessage(recipients, subject, body, options = {}) {
  const sender = normalizeHandle(options.sender || settings.profile?.handle || "");
  const handles = [...new Set((Array.isArray(recipients) ? recipients : parseRecipients(recipients)).map(normalizeHandle).filter((handle) => handle && handle !== sender))];
  if (!handles.length) throw new Error("Add at least one other person's handle.");
  if (handles.some((handle) => !isValidHandle(handle))) throw new Error("Use valid 3-24 character handles separated by commas.");
  if (handles.length === 1 && !options.group) return sendRemoteMessage(handles[0], subject, body, options);
  if (options.gameType) throw new Error("Games are currently for two-person conversations.");
  const members = [...new Set([sender, ...(options.group?.members || []), ...handles])].sort();
  const group = {
    id: options.group?.id || createGroupId(members, options.groupName || subject),
    name: String(options.group?.name || options.groupName || subject || "Group chat").trim().slice(0, 60),
    members,
    messageId: createMessageId(),
  };
  await Promise.all(members.filter((handle) => handle !== sender).map((handle) => (
    sendRemoteMessage(handle, subject, packGroupBody(body, group), { sender, gameId: options.gameId })
  )));
}

async function fetchMessages() {
  const handle = normalizeHandle(settings.profile?.handle || "");
  if (!isValidHandle(handle) || (settings.passcodeHash && !appUnlocked)) return;
  try {
    const query = `or=(sender_handle.eq.${handle},recipient_handle.eq.${handle})&select=id,sender_handle,recipient_handle,subject,body,created_at,read_at,game_id&order=created_at.desc&limit=200`;
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${MESSAGES_TABLE}?${query}`, { headers: getHeaders() });
    if (!response.ok) throw new Error();
    const rows = await response.json();
    const groups = new Map();
    rows.forEach((row) => {
      const grouped = unpackGroupBody(row.body);
      const other = row.sender_handle === handle ? row.recipient_handle : row.sender_handle;
      const key = grouped.group?.id ? `group:${grouped.group.id}` : `${other}|${row.subject}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ ...row, group: grouped.group, display_body: grouped.body });
    });
    threads = [...groups.entries()].map(([key, rows]) => {
      rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      const group = rows.find((row) => row.group)?.group || null;
      const visibleRows = group
        ? rows.filter((row, index, all) => all.findIndex((item) => item.group?.messageId === row.group?.messageId) === index)
        : rows;
      const [other, directTitle] = key.split("|");
      const people = group ? group.members.filter((member) => member !== handle).join(", ") : other;
      const title = group?.name || directTitle;
      const latest = rows[rows.length - 1];
      const decoded = unpackBody(latest.display_body ?? latest.body);
      const game = latest.game_id ? gameRows.find((entry) => entry.id === latest.game_id) : null;
      const unread = rows.filter((row) => row.recipient_handle === handle && !row.read_at);
      return {
        id: key,
        title,
        people,
        recipients: group ? group.members.filter((member) => member !== handle) : [other],
        group,
        status: "Open",
        labels: group ? `${group.members.length} people` : game || decoded.game ? `Game: ${getGameTitle(game?.type || decoded.game)}` : "Live",
        urgency: "Normal",
        receipt: "Synced",
        summary: game || decoded.game ? `${other} shared a ${getGameTitle(game?.type || decoded.game)} game.` : decoded.body.slice(0, 120),
        changed: "Synced from live messaging.",
        actions: [],
        rows,
        gameId: [...rows].reverse().find((row) => row.game_id)?.game_id || "",
        unreadCount: unread.length,
        messages: visibleRows.map((row) => {
          const unpacked = unpackBody(row.display_body ?? row.body);
          const game = unpacked.game ? `\n\nGame invite: ${getGameTitle(unpacked.game)}` : "";
          return {
            sender: row.sender_handle === handle ? "You" : row.sender_handle,
            time: new Date(row.created_at).toLocaleString(),
            body: `${unpacked.body}${game}`,
            topic: unpacked.game ? "Game" : "Message",
            mine: row.sender_handle === handle,
            readAt: row.read_at,
          };
        }),
      };
    });
    await fetchGames(handle);
    await fetchTypingIndicators(handle);
    notifyNewUnread(rows, handle);
    activeThread = activeThread ? threads.find((thread) => thread.id === activeThread.id) || null : threads[0] || null;
    render();
  } catch {
    toast("Could not refresh live messages.");
  }
}

async function fetchGames(handle) {
  try {
    const query = `or=(x_handle.eq.${encodeURIComponent(handle)},o_handle.eq.${encodeURIComponent(handle)})&select=id,type,x_handle,o_handle,board,turn_handle,status,created_at,updated_at&order=updated_at.desc&limit=100`;
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${GAMES_TABLE}?${query}`, { headers: getHeaders() });
    const payload = await response.json().catch(() => []);
    gameRows = response.ok && Array.isArray(payload) ? payload : [];
  } catch {
    gameRows = [];
  }
}

async function fetchTypingIndicators(handle) {
  try {
    const since = new Date(Date.now() - 9000).toISOString();
    const query = `recipient_handle=eq.${encodeURIComponent(handle)}&is_typing=eq.true&updated_at=gt.${encodeURIComponent(since)}&select=sender_handle,recipient_handle,subject_key,is_typing,updated_at`;
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${TYPING_TABLE}?${query}`, { headers: getHeaders() });
    const payload = await response.json().catch(() => []);
    typingRows = response.ok && Array.isArray(payload) ? payload : [];
  } catch {
    typingRows = [];
  }
}

function notifyNewUnread(rows, handle) {
  const incoming = rows.filter((row) => row.recipient_handle === handle && !row.read_at);
  const fresh = incoming.filter((row) => !knownUnreadIds.has(row.id));
  knownUnreadIds = new Set(incoming.map((row) => row.id));
  if (initialMessageFetch) {
    initialMessageFetch = false;
    return;
  }
  if (!fresh.length || !settings.notifications?.device || !("Notification" in window) || Notification.permission !== "granted") return;
  const row = fresh[0];
  const notificationBody = unpackGroupBody(row.body).body;
  new Notification(`New Threadline message from ${row.sender_handle}`, { body: row.subject || notificationBody.slice(0, 80), icon: "threadline-icon-192.png" });
}

function getCallPeer() {
  if (!callSession?.call) return "";
  return callSession.role === "caller" ? callSession.call.callee_handle : callSession.call.caller_handle;
}

function showCallPanel({ label = "Threadline call", status = "Connecting...", incoming = false, video = false, connected = false } = {}) {
  $("#callOverlay").hidden = false;
  $("#callLabel").textContent = label;
  $("#callStatus").textContent = status;
  $("#callVideoStage").hidden = !video;
  $("#acceptCallButton").hidden = !incoming;
  $("#enableRingButton").hidden = !incoming || ringtoneUnlocked;
  $("#muteCallButton").hidden = !connected;
}

function hideCallPanel() {
  $("#callOverlay").hidden = true;
  $("#callVideoStage").hidden = true;
}

async function ensureRingtoneAudio() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return null;
  ringtoneAudio ||= new AudioContext();
  if (ringtoneAudio.state === "suspended") await ringtoneAudio.resume();
  ringtoneUnlocked = ringtoneAudio.state === "running";
  return ringtoneAudio;
}

async function playRingToneOnce() {
  try {
    const audio = await ensureRingtoneAudio();
    if (!audio) return false;
    const now = audio.currentTime;
    const gain = audio.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
    gain.connect(audio.destination);
    [740, 920].forEach((frequency, index) => {
      const oscillator = audio.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, now + index * 0.2);
      oscillator.connect(gain);
      oscillator.start(now + index * 0.2);
      oscillator.stop(now + 0.3 + index * 0.2);
    });
    return true;
  } catch {
    ringtoneUnlocked = false;
    return false;
  }
}

function startIncomingRingtone() {
  if (ringtoneTimer) return;
  playRingToneOnce().then(() => { $("#enableRingButton").hidden = ringtoneUnlocked; });
  if ("vibrate" in navigator) navigator.vibrate([220, 120, 220]);
  ringtoneTimer = window.setInterval(() => {
    playRingToneOnce().then(() => { $("#enableRingButton").hidden = ringtoneUnlocked; });
    if ("vibrate" in navigator) navigator.vibrate([220, 120, 220]);
  }, 1500);
}

function stopIncomingRingtone() {
  if (ringtoneTimer) window.clearInterval(ringtoneTimer);
  ringtoneTimer = null;
  if ("vibrate" in navigator) navigator.vibrate(0);
}

async function enableIncomingRingSound() {
  await playRingToneOnce();
  $("#enableRingButton").hidden = ringtoneUnlocked;
  $("#callStatus").textContent = ringtoneUnlocked ? "Ringing..." : "Sound is blocked. Keep this screen open for vibration.";
}

function notifyIncomingCall(call) {
  if (!settings.notifications?.device || !("Notification" in window) || Notification.permission !== "granted") return;
  const options = {
    body: `${call.caller_handle} is calling you on Threadline.`,
    icon: "threadline-icon-192.png",
    badge: "threadline-icon-192.png",
    tag: `threadline-call-${call.id}`,
    requireInteraction: true,
    data: { url: "./?incomingCall=1", callId: call.id },
  };
  if (serviceWorkerRegistration) serviceWorkerRegistration.showNotification(`Incoming ${call.call_type === "video" ? "FaceTime" : "voice call"}`, options);
  else new Notification(`Incoming ${call.call_type === "video" ? "FaceTime" : "voice call"}`, options);
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    serviceWorkerRegistration = await navigator.serviceWorker.register("./threadline-sw.js", { updateViaCache: "none" });
    await navigator.serviceWorker.ready;
  } catch {
    serviceWorkerRegistration = null;
  }
}

function renderBackgroundCallStatus() {
  const status = $("#backgroundCallStatus");
  if (!status) return;
  if (!("serviceWorker" in navigator)) {
    status.textContent = "This browser cannot receive installed-app call alerts.";
    return;
  }
  status.textContent = serviceWorkerRegistration
    ? ("PushManager" in window
      ? "Tap-to-answer alerts are installed. Closed-app delivery is ready for the pending Threadline VAPID sender."
      : "Tap-to-answer alerts are installed, but this browser does not support closed-app push.")
    : "Installed-app call alerts will finish preparing after this page reloads.";
}

async function patchCall(callId, data) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${CALLS_TABLE}?id=eq.${encodeURIComponent(callId)}`, {
    method: "PATCH",
    headers: getHeaders({ "Content-Type": "application/json", Prefer: "return=representation" }),
    body: JSON.stringify({ ...data, updated_at: new Date().toISOString() }),
  });
  const payload = await response.json().catch(() => []);
  if (!response.ok) throw new Error("Call update failed.");
  return Array.isArray(payload) ? payload[0] : payload;
}

async function fetchCall(callId) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${CALLS_TABLE}?id=eq.${encodeURIComponent(callId)}&select=*`, { headers: getHeaders() });
  const payload = await response.json().catch(() => []);
  if (!response.ok) throw new Error("Call fetch failed.");
  return Array.isArray(payload) ? payload[0] : null;
}

async function getCallMedia(mediaType) {
  if (mediaType === "voice") return navigator.mediaDevices.getUserMedia({ audio: true });
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true, video: { facingMode: "user" } });
  } catch {
    toast("Camera unavailable. Joining with microphone only.");
    return navigator.mediaDevices.getUserMedia({ audio: true });
  }
}

async function createCallPeer(role, call) {
  const mediaType = call.call_type === "video" ? "video" : "voice";
  const stream = await getCallMedia(mediaType);
  const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  if (mediaType === "video") $("#localCallVideo").srcObject = stream;
  stream.getTracks().forEach((track) => peer.addTrack(track, stream));
  peer.addEventListener("track", (event) => {
    if (mediaType === "video") $("#remoteCallVideo").srcObject = event.streams[0];
    else $("#remoteCallAudio").srcObject = event.streams[0];
  });
  peer.addEventListener("icecandidate", async (event) => {
    if (!event.candidate || !callSession?.call?.id) return;
    try {
      const fresh = await fetchCall(callSession.call.id);
      const key = role === "caller" ? "caller_candidates" : "callee_candidates";
      const candidates = Array.isArray(fresh?.[key]) ? [...fresh[key]] : [];
      candidates.push(event.candidate.toJSON());
      callSession.call = await patchCall(callSession.call.id, { [key]: candidates });
    } catch {
      toast("Call connection signal could not sync.");
    }
  });
  peer.addEventListener("connectionstatechange", () => {
    const status = peer.connectionState === "connected" ? "Connected" : peer.connectionState === "disconnected" ? "Reconnecting..." : "Connecting...";
    showCallPanel({ label: `${mediaType === "video" ? "FaceTime" : "Voice call"} with ${getCallPeer()}`, status, connected: true, video: mediaType === "video" });
  });
  return { peer, stream };
}

async function startCall(mediaType) {
  const handle = normalizeHandle(settings.profile?.handle || "");
  const callee = activeThread?.recipients?.[0] || "";
  if (!activeThread || activeThread.group) return toast("Calls are currently for two-person conversations.");
  if (!isValidHandle(handle) || !isValidHandle(callee)) return toast("Open a direct conversation and save your handle first.");
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) return toast("Calls are not supported in this browser.");
  try {
    showCallPanel({ label: `Calling ${callee}`, status: mediaType === "video" ? "Starting camera..." : "Starting microphone...", video: mediaType === "video" });
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${CALLS_TABLE}`, {
      method: "POST",
      headers: getHeaders({ "Content-Type": "application/json", Prefer: "return=representation" }),
      body: JSON.stringify([{ call_type: mediaType, caller_handle: handle, callee_handle: callee, status: "ringing" }]),
    });
    const payload = await response.json().catch(() => []);
    if (!response.ok || !payload[0]) throw new Error();
    const call = payload[0];
    const { peer, stream } = await createCallPeer("caller", call);
    callSession = { role: "caller", call, peer, stream, accepted: false, muted: false };
    knownCallCandidateCounts = { caller: 0, callee: 0 };
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    callSession.call = await patchCall(call.id, { offer: peer.localDescription.toJSON(), status: "ringing" });
    showCallPanel({ label: `Calling ${callee}`, status: "Ringing...", video: mediaType === "video" });
  } catch {
    endLocalCall();
    toast("Could not start the call.");
  }
}

async function acceptCall() {
  if (!callSession?.call || callSession.role !== "callee") return;
  stopIncomingRingtone();
  try {
    const { peer, stream } = await createCallPeer("callee", callSession.call);
    callSession.peer = peer;
    callSession.stream = stream;
    await peer.setRemoteDescription(callSession.call.offer);
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    callSession.call = await patchCall(callSession.call.id, { answer: peer.localDescription.toJSON(), status: "accepted" });
    knownCallCandidateCounts = { caller: 0, callee: 0 };
    showCallPanel({ label: `${callSession.call.call_type === "video" ? "FaceTime" : "Voice call"} with ${getCallPeer()}`, status: "Connecting...", connected: true, video: callSession.call.call_type === "video" });
  } catch {
    toast("Could not accept the call.");
    endCall();
  }
}

async function addRemoteCandidates(call) {
  if (!callSession?.peer) return;
  const key = callSession.role === "caller" ? "callee_candidates" : "caller_candidates";
  const seenKey = callSession.role === "caller" ? "callee" : "caller";
  const candidates = Array.isArray(call[key]) ? call[key] : [];
  for (const candidate of candidates.slice(knownCallCandidateCounts[seenKey])) {
    try { await callSession.peer.addIceCandidate(candidate); } catch { /* descriptions may still be syncing */ }
  }
  knownCallCandidateCounts[seenKey] = candidates.length;
}

async function pollCalls() {
  const handle = normalizeHandle(settings.profile?.handle || "");
  if (!isValidHandle(handle)) return;
  try {
    if (callSession?.call?.id) {
      const call = await fetchCall(callSession.call.id);
      if (!call) return;
      callSession.call = call;
      if (["declined", "ended"].includes(call.status)) {
        await logCallHistory(call, call.status === "declined" ? "Missed call" : `${call.call_type === "video" ? "FaceTime" : "Voice"} call ended`);
        return endLocalCall();
      }
      if (callSession.role === "caller" && call.answer && !callSession.accepted) {
        await callSession.peer.setRemoteDescription(call.answer);
        callSession.accepted = true;
      }
      await addRemoteCandidates(call);
      return;
    }
    const since = new Date(Date.now() - 60000).toISOString();
    const query = `callee_handle=eq.${encodeURIComponent(handle)}&status=eq.ringing&updated_at=gt.${encodeURIComponent(since)}&select=*&order=updated_at.desc&limit=1`;
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${CALLS_TABLE}?${query}`, { headers: getHeaders() });
    const payload = await response.json().catch(() => []);
    if (!response.ok || !payload[0]) return;
    const call = payload[0];
    callSession = { role: "callee", call, peer: null, stream: null, accepted: false, muted: false };
    knownCallCandidateCounts = { caller: 0, callee: 0 };
    showCallPanel({ label: `Incoming ${call.call_type === "video" ? "FaceTime" : "voice call"} from ${call.caller_handle}`, status: "Incoming call", incoming: true, video: call.call_type === "video" });
    startIncomingRingtone();
    notifyIncomingCall(call);
  } catch {
    // Calling is optional if the shared call table is not configured.
  }
}

function toggleCallMute() {
  if (!callSession?.stream) return;
  callSession.muted = !callSession.muted;
  callSession.stream.getAudioTracks().forEach((track) => { track.enabled = !callSession.muted; });
  $("#muteCallButton span").textContent = callSession.muted ? "Unmute" : "Mute";
}

function endLocalCall() {
  stopIncomingRingtone();
  callSession?.stream?.getTracks().forEach((track) => track.stop());
  callSession?.peer?.close();
  callSession = null;
  knownCallCandidateCounts = { caller: 0, callee: 0 };
  $("#remoteCallAudio").srcObject = null;
  $("#remoteCallVideo").srcObject = null;
  $("#localCallVideo").srcObject = null;
  $("#muteCallButton span").textContent = "Mute";
  hideCallPanel();
}

async function logCallHistory(call, label) {
  if (!call?.id || loggedCallIds.has(call.id)) return;
  loggedCallIds.add(call.id);
  const me = normalizeHandle(settings.profile?.handle || "");
  const recipient = call.caller_handle === me ? call.callee_handle : call.caller_handle;
  if (!isValidHandle(recipient)) return;
  try {
    await sendRemoteMessage(recipient, "Call history", `${CALL_LOG_PREFIX}${JSON.stringify({ type: call.call_type || "voice", label })}\n${label}`);
  } catch {
    // The call should still close even if history cannot sync.
  }
}

async function endCall() {
  const call = callSession?.call;
  const declined = callSession?.role === "callee" && !callSession.peer;
  try {
    if (call?.id) await patchCall(call.id, { status: declined ? "declined" : "ended" });
  } catch {
    // Local cleanup still matters if the network drops.
  }
  await logCallHistory(call, declined ? "Missed call" : `${call?.call_type === "video" ? "FaceTime" : "Voice"} call ended`);
  endLocalCall();
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
  if (settings.profile?.avatar) $("#profileMark").innerHTML = `<img class="avatar-image" src="${escapeHtml(settings.profile.avatar)}" alt="" />`;
  else if (!initials) $("#profileMark").innerHTML = '<i data-lucide="user"></i>';
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
  const filteredThreads = threads.filter((thread) => {
    const matchesSearch = !searchText || `${thread.title} ${thread.summary} ${thread.people}`.toLowerCase().includes(searchText);
    const matchesFilter = threadFilter === "All"
      || (threadFilter === "Sender" && thread.people)
      || (threadFilter === "Project" && thread.title.toLowerCase().includes("project"))
      || (threadFilter === "Deadline" && /deadline|due|today|tomorrow/i.test(thread.summary))
      || (threadFilter === "Status" && thread.status !== "Resolved");
    return matchesSearch && matchesFilter;
  });
  const visibleThreads = showAllThreads ? filteredThreads : filteredThreads.slice(0, 4);
  const hiddenThreadCount = filteredThreads.length - visibleThreads.length;
  if (!visibleThreads.length) {
    list.innerHTML = `<div class="thread-list-empty"><i data-lucide="search-x"></i><strong>No matching threads</strong><span>Try a different search or filter.</span></div>`;
    return;
  }
  list.innerHTML = visibleThreads
    .map(
      (thread) => `
        <button class="thread-card ${thread.id === activeThread?.id ? "active" : ""}" data-id="${escapeHtml(thread.id)}">
          <strong>${escapeHtml(thread.title)}</strong>
          ${thread.unreadCount ? `<b class="unread-badge">${thread.unreadCount}</b>` : ""}
          <span>${escapeHtml(thread.summary)}</span>
          <span class="thread-meta"><span>${escapeHtml(thread.people)}</span><span>${escapeHtml(thread.urgency)}</span></span>
        </button>
      `,
    )
    .join("");
  if (filteredThreads.length > 4) {
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
      markThreadRead(activeThread);
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
      const { sender, time, body, topic, mine, readAt } = activeThread.messages[index];
      const cleanBody = quotesCleaned ? body.replace(/>.*$/, "").trim() : body;
      return `
        <article class="message ${mine ? "from-me" : "from-them"}" data-index="${index}">
          <div class="message-head">
            <div>
              <strong>${escapeHtml(sender)}</strong>
              <span class="thread-meta">${escapeHtml(time)}</span>
            </div>
            <button class="collapse-button">${index === 0 ? "Collapse" : "Expand"}</button>
          </div>
          ${topicsSplit ? `<span class="topic-tag">${escapeHtml(topic)}</span>` : ""}
          ${renderMessageBody(cleanBody)}
          ${mine ? `<span class="message-receipt">${readAt ? "Read" : "Sent"}</span>` : ""}
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

function renderMessageBody(body) {
  const call = parsePrefixedJson(body, CALL_LOG_PREFIX);
  if (call) return `<div class="message-media"><strong>${escapeHtml(call.label || "Call ended")}</strong><button class="ghost-button call-back-button" data-call-type="${escapeHtml(call.type || "voice")}"><i data-lucide="${call.type === "video" ? "video" : "phone"}"></i> Call back</button></div>`;
  const photo = parsePrefixedJson(body, PHOTO_PREFIX);
  if (photo?.url) return `<div class="message-media"><img src="${escapeHtml(photo.url)}" alt="${escapeHtml(photo.name || "Sent photo")}" /><span>${escapeHtml(photo.name || "Photo")}</span></div>`;
  const voice = parsePrefixedJson(body, VOICE_NOTE_PREFIX);
  if (voice?.url) return `<div class="message-media"><audio controls src="${escapeHtml(voice.url)}"></audio><span>Voice note</span></div>`;
  const file = parsePrefixedJson(body, FILE_PREFIX);
  if (file?.url) return `<div class="message-media"><a class="ghost-button" href="${escapeHtml(file.url)}" download="${escapeHtml(file.name || "download")}"><i data-lucide="download"></i> ${escapeHtml(file.name || "Download file")}</a></div>`;
  return `<p class="message-body ${body.includes(">") && !quotesCleaned ? "quote" : ""}">${escapeHtml(body)}</p>`;
}

function renderActions() {
  $("#actionItems").innerHTML = activeThread.actions
    .map((item, index) => `<label><input type="checkbox" ${index === 2 ? "checked" : ""} /> ${item}</label>`)
    .join("");
}

function renderGroupInfo() {
  const section = $("#groupInfoSection");
  section.hidden = !activeThread?.group;
  if (!activeThread?.group) return;
  $("#groupNameInput").value = activeThread.group.name;
  $("#groupMembersInput").value = "";
  $("#groupMemberList").textContent = `Members: ${activeThread.group.members.join(", ")}`;
}

function activeTypingHandle() {
  if (!activeThread) return "";
  return typingRows.find((row) => activeThread.recipients.includes(row.sender_handle) && row.subject_key === activeThread.title.toLowerCase().slice(0, 120))?.sender_handle || "";
}

function renderSidebarData() {
  const lobby = $("#gameLobbyList");
  lobby.innerHTML = gameRows.length
    ? gameRows.slice(0, 6).map((game) => {
        const other = game.x_handle === settings.profile?.handle ? game.o_handle : game.x_handle;
        return `<button data-game-open="${escapeHtml(game.id)}"><i data-lucide="play"></i><span>${escapeHtml(getGameTitle(game.type))}<br><small>${escapeHtml(other)} · ${escapeHtml(game.status.replaceAll("_", " "))}</small></span></button>`;
      }).join("")
    : `<span class="sidebar-empty">No active games yet</span>`;
  $("#gameLobbyCount").textContent = String(gameRows.length);
  const contacts = [...new Set(threads.flatMap((thread) => thread.recipients || [thread.people]))].filter(Boolean);
  $("#contactList").innerHTML = contacts.length
    ? contacts.map((contact) => `<button data-contact="${escapeHtml(contact)}"><i data-lucide="user-round"></i> ${escapeHtml(contact)}</button>`).join("")
    : `<span class="sidebar-empty">Contacts appear after you message someone</span>`;
  $("#contactsCount").textContent = String(contacts.length);
  lobby.querySelectorAll("[data-game-open]").forEach((button) => button.addEventListener("click", () => {
    const thread = threads.find((item) => item.gameId === button.dataset.gameOpen);
    if (thread) activeThread = thread;
    render();
    setSidebarOpen(false);
  }));
  $("#contactList").querySelectorAll("[data-contact]").forEach((button) => button.addEventListener("click", () => {
    $("#composeTo").value = button.dataset.contact;
    openCompose();
    setSidebarOpen(false);
  }));
}

async function markThreadRead(thread) {
  if (!thread?.unreadCount) return;
  const unreadRows = thread.rows.filter((row) => row.recipient_handle === settings.profile?.handle && !row.read_at);
  const now = new Date().toISOString();
  unreadRows.forEach((row) => { row.read_at = now; });
  thread.unreadCount = 0;
  try {
    const ids = unreadRows.map((row) => encodeURIComponent(row.id)).join(",");
    await fetch(`${SUPABASE_URL}/rest/v1/${MESSAGES_TABLE}?id=in.(${ids})`, {
      method: "PATCH",
      headers: getHeaders({ "Content-Type": "application/json", Prefer: "return=minimal" }),
      body: JSON.stringify({ read_at: now }),
    });
  } catch {
    toast("Opened locally. Read receipt will retry later.");
  }
}

function renderGameBoard() {
  const panel = $("#gameBoardPanel");
  const game = activeThread?.gameId ? gameRows.find((entry) => entry.id === activeThread.gameId) : null;
  panel.hidden = !game;
  if (!game) return;
  const myHandle = settings.profile?.handle;
  const myMark = game.x_handle === myHandle ? "x" : "o";
  const canMove = game.status === "active" && game.turn_handle === myHandle;
  panel.innerHTML = `<header><div><span class="eyebrow">Game Lobby</span><h3>${escapeHtml(getGameTitle(game.type))}</h3></div><strong>${canMove ? "Your turn" : escapeHtml(game.status === "active" ? `Waiting for ${game.turn_handle}` : game.status.replaceAll("_", " "))}</strong></header><p>${escapeHtml(getGameRules(game.type))}</p><div id="activeGameSurface"></div>`;
  const surface = $("#activeGameSurface");
  if (game.type === "tic_tac_toe") {
    const board = normalizeArray(game.board, 9);
    surface.innerHTML = `<div class="game-grid tic">${board.map((mark, index) => `<button class="game-cell ${mark}" data-cell="${index}" ${!canMove || mark ? "disabled" : ""}>${mark.toUpperCase()}</button>`).join("")}</div>`;
    surface.querySelectorAll("[data-cell]").forEach((button) => button.addEventListener("click", () => playTicTacToeMove(game, Number(button.dataset.cell))));
  } else if (game.type === "connect_four") {
    const board = normalizeArray(game.board, 42);
    surface.innerHTML = `<div class="game-grid connect">${board.map((mark, index) => `<button class="game-cell ${mark}" data-column="${index % 7}" ${!canMove ? "disabled" : ""}>${mark ? "●" : ""}</button>`).join("")}</div>`;
    surface.querySelectorAll("[data-column]").forEach((button) => button.addEventListener("click", () => playConnectFourMove(game, Number(button.dataset.column))));
  } else if (game.type === "word_chain") {
    const words = Array.isArray(game.board) ? game.board : [];
    surface.innerHTML = `<div class="word-chain-list">${words.map((word) => `<span>${escapeHtml(word)}</span>`).join("") || "<span>Start the chain</span>"}</div><form id="wordChainForm"><input id="wordChainInput" placeholder="Next word" ${!canMove ? "disabled" : ""} /><button class="primary-action small" ${!canMove ? "disabled" : ""}>Play</button></form>`;
    $("#wordChainForm").addEventListener("submit", (event) => { event.preventDefault(); playWordChainMove(game, $("#wordChainInput").value); });
  } else {
    const board = normalizeBattleship(game.board);
    const enemy = myMark === "x" ? "o" : "x";
    surface.innerHTML = `<p>Tap enemy waters to fire.</p><div class="game-grid battleship">${Array.from({ length: 25 }, (_, index) => {
      const shot = board.shots[myMark].includes(index);
      const hit = shot && board.ships[enemy].includes(index);
      return `<button class="game-cell ${hit ? "hit" : shot ? "miss" : ""}" data-cell="${index}" ${!canMove || shot ? "disabled" : ""}>${hit ? "×" : shot ? "·" : ""}</button>`;
    }).join("")}</div>`;
    surface.querySelectorAll("[data-cell]").forEach((button) => button.addEventListener("click", () => playBattleshipMove(game, Number(button.dataset.cell))));
  }
}

function normalizeArray(board, size) {
  const next = Array.isArray(board) ? [...board] : [];
  while (next.length < size) next.push("");
  return next.slice(0, size);
}

function normalizeBattleship(board) {
  return board && !Array.isArray(board) ? board : { ships: { x: [0, 1, 2, 10, 11], o: [3, 4, 5, 20, 21] }, shots: { x: [], o: [] } };
}

async function saveGameMove(game, board, status, mark) {
  const nextTurn = mark === "x" ? game.o_handle : game.x_handle;
  await fetch(`${SUPABASE_URL}/rest/v1/${GAMES_TABLE}?id=eq.${encodeURIComponent(game.id)}`, {
    method: "PATCH",
    headers: getHeaders({ "Content-Type": "application/json", Prefer: "return=minimal" }),
    body: JSON.stringify({ board, status, turn_handle: status === "active" ? nextTurn : game.turn_handle, updated_at: new Date().toISOString() }),
  });
  await sendRemoteMessage(nextTurn, `${getGameTitle(game.type)} move`, `${settings.profile.handle} made a move. ${status === "active" ? "Your turn." : status.replaceAll("_", " ")}.`, { gameId: game.id });
  await fetchMessages();
}

function getTicTacToeStatus(board) {
  const wins = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (const [a,b,c] of wins) if (board[a] && board[a] === board[b] && board[a] === board[c]) return `${board[a]}_won`;
  return board.every(Boolean) ? "draw" : "active";
}

async function playTicTacToeMove(game, index) {
  const board = normalizeArray(game.board, 9);
  if (game.turn_handle !== settings.profile.handle || board[index]) return;
  const mark = game.x_handle === settings.profile.handle ? "x" : "o";
  board[index] = mark;
  await saveGameMove(game, board, getTicTacToeStatus(board), mark);
}

async function playConnectFourMove(game, column) {
  const board = normalizeArray(game.board, 42);
  if (game.turn_handle !== settings.profile.handle || board[column]) return;
  const mark = game.x_handle === settings.profile.handle ? "x" : "o";
  for (let row = 5; row >= 0; row -= 1) if (!board[row * 7 + column]) { board[row * 7 + column] = mark; break; }
  const won = board.some((cell, index) => cell && [[1,0],[0,1],[1,1],[1,-1]].some(([dc,dr]) => Array.from({ length: 4 }, (_, step) => {
    const row = Math.floor(index / 7) + dr * step;
    const col = index % 7 + dc * step;
    return row >= 0 && row < 6 && col >= 0 && col < 7 && board[row * 7 + col] === cell;
  }).every(Boolean)));
  await saveGameMove(game, board, won ? `${mark}_won` : board.every(Boolean) ? "draw" : "active", mark);
}

async function playWordChainMove(game, rawWord) {
  const words = Array.isArray(game.board) ? [...game.board] : [];
  const word = rawWord.toLowerCase().replace(/[^a-z]/g, "");
  if (word.length < 2 || words.includes(word) || (words.length && word[0] !== words.at(-1).at(-1))) return toast("Use a new word that begins with the last letter.");
  words.push(word);
  await saveGameMove(game, words, "active", game.x_handle === settings.profile.handle ? "x" : "o");
}

async function playBattleshipMove(game, index) {
  const board = normalizeBattleship(game.board);
  const mark = game.x_handle === settings.profile.handle ? "x" : "o";
  const enemy = mark === "x" ? "o" : "x";
  if (game.turn_handle !== settings.profile.handle || board.shots[mark].includes(index)) return;
  board.shots[mark].push(index);
  const won = board.ships[enemy].every((cell) => board.shots[mark].includes(cell));
  await saveGameMove(game, board, won ? `${mark}_won` : "active", mark);
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
  $("#threadSubtitle").textContent = `${activeThread.group ? `Group with ${activeThread.people}` : activeThread.people} · ${activeThread.messages.length} message${activeThread.messages.length === 1 ? "" : "s"} · read receipt ${activeThread.receipt}`;
  $("#threadLabels").textContent = activeThread.labels;
  $("#detailPresence").textContent = activeTypingHandle() ? `${activeTypingHandle()} is typing...` : "Live conversation";
  $("#summaryText").textContent = activeThread.summary;
  const status = $("#threadStatus");
  status.textContent = activeThread.status;
  status.className = `status-pill ${activeThread.status.toLowerCase()}`;
  $("#statusSelect").value = activeThread.status;
  $("#voiceCallButton").disabled = Boolean(activeThread.group);
  $("#videoCallButton").disabled = Boolean(activeThread.group);
  renderMessages();
  renderActions();
  renderGameBoard();
  renderGroupInfo();
}

function render() {
  renderThreads();
  renderReader();
  $("#inboxCount").textContent = String(threads.length);
  renderSidebarData();
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
  const callback = event.target.closest(".call-back-button");
  if (callback) startCall(callback.dataset.callType === "video" ? "video" : "voice");
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
function setSidebarOpen(open) {
  document.body.classList.toggle("sidebar-open", open);
  $("#sidebarToggleButton").setAttribute("aria-expanded", String(open));
}

$("#sidebarToggleButton").addEventListener("click", () => setSidebarOpen(!document.body.classList.contains("sidebar-open")));
$("#sidebarScrim").addEventListener("click", () => setSidebarOpen(false));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setSidebarOpen(false);
});
$("#readerToolsButton").addEventListener("click", () => {
  const panel = $("#readerToolsPanel");
  panel.hidden = !panel.hidden;
  $("#readerToolsButton").setAttribute("aria-expanded", String(!panel.hidden));
});
$("#filtersButton").addEventListener("click", () => {
  const open = document.body.classList.toggle("filters-open");
  $("#filtersButton").setAttribute("aria-expanded", String(open));
});
$("#inspectorButton").addEventListener("click", () => {
  const open = document.body.classList.toggle("inspector-open");
  $("#inspectorButton").setAttribute("aria-expanded", String(open));
  if (open) $("#inspectorPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
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
  $("#profileRecoveryEmail").value = settings.recoveryEmail || "";
  $("#profileRememberMe").checked = localStorage.getItem("threadlineRemembered") === "1";
  pendingAvatar = settings.profile?.avatar || "";
  $("#avatarPreview").innerHTML = pendingAvatar ? `<img src="${escapeHtml(pendingAvatar)}" alt="Profile preview" />` : "";
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
  const recoveryEmail = $("#profileRecoveryEmail").value.trim().toLowerCase();
  const rememberMe = $("#profileRememberMe").checked;
  const passcodeHash = passcode ? encodePasscode(passcode) : settings.passcodeHash || "";
  settings.profile = {
    name: $("#profileName").value.trim(),
    handle,
    email: $("#profileEmail").value.trim(),
    workspace: $("#profileWorkspace").value.trim(),
    avatar: pendingAvatar,
  };
  if (passcode) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recoveryEmail)) {
      toast("Add a recovery email before setting a passcode.");
      return;
    }
    settings.passcodeHash = passcodeHash;
    appUnlocked = true;
    localStorage.removeItem("threadlineRemembered");
  }
  settings.recoveryEmail = recoveryEmail;
  if (rememberMe) localStorage.setItem("threadlineRemembered", "1");
  else localStorage.removeItem("threadlineRemembered");
  saveSettings();
  $("#profileDialog").close();
  toast("Profile saved.");
  fetchMessages();
});
$("#profileAvatar").addEventListener("change", async (event) => {
  try {
    pendingAvatar = await readFileAsDataUrl(event.target.files[0], 300 * 1024);
    $("#avatarPreview").innerHTML = `<img src="${escapeHtml(pendingAvatar)}" alt="Profile preview" />`;
  } catch (error) {
    toast(error.message);
  }
});

$("#saveGroupButton").addEventListener("click", async () => {
  if (!activeThread?.group) return;
  const members = [...new Set([...activeThread.group.members, ...parseRecipients($("#groupMembersInput").value)])];
  const group = { ...activeThread.group, name: $("#groupNameInput").value.trim() || activeThread.group.name, members };
  try {
    await sendConversationMessage(members, activeThread.title, `Group updated by ${settings.profile.handle}.`, { group });
    toast("Group updated.");
    await fetchMessages();
  } catch (error) { toast(error.message); }
});
$("#leaveGroupButton").addEventListener("click", async () => {
  if (!activeThread?.group) return;
  const members = activeThread.group.members.filter((member) => member !== settings.profile.handle);
  try {
    const group = { ...activeThread.group, members, messageId: createMessageId() };
    await Promise.all(members.map((member) => sendRemoteMessage(member, activeThread.title, packGroupBody(`${settings.profile.handle} left the group.`, group))));
    activeThread = null;
    toast("You left the group.");
    await fetchMessages();
  } catch (error) { toast(error.message); }
});

function openNotificationDialog() {
  $("#notifyReplies").checked = Boolean(settings.notifications?.replies);
  $("#notifyMentions").checked = Boolean(settings.notifications?.mentions);
  $("#notifyFollowups").checked = Boolean(settings.notifications?.followups);
  $("#notifyDevice").checked = Boolean(settings.notifications?.device);
  renderBackgroundCallStatus();
  openSettingsDialog($("#notificationDialog"));
}
$("#notificationForm").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  settings.notifications = {
    replies: $("#notifyReplies").checked,
    mentions: $("#notifyMentions").checked,
    followups: $("#notifyFollowups").checked,
    device: $("#notifyDevice").checked,
  };
  if (settings.notifications.device && "Notification" in window && Notification.permission === "default") await Notification.requestPermission();
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
function openCompose() {
  pendingGameType = "";
  $("#gameAttachLabel").textContent = "None";
  $("#composeDialog").showModal();
  $("#composeTo").focus();
  updateComposeGroupState();
}

function updateComposeGroupState() {
  const isGroup = parseRecipients($("#composeTo").value).length > 1;
  document.querySelectorAll("[data-game]").forEach((button) => {
    button.disabled = isGroup && Boolean(button.dataset.game);
  });
  if (isGroup && pendingGameType) pendingGameType = "";
  $("#gameAttachLabel").textContent = isGroup ? "Two-person chats only" : getGameTitle(pendingGameType) || "None";
}

$("#composeButton").addEventListener("click", openCompose);
$("#emptyComposeButton").addEventListener("click", openCompose);
$("#composeTo").addEventListener("input", updateComposeGroupState);
$("#composeForm").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  const recipients = parseRecipients($("#composeTo").value);
  const subject = $("#composeSubject").value.trim();
  const message = $("#composeMessage").value.trim();
  const body = pendingGameType ? `${GAME_PREFIX}${pendingGameType}\n${message}\n\n${getGameRules(pendingGameType)}` : message;
  try {
    await sendConversationMessage(recipients, subject, body, { gameType: pendingGameType, groupName: $("#composeGroupName").value.trim() });
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
    await sendConversationMessage(activeThread.recipients, activeThread.title, $("#replyBox").value.trim(), { group: activeThread.group });
    $("#replyBox").value = "";
    toast("Reply sent.");
    await fetchMessages();
  } catch (error) {
    toast(error.message);
  }
});
$("#refreshButton").addEventListener("click", fetchMessages);
$("#voiceCallButton").addEventListener("click", () => startCall("voice"));
$("#videoCallButton").addEventListener("click", () => startCall("video"));
$("#acceptCallButton").addEventListener("click", acceptCall);
$("#enableRingButton").addEventListener("click", enableIncomingRingSound);
$("#muteCallButton").addEventListener("click", toggleCallMute);
$("#endCallButton").addEventListener("click", endCall);
document.addEventListener("pointerdown", () => {
  if (!ringtoneUnlocked) ensureRingtoneAudio().catch(() => {});
}, { once: true });
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
$("#forgotPasscodeButton").addEventListener("click", () => {
  $("#lockRecovery").hidden = !$("#lockRecovery").hidden;
  $("#recoveryEmailHint").textContent = settings.recoveryEmail
    ? `Reset code will be sent to ${settings.recoveryEmail}.`
    : "Add a recovery email in Profile first.";
});
$("#sendResetCodeButton").addEventListener("click", () => {
  if (!settings.recoveryEmail) {
    $("#lockStatus").textContent = "No recovery email is saved.";
    return;
  }
  pendingResetCode = String(Math.floor(100000 + Math.random() * 900000));
  $("#resetPasscodeButton").hidden = false;
  $("#lockStatus").textContent = "Enter the emailed reset code above.";
  window.location.href = `mailto:${encodeURIComponent(settings.recoveryEmail)}?subject=Threadline%20reset%20code&body=Your%20Threadline%20reset%20code%20is%20${pendingResetCode}.`;
});
$("#resetPasscodeButton").addEventListener("click", () => {
  if (!pendingResetCode || $("#unlockCode").value.trim() !== pendingResetCode) {
    $("#lockStatus").textContent = "Enter the emailed reset code above first.";
    return;
  }
  settings.passcodeHash = "";
  pendingResetCode = "";
  appUnlocked = true;
  localStorage.removeItem("threadlineRemembered");
  saveSettings();
  $("#unlockCode").value = "";
  $("#lockRecovery").hidden = true;
  toast("Passcode reset. Add a new one in Profile.");
  fetchMessages();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden || !settings.passcodeHash || localStorage.getItem("threadlineRemembered") === "1") return;
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
  searchText = event.target.value.trim().toLowerCase();
  renderThreads();
});

document.querySelectorAll(".nav-list button, .folder, .saved-search, .chip").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.matches(".nav-list button, .chip")) {
      button.parentElement.querySelectorAll("button").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
    }
    if (!threads.length) toast("There are no conversations here yet.");
    if (button.matches(".chip")) {
      threadFilter = button.textContent.trim();
      renderThreads();
    }
  });
});

async function sendTypingState(isTyping) {
  if (!activeThread || !isValidHandle(settings.profile?.handle || "")) return;
  try {
    await Promise.all(activeThread.recipients.map((recipient) => fetch(`${SUPABASE_URL}/rest/v1/${TYPING_TABLE}?on_conflict=sender_handle,recipient_handle,subject_key`, {
      method: "POST",
      headers: getHeaders({ "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify([{
        sender_handle: settings.profile.handle,
        recipient_handle: recipient,
        subject_key: activeThread.title.toLowerCase().slice(0, 120),
        is_typing: Boolean(isTyping),
        updated_at: new Date().toISOString(),
      }]),
    })));
  } catch {
    // Typing indicators are optional.
  }
}

$("#replyBox").addEventListener("input", () => {
  const now = Date.now();
  if (now - lastTypingSentAt > 1800) {
    lastTypingSentAt = now;
    sendTypingState(true);
  }
  window.clearTimeout(typingIdleTimer);
  typingIdleTimer = window.setTimeout(() => sendTypingState(false), 3500);
});

function readFileAsDataUrl(file, maxBytes) {
  if (!file || file.size > maxBytes) throw new Error(`Keep attachments under ${Math.round(maxBytes / 1024)} KB.`);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.readAsDataURL(file);
  });
}

async function sendAttachment(prefix, payload, label) {
  if (!activeThread) return toast("Open a conversation first.");
  try {
    await sendConversationMessage(activeThread.recipients, activeThread.title, `${prefix}${JSON.stringify(payload)}\n${label}`, { group: activeThread.group });
    toast(`${label} sent.`);
    await fetchMessages();
  } catch (error) {
    toast(error.message);
  }
}

$("#photoButton").addEventListener("click", () => $("#photoInput").click());
$("#fileButton").addEventListener("click", () => $("#fileInput").click());
$("#photoInput").addEventListener("change", async (event) => {
  try {
    const file = event.target.files[0];
    await sendAttachment(PHOTO_PREFIX, { url: await readFileAsDataUrl(file, 500 * 1024), name: file.name }, "Photo");
  } catch (error) { toast(error.message); }
  event.target.value = "";
});
$("#fileInput").addEventListener("change", async (event) => {
  try {
    const file = event.target.files[0];
    await sendAttachment(FILE_PREFIX, { url: await readFileAsDataUrl(file, 250 * 1024), name: file.name }, "File");
  } catch (error) { toast(error.message); }
  event.target.value = "";
});

$("#voiceNoteButton").addEventListener("click", async () => {
  if (voiceRecorder?.state === "recording") {
    voiceRecorder.stop();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast("Voice notes are not supported in this browser.");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    voiceChunks = [];
    voiceRecorder = new MediaRecorder(stream);
    voiceRecorder.ondataavailable = (event) => voiceChunks.push(event.data);
    voiceRecorder.onstop = async () => {
      window.clearInterval(voiceTimer);
      voiceTimer = null;
      $("#recordingStrip").hidden = true;
      stream.getTracks().forEach((track) => track.stop());
      $("#voiceNoteButton").classList.remove("active");
      if (cancelVoiceNote) return;
      const blob = new Blob(voiceChunks, { type: voiceRecorder.mimeType });
      if (blob.size > 500 * 1024) return toast("Keep voice notes short, under 500 KB.");
      const file = new File([blob], "voice-note.webm", { type: blob.type });
      await sendAttachment(VOICE_NOTE_PREFIX, { url: await readFileAsDataUrl(file, 500 * 1024) }, "Voice note");
    };
    cancelVoiceNote = false;
    voiceStartedAt = Date.now();
    $("#recordingStrip").hidden = false;
    $("#recordingTime").textContent = "0:00";
    voiceTimer = window.setInterval(() => {
      const seconds = Math.floor((Date.now() - voiceStartedAt) / 1000);
      $("#recordingTime").textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
      if (seconds >= 60 && voiceRecorder?.state === "recording") voiceRecorder.stop();
    }, 250);
    voiceRecorder.start();
    $("#voiceNoteButton").classList.add("active");
    toast("Recording voice note. Tap the microphone again to send.");
  } catch {
    toast("Microphone permission was not granted.");
  }
});
$("#cancelRecordingButton").addEventListener("click", () => {
  if (voiceRecorder?.state !== "recording") return;
  cancelVoiceNote = true;
  voiceRecorder.stop();
  toast("Voice note canceled.");
});

$("#inlineAiButton").addEventListener("click", () => {
  const context = activeThread ? `Help me reply in "${activeThread.title}" with ${activeThread.people}. ` : "";
  $("#aiPrompt").value = context;
  openSettingsDialog($("#aiDialog"));
});
$("#sidebarNotificationsButton").addEventListener("click", openNotificationDialog);
$("#sidebarProfileButton").addEventListener("click", () => $("#profileButton").click());
$("#installHelpButton").addEventListener("click", () => openSettingsDialog($("#installDialog")));

render();
registerServiceWorker().then(renderBackgroundCallStatus);
fetchMessages();
window.setInterval(fetchMessages, 15000);
window.setInterval(pollCalls, 2500);
