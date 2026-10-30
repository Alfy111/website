import './style.css';

const { VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, VITE_VAPID_PUBLIC_KEY } = import.meta.env;
const SYNC_INTERVAL_MS = 2000;
const TYPING_HEARTBEAT_MS = 2000;
const TYPING_IDLE_TIMEOUT_MS = 3000;

const status = document.querySelector('#status');
const pinPanel = document.querySelector('#pin-panel');
const pinDots = document.querySelector('#pin-dots');
const keypad = document.querySelector('#keypad');
const chatPanel = document.querySelector('#chat-panel');
const chatPlayer = document.querySelector('#chat-player');
const editNotificationButton = document.querySelector('#edit-notification');
const toggleNotificationsButton = document.querySelector('#toggle-notifications');
const typingIndicator = document.querySelector('#typing-indicator');
const messageForm = document.querySelector('#message-form');
const messageInput = document.querySelector('#message');
const messagesList = document.querySelector('#messages');
const quickExitButton = document.querySelector('#quick-exit');

const QUICK_EXIT_URL = 'https://www.google.com/search?q=weather';
const NOTIFICATION_TEXT_KEY = 'chat-notification-title-v2';
const NOTIFICATIONS_ENABLED_KEY = 'chat-notifications-enabled';
const DEFAULT_NOTIFICATION_TEXT = 'Freeform Chat';
let pinDigits = '';
let currentPin;
let currentPlayer;
let syncTimer;
let typingHeartbeatTimer;
let typingIdleTimer;
let renderedMessageIds = '';
let currentMessages = [];
let isTyping = false;
let notificationText = localStorage.getItem(NOTIFICATION_TEXT_KEY) || DEFAULT_NOTIFICATION_TEXT;
let notificationsEnabled = localStorage.getItem(NOTIFICATIONS_ENABLED_KEY) === 'true';
let pushRegistration;

function setStatus(message, isError = false) {
  status.textContent = message;
  status.dataset.error = String(isError);
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

  item.append(author, body, time);
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
  const nextIds = messages.map((message) => message.id).join(',');
  if (nextIds === renderedMessageIds) return;

  const wasAtBottom = messagesList.scrollHeight - messagesList.scrollTop - messagesList.clientHeight < 32;
  messagesList.replaceChildren();
  messages.forEach(renderMessage);
  currentMessages = messages;
  renderedMessageIds = nextIds;

  if (shouldScroll || wasAtBottom) {
    messagesList.scrollTop = messagesList.scrollHeight;
  }
}

function updateNotificationButton() {
  toggleNotificationsButton.textContent = notificationsEnabled ? 'Disable alerts' : 'Enable alerts';
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

async function getPushSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('This browser does not support web push notifications.');
  }
  if (!VITE_VAPID_PUBLIC_KEY) {
    throw new Error('Set VITE_VAPID_PUBLIC_KEY in the deployment environment and rebuild the site.');
  }

  pushRegistration = await navigator.serviceWorker.register('/service-worker.js');
  await navigator.serviceWorker.ready;
  const existingSubscription = await pushRegistration.pushManager.getSubscription();
  return existingSubscription || pushRegistration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: decodeVapidPublicKey(VITE_VAPID_PUBLIC_KEY),
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

    const subscription = await getPushSubscription();
    await requestChat('push-subscribe', currentPin, undefined, undefined, {
      subscription: subscription.toJSON(),
      notificationTitle: notificationText,
    });
    notificationsEnabled = true;
    localStorage.setItem(NOTIFICATIONS_ENABLED_KEY, 'true');
    updateNotificationButton();
    setStatus('Push notifications enabled on this device.');
  } catch (error) {
    setStatus(`Could not enable push notifications: ${error.message}`, true);
  }
});

editNotificationButton.addEventListener('click', () => {
  const text = window.prompt('Text to show for new messages:', notificationText);
  if (text === null) return;
  if (!text.trim()) {
    setStatus('Notification text cannot be empty.', true);
    return;
  }

  notificationText = text.trim();
  localStorage.setItem(NOTIFICATION_TEXT_KEY, notificationText);
  const updateSubscription = async () => {
    const subscription = await pushRegistration?.pushManager.getSubscription();
    if (subscription && currentPin && notificationsEnabled) {
      await requestChat('push-subscribe', currentPin, undefined, undefined, {
        subscription: subscription.toJSON(),
        notificationTitle: notificationText,
      });
    }
  };
  void updateSubscription()
    .then(() => setStatus('Notification title updated.'))
    .catch((error) => setStatus(`Could not update notification title: ${error.message}`, true));
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
  if (!content || !currentPin) return;

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
    setStatus('');
  } catch (error) {
    if (currentPin === pin) setStatus(`Could not send message: ${error.message}`, true);
  } finally {
    button.disabled = false;
  }
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

quickExitButton.addEventListener('click', () => {
  window.clearInterval(syncTimer);
  updateTypingStatus(false);
  window.location.replace(QUICK_EXIT_URL);
});

showPinPanel();
updatePinDots();
updateNotificationButton();
