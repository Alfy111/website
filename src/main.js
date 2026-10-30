import './style.css';

const { VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY } = import.meta.env;
const SYNC_INTERVAL_MS = 5000;

const status = document.querySelector('#status');
const pinPanel = document.querySelector('#pin-panel');
const pinDots = document.querySelector('#pin-dots');
const keypad = document.querySelector('#keypad');
const chatPanel = document.querySelector('#chat-panel');
const chatPlayer = document.querySelector('#chat-player');
const messageForm = document.querySelector('#message-form');
const messageInput = document.querySelector('#message');
const messagesList = document.querySelector('#messages');
const quickExitButton = document.querySelector('#quick-exit');

const QUICK_EXIT_URL = 'https://www.google.com/search?q=weather';
let pinDigits = '';
let currentPin;
let syncTimer;
let renderedMessageIds = '';
let currentMessages = [];

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
  item.className = 'message';

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

async function requestChat(action, pin, content) {
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
      body: JSON.stringify({ action, pin, content }),
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

function updateMessages(messages, shouldScroll = false, preserveScroll = false) {
  const nextIds = messages.map((message) => message.id).join(',');
  if (nextIds === renderedMessageIds) return;

  const previousScrollTop = messagesList.scrollTop;
  const wasAtBottom = messagesList.scrollHeight - messagesList.scrollTop - messagesList.clientHeight < 32;
  messagesList.replaceChildren();
  messages.forEach(renderMessage);
  currentMessages = messages;
  renderedMessageIds = nextIds;

  if (preserveScroll) {
    messagesList.scrollTop = previousScrollTop;
  } else if (shouldScroll || wasAtBottom) {
    messagesList.scrollTop = messagesList.scrollHeight;
  }
}

async function syncMessages(pin, shouldScroll = false) {
  const result = await requestChat('load', pin);
  if (currentPin !== pin) return;
  updateMessages(result.messages, shouldScroll);
}

async function unlockChat(pin) {
  keypad.querySelectorAll('button').forEach((button) => {
    button.disabled = true;
  });
  setStatus('Checking PIN…');

  try {
    const result = await requestChat('load', pin);
    currentPin = pin;
    chatPlayer.textContent = result.player;
    messageInput.placeholder = `Message as ${result.player}…`;
    pinPanel.hidden = true;
    chatPanel.hidden = false;
    renderedMessageIds = '';
    currentMessages = [];
    updateMessages(result.messages, true);
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
    updateMessages(messages, false, true);
    messageInput.value = '';
    setStatus('');
  } catch (error) {
    if (currentPin === pin) setStatus(`Could not send message: ${error.message}`, true);
  } finally {
    button.disabled = false;
    if (currentPin) messageInput.focus();
  }
});

quickExitButton.addEventListener('click', () => {
  window.clearInterval(syncTimer);
  window.location.replace(QUICK_EXIT_URL);
});

showPinPanel();
updatePinDots();
