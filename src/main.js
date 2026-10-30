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
const toggleNotificationsButton = document.querySelector('#toggle-notifications');
const notificationWarning = document.querySelector('#notification-warning');
const typingIndicator = document.querySelector('#typing-indicator');
const messageForm = document.querySelector('#message-form');
const messageInput = document.querySelector('#message');
const photoInput = document.querySelector('#photo-input');
const choosePhotoButton = document.querySelector('#choose-photo');
const scrollLatestButton = document.querySelector('#scroll-latest-button');
const messagesList = document.querySelector('#messages');
const quickExitButton = document.querySelector('#quick-exit');
const pinQuickExitButton = document.querySelector('#pin-quick-exit');

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
let serverMessages = [];
const outgoingMessages = [];
const mediaUrlCache = new Map();
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

function showPinPanel() {
  pinPanel.hidden = false;
  chatPanel.hidden = true;
  setStatus('');
}

function renderMessage(message, animate = false) {
  const item = document.createElement('li');
  item.className = [
    'message',
    ...(message.player === currentPlayer ? ['message--own'] : []),
    ...(animate ? ['message--entering'] : []),
  ].join(' ');

  const author = document.createElement('span');
  author.className = 'message-author';
  author.textContent = message.player;

  if (message.mediaUrl || message.previewUrl) {
    const image = document.createElement('img');
    image.className = 'message-photo';
    image.src = message.previewUrl || message.mediaUrl;
    image.alt = 'Photo message';
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
    body.textContent = message.content;
    item.append(body);
  }

  const time = document.createElement('time');
  time.className = 'message-time';
  time.dateTime = message.createdAt;
  time.textContent = new Date(message.createdAt).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });

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
  reactionPicker.className = 'message-reaction-picker';
  const reactionOptions = document.createElement('div');
  reactionOptions.className = 'reaction-options';
  reactionOptions.setAttribute('role', 'group');
  reactionOptions.setAttribute('aria-label', 'Choose a reaction');

  for (const [reaction, details] of Object.entries(REACTIONS)) {
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
    const details = REACTIONS[reaction];
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
  item.append(time);
  if (deliveryIndicator) item.append(deliveryIndicator);
  item.append(reactionControls);
  messagesList.append(item);
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

function updateMessages(messages, shouldScroll = false, animateNewMessages = true) {
  const previousIds = new Set(currentMessages.map((message) => message.id));
  const nextIds = JSON.stringify(messages.map((message) => ({
    id: message.id,
    reactions: message.reactions ?? [],
    deliveryStatus: message.deliveryStatus ?? null,
    mediaUrl: message.mediaUrl ?? null,
    previewUrl: message.previewUrl ?? null,
  })));
  currentMessages = messages;
  if (nextIds === renderedMessageIds) return;

  const wasAtBottom = messagesList.scrollHeight - messagesList.scrollTop - messagesList.clientHeight < 32;
  messagesList.replaceChildren();
  messages.forEach((message) => {
    renderMessage(message, animateNewMessages && !previousIds.has(message.id));
  });
  renderedMessageIds = nextIds;

  if (shouldScroll || wasAtBottom) {
    messagesList.scrollTop = messagesList.scrollHeight;
  }
  updateScrollLatestButton();
}

function getVisibleMessages() {
  const pendingMessages = outgoingMessages.map((message) => ({
    id: message.id,
    player: currentPlayer,
    content: message.content,
    createdAt: message.createdAt,
    reactions: [],
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

function scrollMessagesToLatest() {
  const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'auto'
    : 'smooth';
  const scroll = () => {
    messagesList.scrollTo({ top: messagesList.scrollHeight, behavior });
    updateScrollLatestButton();
  };

  window.requestAnimationFrame(scroll);
  window.setTimeout(scroll, 300);
}

function updateScrollLatestButton() {
  const isAwayFromLatest = messagesList.scrollHeight - messagesList.scrollTop - messagesList.clientHeight > 32;
  scrollLatestButton.hidden = !isAwayFromLatest;
}

messagesList.addEventListener('scroll', updateScrollLatestButton, { passive: true });
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
  const updatedMessages = await attachPhotoUrls(result.messages, pin);
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
      setStatus('Push notifications disabled on this device.');
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
    setStatus('NOTIFICATIONS ENABLED!!!!!: bebe ko!!! di efas', false, true);
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
    serverMessages = await attachPhotoUrls(result.messages, pin);
    if (currentPin !== pin) return;
    chatPlayer.textContent = result.player;
    messageInput.placeholder = `Message as ${result.player}…`;
    typingIndicator.hidden = true;
    typingIndicator.classList.remove('is-typing');
    pinPanel.hidden = true;
    chatPanel.hidden = false;
    renderedMessageIds = '';
    currentMessages = [];
    refreshVisibleMessages(true, false);
    window.requestAnimationFrame(() => {
      if (currentPin === pin) {
        messagesList.scrollTop = messagesList.scrollHeight;
      }
    });
    setStatus('');
    messageInput.focus();
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
  if (pinPanel.hidden) return;

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
  enqueueOutgoingMessage({ pin: currentPin, content });
  messageInput.value = '';
  messageInput.focus({ preventScroll: true });
  scrollMessagesToLatest();
});

function enqueueOutgoingMessage({ pin, content, file }) {
  outgoingMessages.push({
    id: `pending-${crypto.randomUUID()}`,
    pin,
    content,
    file,
    mediaPath: undefined,
    previewUrl: file ? URL.createObjectURL(file) : undefined,
    createdAt: new Date().toISOString(),
    status: 'queued',
  });
  refreshVisibleMessages(true);
  void processOutgoingMessages(pin);
}

choosePhotoButton.addEventListener('click', () => {
  photoInput.click();
});

photoInput.addEventListener('change', () => {
  if (!currentPin) {
    setStatus('Unlock the chat before sending photos.', true);
    photoInput.value = '';
    return;
  }

  let addedCount = 0;
  for (const file of photoInput.files ?? []) {
    if (!PHOTO_UPLOAD_MIME_TYPES.has(file.type)) {
      setStatus('Choose a JPEG, PNG, WebP, GIF, or HEIC photo.', true);
      continue;
    }
    if (file.size > MAX_PHOTO_SIZE_BYTES) {
      setStatus('Each photo must be 8 MB or smaller.', true);
      continue;
    }

    enqueueOutgoingMessage({ pin: currentPin, content: '', file });
    addedCount += 1;
  }
  photoInput.value = '';
  if (addedCount) updateTypingStatus(false);
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
          queuedMessage.mediaPath ? { mediaPath: queuedMessage.mediaPath } : {},
        );
        outgoingMessages.splice(outgoingMessages.indexOf(queuedMessage), 1);
        if (currentPin === pin && !serverMessages.some((message) => message.id === result.message.id)) {
          const messageWithPreview = {
            ...result.message,
            previewUrl: queuedMessage.previewUrl,
          };
          serverMessages.push(messageWithPreview);
          serverMessages.sort((first, second) => first.createdAt.localeCompare(second.createdAt));
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

  const selectedReaction = message.reactions?.some(
    (item) => item.player === currentPlayer && item.reaction === reaction,
  );
  button.disabled = true;
  const pin = currentPin;
  try {
    await requestChat('react', pin, undefined, undefined, {
      messageId,
      reaction,
      enabled: !selectedReaction,
    });
    if (currentPin === pin) {
      await syncMessages(pin);
    }
  } catch (error) {
    if (currentPin === pin) setStatus(`Could not react to message: ${error.message}`, true);
  } finally {
    button.disabled = false;
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
    if (longPressMessage?.isConnected) openReactionPicker(longPressMessage);
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

messagesList.addEventListener('contextmenu', (event) => {
  const message = event.target.closest('.message');
  if (!message || event.target.closest('.message-reaction-controls')) return;
  event.preventDefault();
  openReactionPicker(message);
});

document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('.message-reaction-picker')) closeReactionPickers();
});

messageInput.addEventListener('input', () => {
  const typing = messageInput.value.length > 0;
  window.clearTimeout(typingIdleTimer);
  updateTypingStatus(typing);

  if (typing) {
    typingIdleTimer = window.setTimeout(() => {
      updateTypingStatus(false);
    }, TYPING_IDLE_TIMEOUT_MS);
  }
});

function quickExit() {
  window.clearInterval(syncTimer);
  updateTypingStatus(false);
  window.location.replace(QUICK_EXIT_URL);
}

quickExitButton.addEventListener('click', quickExit);
pinQuickExitButton.addEventListener('click', quickExit);

showPinPanel();
updatePinDots();
updateNotificationButton();
updateScrollLatestButton();
