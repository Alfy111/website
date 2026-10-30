import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function respond(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function hashAddress(address: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(address));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isSupportedPushEndpoint(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (
      url.hostname === 'web.push.apple.com' ||
      url.hostname === 'fcm.googleapis.com' ||
      url.hostname === 'updates.push.services.mozilla.com'
    );
  } catch {
    return false;
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return respond({ error: 'Method not allowed.' }, 405);
  }

  let body: {
    action?: unknown;
    pin?: unknown;
    content?: unknown;
    isTyping?: unknown;
    subscription?: unknown;
    endpoint?: unknown;
    notificationTitle?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return respond({ error: 'Invalid request.' }, 400);
  }

  if (
    body.action !== 'load' &&
    body.action !== 'send' &&
    body.action !== 'typing' &&
    body.action !== 'react' &&
    body.action !== 'push-config' &&
    body.action !== 'push-subscribe' &&
    body.action !== 'push-unsubscribe'
  ) {
    return respond({ error: 'Invalid action.' }, 400);
  }
  if (typeof body.pin !== 'string' || !/^\d{4}$/.test(body.pin)) {
    return respond({ error: 'Enter a 4-digit PIN.' }, 400);
  }

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const pin1 = Deno.env.get('CHAT_PIN_1');
  const pin2 = Deno.env.get('CHAT_PIN_2');
  if (!url || !serviceKey || !pin1 || !pin2 || !/^\d{4}$/.test(pin1) || !/^\d{4}$/.test(pin2) || pin1 === pin2) {
    console.error('PIN chat server configuration is incomplete.');
    return respond({ error: 'Chat server is not configured correctly.' }, 500);
  }

  const player = body.pin === pin1
    ? (Deno.env.get('CHAT_PLAYER_1') || 'ashy')
    : body.pin === pin2
      ? (Deno.env.get('CHAT_PLAYER_2') || 'alfey')
      : undefined;

  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  if (!player) {
    const sourceAddress = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const ipHash = await hashAddress(sourceAddress);
    const { data: allowed, error } = await supabase.rpc('consume_chat_pin_attempt', {
      p_ip_hash: ipHash,
    });

    if (error) {
      console.error('Could not apply PIN rate limit:', error.message);
      return respond({ error: 'Could not verify the PIN. Try again later.' }, 500);
    }
    if (!allowed) {
      return respond({ error: 'Too many incorrect PIN attempts. Try again in 15 minutes.' }, 429);
    }
    return respond({ error: 'Incorrect PIN.' }, 401);
  }

  if (body.action === 'push-config') {
    const vapidPublicKey = Deno.env.get('VAPID_PUBLIC_KEY');
    const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY');
    const vapidSubject = Deno.env.get('VAPID_SUBJECT');
    if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
      console.error('Web Push VAPID configuration is incomplete.');
      return respond({ error: 'Push notifications are not configured on the server.' }, 500);
    }

    return respond({ vapidPublicKey });
  }

  if (body.action === 'load') {
    const otherPlayer = body.pin === pin1
      ? (Deno.env.get('CHAT_PLAYER_2') || 'alfey')
      : (Deno.env.get('CHAT_PLAYER_1') || 'ashy');
    const typingSince = new Date(Date.now() - 5000).toISOString();
    const [{ data, error }, { data: typingState, error: typingError }] = await Promise.all([
      supabase
        .from('chat_messages')
        .select('id, player, content, created_at')
        .order('created_at', { ascending: false })
        .limit(1000),
      supabase
        .from('chat_typing')
        .select('player')
        .eq('player', otherPlayer)
        .eq('is_typing', true)
        .gt('updated_at', typingSince)
        .maybeSingle(),
    ]);

    if (error) {
      console.error('Could not load chat messages:', error.message);
      return respond({ error: 'Could not load chat history.' }, 500);
    }
    if (typingError) {
      console.error('Could not load chat typing status:', typingError.message);
      return respond({ error: 'Could not load typing status.' }, 500);
    }

    const messages = data.reverse();
    const messageIds = messages.map((message) => message.id);
    const { data: reactions, error: reactionsError } = messageIds.length
      ? await supabase
        .from('chat_message_reactions')
        .select('message_id, player, reaction')
        .in('message_id', messageIds)
      : { data: [], error: null };

    if (reactionsError) {
      console.error('Could not load chat reactions:', reactionsError.message);
      return respond({ error: 'Could not load message reactions.' }, 500);
    }

    const reactionsByMessage = new Map<string, { player: string; reaction: string }[]>();
    for (const reaction of reactions) {
      const messageReactions = reactionsByMessage.get(reaction.message_id) ?? [];
      messageReactions.push({ player: reaction.player, reaction: reaction.reaction });
      reactionsByMessage.set(reaction.message_id, messageReactions);
    }

    return respond({
      player,
      typingPlayer: typingState?.player ?? null,
      messages: messages.map((message) => ({
        id: message.id,
        player: message.player,
        content: message.content,
        createdAt: message.created_at,
        reactions: reactionsByMessage.get(message.id) ?? [],
      })),
    });
  }

  if (body.action === 'react') {
    const messageId = body.messageId;
    const reaction = body.reaction;
    if (
      typeof messageId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(messageId) ||
      (reaction !== null &&
        reaction !== 'heart' &&
        reaction !== 'laugh' &&
        reaction !== 'wow' &&
        reaction !== 'sad' &&
        reaction !== 'angry' &&
        reaction !== 'like')
    ) {
      return respond({ error: 'Invalid message reaction.' }, 400);
    }

    const query = supabase
      .from('chat_message_reactions')
      .delete()
      .eq('message_id', messageId)
      .eq('player', player);

    const { error } = reaction === null
      ? await query
      : await supabase
        .from('chat_message_reactions')
        .upsert(
          { message_id: messageId, player, reaction },
          { onConflict: 'message_id,player' },
        );

    if (error) {
      console.error('Could not save chat reaction:', error.message);
      return respond({ error: 'Could not save message reaction.' }, 500);
    }

    return respond({});
  }

  if (body.action === 'typing') {
    if (typeof body.isTyping !== 'boolean') {
      return respond({ error: 'Typing status must be true or false.' }, 400);
    }

    const { error } = await supabase
      .from('chat_typing')
      .upsert({ player, is_typing: body.isTyping, updated_at: new Date().toISOString() });

    if (error) {
      console.error('Could not update chat typing status:', error.message);
      return respond({ error: 'Could not update typing status.' }, 500);
    }

    return respond({});
  }

  if (body.action === 'push-subscribe') {
    const subscription = body.subscription;
    if (
      typeof subscription !== 'object' ||
      subscription === null ||
      !('endpoint' in subscription) ||
      typeof subscription.endpoint !== 'string' ||
      subscription.endpoint.length > 2048 ||
      !isSupportedPushEndpoint(subscription.endpoint) ||
      !('keys' in subscription) ||
      typeof subscription.keys !== 'object' ||
      subscription.keys === null ||
      !('p256dh' in subscription.keys) ||
      typeof subscription.keys.p256dh !== 'string' ||
      !('auth' in subscription.keys) ||
      typeof subscription.keys.auth !== 'string'
    ) {
      return respond({ error: 'Invalid push subscription.' }, 400);
    }

    const notificationTitle = typeof body.notificationTitle === 'string'
      ? body.notificationTitle.trim()
      : 'Freeform Chat';
    if (!notificationTitle || notificationTitle.length > 120) {
      return respond({ error: 'Notification title must be between 1 and 120 characters.' }, 400);
    }

    const vapidPublicKey = Deno.env.get('VAPID_PUBLIC_KEY');
    const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY');
    const vapidSubject = Deno.env.get('VAPID_SUBJECT');
    if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
      console.error('Web Push VAPID configuration is incomplete.');
      return respond({ error: 'Push notifications are not configured on the server.' }, 500);
    }

    const { error } = await supabase
      .from('chat_push_subscriptions')
      .upsert({
        endpoint: subscription.endpoint,
        player,
        subscription,
        notification_title: notificationTitle,
        updated_at: new Date().toISOString(),
      });

    if (error) {
      console.error('Could not save push subscription:', error.message);
      return respond({ error: 'Could not save this device for notifications.' }, 500);
    }

    return respond({ vapidPublicKey });
  }

  if (body.action === 'push-unsubscribe') {
    if (
      typeof body.endpoint !== 'string' ||
      body.endpoint.length > 2048 ||
      !isSupportedPushEndpoint(body.endpoint)
    ) {
      return respond({ error: 'Invalid push endpoint.' }, 400);
    }

    const { error } = await supabase
      .from('chat_push_subscriptions')
      .delete()
      .eq('endpoint', body.endpoint)
      .eq('player', player);

    if (error) {
      console.error('Could not remove push subscription:', error.message);
      return respond({ error: 'Could not disable notifications for this device.' }, 500);
    }

    return respond({});
  }

  if (typeof body.content !== 'string' || !body.content.trim() || body.content.trim().length > 2000) {
    return respond({ error: 'Messages must be between 1 and 2000 characters.' }, 400);
  }

  const { data: message, error } = await supabase
    .from('chat_messages')
    .insert({ player, content: body.content.trim() })
    .select('id, player, content, created_at')
    .single();

  if (error) {
    console.error('Could not save chat message:', error.message);
    return respond({ error: 'Could not save your message.' }, 500);
  }

  const recipientPlayer = body.pin === pin1
    ? (Deno.env.get('CHAT_PLAYER_2') || 'alfey')
    : (Deno.env.get('CHAT_PLAYER_1') || 'ashy');
  const vapidPublicKey = Deno.env.get('VAPID_PUBLIC_KEY');
  const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY');
  const vapidSubject = Deno.env.get('VAPID_SUBJECT');
  if (vapidPublicKey && vapidPrivateKey && vapidSubject) {
    try {
      webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
      const { data: subscriptions, error: subscriptionError } = await supabase
        .from('chat_push_subscriptions')
        .select('endpoint, subscription')
        .eq('player', recipientPlayer);

      if (subscriptionError) {
        console.error('Could not load message push recipients:', subscriptionError.message);
      } else {
        await Promise.all(subscriptions.map(async (savedSubscription) => {
          try {
            await webpush.sendNotification(
              savedSubscription.subscription,
              JSON.stringify({
                title: 'Volume Should Be Turned Down',
                body: "Based on your headphone usage over the last seven days, you've exceeded the recommended limit for audio exposure.",
                icon: '/icons/volume-alert-192.png',
                badge: '/icons/volume-alert-192.png',
                url: '/',
              }),
            );
          } catch (pushError) {
            const statusCode = typeof pushError === 'object' && pushError !== null && 'statusCode' in pushError
              ? pushError.statusCode
              : undefined;
            if (statusCode === 404 || statusCode === 410) {
              const { error: deleteError } = await supabase
                .from('chat_push_subscriptions')
                .delete()
                .eq('endpoint', savedSubscription.endpoint);
              if (deleteError) {
                console.error('Could not delete expired push subscription:', deleteError.message);
              }
            } else {
              console.error('Could not deliver chat push notification:', pushError);
            }
          }
        }));
      }
    } catch (pushError) {
      console.error('Could not send chat push notifications:', pushError);
    }
  }

  return respond({
    message: {
      id: message.id,
      player: message.player,
      content: message.content,
      createdAt: message.created_at,
    },
  });
});
