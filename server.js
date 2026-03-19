require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// ─── Clients ───────────────────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Multi-Key Rotation ─────────────────────────────────────────────────────
const GEMINI_KEYS = [
  process.env.GEMINI_KEY_1 || process.env.GEMINI_API_KEY,
  process.env.GEMINI_KEY_2,
  process.env.GEMINI_KEY_3,
  process.env.GEMINI_KEY_4,
  process.env.GEMINI_KEY_5,
].filter(Boolean);

let _keyIndex = 0;
function getGeminiKey() {
  const key = GEMINI_KEYS[_keyIndex % GEMINI_KEYS.length];
  _keyIndex++;
  return key;
}
console.log(`✅ Loaded ${GEMINI_KEYS.length} Gemini key(s)`);

// ─── Middleware ─────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/favicon.svg', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'public', 'favicon.svg'));
});

// ─── FIX #1: IMPROVED RATE LIMITING (now handles 50-100 concurrent users) ────
const mainLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || req.ip,
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many requests. Please wait.' });
  },
  skip: (req) => req.path === '/api/health'
});

const editLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  skipSuccessfulRequests: false,
  handler: (req, res) => {
    res.status(429).json({ error: 'Editing too fast. Please wait.' });
  }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }
});

app.use('/api/', mainLimiter);
// Will apply editLimiter at /api/edit route below

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG, PNG, WEBP images are allowed'));
  }
});

// ─── FIX #3: SIMPLE CACHING SYSTEM ────────────────────────────────────────────
class SimpleCache {
  constructor(ttl = 60000) {
    this.ttl = ttl;
    this.data = new Map();
  }
  set(key, value) {
    this.data.set(key, { value, expiresAt: Date.now() + this.ttl });
  }
  get(key) {
    const item = this.data.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      this.data.delete(key);
      return null;
    }
    return item.value;
  }
  clear() { this.data.clear(); }
}

const creditCache = new SimpleCache(60000);
const historyCache = new SimpleCache(120000);

// Auto cleanup every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, item] of creditCache.data) {
    if (now > item.expiresAt) creditCache.data.delete(key);
  }
  for (const [key, item] of historyCache.data) {
    if (now > item.expiresAt) historyCache.data.delete(key);
  }
}, 5 * 60 * 1000);

console.log('✅ Cache initialized');

// ─── FIX #4: BASIC MONITORING ─────────────────────────────────────────────────
const metrics = {
  requests: 0,
  edits: 0,
  errors: 0,
  totalTime: 0,
  startTime: Date.now()
};

app.use((req, res, next) => {
  const start = Date.now();
  const originalJson = res.json;
  
  res.json = function(data) {
    const time = Date.now() - start;
    metrics.requests++;
    metrics.totalTime += time;
    if (time > 5000) console.warn(`⚠️ SLOW: ${req.method} ${req.path} (${time}ms)`);
    if (res.statusCode >= 400) metrics.errors++;
    return originalJson.call(this, data);
  };
  next();
});

async function logEvent({ event_type, user_id = null, session_id = null, plan = null, success = true } = {}) {
  try {
    await supabase.from('api_stats').insert({
      event_type,
      user_id,
      session_id,
      plan,
      success,
      model: 'gemini-flash',
      tokens_est: event_type === 'image_edit' ? 1200 : event_type === 'enhance' ? 300 : 0
    });
  } catch (e) {
    // non-critical, never break the main flow
  }
}

// ─── Auth Middleware ────────────────────────────────────────────────────────
async function getUser(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return { user: null, tokenProvided: false };
  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return { user: null, tokenProvided: true };
  return { user, tokenProvided: true };
}

// ─── Credits Logic ──────────────────────────────────────────────────────────
async function checkAnonymousCredit(sessionId) {
  const { data, error } = await supabase
    .from('anonymous_usage')
    .select('*')
    .eq('session_id', sessionId)
    .single();

  if (error || !data) return { canEdit: true, isNew: true };
  if (data.used) return { canEdit: false, isNew: false };
  return { canEdit: true, isNew: false, existing: data };
}

async function useAnonymousCredit(sessionId) {
  const { data: existing } = await supabase
    .from('anonymous_usage')
    .select('*')
    .eq('session_id', sessionId)
    .single();

  if (!existing) {
    await supabase.from('anonymous_usage').insert({ session_id: sessionId, used: true });
  } else {
    await supabase.from('anonymous_usage').update({ used: true }).eq('session_id', sessionId);
  }
}

async function checkUserCredits(userId) {
  // Check cache first
  const cached = creditCache.get(`credits:${userId}`);
  if (cached) return cached;
  
  const today = new Date().toISOString().split('T')[0];

  let { data, error } = await supabase
    .from('user_credits')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (error || !data) {
    await supabase.from('user_credits').insert({
      user_id: userId,
      used_today: 0,
      last_reset: today,
      plan: 'free',
      monthly_credits: 3
    });
    return { canEdit: true, remaining: 3, total_credits: 3, plan: 'free' };
  }

  if (data.subscription_end_date && new Date(data.subscription_end_date) < new Date()) {
    await supabase.from('user_credits').update({
      plan: 'free',
      monthly_credits: 3,
      subscription_end_date: null
    }).eq('user_id', userId);
    data.plan = 'free';
    data.monthly_credits = 3;
  }

  const limit = data.monthly_credits || 3;
  const currentPlan = data.plan || 'free';

  // Free = 3 credits/month (no daily reset). Paid plans get daily reset.
  if (currentPlan !== 'free' && data.last_reset !== today) {
    await supabase.from('user_credits').update({
      used_today: 0,
      last_reset: today
    }).eq('user_id', userId);
    return { canEdit: true, remaining: limit, total_credits: limit, plan: currentPlan };
  }

  const remaining = limit - data.used_today;
  const result = {
    canEdit: remaining > 0,
    remaining: Math.max(0, remaining),
    total_credits: limit,
    plan: data.plan || 'free'
  };
  
  // Cache the result
  creditCache.set(`credits:${userId}`, result);
  return result;
}

async function useUserCredit(userId) {
  const today = new Date().toISOString().split('T')[0];
  await supabase.rpc('increment_credits', { p_user_id: userId, p_today: today });
}

// ─── Routes ─────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'Loom API' });
});

app.get('/api/auth/google', async (req, res) => {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: process.env.FRONTEND_URL }
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ url: data.url });
});

app.get('/api/auth/callback', async (req, res) => {
  res.redirect(`${process.env.FRONTEND_URL}/#auth-callback`);
});

app.post('/api/auth/google-token', async (req, res) => {
  const { access_token } = req.body;
  if (!access_token) return res.status(400).json({ error: 'Token required' });
  const { data, error } = await supabase.auth.getUser(access_token);
  if (error || !data.user) return res.status(401).json({ error: 'Invalid token' });
  res.json({
    token: access_token,
    user: { id: data.user.id, email: data.user.email, name: data.user.user_metadata?.full_name }
  });
});

app.post('/api/auth/signup', authLimiter, async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: name || '' }
  });

  if (error) return res.status(400).json({ error: error.message });

  // ✅ Log signup event
  await logEvent({ event_type: 'signup', user_id: data.user.id, plan: 'free' });

  res.json({ message: 'Account created! You can now sign in.', user: data.user });
});

app.post('/api/auth/signin', authLimiter, async (req, res) => {
  const { email, password } = req.body;

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: 'Invalid email or password' });

  // ✅ Log signin event
  await logEvent({ event_type: 'signin', user_id: data.user.id });

  const name = data.user.user_metadata?.full_name || data.user.email?.split('@')[0] || '';
  res.json({
    token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    user: { id: data.user.id, email: data.user.email, name }
  });
});

app.post('/api/auth/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'Refresh token required' });

  const { data, error } = await supabase.auth.refreshSession({ refresh_token });
  if (error || !data.session) return res.status(401).json({ error: 'Session expired, please login again' });

  const name = data.user.user_metadata?.full_name || data.user.email?.split('@')[0] || '';
  res.json({
    token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    user: { id: data.user.id, email: data.user.email, name }
  });
});

app.post('/api/auth/phone/send', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number required' });
  const { error } = await supabase.auth.signInWithOtp({ phone });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'OTP sent successfully' });
});

app.post('/api/auth/phone/verify', async (req, res) => {
  const { phone, token, name } = req.body;
  if (!phone || !token) return res.status(400).json({ error: 'Phone and token required' });

  const { data, error } = await supabase.auth.verifyOtp({ phone, token, type: 'sms' });
  if (error) return res.status(400).json({ error: error.message });

  if (name && data.user) {
    await supabase.auth.admin.updateUserById(data.user.id, {
      user_metadata: { full_name: name }
    });
  }

  await logEvent({ event_type: 'signup_phone', user_id: data.user.id, plan: 'free' });

  const displayName = name || data.user.phone || '';
  res.json({
    token: data.session.access_token,
    user: { id: data.user.id, phone: data.user.phone, name: displayName }
  });
});

app.post('/api/auth/callback', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return res.status(400).json({ error: error.message });

  const name = data.user.user_metadata?.full_name || data.user.user_metadata?.name || '';
  res.json({
    token: data.session.access_token,
    user: { id: data.user.id, email: data.user.email, name }
  });
});

app.get('/api/credits', async (req, res) => {
  const { user, tokenProvided } = await getUser(req);
  const sessionId = req.headers['x-session-id'];

  if (tokenProvided && !user) {
    return res.status(401).json({ error: 'Session expired', error_ar: 'انتهت الجلسة' });
  }
  if (user) {
    const credits = await checkUserCredits(user.id);
    res.json({ type: 'user', ...credits });
  } else {
    const credits = await checkAnonymousCredit(sessionId || 'unknown');
    res.json({ type: 'anonymous', canEdit: credits.canEdit, remaining: credits.canEdit ? 1 : 0, total_credits: 1 });
  }
});

// ─── Edit History ────────────────────────────────────────────────────────────
app.get('/api/history', async (req, res) => {
  const { user } = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Login required' });

  const { data, error } = await supabase
    .from('edit_history')
    .select('id, prompt, edited_img, original_img, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ history: data || [] });
});

app.delete('/api/history/clear', async (req, res) => {
  const { user } = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Login required' });
  await supabase.from('edit_history').delete().eq('user_id', user.id);
  res.json({ success: true });
});

app.post('/api/enhance', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });

  const { user } = await getUser(req);
  const GROQ_KEY = process.env.GROQ_API_KEY;

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `You are an expert AI image editing prompt engineer specializing in product photography.
Take this simple prompt and rewrite it into a detailed, professional prompt for AI image editing.
Rules:
- Keep the same core intent
- Add professional photography details (lighting, shadows, background quality, composition)
- Be specific and descriptive
- Keep it under 80 words
- Respond ONLY with the improved prompt, no explanations, no quotation marks
- If the input is in Arabic, respond in Arabic. If English, respond in English.

Prompt to enhance: "${prompt}"`
        }]
      })
    });

    const data = await groqRes.json();
    const enhanced = data?.choices?.[0]?.message?.content?.trim();
    if (!enhanced) return res.status(500).json({ error: 'Enhancement failed' });

    // ✅ Log enhance event
    await logEvent({ event_type: 'enhance', user_id: user?.id || null });

    res.json({ enhanced });
  } catch (err) {
    console.error('Enhance error:', err);
    res.status(500).json({ error: 'Enhancement failed' });
  }
});

app.post('/api/edit', editLimiter, upload.single('image'), async (req, res) => {
  try {
    const { prompt, sessionId } = req.body;
    const { user, tokenProvided } = await getUser(req);

    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    if (!prompt || prompt.trim().length < 3) return res.status(400).json({ error: 'Please provide a description' });

    if (tokenProvided && !user) {
      return res.status(401).json({ error: 'Session expired', error_ar: 'انتهت الجلسة، سجّل دخولك مجدداً' });
    }

    if (user) {
      const credits = await checkUserCredits(user.id);
      if (!credits.canEdit) {
        await logEvent({ event_type: 'edit_blocked_no_credits', user_id: user.id, plan: credits.plan, success: false });
        return res.status(403).json({
          error: 'Daily limit reached',
          error_ar: 'انتهت الكريديتس اليومية',
          message: 'You have used all your credits. Upgrade your plan or come back tomorrow!',
          remaining: 0,
          plan: credits.plan
        });
      }
    } else {
      const sid = sessionId || req.headers['x-session-id'];
      if (!sid) return res.status(400).json({ error: 'Session ID required for anonymous usage' });

      const credits = await checkAnonymousCredit(sid);
      if (!credits.canEdit) {
        await logEvent({ event_type: 'edit_blocked_anonymous', session_id: sid, success: false });
        return res.status(403).json({
          error: 'Free credit used',
          error_ar: 'استهلكت الكريديت المجاني',
          message: 'Create a free account to get 3 daily credits!',
          requiresAuth: true,
          remaining: 0
        });
      }
    }

    const imageBase64 = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;
    const enhancedPrompt = buildProductPrompt(prompt);

    const GEMINI_KEY = process.env.GEMINI_API_KEY; // paid key only for image editing
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${GEMINI_KEY}`;

    const geminiRes = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: enhancedPrompt },
            { inline_data: { mime_type: mimeType, data: imageBase64 } }
          ]
        }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE']
        }
      })
    });

    const geminiData = await geminiRes.json();
    console.log('Gemini status:', geminiRes.status);

    if (!geminiRes.ok) {
      console.error('Gemini error:', JSON.stringify(geminiData?.error));
      await logEvent({ event_type: 'image_edit', user_id: user?.id || null, success: false });
      return res.status(500).json({ error: 'Image generation failed', details: geminiData?.error?.message });
    }

    let editedImageBase64 = null;
    let textResponse = '';
    const parts = geminiData?.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (part.inline_data?.data) editedImageBase64 = part.inline_data.data;
      else if (part.inlineData?.data) editedImageBase64 = part.inlineData.data;
      else if (part.text) textResponse = part.text;
    }

    if (!editedImageBase64) {
      await logEvent({ event_type: 'image_edit', user_id: user?.id || null, success: false });
      return res.status(500).json({ error: 'Image generation failed. Please try again.' });
    }

    if (user) {
      await useUserCredit(user.id);
      const newCredits = await checkUserCredits(user.id);

      // ✅ Log successful edit
      await logEvent({ event_type: 'image_edit', user_id: user.id, plan: newCredits.plan, success: true });

      try {
        await supabase.from('edit_history').insert({
          user_id: user.id,
          prompt: prompt.trim(),
          original_img: null, // لا نحفظ الصورة الأصلية لتوفير المساحة
          edited_img: editedImageBase64,
        });
        const { data: oldRows } = await supabase
          .from('edit_history')
          .select('id')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .range(10, 999);
        if (oldRows?.length) {
          await supabase.from('edit_history').delete().in('id', oldRows.map(r => r.id));
        }
      } catch(e) { /* non-critical */ }

      res.json({
        success: true,
        image: editedImageBase64,
        mimeType: 'image/png',
        remaining_credits: newCredits.remaining,
        total_credits: newCredits.total_credits,
        plan: newCredits.plan,
        text: textResponse
      });
    } else {
      const sid = sessionId || req.headers['x-session-id'];
      await useAnonymousCredit(sid);

      // ✅ Log anonymous edit
      await logEvent({ event_type: 'image_edit', session_id: sid, plan: 'anonymous', success: true });

      res.json({
        success: true,
        image: editedImageBase64,
        mimeType: 'image/png',
        remaining_credits: 0,
        total_credits: 1,
        requiresAuthForMore: true,
        text: textResponse
      });
    }

  } catch (err) {
    console.error('Edit error full:', JSON.stringify({
      message: err.message,
      status: err.status,
      cause: err.cause
    }));

    if (err.message?.includes('SAFETY')) {
      return res.status(400).json({ error: 'The image or prompt was flagged. Please try a different one.' });
    }

    res.status(500).json({ error: 'Something went wrong. Please try again.', details: err.message });
  }
});

// ─── Prompt Builder ──────────────────────────────────────────────────────────
function buildProductPrompt(userPrompt) {
  return `You are an expert AI product photo editor. Your task is to edit the provided product image exactly as instructed.

CRITICAL RULES - NEVER BREAK THESE:
1. The product itself must remain 100% IDENTICAL - do not change the label, logo, text, colors, jar shape, lid, or any product detail
2. Only edit the background, lighting, or scene around the product
3. The product must look photorealistic and natural in any new scene
4. If placing the product in someone's hand: the hand must be fully visible, natural, and properly sized relative to the product - never cut off heads or bodies awkwardly
5. Maintain proper human anatomy and proportions at all times
6. The product label must always face the camera and be fully readable

USER INSTRUCTION:
${userPrompt}

OUTPUT: Return only the edited image, photorealistic, high quality, professional commercial photography standard.`;
}

// ─── Gumroad Webhook ─────────────────────────────────────────────────────────
// ✅ FIXED: now correctly handles both Starter and Loom Pro plans
app.post('/api/gumroad/webhook', async (req, res) => {
  try {
    const { email, product_permalink, sale_timestamp } = req.body;
    if (!email) return res.status(400).json({ error: 'No email' });

    const { data: userData, error: userError } = await supabase.auth.admin.listUsers();
    if (userError) return res.status(500).json({ error: 'Error fetching users' });

    const user = userData.users.find(u => u.email === email);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // ✅ Determine plan based on product_permalink
    let plan = 'starter';
    let monthly_credits = 15;

    if (product_permalink === 'gszgh') {
      plan = 'business';
      monthly_credits = 100;
    } else if (product_permalink === 'fiqku') {
      plan = 'pro';
      monthly_credits = 40;
    } else if (product_permalink === 'ixfwd') {
      plan = 'starter';
      monthly_credits = 15;
    }

    const endDate = new Date();
    endDate.setDate(endDate.getDate() + 30);

    await supabase.from('user_credits').upsert({
      user_id: user.id,
      plan,
      monthly_credits,
      used_today: 0,
      last_reset: new Date().toISOString().split('T')[0],
      subscription_end_date: endDate.toISOString()
    }, { onConflict: 'user_id' });

    // ✅ Log subscription event
    await logEvent({ event_type: 'subscription', user_id: user.id, plan, success: true });

    console.log(`✅ ${plan} plan (${monthly_credits} credits) activated for ${email}`);
    res.json({ success: true, plan, monthly_credits });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin Analytics API ─────────────────────────────────────────────────────
// ✅ NEW: endpoint to power your admin dashboard
app.get('/api/admin/stats', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const today = new Date().toISOString().split('T')[0];
    const thisMonth = new Date().toISOString().slice(0, 7);

    // Total edits today
    const { count: editsToday } = await supabase
      .from('api_stats')
      .select('*', { count: 'exact', head: true })
      .eq('event_type', 'image_edit')
      .eq('success', true)
      .gte('created_at', today);

    // Total edits this month
    const { count: editsMonth } = await supabase
      .from('api_stats')
      .select('*', { count: 'exact', head: true })
      .eq('event_type', 'image_edit')
      .eq('success', true)
      .gte('created_at', thisMonth);

    // Total signups
    const { count: signupsTotal } = await supabase
      .from('api_stats')
      .select('*', { count: 'exact', head: true })
      .in('event_type', ['signup', 'signup_phone']);

    // Active subscribers
    const { count: subscribers } = await supabase
      .from('user_credits')
      .select('*', { count: 'exact', head: true })
      .in('plan', ['starter', 'pro', 'business'])
      .gt('subscription_end_date', new Date().toISOString());

    // Starter vs Pro breakdown with margins
    const { count: starterCount } = await supabase
      .from('user_credits')
      .select('*', { count: 'exact', head: true })
      .eq('plan', 'starter')
      .gt('subscription_end_date', new Date().toISOString());

    const { count: proCount } = await supabase
      .from('user_credits')
      .select('*', { count: 'exact', head: true })
      .eq('plan', 'pro')
      .gt('subscription_end_date', new Date().toISOString());

    const { count: businessCount } = await supabase
      .from('user_credits')
      .select('*', { count: 'exact', head: true })
      .eq('plan', 'business')
      .gt('subscription_end_date', new Date().toISOString());

    // Cost per image for profitability tracking
    const PLAN_COSTS = {
      free: { images: 3, apiCost: 0.78 },
      starter: { images: 15, apiCost: 3.90 },
      pro: { images: 40, apiCost: 10.40 },
      business: { images: 100, apiCost: 26.00 }
    };

    // Estimated cost (each edit ~$0.002)
    const estimatedCostMonth = ((editsMonth || 0) * 0.002).toFixed(2);

    // Last 7 days edits
    const last7 = new Date();
    last7.setDate(last7.getDate() - 7);
    const { data: recentEdits } = await supabase
      .from('api_stats')
      .select('created_at')
      .eq('event_type', 'image_edit')
      .eq('success', true)
      .gte('created_at', last7.toISOString())
      .order('created_at', { ascending: true });

    res.json({
      edits_today: editsToday || 0,
      edits_month: editsMonth || 0,
      signups_total: signupsTotal || 0,
      subscribers_active: subscribers || 0,
      starter_count: starterCount || 0,
      pro_count: proCount || 0,
      business_count: businessCount || 0,
      estimated_cost_month_usd: estimatedCostMonth,
      recent_edits: recentEdits || [],
      plan_costs: PLAN_COSTS,
      plan_metrics: {
        starter: { price: 9, apiCost: 3.90, profit: 5.10, margin: 56.7 },
        pro: { price: 19, apiCost: 10.40, profit: 8.60, margin: 45.3 },
        business: { price: 39, apiCost: 26.00, profit: 13.00, margin: 33.3 }
      }
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// NEW FEATURE #1: PROMPT EXTRACTION/ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/analyze-reference', editLimiter, upload.single('reference_image'), async (req, res) => {
  try {
    // Validate input
    if (!req.file) {
      return res.status(400).json({ error: 'No image provided' });
    }

    // Get user and credits
    const { user } = await getUser(req);
    const sessionId = req.headers['x-session-id'] || null;
    
    let canAnalyze = false;
    if (user) {
      const credits = await checkUserCredits(user.id);
      canAnalyze = credits.canEdit;
    } else if (sessionId) {
      canAnalyze = await checkAnonymousCredit(sessionId);
    }

    if (!canAnalyze) {
      return res.status(403).json({ 
        error: 'No credits available',
        requiresAuth: true 
      });
    }

    // Get Gemini API
    const genAI = new GoogleGenerativeAI(getGeminiKey());
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    // Prepare image
    const base64Image = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;
    const mode = req.body.mode || 'extract_style';
    const goal = (req.body.goal || '').trim();

    // Build prompt based on mode
    let analysisPrompt;

    if (mode === 'generate_prompt') {
      // Tool 4: Generate custom prompt for user's product
      analysisPrompt = `You are an elite AI product photography prompt engineer.

Analyze this product image carefully.

${goal ? `User's goal: ${goal}` : ''}

Write a PRECISE, PROFESSIONAL editing prompt (under 110 words) that:
1. Identifies the best background scene/environment for this exact product category
2. Specifies lighting direction, softness, and shadow style
3. Defines surface/texture for the product to rest on
4. Sets mood and color palette that flatters the product
5. Includes composition and depth-of-field style
6. Ends with quality keywords: photorealistic, commercial photography, 8K, product hero shot

RULES:
- Do NOT describe the product itself — only what surrounds it
- Keep the product 100% unchanged
- Respond in the SAME LANGUAGE as the user's goal (Arabic if Arabic goal, English if English goal)
- If no goal provided, respond in Arabic
- Start directly with the prompt — no preamble
- Begin with: "برومت:" or "PROMPT:" depending on language`;

    } else {
      // Tool 2: Extract photography style (original behavior)
      analysisPrompt = `You are a professional product photographer analyst.

Analyze this reference product image and extract ONLY the photography style details.

CRITICAL: Focus ONLY on the environment, lighting, background, and style.
Do NOT mention or describe the product itself.

Extract and describe in detail:
1. Background (color, texture, pattern, brightness level)
2. Lighting setup (direction, softness, intensity, shadow characteristics)
3. Camera angle and perspective
4. Color palette and dominant tones
5. Texture and surface appearance
6. Overall mood and aesthetic
7. Any special effects or post-processing style

Format your response as a detailed, actionable photography prompt that a different product photographer could use to photograph a DIFFERENT product in the EXACT same style.

The prompt should be ready to use directly in an image generation API or as instructions for a photographer.

Start with: "PHOTOGRAPHY STYLE PROMPT:"`;
    }

    const response = await model.generateContent([
      {
        inlineData: {
          data: base64Image,
          mimeType: mimeType
        }
      },
      { text: analysisPrompt }
    ]);

    const extractedPrompt = response.response.text();

    // Deduct credit
    if (user) {
      await useUserCredit(user.id);
    } else if (sessionId) {
      await useAnonymousCredit(sessionId);
    }

    // Log event
    await logEvent({
      event_type: 'prompt_analysis',
      user_id: user?.id || null,
      session_id: sessionId,
      success: true
    });

    // Get remaining credits
    let remainingCredits = 'anonymous';
    if (user) {
      const updated = await checkUserCredits(user.id);
      remainingCredits = updated.remaining;
    }

    res.json({
      success: true,
      prompt: extractedPrompt,
      credit_used: 1,
      remaining_credits: remainingCredits
    });

  } catch (err) {
    console.error('Analyze error:', err);
    
    const { user } = await getUser(req);
    const sessionId = req.headers['x-session-id'] || null;
    
    await logEvent({
      event_type: 'prompt_analysis',
      user_id: user?.id || null,
      session_id: sessionId,
      success: false
    });

    res.status(500).json({ 
      error: 'Failed to analyze image',
      details: err.message 
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// NEW FEATURE #2: PRODUCT SWAP/REPLACEMENT
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/swap-product', editLimiter, upload.fields([
  { name: 'user_product', maxCount: 1 },
  { name: 'reference_image', maxCount: 1 }
]), async (req, res) => {
  try {
    // Validate input
    if (!req.files['user_product'] || !req.files['reference_image']) {
      return res.status(400).json({ 
        error: 'Both images required',
        required: ['user_product', 'reference_image']
      });
    }

    const swapPrompt = req.body.swap_prompt || '';
    if (!swapPrompt.trim()) {
      return res.status(400).json({ error: 'Swap prompt required' });
    }

    // Get user and credits
    const { user } = await getUser(req);
    const sessionId = req.headers['x-session-id'] || null;
    
    let canSwap = false;
    if (user) {
      const credits = await checkUserCredits(user.id);
      canSwap = credits.canEdit;
    } else if (sessionId) {
      canSwap = await checkAnonymousCredit(sessionId);
    }

    if (!canSwap) {
      return res.status(403).json({ 
        error: 'No credits available',
        requiresAuth: true 
      });
    }

    // Get Gemini API
    const genAI = new GoogleGenerativeAI(getGeminiKey());
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    // Prepare images
    const userProductBase64 = req.files['user_product'][0].buffer.toString('base64');
    const referenceImageBase64 = req.files['reference_image'][0].buffer.toString('base64');

    // Call Gemini to analyze swap
    const swapAnalysisPrompt = `You are an expert in product composition and styling.

You will receive two images:
1. The user's product (that needs to be placed)
2. A reference image (with environment to replicate)

Your task: Provide detailed instructions for replacing the reference product with the user's product while keeping EVERYTHING ELSE identical.

CRITICAL RULES:
1. ONLY analyze - do not generate images
2. The background must remain EXACTLY as is
3. The lighting must remain EXACTLY as is
4. The shadows and reflections must stay in the same positions
5. The camera angle must be identical
6. The composition and framing must be preserved
7. Only the product itself changes

Reference Style Instructions: ${swapPrompt}

Provide detailed instructions that include:
- Exact placement location
- Size adjustments needed
- Lighting adjustments (if minimal)
- Shadow considerations
- Reflection handling
- Color harmony adjustments
- Final composition notes

Format as: "PRODUCT SWAP INSTRUCTIONS:"`;

    const response = await model.generateContent([
      { text: 'User Product to Insert:' },
      {
        inlineData: {
          data: userProductBase64,
          mimeType: req.files['user_product'][0].mimetype
        }
      },
      { text: 'Reference Image (environment to keep):' },
      {
        inlineData: {
          data: referenceImageBase64,
          mimeType: req.files['reference_image'][0].mimetype
        }
      },
      { text: swapAnalysisPrompt }
    ]);

    const swapInstructions = response.response.text();

    // Deduct credit
    if (user) {
      await useUserCredit(user.id);
    } else if (sessionId) {
      await useAnonymousCredit(sessionId);
    }

    // Log event
    await logEvent({
      event_type: 'product_swap',
      user_id: user?.id || null,
      session_id: sessionId,
      success: true
    });

    // Get remaining credits
    let remainingCredits = 'anonymous';
    if (user) {
      const updated = await checkUserCredits(user.id);
      remainingCredits = updated.remaining;
    }

    res.json({
      success: true,
      message: 'Product swap analysis completed',
      instructions: swapInstructions,
      next_steps: 'Use these instructions with image generation API (DALL-E, Stable Diffusion, Midjourney) to generate the final swapped image',
      credit_used: 1,
      remaining_credits: remainingCredits
    });

  } catch (err) {
    console.error('Swap error:', err);
    
    const { user } = await getUser(req);
    const sessionId = req.headers['x-session-id'] || null;
    
    await logEvent({
      event_type: 'product_swap',
      user_id: user?.id || null,
      session_id: sessionId,
      success: false
    });

    res.status(500).json({ 
      error: 'Failed to swap products',
      details: err.message 
    });
  }
});



// ═══════════════════════════════════════════════════════════════════════
// TOOL 3: SWAP GENERATE — يولّد صورة فعلية بدمج المنتج في المشهد المرجعي
// ═══════════════════════════════════════════════════════════════════════

app.post('/api/swap-generate', editLimiter, upload.fields([
  { name: 'user_product',    maxCount: 1 },
  { name: 'reference_image', maxCount: 1 }
]), async (req, res) => {
  try {
    if (!req.files['user_product'] || !req.files['reference_image']) {
      return res.status(400).json({ error: 'Both images required' });
    }

    const extraPrompt = (req.body.extra_prompt || '').trim();
    const { user, tokenProvided } = await getUser(req);
    const sessionId = req.headers['x-session-id'] || req.body.sessionId;

    if (tokenProvided && !user) {
      return res.status(401).json({ error: 'Session expired', error_ar: 'انتهت الجلسة' });
    }

    if (user) {
      const credits = await checkUserCredits(user.id);
      if (!credits.canEdit) {
        return res.status(403).json({ error: 'No credits available', remaining: 0, plan: credits.plan });
      }
    } else {
      const sid = sessionId;
      if (!sid) return res.status(400).json({ error: 'Session ID required' });
      const cred = await checkAnonymousCredit(sid);
      if (!cred.canEdit) {
        return res.status(403).json({ error: 'Free credit used', requiresAuth: true });
      }
    }

    const productBase64   = req.files['user_product'][0].buffer.toString('base64');
    const productMime     = req.files['user_product'][0].mimetype;
    const referenceBase64 = req.files['reference_image'][0].buffer.toString('base64');
    const referenceMime   = req.files['reference_image'][0].mimetype;

    const swapPrompt = `You are an expert AI product photo editor.

You are given TWO images:
1. USER'S PRODUCT — the product that must appear in the final image
2. REFERENCE SCENE — the background, environment, lighting and composition to replicate

YOUR TASK: Generate a NEW photorealistic image where the USER'S PRODUCT is placed naturally in the EXACT same scene as the reference image.

CRITICAL RULES — NEVER BREAK:
1. The USER'S PRODUCT must appear 100% identical — same label, colors, shape, logo, every detail
2. The background, lighting, shadows, textures and composition must match the reference scene exactly
3. The product placement must look natural and physically realistic
4. Match the camera angle and perspective from the reference image
5. The product label must always face the camera and be fully readable
6. Shadows and reflections must be consistent with the reference lighting
7. Final image must be photorealistic commercial photography quality

${extraPrompt ? `Additional instruction: ${extraPrompt}` : ''}

OUTPUT: A single photorealistic product image at commercial photography quality. The product from image 1 placed in the scene from image 2.`;

    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${GEMINI_KEY}`;

    const geminiRes = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: 'IMAGE 1 — USER PRODUCT (must remain identical):' },
            { inline_data: { mime_type: productMime,   data: productBase64   } },
            { text: 'IMAGE 2 — REFERENCE SCENE (background/environment to replicate):' },
            { inline_data: { mime_type: referenceMime, data: referenceBase64 } },
            { text: swapPrompt }
          ]
        }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
      })
    });

    const geminiData = await geminiRes.json();

    if (!geminiRes.ok) {
      console.error('Gemini swap-generate error:', JSON.stringify(geminiData?.error));
      await logEvent({ event_type: 'swap_generate', user_id: user?.id || null, success: false });
      return res.status(500).json({ error: 'Image generation failed', details: geminiData?.error?.message });
    }

    let editedImageBase64 = null;
    const parts = geminiData?.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (part.inline_data?.data) editedImageBase64 = part.inline_data.data;
      else if (part.inlineData?.data) editedImageBase64 = part.inlineData.data;
    }

    if (!editedImageBase64) {
      await logEvent({ event_type: 'swap_generate', user_id: user?.id || null, success: false });
      return res.status(500).json({ error: 'No image returned. Please try again.' });
    }

    if (user) {
      await useUserCredit(user.id);
      const newCredits = await checkUserCredits(user.id);
      await logEvent({ event_type: 'swap_generate', user_id: user.id, plan: newCredits.plan, success: true });

      try {
        await supabase.from('edit_history').insert({
          user_id: user.id,
          prompt: `[SWAP] ${extraPrompt || 'Product swap from reference'}`.trim(),
          original_img: null,
          edited_img: editedImageBase64,
        });
        const { data: oldRows } = await supabase
          .from('edit_history').select('id')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .range(10, 999);
        if (oldRows?.length) {
          await supabase.from('edit_history').delete().in('id', oldRows.map(r => r.id));
        }
      } catch(e) { /* non-critical */ }

      return res.json({
        success: true,
        image: editedImageBase64,
        mimeType: 'image/png',
        remaining_credits: newCredits.remaining,
        total_credits: newCredits.total_credits,
        plan: newCredits.plan
      });

    } else {
      const sid = sessionId;
      await useAnonymousCredit(sid);
      await logEvent({ event_type: 'swap_generate', session_id: sid, plan: 'anonymous', success: true });
      return res.json({
        success: true,
        image: editedImageBase64,
        mimeType: 'image/png',
        remaining_credits: 0,
        total_credits: 1,
        requiresAuthForMore: true
      });
    }

  } catch (err) {
    console.error('Swap-generate error:', err.message);
    if (err.message?.includes('SAFETY')) {
      return res.status(400).json({ error: 'Image flagged by safety filter. Please try different images.' });
    }
    res.status(500).json({ error: 'Something went wrong. Please try again.', details: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// TOOL 2: REMOVE BACKGROUND — يزيل الخلفية ويضع خلفية بيضاء نقية
// ═══════════════════════════════════════════════════════════════════════

app.post('/api/remove-bg', editLimiter, upload.single('image'), async (req, res) => {
  try {
    const { sessionId } = req.body;
    const { user, tokenProvided } = await getUser(req);

    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    if (tokenProvided && !user) {
      return res.status(401).json({ error: 'Session expired', error_ar: 'انتهت الجلسة، سجّل دخولك مجدداً' });
    }

    if (user) {
      const credits = await checkUserCredits(user.id);
      if (!credits.canEdit) {
        await logEvent({ event_type: 'remove_bg', user_id: user.id, plan: credits.plan, success: false });
        return res.status(403).json({ error: 'No credits available', remaining: 0, plan: credits.plan });
      }
    } else {
      const sid = sessionId || req.headers['x-session-id'];
      if (!sid) return res.status(400).json({ error: 'Session ID required' });
      const cred = await checkAnonymousCredit(sid);
      if (!cred.canEdit) {
        return res.status(403).json({ error: 'Free credit used', requiresAuth: true });
      }
    }

    const imageBase64 = req.file.buffer.toString('base64');
    const mimeType    = req.file.mimetype;

    const bgRemovePrompt = `You are an expert AI photo editor specializing in e-commerce product photography for Amazon UAE and Noon marketplace.

Remove the background from this product image completely.

CRITICAL RULES:
1. Replace the background with pure white (#FFFFFF) — perfectly clean solid white
2. The product itself must remain 100% IDENTICAL — same colors, shape, labels, logo, every single detail
3. Product edges must be clean, sharp, and natural — no harsh cutout effect, no fringing
4. Remove ALL shadows, reflections, and environmental elements from the background area
5. Keep a very subtle natural shadow directly under the product for realism (optional, only if it looks natural)
6. Result must meet Amazon UAE and Noon marketplace standards for product listing images

OUTPUT: Return only the edited image with pure white background. Professional commercial photography quality.`;

    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${GEMINI_KEY}`;

    const geminiRes = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: bgRemovePrompt },
            { inline_data: { mime_type: mimeType, data: imageBase64 } }
          ]
        }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
      })
    });

    const geminiData = await geminiRes.json();

    if (!geminiRes.ok) {
      console.error('Remove BG Gemini error:', JSON.stringify(geminiData?.error));
      await logEvent({ event_type: 'remove_bg', user_id: user?.id || null, success: false });
      return res.status(500).json({ error: 'Background removal failed', details: geminiData?.error?.message });
    }

    let editedImageBase64 = null;
    const parts = geminiData?.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (part.inline_data?.data)  editedImageBase64 = part.inline_data.data;
      else if (part.inlineData?.data) editedImageBase64 = part.inlineData.data;
    }

    if (!editedImageBase64) {
      await logEvent({ event_type: 'remove_bg', user_id: user?.id || null, success: false });
      return res.status(500).json({ error: 'No image returned. Please try again.' });
    }

    if (user) {
      await useUserCredit(user.id);
      const newCredits = await checkUserCredits(user.id);
      await logEvent({ event_type: 'remove_bg', user_id: user.id, plan: newCredits.plan, success: true });
      try {
        await supabase.from('edit_history').insert({
          user_id: user.id,
          prompt: '[REMOVE BG] خلفية بيضاء نقية',
          original_img: null,
          edited_img: editedImageBase64,
        });
        const { data: oldRows } = await supabase
          .from('edit_history').select('id')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .range(10, 999);
        if (oldRows?.length) {
          await supabase.from('edit_history').delete().in('id', oldRows.map(r => r.id));
        }
      } catch(e) { /* non-critical */ }

      return res.json({
        success: true,
        image: editedImageBase64,
        mimeType: 'image/png',
        remaining_credits: newCredits.remaining,
        total_credits: newCredits.total_credits,
        plan: newCredits.plan
      });
    } else {
      const sid = sessionId || req.headers['x-session-id'];
      await useAnonymousCredit(sid);
      await logEvent({ event_type: 'remove_bg', session_id: sid, plan: 'anonymous', success: true });
      return res.json({
        success: true,
        image: editedImageBase64,
        mimeType: 'image/png',
        remaining_credits: 0,
        total_credits: 1,
        requiresAuthForMore: true
      });
    }

  } catch (err) {
    console.error('Remove BG error:', err.message);
    if (err.message?.includes('SAFETY')) {
      return res.status(400).json({ error: 'Image flagged by safety filter. Please try a different image.' });
    }
    res.status(500).json({ error: 'Something went wrong. Please try again.', details: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// TOOL 4: INFOGRAPHIC — يولّد إنفوجرافيك احترافي بالعربي
// ═══════════════════════════════════════════════════════════════════════

app.post('/api/infographic', editLimiter, upload.single('image'), async (req, res) => {
  try {
    const { features, sessionId } = req.body;
    const { user, tokenProvided } = await getUser(req);

    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    if (!features || features.trim().length < 3) {
      return res.status(400).json({ error: 'Product features required', error_ar: 'أدخل مميزات المنتج أولاً' });
    }
    if (tokenProvided && !user) {
      return res.status(401).json({ error: 'Session expired', error_ar: 'انتهت الجلسة، سجّل دخولك مجدداً' });
    }

    if (user) {
      const credits = await checkUserCredits(user.id);
      if (!credits.canEdit) {
        await logEvent({ event_type: 'infographic', user_id: user.id, plan: credits.plan, success: false });
        return res.status(403).json({ error: 'No credits available', remaining: 0, plan: credits.plan });
      }
    } else {
      const sid = sessionId || req.headers['x-session-id'];
      if (!sid) return res.status(400).json({ error: 'Session ID required' });
      const cred = await checkAnonymousCredit(sid);
      if (!cred.canEdit) {
        return res.status(403).json({ error: 'Free credit used', requiresAuth: true });
      }
    }

    const imageBase64 = req.file.buffer.toString('base64');
    const mimeType    = req.file.mimetype;

    const featureLines = features.trim().split('\n').filter(l => l.trim()).map(l => l.trim());
    const featuresFormatted = featureLines.map((f, i) => `${i+1}. ${f}`).join('\n');

    const infographicPrompt = `You are a professional e-commerce graphic designer creating Amazon A+ content and product infographics for the UAE market.

Create a COMPLETE professional product infographic image.

DESIGN REQUIREMENTS:
- Pure white (#FFFFFF) background — clean and bright
- The product is CENTERED and prominently displayed
- Add ${Math.min(featureLines.length, 6)} callout lines pointing to different parts of the product
- Each callout consists of: a thin elegant line + a rounded text box with title and subtitle
- Text boxes: white background, subtle light gray border, rounded corners
- Overall design: premium, clean, modern — Amazon A+ content quality standard

PRODUCT FEATURES (write these as callout labels in Arabic):
${featuresFormatted}

TYPOGRAPHY & LANGUAGE:
- Write ALL text in Arabic
- Arabic text must be right-to-left aligned
- Callout titles: bold Arabic, ~15px
- Callout subtitles: regular Arabic, ~11px, muted gray color
- Font: clean modern Arabic typeface

CALLOUT PLACEMENT:
- Distribute callouts evenly: some on the right side, some on the left side
- Top callouts point to upper product features (lid, cap, top area)
- Bottom callouts point to lower features (base, bottom, material)
- Lines should be thin (1px) and elegant
- Leave generous space around the product

PRODUCT RULE (MOST IMPORTANT):
- The product itself must remain 100% IDENTICAL — same colors, shape, labels, text, logo
- Do NOT modify anything about the product appearance

OUTPUT: Return the complete infographic image. White background, product centered, Arabic callouts, professional e-commerce quality.`;

    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${GEMINI_KEY}`;

    const geminiRes = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: infographicPrompt },
            { inline_data: { mime_type: mimeType, data: imageBase64 } }
          ]
        }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
      })
    });

    const geminiData = await geminiRes.json();

    if (!geminiRes.ok) {
      console.error('Infographic Gemini error:', JSON.stringify(geminiData?.error));
      await logEvent({ event_type: 'infographic', user_id: user?.id || null, success: false });
      return res.status(500).json({ error: 'Infographic generation failed', details: geminiData?.error?.message });
    }

    let editedImageBase64 = null;
    const resParts = geminiData?.candidates?.[0]?.content?.parts || [];
    for (const part of resParts) {
      if (part.inline_data?.data)  editedImageBase64 = part.inline_data.data;
      else if (part.inlineData?.data) editedImageBase64 = part.inlineData.data;
    }

    if (!editedImageBase64) {
      await logEvent({ event_type: 'infographic', user_id: user?.id || null, success: false });
      return res.status(500).json({ error: 'No image returned. Please try again.' });
    }

    if (user) {
      await useUserCredit(user.id);
      const newCredits = await checkUserCredits(user.id);
      await logEvent({ event_type: 'infographic', user_id: user.id, plan: newCredits.plan, success: true });
      try {
        const featuresSummary = featureLines.slice(0,3).join(' | ');
        await supabase.from('edit_history').insert({
          user_id: user.id,
          prompt: `[INFOGRAPHIC] ${featuresSummary}`.substring(0, 200),
          original_img: null,
          edited_img: editedImageBase64,
        });
        const { data: oldRows } = await supabase
          .from('edit_history').select('id')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .range(10, 999);
        if (oldRows?.length) {
          await supabase.from('edit_history').delete().in('id', oldRows.map(r => r.id));
        }
      } catch(e) { /* non-critical */ }

      return res.json({
        success: true,
        image: editedImageBase64,
        mimeType: 'image/png',
        remaining_credits: newCredits.remaining,
        total_credits: newCredits.total_credits,
        plan: newCredits.plan
      });
    } else {
      const sid = sessionId || req.headers['x-session-id'];
      await useAnonymousCredit(sid);
      await logEvent({ event_type: 'infographic', session_id: sid, plan: 'anonymous', success: true });
      return res.json({
        success: true,
        image: editedImageBase64,
        mimeType: 'image/png',
        remaining_credits: 0,
        total_credits: 1,
        requiresAuthForMore: true
      });
    }

  } catch (err) {
    console.error('Infographic error:', err.message);
    if (err.message?.includes('SAFETY')) {
      return res.status(400).json({ error: 'Image flagged by safety filter. Please try a different image.' });
    }
    res.status(500).json({ error: 'Something went wrong. Please try again.', details: err.message });
  }
});

// ─── Explicit static HTML routes ────────────────────────────────────────────
app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/privacy.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});
app.get('/terms.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});

// ─── Fallback to Frontend ────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── FIX #2: TIMEOUT & MONITORING ENDPOINT ────────────────────────────────────
app.use((req, res, next) => {
  res.setTimeout(50000, () => {
    if (!res.headersSent) {
      res.status(408).json({ error: 'Request timeout' });
    }
  });
  next();
});

app.get('/api/metrics', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const uptime = (Date.now() - metrics.startTime) / 1000;
  res.json({
    uptime: `${Math.floor(uptime / 60)} min`,
    requests: metrics.requests,
    errors: metrics.errors,
    avgTime: Math.round(metrics.totalTime / metrics.requests) + 'ms',
    cacheSize: creditCache.data.size
  });
});

// ─── Start Server ────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`🚀 Loom API running on port ${PORT} [OPTIMIZED]`);
  console.log('✅ Rate limiting: ACTIVE');
  console.log('✅ Caching: ACTIVE');
  console.log('✅ Monitoring: ACTIVE');
});

// Set server timeout
server.setTimeout(60000);
