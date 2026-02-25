// MNM Fitness - Cloudflare Worker
// Handles: Stripe webhooks, magic link auth, session management, protected content

const RESEND_API_KEY = 're_cr1DTCVy_G5bpTrMwfSC4MmJWYABy8DBq';
const STRIPE_WEBHOOK_SECRET = 'whsec_1kd0lvcbMTJkHa6z7YLRKcs8BBnf14Ui';
const SITE_URL = 'https://mnmfitness02.mnmfitness02.workers.dev';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (path === '/webhook' && request.method === 'POST') return handleStripeWebhook(request, env);
    if (path === '/auth/request-login' && request.method === 'POST') return handleRequestLogin(request, env, corsHeaders);
    if (path === '/auth/verify' && request.method === 'GET') return handleVerifyToken(request, env);
    if (path === '/auth/logout' && request.method === 'POST') return handleLogout(request, env, corsHeaders);
    if (path === '/api/member' && request.method === 'GET') return handleGetMember(request, env, corsHeaders);

    return new Response('Not found', { status: 404 });
  }
};

async function handleStripeWebhook(request, env) {
  const signature = request.headers.get('stripe-signature');
  const body = await request.text();
  const isValid = await verifyStripeSignature(body, signature, STRIPE_WEBHOOK_SECRET);
  if (!isValid) return new Response('Invalid signature', { status: 401 });

  const event = JSON.parse(body);
  if (event.type === 'checkout.session.completed') await handleCheckoutCompleted(event.data.object, env);
  if (event.type === 'invoice.payment_succeeded') await handleInvoicePayment(event.data.object, env);
  if (event.type === 'customer.subscription.deleted') await handleSubscriptionCancelled(event.data.object, env);

  return new Response('OK', { status: 200 });
}

async function handleCheckoutCompleted(session, env) {
  const email = session.customer_details?.email;
  if (!email) return;

  const productName = session.metadata?.product_name || 'unknown';
  const isSubscription = session.mode === 'subscription';

  let user = await getUser(email, env);
  if (!user) {
    user = { email, createdAt: new Date().toISOString(), products: [], subscriptions: [], monthsActive: {} };
  }

  if (isSubscription) {
    if (!user.subscriptions.includes(productName)) user.subscriptions.push(productName);
    user.monthsActive[productName] = user.monthsActive[productName] || 1;
  } else {
    if (!user.products.includes(productName)) user.products.push(productName);
  }

  user.stripeCustomerId = session.customer;
  await saveUser(email, user, env);
  await sendMagicLink(email.toLowerCase(), env, true);
}

async function handleInvoicePayment(invoice, env) {
  const email = invoice.customer_email;
  if (!email) return;
  const user = await getUser(email, env);
  if (!user) return;
  user.subscriptions.forEach(sub => {
    user.monthsActive[sub] = (user.monthsActive[sub] || 1) + 1;
  });
  await saveUser(email, user, env);
}

async function handleSubscriptionCancelled(subscription, env) {
  console.log('Subscription cancelled:', subscription.id);
}

async function handleRequestLogin(request, env, corsHeaders) {
  const { email } = await request.json();
  if (!email || !email.includes('@')) {
    return new Response(JSON.stringify({ error: 'Invalid email' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
  const user = await getUser(email.toLowerCase(), env);
  if (user) await sendMagicLink(email.toLowerCase(), env, false);
  return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

async function handleVerifyToken(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!token) return new Response(null, { status: 302, headers: { 'Location': `${SITE_URL}/login.html?error=invalid` } });

  const tokenData = await env.MNM_SESSIONS.get(`token:${token}`);
  if (!tokenData) return new Response(null, { status: 302, headers: { 'Location': `${SITE_URL}/login.html?error=expired` } });

  const { email, expires } = JSON.parse(tokenData);
  if (Date.now() > expires) {
    await env.MNM_SESSIONS.delete(`token:${token}`);
    return new Response(null, { status: 302, headers: { 'Location': `${SITE_URL}/login.html?error=expired` } });
  }

  await env.MNM_SESSIONS.delete(`token:${token}`);
  const sessionId = generateId();
  await env.MNM_SESSIONS.put(`session:${sessionId}`, JSON.stringify({ email, createdAt: Date.now() }), { expirationTtl: 60 * 60 * 24 * 30 });

  return new Response(null, {
    status: 302,
    headers: {
      'Location': `${SITE_URL}/members.html`,
      'Set-Cookie': `mnm_session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`
    }
  });
}

async function handleLogout(request, env, corsHeaders) {
  const sessionId = getSessionFromCookie(request);
  if (sessionId) await env.MNM_SESSIONS.delete(`session:${sessionId}`);
  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Set-Cookie': 'mnm_session=; Path=/; Max-Age=0' }
  });
}

async function handleGetMember(request, env, corsHeaders) {
  const sessionId = getSessionFromCookie(request);
  if (!sessionId) return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const sessionData = await env.MNM_SESSIONS.get(`session:${sessionId}`);
  if (!sessionData) return new Response(JSON.stringify({ error: 'Session expired' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const { email } = JSON.parse(sessionData);
  const user = await getUser(email, env);
  if (!user) return new Response(JSON.stringify({ error: 'User not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  return new Response(JSON.stringify({
    email: user.email,
    products: user.products,
    subscriptions: user.subscriptions,
    monthsActive: user.monthsActive,
    createdAt: user.createdAt
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

async function getUser(email, env) {
  const data = await env.MNM_USERS.get(`user:${email.toLowerCase()}`);
  return data ? JSON.parse(data) : null;
}

async function saveUser(email, user, env) {
  await env.MNM_USERS.put(`user:${email.toLowerCase()}`, JSON.stringify(user));
}

async function sendMagicLink(email, env, isNewUser) {
  const token = generateId();
  const expires = Date.now() + 1000 * 60 * 30;
  await env.MNM_SESSIONS.put(`token:${token}`, JSON.stringify({ email, expires }), { expirationTtl: 60 * 30 });

  const magicLink = `${SITE_URL}/auth/verify?token=${token}`;
  const subject = isNewUser ? 'Welcome to MNM Fitness — Access Your Members Area' : 'Your MNM Fitness Login Link';

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0b0b0b;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0b0b0b;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#141414;border:1px solid #222;">
        <tr><td style="background:#f91e0f;padding:30px 40px;text-align:center;">
          <h1 style="margin:0;color:#fff;font-size:28px;font-weight:900;letter-spacing:0.05em;text-transform:uppercase;">MNM FITNESS</h1>
          <p style="margin:6px 0 0;color:rgba(255,255,255,0.8);font-size:12px;letter-spacing:0.2em;text-transform:uppercase;">Members Area</p>
        </td></tr>
        <tr><td style="padding:40px;">
          <h2 style="margin:0 0 16px;color:#fff;font-size:22px;font-weight:700;">${isNewUser ? 'Welcome to the MNM Team.' : 'Your login link is ready.'}</h2>
          <p style="margin:0 0 24px;color:#999;font-size:15px;line-height:1.7;">${isNewUser ? 'Your purchase is confirmed. Click below to access your members area.' : 'Click below to access your MNM members area. This link expires in 30 minutes.'}</p>
          <table cellpadding="0" cellspacing="0" style="margin:0 0 32px;">
            <tr><td style="background:#f91e0f;">
              <a href="${magicLink}" style="display:block;padding:16px 40px;color:#fff;font-size:14px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;text-decoration:none;">Access Members Area →</a>
            </td></tr>
          </table>
          <p style="margin:0;color:#555;font-size:13px;line-height:1.6;">If the button doesn't work, copy this link:<br><a href="${magicLink}" style="color:#f91e0f;word-break:break-all;">${magicLink}</a></p>
        </td></tr>
        <tr><td style="padding:24px 40px;border-top:1px solid #222;">
          <p style="margin:0;color:#444;font-size:12px;">If you didn't request this, you can safely ignore this email.<br>MNM Fitness — Toronto, Canada</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'onboarding@resend.dev', to: email, subject, html })
  });
}

function getSessionFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/mnm_session=([^;]+)/);
  return match ? match[1] : null;
}

function generateId() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyStripeSignature(body, signature, secret) {
  try {
    const sigParts = signature.split(',').reduce((acc, part) => {
      const [key, value] = part.split('=');
      acc[key] = value;
      return acc;
    }, {});
    const payload = `${sigParts['t']}.${body}`;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
    const expectedSig = Array.from(new Uint8Array(signatureBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    return expectedSig === sigParts['v1'];
  } catch (e) {
    return false;
  }
}
