self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (error) {
    console.error('Could not parse push notification payload:', error);
  }

  const title = 'Volume Should Be Turned Down';
  const options = {
    body: typeof payload.body === 'string' ? payload.body : '',
    icon: '/icons/volume-alert-192.png',
    badge: '/icons/volume-alert-192.png',
    tag: 'volume-chat-alert',
    renotify: false,
    data: {
      url: typeof payload.url === 'string' ? payload.url : '/',
      endpoint: typeof payload.endpoint === 'string' ? payload.endpoint : '',
      clearToken: typeof payload.clearToken === 'string' ? payload.clearToken : '',
      clearUrl: typeof payload.clearUrl === 'string' ? payload.clearUrl : '',
      apiKey: typeof payload.apiKey === 'string' ? payload.apiKey : '',
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclose', (event) => {
  event.waitUntil(acknowledgeNotificationCleared(event.notification.data));
});

self.addEventListener('notificationclick', (event) => {
  const notificationData = event.notification.data;
  event.notification.close();
  const requestedUrl = new URL(event.notification.data?.url || '/', self.location.origin);
  const targetUrl = requestedUrl.origin === self.location.origin ? requestedUrl.href : self.location.origin;

  event.waitUntil((async () => {
    await acknowledgeNotificationCleared(notificationData);
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.focus();
        return;
      }
    }

    await self.clients.openWindow(targetUrl);
  })());
});

async function acknowledgeNotificationCleared(data) {
  if (!data?.endpoint || !data.clearToken || !data.clearUrl || !data.apiKey) return;

  try {
    const response = await fetch(data.clearUrl, {
      method: 'POST',
      headers: {
        apikey: data.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'push-cleared',
        endpoint: data.endpoint,
        clearToken: data.clearToken,
      }),
    });
    if (!response.ok) {
      console.error('Could not acknowledge cleared push notification:', response.status);
    }
  } catch (error) {
    console.error('Could not acknowledge cleared push notification:', error);
  }
}
