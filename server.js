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

// ─── Middleware ─────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiter - protect API
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// Multer - memory storage (no disk)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG, PNG, WEBP images are allowed'));
  }
});

// ─── Auth Middleware ────────────────────────────────────────────────────────
async function getUser(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

// ─── Credits Logic ──────────────────────────────────────────────────────────

// For anonymous users: track by session_id cookie/header
async function checkAnonymousCredit(sessionId) {
  const today = new Date().toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('anonymous_usage')
    .select('*')
    .eq('session_id', sessionId)
    .single();

  if (error || !data) {
    // New session - has 1 free credit
    return { canEdit: true, isNew: true };
  }

  if (data.used) {
    return { canEdit: false, isNew: false };
  }

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

// For logged-in users: 5 credits/day
async function checkUserCredits(userId) {
  const today = new Date().toISOString().split('T')[0];

  let { data, error } = await supabase
    .from('user_credits')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (error || !data) {
    // First time user - create record
    await supabase.from('user_credits').insert({
      user_id: userId,
      used_today: 0,
      last_reset: today
    });
    return { canEdit: true, remaining: 5 };
  }

  // Reset if new day
  if (data.last_reset !== today) {
    await supabase.from('user_credits').update({
      used_today: 0,
      last_reset: today
    }).eq('user_id', userId);
    return { canEdit: true, remaining: 5 };
  }

  const remaining = 5 - data.used_today;
  return { canEdit: remaining > 0, remaining: Math.max(0, remaining) };
}

async function useUserCredit(userId) {
  const today = new Date().toISOString().split('T')[0];
  await supabase.rpc('increment_credits', { p_user_id: userId, p_today: today });
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'Loom API' });
});

// Auth: Google OAuth - get redirect URL
app.get('/api/auth/google', async (req, res) => {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: process.env.FRONTEND_URL
    }
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ url: data.url });
});

// Auth: Google OAuth callback
app.get('/api/auth/callback', async (req, res) => {
  res.redirect(`${process.env.FRONTEND_URL}/#auth-callback`);
});

// Auth: Exchange Google access token
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

// Auth: Sign Up (Email + Name)
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: name || '' }
  });

  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Account created! You can now sign in.', user: data.user });
});

// Auth: Sign In (Email)
app.post('/api/auth/signin', async (req, res) => {
  const { email, password } = req.body;

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: 'Invalid email or password' });

  const name = data.user.user_metadata?.full_name || data.user.email?.split('@')[0] || '';
  res.json({
    token: data.session.access_token,
    user: { id: data.user.id, email: data.user.email, name }
  });
});

// Auth: Send Phone OTP
app.post('/api/auth/phone/send', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number required' });

  const { error } = await supabase.auth.signInWithOtp({ phone });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'OTP sent successfully' });
});

// Auth: Verify Phone OTP
app.post('/api/auth/phone/verify', async (req, res) => {
  const { phone, token, name } = req.body;
  if (!phone || !token) return res.status(400).json({ error: 'Phone and token required' });

  const { data, error } = await supabase.auth.verifyOtp({ phone, token, type: 'sms' });
  if (error) return res.status(400).json({ error: error.message });

  // Update name if provided
  if (name && data.user) {
    await supabase.auth.admin.updateUserById(data.user.id, {
      user_metadata: { full_name: name }
    });
  }

  const displayName = name || data.user.phone || '';
  res.json({
    token: data.session.access_token,
    user: { id: data.user.id, phone: data.user.phone, name: displayName }
  });
});

// Auth: Google OAuth — get redirect URL
app.get('/api/auth/google', async (req, res) => {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${process.env.FRONTEND_URL}/auth/callback`
    }
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ url: data.url });
});

// Auth: OAuth Callback — exchange code for session
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

// Get credits status
app.get('/api/credits', async (req, res) => {
  const user = await getUser(req);
  const sessionId = req.headers['x-session-id'];

  if (user) {
    const credits = await checkUserCredits(user.id);
    res.json({ type: 'user', ...credits, daily_limit: 5 });
  } else {
    const credits = await checkAnonymousCredit(sessionId || 'unknown');
    res.json({ type: 'anonymous', canEdit: credits.canEdit, remaining: credits.canEdit ? 1 : 0, daily_limit: 1 });
  }
});

// ─── Enhance Prompt ──────────────────────────────────────────────────────────
app.post('/api/enhance', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${GEMINI_KEY}`;

  try {
    const geminiRes = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [{ text: `You are an expert AI image editing prompt engineer specializing in product photography.
Take this simple prompt and rewrite it into a detailed, professional prompt for AI image editing.
Rules:
- Keep the same core intent
- Add professional photography details (lighting, shadows, background quality, composition)
- Be specific and descriptive
- Keep it under 80 words
- Respond ONLY with the improved prompt, no explanations, no quotation marks
- If the input is in Arabic, respond in Arabic. If English, respond in English.

Prompt to enhance: "${prompt}"` }]
        }],
        generationConfig: { maxOutputTokens: 200 }
      })
    });

    const data = await geminiRes.json();
    const enhanced = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!enhanced) return res.status(500).json({ error: 'Enhancement failed' });
    res.json({ enhanced });
  } catch (err) {
    console.error('Enhance error:', err);
    res.status(500).json({ error: 'Enhancement failed' });
  }
});


app.post('/api/edit', upload.single('image'), async (req, res) => {
  try {
    const { prompt, sessionId } = req.body;
    const user = await getUser(req);

    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    if (!prompt || prompt.trim().length < 3) return res.status(400).json({ error: 'Please provide a description' });

    // ── Check Credits ──
    if (user) {
      const credits = await checkUserCredits(user.id);
      if (!credits.canEdit) {
        return res.status(403).json({
          error: 'Daily limit reached',
          error_ar: 'انتهت الكريديتس اليومية',
          message: 'You have used all 5 daily credits. Come back tomorrow!',
          remaining: 0
        });
      }
    } else {
      const sid = sessionId || req.headers['x-session-id'];
      if (!sid) return res.status(400).json({ error: 'Session ID required for anonymous usage' });

      const credits = await checkAnonymousCredit(sid);
      if (!credits.canEdit) {
        return res.status(403).json({
          error: 'Free credit used',
          error_ar: 'استهلكت الكريديت المجاني',
          message: 'Create a free account to get 5 daily credits!',
          requiresAuth: true,
          remaining: 0
        });
      }
    }

    // ── Call Gemini ──
    const imageBase64 = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;

    // Build the prompt - enhanced for product photography
    const enhancedPrompt = buildProductPrompt(prompt);

    const GEMINI_KEY = process.env.GEMINI_API_KEY;
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
      return res.status(500).json({ error: 'Image generation failed. Please try again.' });
    }

    // ── Deduct Credit ──
    if (user) {
      await useUserCredit(user.id);
      const newCredits = await checkUserCredits(user.id);
      const remaining = newCredits.remaining;

      res.json({
        success: true,
        image: editedImageBase64,
        mimeType: 'image/png',
        remaining_credits: remaining,
        text: textResponse
      });
    } else {
      const sid = sessionId || req.headers['x-session-id'];
      await useAnonymousCredit(sid);
      res.json({
        success: true,
        image: editedImageBase64,
        mimeType: 'image/png',
        remaining_credits: 0,
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

// ─── Fallback to Frontend ────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start Server ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Loom API running on port ${PORT}`);
});
