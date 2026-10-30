import './style.css';

const { VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY } = import.meta.env;
const SYNC_INTERVAL_MS = 2000;
const TYPING_HEARTBEAT_MS = 2000;
const TYPING_IDLE_TIMEOUT_MS = 3000;

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
const sendButton = document.querySelector('#send-button');
const messagesList = document.querySelector('#messages');
const quickExitButton = document.querySelector('#quick-exit');

const QUICK_EXIT_URL = 'https://www.google.com/search?q=weather';
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

  container.append(document.createTextNode(details.emoji));
}

function showPinPanel() {
  pinPanel.hidden = false;
  chatPanel.hidden = true;
  setStatus('');
}

function renderMessage(message) {
  const item = document.createElement('li');
  item.className = message.player === currentPlayer ? 'message message--own' : 'message';

  const author = document.createElement('span');
  author.className = 'message-author';
  author.textContent = message.player;

  const body = document.createElement('p');
  body.className = 'message-body';
  body.textContent = message.content;

  const time = document.createElement('time');
  time.className = 'message-time';
  time.dateTime = message.createdAt;
  time.textContent = new Date(message.createdAt).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });

  const reactions = message.reactions ?? [];
  const ownReaction = reactions.find((reaction) => reaction.player === currentPlayer)?.reaction;
  const reactionControls = document.createElement('div');
  reactionControls.className = 'message-reaction-controls';

  const reactionPicker = document.createElement('details');
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
    button.setAttribute('aria-pressed', String(ownReaction === reaction));
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
    chip.className = `reaction-chip${ownReaction === reaction ? ' reaction-chip--selected' : ''}`;
    chip.dataset.messageId = message.id;
    chip.dataset.reaction = reaction;
    chip.setAttribute('aria-label', `${details.label}: ${count}`);
    chip.setAttribute('aria-pressed', String(ownReaction === reaction));
    appendReactionIcon(chip, details);
    chip.append(document.createTextNode(` ${count}`));
    reactionControls.append(chip);
  }

  item.append(author, body, time, reactionControls);
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

function updateMessages(messages, shouldScroll = false) {
  const nextIds = JSON.stringify(messages.map((message) => ({
    id: message.id,
    reactions: message.reactions ?? [],
  })));
  currentMessages = messages;
  if (nextIds === renderedMessageIds) return;

  const wasAtBottom = messagesList.scrollHeight - messagesList.scrollTop - messagesList.clientHeight < 32;
  messagesList.replaceChildren();
  messages.forEach(renderMessage);
  renderedMessageIds = nextIds;

  if (shouldScroll || wasAtBottom) {
    messagesList.scrollTop = messagesList.scrollHeight;
  }
}

function updateNotificationButton() {
  toggleNotificationsButton.setAttribute('aria-checked', String(notificationsEnabled));
  toggleNotificationsButton.setAttribute(
    'aria-label',
    `Push notifications ${notificationsEnabled ? 'on' : 'off'}`,
  );
  notificationWarning.hidden = !notificationsEnabled;
}

function updateSendButton() {
  const hasMessage = Boolean(messageInput.value.trim());
  const icon = sendButton.querySelector('.send-button-icon');
  icon.classList.toggle('send-button-icon--drop', !hasMessage);
  sendButton.setAttribute('aria-label', hasMessage ? 'Send message' : 'Hide keyboard');
  sendButton.title = hasMessage ? 'Send message' : 'Hide keyboard';
}

async function syncMessages(pin, shouldScroll = false) {
  const result = await requestChat('load', pin);
  if (currentPin !== pin) return;
  updateMessages(result.messages, shouldScroll);
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
    chatPlayer.textContent = result.player;
    messageInput.placeholder = `Message as ${result.player}…`;
    typingIndicator.hidden = true;
    typingIndicator.classList.remove('is-typing');
    pinPanel.hidden = true;
    chatPanel.hidden = false;
    renderedMessageIds = '';
    currentMessages = [];
    updateMessages(result.messages, true);
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
    return;
  }
  if (!currentPin) return;

  updateTypingStatus(false);
  messageInput.focus({ preventScroll: true });
  const button = messageForm.querySelector('button');
  button.disabled = true;
  const pin = currentPin;
  try {
    const result = await requestChat('send', pin, content);
    if (currentPin !== pin) return;

    const messages = currentMessages.some((message) => message.id === result.message.id)
      ? currentMessages
      : [...currentMessages, result.message].sort((first, second) =>
        first.createdAt.localeCompare(second.createdAt),
      );
    updateMessages(messages, true);
    messageInput.value = '';
    updateSendButton();
    setStatus('');
  } catch (error) {
    if (currentPin === pin) setStatus(`Could not send message: ${error.message}`, true);
  } finally {
    button.disabled = false;
  }
});

messagesList.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-message-id][data-reaction]');
  if (!button || !currentPin) return;

  const { messageId, reaction } = button.dataset;
  const message = currentMessages.find((item) => item.id === messageId);
  if (!message) return;

  const selectedReaction = message.reactions?.find((item) => item.player === currentPlayer)?.reaction;
  button.disabled = true;
  const pin = currentPin;
  try {
    await requestChat('react', pin, undefined, undefined, {
      messageId,
      reaction: selectedReaction === reaction ? null : reaction,
    });
    if (currentPin === pin) {
      button.closest('details')?.removeAttribute('open');
      await syncMessages(pin);
    }
  } catch (error) {
    if (currentPin === pin) setStatus(`Could not react to message: ${error.message}`, true);
  } finally {
    button.disabled = false;
  }
});

function closeReactionPickers() {
  messagesList.querySelectorAll('.message-reaction-picker[open]').forEach((picker) => {
    picker.open = false;
  });
}

function openReactionPicker(message) {
  closeReactionPickers();
  const picker = message.querySelector('.message-reaction-picker');
  if (picker) picker.open = true;
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
  updateSendButton();
  const typing = messageInput.value.length > 0;
  window.clearTimeout(typingIdleTimer);
  updateTypingStatus(typing);

  if (typing) {
    typingIdleTimer = window.setTimeout(() => {
      updateTypingStatus(false);
    }, TYPING_IDLE_TIMEOUT_MS);
  }
});

quickExitButton.addEventListener('click', () => {
  window.clearInterval(syncTimer);
  updateTypingStatus(false);
  window.location.replace(QUICK_EXIT_URL);
});

showPinPanel();
updatePinDots();
updateNotificationButton();
updateSendButton();
