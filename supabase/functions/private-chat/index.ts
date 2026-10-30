import { createClient } from 'npm:@supabase/supabase-js@2';

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

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return respond({ error: 'Method not allowed.' }, 405);
  }

  let body: { action?: unknown; pin?: unknown; content?: unknown };
  try {
    body = await request.json();
  } catch {
    return respond({ error: 'Invalid request.' }, 400);
  }

  if ((body.action !== 'load' && body.action !== 'send') || typeof body.pin !== 'string' || !/^\d{4}$/.test(body.pin)) {
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

  if (body.action === 'load') {
    const { data, error } = await supabase
      .from('chat_messages')
      .select('id, player, content, created_at')
      .order('created_at', { ascending: false })
      .limit(1000);

    if (error) {
      console.error('Could not load chat messages:', error.message);
      return respond({ error: 'Could not load chat history.' }, 500);
    }

    return respond({
      player,
      messages: data.reverse().map((message) => ({
        id: message.id,
        player: message.player,
        content: message.content,
        createdAt: message.created_at,
      })),
    });
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

  return respond({
    message: {
      id: message.id,
      player: message.player,
      content: message.content,
      createdAt: message.created_at,
    },
  });
});
