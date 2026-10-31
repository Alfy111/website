import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const PHOTO_BUCKET = 'chat-photos';
const MAX_PHOTO_SIZE_BYTES = 8 * 1024 * 1024;
const PHOTO_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
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
      url.hostname.endsWith('.push.apple.com') ||
      url.hostname === 'fcm.googleapis.com' ||
      url.hostname === 'updates.push.services.mozilla.com' ||
      url.hostname.endsWith('.notify.windows.com')
    );
  } catch {
    return false;
  }
}

function isPlayerPhotoPath(value: unknown, player: string): value is string {
  if (typeof value !== 'string' || !value.startsWith(`${player}/`)) return false;
  return isPhotoFilename(value.slice(player.length + 1));
}

function isPhotoFilename(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp|gif|heic|heif)$/i
    .test(value);
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
    messageId?: unknown;
    reaction?: unknown;
    enabled?: unknown;
    contentType?: unknown;
    paths?: unknown;
    mediaPath?: unknown;
    replyToId?: unknown;
    messageIds?: unknown;
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
    body.action !== 'seen' &&
    body.action !== 'typing' &&
    body.action !== 'react' &&
    body.action !== 'photo-upload' &&
    body.action !== 'photo-urls' &&
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
  const allowedPhotoPlayers = [
    Deno.env.get('CHAT_PLAYER_1') || 'ashy',
    Deno.env.get('CHAT_PLAYER_2') || 'alfey',
  ];

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

  if (body.action === 'photo-upload') {
    if (typeof body.contentType !== 'string' || !PHOTO_EXTENSIONS[body.contentType]) {
      return respond({ error: 'Unsupported photo type.' }, 400);
    }

    const path = `${player}/${crypto.randomUUID()}.${PHOTO_EXTENSIONS[body.contentType]}`;
    const { data, error } = await supabase.storage
      .from(PHOTO_BUCKET)
      .createSignedUploadUrl(path);

    if (error) {
      console.error('Could not create signed photo upload URL:', error.message);
      return respond({ error: 'Could not prepare the photo upload.' }, 500);
    }

    return respond({ path: data.path, signedUrl: data.signedUrl });
  }

  if (body.action === 'photo-urls') {
    if (
      !Array.isArray(body.paths) ||
      body.paths.length > 50 ||
      body.paths.some((path) => typeof path !== 'string' || !allowedPhotoPlayers.some((owner) =>
        isPlayerPhotoPath(path, owner)
      ))
    ) {
      return respond({ error: 'Invalid photo paths.' }, 400);
    }

    const paths = [...new Set(body.paths as string[])];
    if (!paths.length) return respond({ photoUrls: {} });

    const { data, error } = await supabase.storage
      .from(PHOTO_BUCKET)
      .createSignedUrls(paths, 3600);

    if (error) {
      console.error('Could not create signed photo URLs:', error.message);
      return respond({ error: 'Could not load chat photos.' }, 500);
    }

    const photoUrls: Record<string, string> = {};
    for (const item of data) {
      if (item.error || !item.signedUrl) {
        console.error('Could not create signed URL for chat photo:', item.path, item.error);
        continue;
      }
      photoUrls[item.path] = item.signedUrl;
    }
    return respond({ photoUrls });
  }

  if (body.action === 'seen') {
    if (
      !Array.isArray(body.messageIds) ||
      body.messageIds.length > 1000 ||
      body.messageIds.some((id) =>
        typeof id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
      )
    ) {
      return respond({ error: 'Invalid message IDs for read receipts.' }, 400);
    }
    if (!body.messageIds.length) return respond({ seenMessages: [] });

    const seenAt = new Date().toISOString();
    const { data: seenMessages, error } = await supabase
      .from('chat_messages')
      .update({ seen_by: player, seen_at: seenAt })
      .neq('player', player)
      .in('id', body.messageIds as string[])
      .is('seen_at', null)
      .select('id, seen_by, seen_at');

    if (error) {
      console.error('Could not mark chat messages as seen:', error.message);
      return respond({ error: 'Could not update message read status.' }, 500);
    }

    return respond({
      seenMessages: seenMessages.map((message) => ({
        id: message.id,
        seenBy: message.seen_by,
        seenAt: message.seen_at,
      })),
    });
  }

  if (body.action === 'load') {
    const otherPlayer = body.pin === pin1
      ? (Deno.env.get('CHAT_PLAYER_2') || 'alfey')
      : (Deno.env.get('CHAT_PLAYER_1') || 'ashy');
    const typingSince = new Date(Date.now() - 5000).toISOString();
    const [{ data, error }, { data: typingState, error: typingError }] = await Promise.all([
      supabase
        .from('chat_messages')
        .select('id, player, content, media_path, created_at, seen_by, seen_at, reply_to')
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
    const replyToIds = [...new Set(messages.map((message) => message.reply_to).filter(Boolean))];
    const { data: reactions, error: reactionsError } = messageIds.length
      ? await supabase
        .from('chat_message_reactions')
        .select('message_id, player, reaction')
        .in('message_id', messageIds)
      : { data: [], error: null };
    const { data: replyParents, error: replyParentsError } = replyToIds.length
      ? await supabase
        .from('chat_messages')
        .select('id, player, content, media_path')
        .in('id', replyToIds)
      : { data: [], error: null };

    if (reactionsError) {
      console.error('Could not load chat reactions:', reactionsError.message);
      return respond({ error: 'Could not load message reactions.' }, 500);
    }
    if (replyParentsError) {
      console.error('Could not load replied-to messages:', replyParentsError.message);
      return respond({ error: 'Could not load message replies.' }, 500);
    }

    const reactionsByMessage = new Map<string, { player: string; reaction: string }[]>();
    for (const reaction of reactions) {
      const messageReactions = reactionsByMessage.get(reaction.message_id) ?? [];
      messageReactions.push({ player: reaction.player, reaction: reaction.reaction });
      reactionsByMessage.set(reaction.message_id, messageReactions);
    }
    const replyParentById = new Map(replyParents.map((message) => [message.id, message]));

    return respond({
      player,
      otherPlayer,
      typingPlayer: typingState?.player ?? null,
      messages: messages.map((message) => ({
        id: message.id,
        player: message.player,
        content: message.content,
        mediaPath: message.media_path,
        createdAt: message.created_at,
        seenBy: message.seen_by,
        seenAt: message.seen_at,
        replyTo: message.reply_to
          ? (() => {
            const parent = replyParentById.get(message.reply_to);
            return parent
              ? {
                id: parent.id,
                player: parent.player,
                content: parent.content || (parent.media_path ? 'Photo' : ''),
              }
              : null;
          })()
          : null,
        reactions: reactionsByMessage.get(message.id) ?? [],
      })),
    });
  }

  if (body.action === 'react') {
    const messageId = body.messageId;
    const reaction = body.reaction;
    const enabled = body.enabled;
    const isBuiltInReaction = reaction === 'heart' ||
      reaction === 'laugh' ||
      reaction === 'wow' ||
      reaction === 'sad' ||
      reaction === 'angry' ||
      reaction === 'like';
    if (
      typeof messageId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(messageId) ||
      !isBuiltInReaction ||
      typeof enabled !== 'boolean'
    ) {
      return respond({ error: 'Invalid message reaction.' }, 400);
    }

    const { error } = enabled
      ? await supabase
        .from('chat_message_reactions')
        .upsert(
          { message_id: messageId, player, reaction },
          { onConflict: 'message_id,player,reaction' },
        )
      : await supabase
        .from('chat_message_reactions')
        .delete()
        .eq('message_id', messageId)
        .eq('player', player)
        .eq('reaction', reaction);

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

  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const mediaPath = body.mediaPath === undefined ? null : body.mediaPath;
  const replyToId = body.replyToId === undefined ? null : body.replyToId;
  if (
    (content.length > 2000 || (!content && !mediaPath)) ||
    (mediaPath !== null && !isPlayerPhotoPath(mediaPath, player)) ||
    (replyToId !== null && (
      typeof replyToId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(replyToId)
    ))
  ) {
    return respond({ error: 'Enter a message or attach a valid photo and reply target.' }, 400);
  }

  let replyParent = null;
  if (replyToId) {
    const { data, error: replyError } = await supabase
      .from('chat_messages')
      .select('id, player, content, media_path')
      .eq('id', replyToId)
      .maybeSingle();
    if (replyError) {
      console.error('Could not load replied-to message:', replyError.message);
      return respond({ error: 'Could not load the message being replied to.' }, 500);
    }
    if (!data) return respond({ error: 'The message being replied to no longer exists.' }, 400);
    replyParent = data;
  }

  if (mediaPath) {
    const { data: photo, error: photoError } = await supabase.storage
      .from(PHOTO_BUCKET)
      .info(mediaPath);
    if (photoError || !photo) {
      if (photoError) console.error('Could not verify uploaded chat photo:', photoError.message);
      return respond({ error: 'The photo upload is missing or expired. Please retry.' }, 400);
    }
    if (photo.metadata?.size > MAX_PHOTO_SIZE_BYTES) {
      return respond({ error: 'Photos must be 8 MB or smaller.' }, 400);
    }
  }

  const { data: message, error } = await supabase
    .from('chat_messages')
    .insert({ player, content, media_path: mediaPath, reply_to: replyToId })
    .select('id, player, content, media_path, created_at, seen_by, seen_at, reply_to')
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
        .select('endpoint, subscription, notification_title')
        .eq('player', recipientPlayer);

      if (subscriptionError) {
        console.error('Could not load message push recipients:', subscriptionError.message);
      } else {
        await Promise.all((subscriptions ?? []).map(async (savedSubscription) => {
          try {
            await webpush.sendNotification(
              savedSubscription.subscription,
              JSON.stringify({
                title: typeof savedSubscription.notification_title === 'string'
                  ? savedSubscription.notification_title
                  : 'Volume Should Be Turned Down',
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
      mediaPath: message.media_path,
      createdAt: message.created_at,
      seenBy: message.seen_by,
      seenAt: message.seen_at,
      replyTo: replyParent
        ? {
          id: replyParent.id,
          player: replyParent.player,
          content: replyParent.content || (replyParent.media_path ? 'Photo' : ''),
        }
        : null,
    },
  });
});
