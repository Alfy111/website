import './style.css';

const { VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY } = import.meta.env;
const SYNC_INTERVAL_MS = 2000;
const TYPING_HEARTBEAT_MS = 2000;
const TYPING_IDLE_TIMEOUT_MS = 3000;
const MAX_PHOTO_SIZE_BYTES = 8 * 1024 * 1024;
const PHOTO_UPLOAD_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
]);

const status = document.querySelector('#status');
const pinPanel = document.querySelector('#pin-panel');
const pinDots = document.querySelector('#pin-dots');
const keypad = document.querySelector('#keypad');
const chatPanel = document.querySelector('#chat-panel');
const chatPlayer = document.querySelector('#chat-player');
const chatToolsPage = document.querySelector('#chat-tools-page');
const chatToolsTitle = document.querySelector('#chat-tools-title');
const searchPage = document.querySelector('#search-page');
const searchToolbar = document.querySelector('#search-toolbar');
const chatStats = document.querySelector('#chat-stats');
const toggleNotificationsButton = document.querySelector('#toggle-notifications');
const notificationWarning = document.querySelector('#notification-warning');
const typingIndicator = document.querySelector('#typing-indicator');
const messageForm = document.querySelector('#message-form');
const replyPreview = document.querySelector('#reply-preview');
const replyPreviewPlayer = document.querySelector('#reply-preview-player');
const replyPreviewText = document.querySelector('#reply-preview-text');
const cancelReplyButton = document.querySelector('#cancel-reply');
const messageInput = document.querySelector('#message');
const photoInput = document.querySelector('#photo-input');
const cameraInput = document.querySelector('#camera-input');
const choosePhotoButton = document.querySelector('#choose-photo');
const takePhotoButton = document.querySelector('#take-photo');
const scrollLatestButton = document.querySelector('#scroll-latest-button');
const messagesList = document.querySelector('#messages');
const messageSearch = document.querySelector('#message-search');
const searchResults = document.querySelector('#search-results');
const searchResultList = document.querySelector('#search-result-list');
const previousSearchResultButton = document.querySelector('#previous-search-result');
const nextSearchResultButton = document.querySelector('#next-search-result');
const photoAlbum = document.querySelector('#photo-album');
const photoAlbumGrid = document.querySelector('#photo-album-grid');
const photoAlbumCount = document.querySelector('#photo-album-count');
const chatToolPhotoCount = document.querySelector('#chat-tool-photo-count');
const quickExitButton = document.querySelector('#quick-exit');
const pinQuickExitButton = document.querySelector('#pin-quick-exit');
const messageActions = document.querySelector('#message-actions');
const messageActionsButtons = document.querySelector('.message-actions-buttons');
const photoReview = document.querySelector('#photo-review');
const photoReviewPreviews = document.querySelector('#photo-review-previews');
const photoViewer = document.querySelector('#photo-viewer');
const photoViewerImage = document.querySelector('#photo-viewer-image');

const QUICK_EXIT_URL = 'https://www.google.com/search?q=what%27s+pax+silica';
const NOTIFICATIONS_ENABLED_KEY = 'chat-notifications-enabled';
const NOTIFICATION_TITLE = 'Freeform Chat';
const REACTIONS = {
  heart: { emoji: '❤️', label: 'Heart' },
  laugh: { emoji: '😂', label: 'Laugh' },
  wow: { image: '/icons/wow-reaction.png', label: 'Wow' },
  sad: { emoji: '😢', label: 'Sad' },
  angry: { image: '/icons/angry-reaction.png', label: 'Angry' },
  like: { image: '/icons/like-reaction.png', label: 'Like' },
};
let pinDigits = '';
let currentPin;
let currentPlayer;
let syncTimer;
let typingHeartbeatTimer;
let typingIdleTimer;
let renderedMessageIds = '';
let currentMessages = [];
let followLatestMessages = true;
let replyingTo;
let serverMessages = [];
let currentPeer;
let searchQuery = '';
let searchResultIds = [];
let searchMatchIndex = 0;
let renderedSearchResults = '';
let toolsPageOpen = false;
let searchActive = false;
let returnToToolsAfterSearch = false;
let stagedPhotos = [];
let stagedPhotoReply;
let activeActionMessageId;
let suppressedMessageClickId;
let suppressedMessageClickTimer;
let activePhotoUrl;
let quickExitPointerId;
let quickExitPointerStart;
let quickExitPosition;
let suppressQuickExitClick = false;
const outgoingMessages = [];
const mediaUrlCache = new Map();
const pendingReactionActions = new Set();
let isProcessingSendQueue = false;
let isTyping = false;
let notificationsEnabled = localStorage.getItem(NOTIFICATIONS_ENABLED_KEY) === 'true';
let pushRegistration;
let longPressTimer;
let longPressMessage;
let longPressPointerId;
let longPressStartX = 0;
let longPressStartY = 0;

function setStatus(message, isError = false, isHighlighted = false) {
  if (chatPanel.hidden) {
    pinPanel.after(status);
  } else {
    notificationWarning.before(status);
  }
  status.textContent = message;
  status.dataset.error = String(isError);
  status.dataset.highlighted = String(isHighlighted);
}

function updatePinDots() {
  pinDots.replaceChildren(
    ...Array.from({ length: 4 }, (_, index) => {
      const dot = document.createElement('span');
      dot.className = `pin-dot${index < pinDigits.length ? ' pin-dot--filled' : ''}`;
      return dot;
    }),
  );
}

function getReactionDetails(reaction) {
  return REACTIONS[reaction];
}

function getReactionEntries() {
  return Object.entries(REACTIONS);
}

function appendReactionIcon(container, details) {
  if (details.image) {
    const image = document.createElement('img');
    image.className = 'reaction-icon';
    image.src = details.image;
    image.alt = '';
    image.setAttribute('aria-hidden', 'true');
    container.append(image);
    return;
  }

  const emoji = document.createElement('span');
  emoji.className = 'reaction-emoji';
  emoji.textContent = details.emoji;
  container.append(emoji);
}

function formatSeenTime(value) {
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function showPinPanel() {
  pinPanel.hidden = false;
  chatPanel.hidden = true;
  setStatus('');
}

function appendHighlightedText(container, text) {
  if (!searchQuery) {
    container.textContent = text;
    return;
  }

  const matcher = new RegExp(searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  let lastIndex = 0;
  for (const match of text.matchAll(matcher)) {
    container.append(document.createTextNode(text.slice(lastIndex, match.index)));
    const highlight = document.createElement('mark');
    highlight.textContent = match[0];
    container.append(highlight);
    lastIndex = match.index + match[0].length;
  }
  container.append(document.createTextNode(text.slice(lastIndex)));
}

function renderMessage(message, animate = false, showSeen = false) {
  const item = document.createElement('li');
  item.dataset.messageId = message.id;
  item.className = [
    'message',
    ...(message.player === currentPlayer ? ['message--own'] : []),
    ...(message.id === activeActionMessageId ? ['message--focused'] : []),
    ...(showSeen ? ['message--last'] : []),
    ...(message.mediaUrl || message.previewUrl ? ['message--has-photo'] : []),
    ...((message.mediaUrl || message.previewUrl) && !message.content ? ['message--photo-only'] : []),
    ...(animate ? ['message--entering'] : []),
  ].join(' ');

  const author = document.createElement('span');
  author.className = 'message-author';
  appendHighlightedText(author, message.player);

  if (message.replyTo) {
    const reply = document.createElement('blockquote');
    reply.className = 'message-reply';
    const replyAuthor = document.createElement('span');
    replyAuthor.className = 'message-reply-author';
    appendHighlightedText(replyAuthor, message.replyTo.player);
    const replyText = document.createElement('span');
    replyText.className = 'message-reply-text';
    appendHighlightedText(replyText, message.replyTo.content || 'Photo');
    reply.append(replyAuthor, replyText);
    item.append(reply);
  }

  if (message.mediaUrl || message.previewUrl) {
    const image = document.createElement('img');
    image.className = 'message-photo';
    image.src = message.previewUrl || message.mediaUrl;
    image.alt = 'Photo message';
    image.tabIndex = 0;
    image.setAttribute('role', 'button');
    image.setAttribute('aria-label', 'Open photo preview');
    image.loading = 'eager';
    image.addEventListener('error', () => {
      image.alt = 'Photo preview could not be loaded';
      image.classList.add('message-photo--error');
    }, { once: true });
    item.append(image);
  }

  if (message.content) {
    const body = document.createElement('p');
    body.className = 'message-body';
    appendHighlightedText(body, message.content);
    item.append(body);
  }

  const time = document.createElement('time');
  time.className = 'message-time';
  time.dateTime = message.createdAt;
  time.textContent = new Date(message.createdAt).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
  item.append(time);
  if (showSeen && message.seenAt && message.seenBy) {
    const seen = document.createElement('span');
    seen.className = 'message-seen';
    seen.textContent = `Seen by ${message.seenBy} · ${formatSeenTime(message.seenAt)}`;
    item.prepend(seen);
  }

  let deliveryIndicator;
  if (message.deliveryStatus === 'queued' || message.deliveryStatus === 'sending') {
    const delivery = document.createElement('span');
    delivery.className = 'message-delivery';
    const spinner = document.createElement('span');
    spinner.className = 'message-delivery-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    delivery.append(spinner, document.createTextNode(
      message.deliveryStatus === 'queued' ? 'Queued' : 'Sending',
    ));
    deliveryIndicator = delivery;
  } else if (message.deliveryStatus === 'failed') {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'message-delivery message-delivery--failed';
    retry.dataset.retryMessage = message.id;
    retry.textContent = 'Failed to send · tap to retry';
    deliveryIndicator = retry;
  }

  const reactions = message.reactions ?? [];
  const ownReactions = new Set(
    reactions.filter((reaction) => reaction.player === currentPlayer).map((reaction) => reaction.reaction),
  );
  const reactionControls = document.createElement('div');
  reactionControls.className = 'message-reaction-controls';

  const reactionPicker = document.createElement('div');
  reactionPicker.className = [
    'message-reaction-picker',
    ...(message.id === activeActionMessageId ? ['message-reaction-picker--open'] : []),
  ].join(' ');
  const reactionOptions = document.createElement('div');
  reactionOptions.className = 'reaction-options';
  reactionOptions.setAttribute('role', 'group');
  reactionOptions.setAttribute('aria-label', 'Choose a reaction');

  for (const [reaction, details] of getReactionEntries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'reaction-option';
    button.dataset.messageId = message.id;
    button.dataset.reaction = reaction;
    appendReactionIcon(button, details);
    button.setAttribute('aria-label', details.label);
    button.setAttribute('aria-pressed', String(ownReactions.has(reaction)));
    reactionOptions.append(button);
  }

  reactionPicker.append(reactionOptions);
  reactionControls.append(reactionPicker);

  const counts = new Map();
  for (const { reaction } of reactions) {
    counts.set(reaction, (counts.get(reaction) ?? 0) + 1);
  }
  for (const [reaction, count] of counts) {
    const details = getReactionDetails(reaction);
    if (!details) continue;

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `reaction-chip${ownReactions.has(reaction) ? ' reaction-chip--selected' : ''}`;
    chip.dataset.messageId = message.id;
    chip.dataset.reaction = reaction;
    chip.setAttribute('aria-label', `${details.label}: ${count}`);
    chip.setAttribute('aria-pressed', String(ownReactions.has(reaction)));
    appendReactionIcon(chip, details);
    chip.append(document.createTextNode(` ${count}`));
    reactionControls.append(chip);
  }

  item.prepend(author);
  if (deliveryIndicator) item.append(deliveryIndicator);
  item.append(reactionControls);
  messagesList.append(item);
  return item;
}

async function requestChat(action, pin, content, typing, extra = {}) {
  if (!VITE_SUPABASE_URL || !VITE_SUPABASE_PUBLISHABLE_KEY) {
    throw new Error('Set the Supabase URL and publishable key in .env to enable synced chat.');
  }

  let response;
  try {
    const projectUrl = VITE_SUPABASE_URL.replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
    response = await fetch(`${projectUrl}/functions/v1/private-chat`, {
      method: 'POST',
      headers: {
        apikey: VITE_SUPABASE_PUBLISHABLE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action, pin, content, isTyping: typing, ...extra }),
    });
  } catch {
    throw new Error('Could not reach the chat server. Check your connection.');
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('The chat server returned an invalid response.');
  }

  if (!response.ok) {
    throw new Error(result.error || 'The chat request failed.');
  }
  return result;
}

async function uploadPhoto(file, uploadUrl) {
  const projectUrl = VITE_SUPABASE_URL.replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  const signedUrl = new URL(uploadUrl, `${projectUrl}/storage/v1/`);
  let response;
  try {
    response = await fetch(signedUrl, {
      method: 'PUT',
      headers: {
        apikey: VITE_SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${VITE_SUPABASE_PUBLISHABLE_KEY}`,
        'Content-Type': file.type,
        'x-upsert': 'false',
      },
      body: file,
    });
  } catch {
    throw new Error('Could not upload the photo. Check your connection.');
  }

  if (!response.ok) {
    throw new Error('Could not upload the photo. Please try again.');
  }
}


async function attachPhotoUrls(messages, pin) {
  const now = Date.now();
  const paths = [...new Set(messages.map((message) => message.mediaPath).filter(Boolean))]
    .filter((path) => {
      const cached = mediaUrlCache.get(path);
      return !cached || cached.expiresAt <= now;
    });

  for (let index = 0; index < paths.length; index += 50) {
    const { photoUrls } = await requestChat('photo-urls', pin, undefined, undefined, {
      paths: paths.slice(index, index + 50),
    });
    for (const [path, url] of Object.entries(photoUrls)) {
      mediaUrlCache.set(path, { url, expiresAt: now + 50 * 60 * 1000 });
    }
  }

  return messages.map((message) => ({
    ...message,
    mediaUrl: message.mediaPath ? mediaUrlCache.get(message.mediaPath)?.url : undefined,
  }));
}

async function markMessagesSeen(messages, pin) {
  if (
    document.visibilityState !== 'visible' ||
    !messages.some((message) => message.player !== currentPlayer && !message.seenAt)
  ) {
    return messages;
  }

  const messageIds = messages
    .filter((message) => message.player !== currentPlayer && !message.seenAt)
    .map((message) => message.id);
  const { seenMessages } = await requestChat('seen', pin, undefined, undefined, { messageIds });
  if (!seenMessages?.length) return messages;

  const receipts = new Map(seenMessages.map((message) => [message.id, message]));
  return messages.map((message) => {
    const receipt = receipts.get(message.id);
    return receipt
      ? { ...message, seenBy: receipt.seenBy, seenAt: receipt.seenAt }
      : message;
  });
}

function updateReplyPreview(message) {
  replyingTo = message
    ? {
      id: message.id,
      player: message.player,
      content: message.content || (message.mediaPath || message.previewUrl ? 'Photo' : ''),
    }
    : undefined;
  replyPreview.hidden = !replyingTo;
  if (!replyingTo) return;
  replyPreviewPlayer.textContent = `Replying to ${replyingTo.player}`;
  replyPreviewText.textContent = replyingTo.content;
  messageInput.focus({ preventScroll: true });
}

cancelReplyButton.addEventListener('click', () => updateReplyPreview(null));

function updateMessages(messages, shouldScroll = false, animateNewMessages = true) {
  const previousIds = new Set(currentMessages.map((message) => message.id));
  const matchingMessages = messages.filter((message) => {
    if (!searchQuery) return true;
    const searchableText = `${message.player} ${message.content} ${message.replyTo?.player ?? ''} ${message.replyTo?.content ?? ''}`;
    return searchableText.toLocaleLowerCase().includes(searchQuery);
  });
  const previousSearchTarget = searchResultIds[searchMatchIndex];
  searchResultIds = searchQuery ? matchingMessages.map((message) => message.id) : [];
  if (!searchResultIds.length) {
    searchMatchIndex = 0;
  } else if (previousSearchTarget && searchResultIds.includes(previousSearchTarget)) {
    searchMatchIndex = searchResultIds.indexOf(previousSearchTarget);
  } else {
    searchMatchIndex = Math.min(searchMatchIndex, searchResultIds.length - 1);
  }
  updateSearchResultControls();
  const nextIds = JSON.stringify({
    searchQuery,
    messages: messages.map((message) => ({
      id: message.id,
      content: message.content,
      mediaPath: message.mediaPath ?? null,
      createdAt: message.createdAt,
      reactions: message.reactions ?? [],
      deliveryStatus: message.deliveryStatus ?? null,
      mediaUrl: message.mediaUrl ?? null,
      previewUrl: message.previewUrl ?? null,
      seenBy: message.seenBy ?? null,
      seenAt: message.seenAt ?? null,
      replyTo: message.replyTo ?? null,
    })),
  });
  currentMessages = messages;
  renderSearchResults(matchingMessages);
  if (nextIds === renderedMessageIds) return;

  const wasAtBottom = messagesList.scrollHeight - messagesList.scrollTop - messagesList.clientHeight < 32;
  messagesList.replaceChildren();
  const latestMessage = messages.at(-1);
  const latestOwnMessageId = latestMessage?.player === currentPlayer
    ? latestMessage.id
    : undefined;
  if (!messages.length) {
    const emptyState = document.createElement('li');
    emptyState.className = 'messages-empty';
    emptyState.textContent = 'No messages yet.';
    messagesList.append(emptyState);
  } else {
    messages.forEach((message) => {
      const element = renderMessage(
        message,
        animateNewMessages && !previousIds.has(message.id),
        message.id === latestOwnMessageId,
      );
      if (message.id === searchResultIds[searchMatchIndex] && searchQuery) {
        element.classList.add('message--search-current');
      }
    });
  }
  renderedMessageIds = nextIds;
  renderPhotoAlbum(messages);
  if (!messageActions.hidden && activeActionMessageId) {
    const focusedMessage = messagesList.querySelector(
      `[data-message-id="${CSS.escape(activeActionMessageId)}"]`,
    );
    if (focusedMessage) positionMessageActions(focusedMessage);
  }

  if (shouldScroll || wasAtBottom) {
    followLatestMessages = true;
    messagesList.scrollTop = messagesList.scrollHeight;
  }
  updateScrollLatestButton();
}

function updateSearchResultControls() {
  const total = searchResultIds.length;
  searchResults.textContent = !searchQuery
    ? 'Search messages'
    : total
      ? `${searchMatchIndex + 1} of ${total} results`
      : '0 results';
  previousSearchResultButton.disabled = total < 2;
  nextSearchResultButton.disabled = total < 2;
}

function formatMessageDateTime(value) {
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function renderSearchResults(messages) {
  if (!searchActive) {
    renderedSearchResults = '';
    return;
  }
  const scrollTop = searchResultList.scrollTop;
  const signature = JSON.stringify({
    query: searchQuery,
    currentId: searchResultIds[searchMatchIndex],
    messages: messages.map((message) => ({
      id: message.id,
      player: message.player,
      content: message.content,
      createdAt: message.createdAt,
      mediaUrl: message.mediaUrl ?? null,
      previewUrl: message.previewUrl ?? null,
    })),
  });
  if (signature === renderedSearchResults) return;
  renderedSearchResults = signature;
  if (!searchQuery) {
    const emptyState = document.createElement('li');
    emptyState.className = 'search-results-empty';
    emptyState.textContent = 'Type to search your messages.';
    searchResultList.replaceChildren(emptyState);
    searchResultList.scrollTop = scrollTop;
    return;
  }
  if (!messages.length) {
    const emptyState = document.createElement('li');
    emptyState.className = 'search-results-empty';
    emptyState.textContent = 'No matching messages.';
    searchResultList.replaceChildren(emptyState);
    searchResultList.scrollTop = scrollTop;
    return;
  }

  const results = messages.map((message, index) => {
    const item = document.createElement('li');
    const result = document.createElement('button');
    result.type = 'button';
    result.className = `search-result-card${index === searchMatchIndex ? ' search-result-card--current' : ''}`;
    result.dataset.searchResultId = message.id;

    const heading = document.createElement('span');
    heading.className = 'search-result-heading';
    const author = document.createElement('strong');
    appendHighlightedText(author, message.player);
    const dateTime = document.createElement('time');
    dateTime.dateTime = message.createdAt;
    dateTime.textContent = formatMessageDateTime(message.createdAt);
    heading.append(author, dateTime);

    if (message.mediaUrl || message.previewUrl) {
      const image = document.createElement('img');
      image.className = 'search-result-photo';
      image.src = message.previewUrl || message.mediaUrl;
      image.alt = 'Attached photo';
      result.append(image);
    }

    const body = document.createElement('span');
    body.className = 'search-result-message';
    appendHighlightedText(body, message.content || (message.mediaPath ? 'Photo' : ''));
    const hint = document.createElement('span');
    hint.className = 'search-result-hint';
    hint.textContent = 'Show in chat →';
    result.append(heading, body, hint);
    item.append(result);
    return item;
  });
  searchResultList.replaceChildren(...results);
  searchResultList.scrollTop = scrollTop;
}

function navigateSearchResults(direction) {
  if (!searchResultIds.length) return;
  searchMatchIndex = (searchMatchIndex + direction + searchResultIds.length) % searchResultIds.length;
  updateSearchResultControls();
  searchResultList.querySelectorAll('.search-result-card--current').forEach((result) => {
    result.classList.remove('search-result-card--current');
  });
  const resultElement = searchResultList.querySelector(
    `[data-search-result-id="${CSS.escape(searchResultIds[searchMatchIndex])}"]`,
  );
  if (!resultElement) return;
  resultElement.classList.add('search-result-card--current');
  resultElement.scrollIntoView({
    block: 'center',
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  });
}

function showMessageInChat(messageId) {
  returnToToolsAfterSearch = false;
  if (searchActive) closeSearch();
  hideChatTools();
  photoAlbum.hidden = true;
  window.requestAnimationFrame(() => {
    const messageElement = messagesList.querySelector(
      `[data-message-id="${CSS.escape(messageId)}"]`,
    );
    if (!messageElement) {
      setStatus('Could not find that message in the conversation.', true);
      return;
    }
    messageElement.scrollIntoView({
      block: 'center',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
    messageElement.classList.add('message--search-current');
    window.setTimeout(() => messageElement.classList.remove('message--search-current'), 1800);
  });
}

function renderPhotoAlbum(messages) {
  const scrollTop = photoAlbumGrid.scrollTop;
  const photos = messages.filter((message) => message.mediaUrl || message.previewUrl);
  photoAlbumCount.textContent = `${photos.length} ${photos.length === 1 ? 'photo' : 'photos'}`;
  chatToolPhotoCount.textContent = String(photos.length);
  if (!photos.length) {
    const emptyState = document.createElement('p');
    emptyState.className = 'photo-album-empty';
    emptyState.textContent = 'Photos shared in this chat will appear here.';
    photoAlbumGrid.replaceChildren(emptyState);
    return;
  }

  const tiles = photos.map((message) => {
    const tile = document.createElement('article');
    tile.className = 'photo-album-tile';
    tile.dataset.messageId = message.id;
    const previewButton = document.createElement('button');
    previewButton.type = 'button';
    previewButton.className = 'photo-album-preview';
    previewButton.setAttribute('aria-label', `Preview photo sent by ${message.player}`);
    const image = document.createElement('img');
    image.src = message.previewUrl || message.mediaUrl;
    image.alt = `Photo sent by ${message.player}`;
    image.loading = 'lazy';
    previewButton.append(image);
    const caption = document.createElement('span');
    caption.className = 'photo-album-caption';
    caption.textContent = `${message.player} · ${formatMessageDateTime(message.createdAt)}`;
    const showInChat = document.createElement('button');
    showInChat.type = 'button';
    showInChat.className = 'photo-show-in-chat';
    showInChat.dataset.showInChatId = message.id;
    showInChat.textContent = 'Show in chat';
    tile.append(previewButton, caption, showInChat);
    return tile;
  });
  photoAlbumGrid.replaceChildren(...tiles);
  photoAlbumGrid.scrollTop = scrollTop;
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function updateChatStats() {
  if (!currentPlayer || !currentPeer) return;
  const today = localDateKey(new Date());
  const todayCounts = new Map([[currentPlayer, 0], [currentPeer, 0]]);
  const activePlayersByDay = new Map();
  for (const message of serverMessages) {
    const sentAt = new Date(message.createdAt);
    const day = localDateKey(sentAt);
    if (day === today) {
      todayCounts.set(message.player, (todayCounts.get(message.player) ?? 0) + 1);
    }
    const activePlayers = activePlayersByDay.get(day) ?? new Set();
    activePlayers.add(message.player);
    activePlayersByDay.set(day, activePlayers);
  }

  const activeBothPlayers = (date) => {
    const players = activePlayersByDay.get(localDateKey(date));
    return players?.has(currentPlayer) && players?.has(currentPeer);
  };
  const currentDate = new Date();
  const streakStart = activeBothPlayers(currentDate)
    ? currentDate
    : new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate() - 1);
  let streak = 0;
  if (activeBothPlayers(streakStart)) {
    const date = new Date(streakStart);
    while (activeBothPlayers(date)) {
      streak += 1;
      date.setDate(date.getDate() - 1);
    }
  }

  chatStats.textContent =
    `${currentPlayer} sent ${todayCounts.get(currentPlayer)} · ${currentPeer} sent ${todayCounts.get(currentPeer)} today · ${streak}-day streak`;
}

function getVisibleMessages() {
  const pendingMessages = outgoingMessages.map((message) => ({
    id: message.id,
    player: currentPlayer,
    content: message.content,
    createdAt: message.createdAt,
    reactions: [],
    replyTo: message.replyTo,
    mediaPath: message.mediaPath,
    previewUrl: message.previewUrl,
    deliveryStatus: message.status,
  }));
  return [...serverMessages, ...pendingMessages].sort((first, second) =>
    first.createdAt.localeCompare(second.createdAt),
  );
}

function refreshVisibleMessages(shouldScroll = false, animateNewMessages = true) {
  updateMessages(getVisibleMessages(), shouldScroll, animateNewMessages);
}

function scrollMessagesToLatest(
  behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
) {
  followLatestMessages = true;
  const scroll = () => {
    messagesList.scrollTop = messagesList.scrollHeight;
    messagesList.scrollTo({ top: messagesList.scrollHeight, behavior });
    updateScrollLatestButton();
  };

  scroll();
  window.requestAnimationFrame(scroll);
  window.setTimeout(scroll, 300);
}

function updateScrollLatestButton() {
  const isAwayFromLatest = messagesList.scrollHeight - messagesList.scrollTop - messagesList.clientHeight > 32;
  scrollLatestButton.classList.toggle('scroll-latest-button--visible', isAwayFromLatest);
  scrollLatestButton.setAttribute('aria-hidden', String(!isAwayFromLatest));
  scrollLatestButton.tabIndex = isAwayFromLatest ? 0 : -1;
}

messagesList.addEventListener('scroll', () => {
  followLatestMessages =
    messagesList.scrollHeight - messagesList.scrollTop - messagesList.clientHeight < 32;
  updateScrollLatestButton();
}, { passive: true });

messagesList.addEventListener('load', (event) => {
  if (followLatestMessages && event.target instanceof HTMLImageElement) {
    messagesList.scrollTop = messagesList.scrollHeight;
    updateScrollLatestButton();
  }
}, true);

window.addEventListener('resize', () => {
  if (followLatestMessages && currentPin) scrollMessagesToLatest('auto');
});

window.addEventListener('pageshow', () => {
  if (currentPin) scrollMessagesToLatest('auto');
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentPin) {
    scrollMessagesToLatest('auto');
    void syncMessages(currentPin).catch((error) => {
      if (currentPin) setStatus(`Could not sync chat: ${error.message}`, true);
    });
  }
});
scrollLatestButton.addEventListener('click', () => {
  messageInput.blur();
  scrollMessagesToLatest();
});

messagesList.addEventListener('animationend', (event) => {
  if (event.animationName === 'message-enter') {
    event.target.classList.remove('message--entering');
  }
});

function updateNotificationButton() {
  toggleNotificationsButton.setAttribute('aria-checked', String(notificationsEnabled));
  toggleNotificationsButton.setAttribute(
    'aria-label',
    `Push notifications ${notificationsEnabled ? 'on' : 'off'}`,
  );
  notificationWarning.hidden = !notificationsEnabled;
}

async function syncMessages(pin, shouldScroll = false) {
  const result = await requestChat('load', pin);
  if (currentPin !== pin) return;
  let updatedMessages = await attachPhotoUrls(result.messages, pin);
  if (currentPin !== pin) return;
  updatedMessages = await markMessagesSeen(updatedMessages, pin);
  if (currentPin !== pin) return;
  for (const previous of serverMessages) {
    if (
      previous.previewUrl &&
      updatedMessages.some((message) => message.mediaPath === previous.mediaPath && message.mediaUrl)
    ) {
      URL.revokeObjectURL(previous.previewUrl);
    }
  }
  serverMessages = updatedMessages;
  updateChatStats();
  refreshVisibleMessages(shouldScroll);
  typingIndicator.textContent = result.typingPlayer ? `${result.typingPlayer} is typing` : '';
  typingIndicator.classList.toggle('is-typing', Boolean(result.typingPlayer));
  typingIndicator.hidden = !result.typingPlayer;
}

function decodeVapidPublicKey(publicKey) {
  const padding = '='.repeat((4 - (publicKey.length % 4)) % 4);
  const base64 = (publicKey + padding).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function areKeysEqual(first, second) {
  if (!first || !second || first.byteLength !== second.byteLength) return false;
  const firstBytes = new Uint8Array(first);
  const secondBytes = new Uint8Array(second);
  return firstBytes.every((byte, index) => byte === secondBytes[index]);
}

async function getPushSubscription(vapidPublicKey) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('This browser does not support web push notifications.');
  }

  pushRegistration = await navigator.serviceWorker.register('/service-worker.js');
  await navigator.serviceWorker.ready;
  let subscription = await pushRegistration.pushManager.getSubscription();
  const applicationServerKey = decodeVapidPublicKey(vapidPublicKey);
  if (subscription && !areKeysEqual(subscription.options.applicationServerKey, applicationServerKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }

  return subscription || pushRegistration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey,
  });
}

toggleNotificationsButton.addEventListener('click', async () => {
  if (notificationsEnabled) {
    try {
      if ('serviceWorker' in navigator) {
        pushRegistration ??= await navigator.serviceWorker.getRegistration('/service-worker.js');
      }
      const subscription = await pushRegistration?.pushManager.getSubscription();
      if (subscription && currentPin) {
        await requestChat('push-unsubscribe', currentPin, undefined, undefined, {
          endpoint: subscription.endpoint,
        });
        await subscription.unsubscribe();
      }
      notificationsEnabled = false;
      localStorage.setItem(NOTIFICATIONS_ENABLED_KEY, 'false');
      updateNotificationButton();
      setStatus('');
    } catch (error) {
      setStatus(`Could not disable push notifications: ${error.message}`, true);
    }
    return;
  }

  if (!currentPin) {
    setStatus('Unlock the chat before enabling notifications.', true);
    return;
  }
  if (!window.isSecureContext || !('Notification' in window)) {
    setStatus('Push notifications require HTTPS and a supported browser.', true);
    return;
  }

  try {
    const permission = Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission();
    if (permission !== 'granted') {
      setStatus('Allow notifications in your browser settings to receive alerts.', true);
      return;
    }

    const pushConfig = await requestChat('push-config', currentPin);
    const subscription = await getPushSubscription(pushConfig.vapidPublicKey);
    await requestChat('push-subscribe', currentPin, undefined, undefined, {
      subscription: subscription.toJSON(),
      notificationTitle: NOTIFICATION_TITLE,
    });
    notificationsEnabled = true;
    localStorage.setItem(NOTIFICATIONS_ENABLED_KEY, 'true');
    updateNotificationButton();
    setStatus('');
  } catch (error) {
    setStatus(`Could not enable push notifications: ${error.message}`, true);
  }
});

function updateTypingStatus(typing) {
  if (!currentPin) return;
  if (!typing) {
    window.clearTimeout(typingIdleTimer);
  }
  if (typing === isTyping) return;

  isTyping = typing;
  window.clearInterval(typingHeartbeatTimer);
  void requestChat('typing', currentPin, undefined, typing).catch((error) => {
    setStatus(`Could not update typing status: ${error.message}`, true);
  });

  if (typing) {
    typingHeartbeatTimer = window.setInterval(() => {
      if (currentPin && isTyping) {
        void requestChat('typing', currentPin, undefined, true).catch((error) => {
          setStatus(`Could not update typing status: ${error.message}`, true);
        });
      }
    }, TYPING_HEARTBEAT_MS);
  }
}

async function unlockChat(pin) {
  keypad.querySelectorAll('button').forEach((button) => {
    button.disabled = true;
  });
  setStatus('Checking PIN…');

  try {
    const result = await requestChat('load', pin);
    currentPin = pin;
    currentPlayer = result.player;
    currentPeer = result.otherPlayer;
    serverMessages = await attachPhotoUrls(result.messages, pin);
    serverMessages = await markMessagesSeen(serverMessages, pin);
    if (currentPin !== pin) return;
    chatPlayer.textContent = result.player;
    updateChatStats();
    messageInput.placeholder = `Message as ${result.player}…`;
    typingIndicator.hidden = true;
    typingIndicator.classList.remove('is-typing');
    pinPanel.hidden = true;
    chatPanel.hidden = false;
    if (quickExitPosition) {
      window.requestAnimationFrame(() => {
        if (currentPin === pin) applyQuickExitPosition(quickExitPosition.x, quickExitPosition.y);
      });
    }
    renderedMessageIds = '';
    currentMessages = [];
    refreshVisibleMessages(true, false);
    setStatus('');
    scrollMessagesToLatest('auto');
    window.clearInterval(syncTimer);
    syncTimer = window.setInterval(() => {
      void syncMessages(pin).catch((error) => {
        if (currentPin === pin) setStatus(`Could not sync chat: ${error.message}`, true);
      });
    }, SYNC_INTERVAL_MS);
    if (outgoingMessages.some((message) => message.pin === pin && message.status === 'queued')) {
      void processOutgoingMessages(pin);
    }
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    keypad.querySelectorAll('button').forEach((button) => {
      button.disabled = false;
    });
  }
}

function enterDigit(digit) {
  if (pinDigits.length >= 4) return;
  pinDigits += digit;
  updatePinDots();
  setStatus('');

  if (pinDigits.length !== 4) return;

  const pin = pinDigits;
  pinDigits = '';
  updatePinDots();
  void unlockChat(pin);
}

keypad.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;

  if (button.dataset.digit) {
    enterDigit(button.dataset.digit);
  } else if (button.dataset.action === 'backspace') {
    pinDigits = pinDigits.slice(0, -1);
    updatePinDots();
    setStatus('');
  }
});

document.addEventListener('keydown', (event) => {
  if (!pinPanel.hidden) {
    if (/^\d$/.test(event.key)) {
      enterDigit(event.key);
    } else if (event.key === 'Backspace') {
      pinDigits = pinDigits.slice(0, -1);
      updatePinDots();
      setStatus('');
    } else if (event.key === 'Escape') {
      pinDigits = '';
      updatePinDots();
      setStatus('');
    }
    return;
  }

  if (event.key === 'Escape') {
    if (!photoViewer.hidden) closePhotoViewer();
    else if (!photoReview.hidden) clearPhotoReview();
    else if (!messageActions.hidden) closeMessageActions();
    else if (!photoAlbum.hidden) {
      photoAlbum.hidden = true;
      showChatTools();
    } else if (searchActive) closeSearch();
    else if (toolsPageOpen) hideChatTools();
  }
});

messageForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const content = messageInput.value.trim();
  if (!content) {
    messageInput.blur();
    scrollMessagesToLatest();
    return;
  }
  if (!currentPin) return;

  updateTypingStatus(false);
  enqueueOutgoingMessage({
    pin: currentPin,
    content,
    replyToId: replyingTo?.id,
    replyTo: replyingTo,
  });
  updateReplyPreview(null);
  messageInput.value = '';
  updateCaptureButton();
  messageInput.focus({ preventScroll: true });
  scrollMessagesToLatest();
});

function enqueueOutgoingMessage({ pin, content, file, previewUrl, replyToId, replyTo }) {
  outgoingMessages.push({
    id: `pending-${crypto.randomUUID()}`,
    pin,
    content,
    file,
    replyToId,
    replyTo,
    mediaPath: undefined,
    previewUrl: previewUrl ?? (file ? URL.createObjectURL(file) : undefined),
    createdAt: new Date().toISOString(),
    status: 'queued',
  });
  refreshVisibleMessages(true);
  void processOutgoingMessages(pin);
}

choosePhotoButton.addEventListener('click', () => {
  photoInput.click();
});

takePhotoButton.addEventListener('click', () => {
  if (messageInput.value.trim()) {
    messageForm.requestSubmit();
    return;
  }
  cameraInput.click();
});

function updateCaptureButton() {
  const hasMessage = Boolean(messageInput.value.trim());
  takePhotoButton.classList.toggle('photo-button--send', hasMessage);
  takePhotoButton.setAttribute('aria-label', hasMessage ? 'Send message' : 'Take a photo');
  takePhotoButton.title = hasMessage ? 'Send message' : 'Take a photo';
}

function openPhotoReview(files) {
  if (!currentPin) {
    setStatus('Unlock the chat before sending photos.', true);
    return;
  }

  stagedPhotos = [];
  for (const file of files) {
    if (!PHOTO_UPLOAD_MIME_TYPES.has(file.type)) {
      setStatus('Choose a JPEG, PNG, WebP, GIF, or HEIC photo.', true);
      continue;
    }
    if (file.size > MAX_PHOTO_SIZE_BYTES) {
      setStatus('Each photo must be 8 MB or smaller.', true);
      continue;
    }

    stagedPhotos.push({ file, previewUrl: URL.createObjectURL(file) });
  }
  if (!stagedPhotos.length) return;

  stagedPhotoReply = replyingTo ? { ...replyingTo } : undefined;
  photoReviewPreviews.replaceChildren();
  for (const { file, previewUrl } of stagedPhotos) {
    const preview = document.createElement('figure');
    preview.className = 'photo-review-item';
    const image = document.createElement('img');
    image.src = previewUrl;
    image.alt = file.name || 'Photo to send';
    const caption = document.createElement('figcaption');
    caption.textContent = file.name || 'Photo';
    preview.append(image, caption);
    photoReviewPreviews.append(preview);
  }
  document.querySelector('#send-photo-review').textContent =
    `Send ${stagedPhotos.length} ${stagedPhotos.length === 1 ? 'photo' : 'photos'}`;
  photoReview.hidden = false;
}

function clearPhotoReview() {
  for (const photo of stagedPhotos) URL.revokeObjectURL(photo.previewUrl);
  stagedPhotos = [];
  stagedPhotoReply = undefined;
  photoReviewPreviews.replaceChildren();
  photoReview.hidden = true;
}

function handlePhotoSelection(event) {
  const input = event.currentTarget;
  openPhotoReview(Array.from(input.files ?? []));
  input.value = '';
}

function sendReviewedPhotos() {
  if (!currentPin || !stagedPhotos.length) return;
  const pin = currentPin;
  const replyTo = stagedPhotoReply;
  const photosToSend = stagedPhotos;
  stagedPhotos = [];
  stagedPhotoReply = undefined;
  photoReviewPreviews.replaceChildren();
  photoReview.hidden = true;

  for (const { file, previewUrl } of photosToSend) {
    enqueueOutgoingMessage({
      pin,
      content: '',
      file,
      previewUrl,
      replyToId: replyTo?.id,
      replyTo,
    });
  }
  if (replyTo) updateReplyPreview(null);
  updateTypingStatus(false);
}

photoInput.addEventListener('change', handlePhotoSelection);
cameraInput.addEventListener('change', handlePhotoSelection);
document.querySelector('#send-photo-review').addEventListener('click', sendReviewedPhotos);
document.querySelector('#cancel-photo-review').addEventListener('click', clearPhotoReview);
document.querySelector('#photo-review-backdrop').addEventListener('click', clearPhotoReview);

function openMessageActions(element) {
  const message = currentMessages.find((item) => item.id === element.dataset.messageId);
  if (!message) return;
  if (swipeMessage) swipeMessage.style.transform = '';
  swipeMessage = undefined;
  swipePointerId = undefined;
  activeActionMessageId = message.id;
  suppressedMessageClickId = message.id;
  window.clearTimeout(suppressedMessageClickTimer);
  suppressedMessageClickTimer = window.setTimeout(() => {
    suppressedMessageClickId = undefined;
  }, 700);
  element.classList.add('message--focused');
  messageActions.hidden = false;
  positionMessageActions(element);
  openReactionPicker(element);
}

function positionMessageActions(messageElement) {
  const messageBounds = messageElement.getBoundingClientRect();
  const panelBounds = chatPanel.getBoundingClientRect();
  const actionsBounds = messageActionsButtons.getBoundingClientRect();
  const centerY = messageBounds.top - panelBounds.top + messageBounds.height / 2;
  const gap = 12;
  const canPlaceRight = panelBounds.right - messageBounds.right >= actionsBounds.width + gap;
  const left = canPlaceRight
    ? messageBounds.right - panelBounds.left + gap
    : messageBounds.left - panelBounds.left - actionsBounds.width - gap;
  const maxLeft = Math.max(8, panelBounds.width - actionsBounds.width - 8);
  const top = Math.max(
    8,
    Math.min(centerY - actionsBounds.height / 2, panelBounds.height - actionsBounds.height - 8),
  );
  messageActionsButtons.style.left = `${Math.max(8, Math.min(left, maxLeft))}px`;
  messageActionsButtons.style.top = `${top}px`;
}

function closeMessageActions() {
  messageActions.hidden = true;
  closeReactionPickers();
  messagesList.querySelector('.message--focused')?.classList.remove('message--focused');
  activeActionMessageId = undefined;
}

function openPhotoViewer(photo) {
  activePhotoUrl = photo.currentSrc || photo.src;
  photoViewerImage.src = activePhotoUrl;
  photoViewer.hidden = false;
}

function closePhotoViewer() {
  photoViewer.hidden = true;
  photoViewerImage.removeAttribute('src');
  activePhotoUrl = undefined;
}

async function downloadPhoto() {
  if (!activePhotoUrl) return;
  try {
    const response = await fetch(activePhotoUrl);
    if (!response.ok) throw new Error('The image could not be downloaded.');
    const imageBlob = await response.blob();
    const downloadUrl = URL.createObjectURL(imageBlob);
    const sourcePath = activePhotoUrl.split('?')[0];
    const fileName = sourcePath.split('/').pop() || 'chat-photo';
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
  } catch (error) {
    setStatus(`Could not download photo: ${error.message}`, true);
  }
}

messagesList.addEventListener('click', (event) => {
  const photo = event.target.closest('.message-photo');
  if (!photo) return;
  if (photo.closest('.message')?.dataset.messageId === suppressedMessageClickId) {
    event.preventDefault();
    event.stopPropagation();
    suppressedMessageClickId = undefined;
    window.clearTimeout(suppressedMessageClickTimer);
    return;
  }
  openPhotoViewer(photo);
});
messagesList.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const photo = event.target.closest('.message-photo');
  if (!photo) return;
  event.preventDefault();
  openPhotoViewer(photo);
});

document.querySelector('#message-actions-backdrop').addEventListener('click', closeMessageActions);
document.querySelector('#reply-to-message').addEventListener('click', () => {
  const message = currentMessages.find((item) => item.id === activeActionMessageId);
  closeMessageActions();
  if (message) updateReplyPreview(message);
});
document.querySelector('#copy-message').addEventListener('click', async () => {
  const message = currentMessages.find((item) => item.id === activeActionMessageId);
  if (!message) return;
  try {
    await navigator.clipboard.writeText(message.content || 'Photo');
    closeMessageActions();
    setStatus('Message copied.');
  } catch (error) {
    setStatus(`Could not copy message: ${error.message}`, true);
  }
});
document.querySelector('#photo-viewer-backdrop').addEventListener('click', closePhotoViewer);
document.querySelector('#close-photo-viewer').addEventListener('click', closePhotoViewer);
document.querySelector('#download-photo').addEventListener('click', () => {
  void downloadPhoto();
});

messageSearch.addEventListener('input', () => {
  searchQuery = messageSearch.value.trim().toLocaleLowerCase();
  searchMatchIndex = 0;
  searchResultIds = [];
  refreshVisibleMessages();
});
previousSearchResultButton.addEventListener('click', () => navigateSearchResults(-1));
nextSearchResultButton.addEventListener('click', () => navigateSearchResults(1));

function showChatTools() {
  toolsPageOpen = true;
  chatToolsPage.hidden = false;
  chatToolsTitle.textContent = currentPlayer;
}

function hideChatTools() {
  toolsPageOpen = false;
  chatToolsPage.hidden = true;
}

function openSearch() {
  hideChatTools();
  returnToToolsAfterSearch = true;
  searchActive = true;
  searchPage.hidden = false;
  refreshVisibleMessages();
  messageSearch.focus({ preventScroll: true });
}

function closeSearch() {
  searchActive = false;
  searchPage.hidden = true;
  renderedSearchResults = '';
  messageSearch.value = '';
  searchQuery = '';
  searchResultIds = [];
  searchMatchIndex = 0;
  refreshVisibleMessages();
  if (returnToToolsAfterSearch) showChatTools();
}

chatPlayer.addEventListener('click', showChatTools);
document.querySelector('#close-chat-tools').addEventListener('click', hideChatTools);
document.querySelector('#open-search').addEventListener('click', openSearch);
document.querySelector('#close-search').addEventListener('click', closeSearch);
document.querySelector('#open-photo-album').addEventListener('click', () => {
  renderPhotoAlbum(getVisibleMessages());
  hideChatTools();
  photoAlbum.hidden = false;
});
document.querySelector('#close-photo-album').addEventListener('click', () => {
  photoAlbum.hidden = true;
  if (currentPin) showChatTools();
});
photoAlbumGrid.addEventListener('click', (event) => {
  const showInChatButton = event.target.closest('[data-show-in-chat-id]');
  if (showInChatButton) {
    showMessageInChat(showInChatButton.dataset.showInChatId);
    return;
  }
  const previewButton = event.target.closest('.photo-album-preview');
  const image = previewButton?.querySelector('img');
  if (image) openPhotoViewer(image);
});
searchResultList.addEventListener('click', (event) => {
  const result = event.target.closest('[data-search-result-id]');
  if (result) showMessageInChat(result.dataset.searchResultId);
});

async function processOutgoingMessages(pin) {
  if (isProcessingSendQueue) return;
  isProcessingSendQueue = true;
  try {
    while (currentPin === pin) {
      const queuedMessage = outgoingMessages.find(
        (message) => message.pin === pin && message.status === 'queued',
      );
      if (!queuedMessage) break;

      queuedMessage.status = 'sending';
      refreshVisibleMessages();
      try {
        if (queuedMessage.file && !queuedMessage.mediaPath) {
          const upload = await requestChat('photo-upload', pin, undefined, undefined, {
            contentType: queuedMessage.file.type,
          });
          await uploadPhoto(queuedMessage.file, upload.signedUrl);
          queuedMessage.mediaPath = upload.path;
        }

        const result = await requestChat(
          'send',
          pin,
          queuedMessage.content,
          undefined,
          {
            ...(queuedMessage.mediaPath ? { mediaPath: queuedMessage.mediaPath } : {}),
            ...(queuedMessage.replyToId ? { replyToId: queuedMessage.replyToId } : {}),
          },
        );
        outgoingMessages.splice(outgoingMessages.indexOf(queuedMessage), 1);
        if (currentPin === pin && !serverMessages.some((message) => message.id === result.message.id)) {
          const messageWithPreview = {
            ...result.message,
            previewUrl: queuedMessage.previewUrl,
          };
          serverMessages.push(messageWithPreview);
          serverMessages.sort((first, second) => first.createdAt.localeCompare(second.createdAt));
          updateChatStats();
          if (queuedMessage.mediaPath) {
            try {
              const [messageWithPhotoUrl] = await attachPhotoUrls([result.message], pin);
              const messageIndex = serverMessages.findIndex((message) => message.id === result.message.id);
              if (messageIndex !== -1 && messageWithPhotoUrl.mediaUrl) {
                if (queuedMessage.previewUrl) URL.revokeObjectURL(queuedMessage.previewUrl);
                serverMessages[messageIndex] = messageWithPhotoUrl;
              }
            } catch (error) {
              setStatus(`Message sent, but its photo preview could not be refreshed: ${error.message}`, true);
            }
          }
        }
        if (currentPin === pin) refreshVisibleMessages(true);
      } catch (error) {
        queuedMessage.status = 'failed';
        refreshVisibleMessages();
        if (currentPin === pin) setStatus(`Could not send message: ${error.message}`, true);
      }
    }
  } finally {
    isProcessingSendQueue = false;
    if (currentPin && outgoingMessages.some(
      (message) => message.pin === currentPin && message.status === 'queued',
    )) {
      void processOutgoingMessages(currentPin);
    }
  }
}

messagesList.addEventListener('click', async (event) => {
  const retryButton = event.target.closest('button[data-retry-message]');
  if (retryButton && currentPin) {
    const queuedMessage = outgoingMessages.find((message) => message.id === retryButton.dataset.retryMessage);
    if (queuedMessage) {
      queuedMessage.status = 'queued';
      refreshVisibleMessages();
      void processOutgoingMessages(currentPin);
    }
    return;
  }

  const button = event.target.closest('button[data-message-id][data-reaction]');
  if (!button || !currentPin) return;

  const { messageId, reaction } = button.dataset;
  const message = currentMessages.find((item) => item.id === messageId);
  if (!message) return;

  const actionKey = `${messageId}:${reaction}`;
  if (pendingReactionActions.has(actionKey)) return;
  const selectedReaction = message.reactions?.some(
    (item) => item.player === currentPlayer && item.reaction === reaction,
  );
  closeMessageActions();
  const serverMessage = serverMessages.find((item) => item.id === messageId);
  if (!serverMessage) return;
  const previousReactions = serverMessage.reactions ?? [];
  pendingReactionActions.add(actionKey);
  serverMessage.reactions = selectedReaction
    ? previousReactions.filter((item) => !(item.player === currentPlayer && item.reaction === reaction))
    : [...previousReactions, { player: currentPlayer, reaction }];
  refreshVisibleMessages();
  const pin = currentPin;
  try {
    await requestChat('react', pin, undefined, undefined, {
      messageId,
      reaction,
      enabled: !selectedReaction,
    });
  } catch (error) {
    serverMessage.reactions = previousReactions;
    if (currentPin === pin) {
      refreshVisibleMessages();
      setStatus(`Could not react to message: ${error.message}`, true);
    }
  } finally {
    pendingReactionActions.delete(actionKey);
  }
});

function closeReactionPickers() {
  messagesList.querySelectorAll('.message-reaction-picker--open').forEach((picker) => {
    picker.classList.remove('message-reaction-picker--open');
  });
}

function openReactionPicker(message) {
  closeReactionPickers();
  const picker = message.querySelector('.message-reaction-picker');
  picker?.classList.add('message-reaction-picker--open');
}

function clearLongPress() {
  window.clearTimeout(longPressTimer);
  longPressTimer = undefined;
  longPressMessage = undefined;
  longPressPointerId = undefined;
}

messagesList.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target.closest('.message-reaction-controls')) return;
  const message = event.target.closest('.message');
  if (!message) return;

  clearLongPress();
  longPressMessage = message;
  longPressPointerId = event.pointerId;
  longPressStartX = event.clientX;
  longPressStartY = event.clientY;
  longPressTimer = window.setTimeout(() => {
    if (longPressMessage?.isConnected) openMessageActions(longPressMessage);
    clearLongPress();
  }, 500);
});

document.addEventListener('pointermove', (event) => {
  if (event.pointerId !== longPressPointerId) return;
  if (
    Math.abs(event.clientX - longPressStartX) > 12 ||
    Math.abs(event.clientY - longPressStartY) > 12
  ) {
    clearLongPress();
  }
});

document.addEventListener('pointerup', (event) => {
  if (event.pointerId === longPressPointerId) clearLongPress();
});
document.addEventListener('pointercancel', clearLongPress);

let swipeMessage;
let swipePointerId;
let swipeStartX = 0;
let swipeStartY = 0;

messagesList.addEventListener('pointerdown', (event) => {
  if (
    event.pointerType !== 'touch' ||
    !messageActions.hidden ||
    event.target.closest('.message-reaction-controls')
  ) return;
  const element = event.target.closest('.message');
  if (
    !element ||
    element.classList.contains('message--focused') ||
    element.dataset.messageId.startsWith('pending-')
  ) return;
  swipeMessage = element;
  swipePointerId = event.pointerId;
  swipeStartX = event.clientX;
  swipeStartY = event.clientY;
});

document.addEventListener('pointermove', (event) => {
  if (event.pointerId !== swipePointerId || !swipeMessage?.isConnected) return;
  const deltaX = event.clientX - swipeStartX;
  const deltaY = event.clientY - swipeStartY;
  if (deltaX > 0 && Math.abs(deltaX) > Math.abs(deltaY)) {
    swipeMessage.style.transform = `translateX(${Math.min(deltaX, 76)}px)`;
  } else if (Math.abs(deltaY) > 12) {
    swipeMessage = undefined;
    swipePointerId = undefined;
  }
});

function finishReplySwipe(event) {
  if (event.pointerId !== swipePointerId) return;
  const element = swipeMessage;
  const deltaX = event.clientX - swipeStartX;
  const deltaY = event.clientY - swipeStartY;
  if (element) {
    element.style.transform = '';
    if (deltaX >= 64 && deltaX > Math.abs(deltaY) * 1.25) {
      const message = currentMessages.find((item) => item.id === element.dataset.messageId);
      if (message) updateReplyPreview(message);
    }
  }
  swipeMessage = undefined;
  swipePointerId = undefined;
}

document.addEventListener('pointerup', finishReplySwipe);
document.addEventListener('pointercancel', (event) => {
  if (event.pointerId !== swipePointerId) return;
  if (swipeMessage) swipeMessage.style.transform = '';
  swipeMessage = undefined;
  swipePointerId = undefined;
});

messagesList.addEventListener('contextmenu', (event) => {
  const message = event.target.closest('.message');
  if (!message || event.target.closest('.message-reaction-controls')) return;
  event.preventDefault();
  openMessageActions(message);
});

document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('.message-reaction-picker')) closeReactionPickers();
});

messageInput.addEventListener('input', () => {
  updateCaptureButton();
  const typing = messageInput.value.length > 0;
  window.clearTimeout(typingIdleTimer);
  updateTypingStatus(typing);

  if (typing) {
    typingIdleTimer = window.setTimeout(() => {
      updateTypingStatus(false);
    }, TYPING_IDLE_TIMEOUT_MS);
  }
});

messageInput.addEventListener('paste', (event) => {
  const imageFiles = Array.from(event.clipboardData?.items ?? [])
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file) => file instanceof File);
  if (!imageFiles.length) return;
  event.preventDefault();
  openPhotoReview(imageFiles);
});

function quickExit() {
  window.clearInterval(syncTimer);
  updateTypingStatus(false);
  window.location.replace(QUICK_EXIT_URL);
}

function applyQuickExitPosition(x, y) {
  const bounds = chatPanel.getBoundingClientRect();
  const maxX = Math.max(0, bounds.width - quickExitButton.offsetWidth);
  const maxY = Math.max(0, bounds.height - quickExitButton.offsetHeight);
  quickExitPosition = {
    x: Math.max(0, Math.min(x, maxX)),
    y: Math.max(0, Math.min(y, maxY)),
  };
  quickExitButton.style.left = `${quickExitPosition.x}px`;
  quickExitButton.style.top = `${quickExitPosition.y}px`;
  quickExitButton.style.right = 'auto';
}

const savedQuickExitPosition = localStorage.getItem('chat-quick-exit-position')?.split(',').map(Number);
if (savedQuickExitPosition?.length === 2 && savedQuickExitPosition.every(Number.isFinite)) {
  quickExitPosition = { x: savedQuickExitPosition[0], y: savedQuickExitPosition[1] };
}

quickExitButton.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  quickExitPointerId = event.pointerId;
  const panelBounds = chatPanel.getBoundingClientRect();
  const buttonBounds = quickExitButton.getBoundingClientRect();
  quickExitPointerStart = {
    x: event.clientX,
    y: event.clientY,
    left: buttonBounds.left - panelBounds.left,
    top: buttonBounds.top - panelBounds.top,
    moved: false,
  };
  quickExitButton.setPointerCapture(event.pointerId);
});

quickExitButton.addEventListener('pointermove', (event) => {
  if (event.pointerId !== quickExitPointerId || !quickExitPointerStart) return;
  const deltaX = event.clientX - quickExitPointerStart.x;
  const deltaY = event.clientY - quickExitPointerStart.y;
  if (!quickExitPointerStart.moved && Math.hypot(deltaX, deltaY) < 5) return;
  quickExitPointerStart.moved = true;
  applyQuickExitPosition(
    quickExitPointerStart.left + deltaX,
    quickExitPointerStart.top + deltaY,
  );
});

quickExitButton.addEventListener('pointerup', (event) => {
  if (event.pointerId !== quickExitPointerId) return;
  if (quickExitPointerStart?.moved && quickExitPosition) {
    localStorage.setItem(
      'chat-quick-exit-position',
      `${quickExitPosition.x},${quickExitPosition.y}`,
    );
    suppressQuickExitClick = true;
    window.setTimeout(() => {
      suppressQuickExitClick = false;
    });
  }
  quickExitPointerId = undefined;
  quickExitPointerStart = undefined;
});
quickExitButton.addEventListener('pointercancel', () => {
  quickExitPointerId = undefined;
  quickExitPointerStart = undefined;
});

window.addEventListener('resize', () => {
  if (quickExitPosition && !chatPanel.hidden) {
    applyQuickExitPosition(quickExitPosition.x, quickExitPosition.y);
  }
});

quickExitButton.addEventListener('click', (event) => {
  if (suppressQuickExitClick) {
    event.preventDefault();
    return;
  }
  quickExit();
});
pinQuickExitButton.addEventListener('click', quickExit);

showPinPanel();
updatePinDots();
updateNotificationButton();
updateScrollLatestButton();
updateCaptureButton();
