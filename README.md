# Loom — تعديل صور المنتجات بالذكاء الاصطناعي

> Made with ❤️ by Maven

---

## 🚀 خطوات الإعداد الكاملة

### 1️⃣ Supabase — إعداد قاعدة البيانات

1. اذهب إلى [supabase.com](https://supabase.com) → افتح مشروع Loom
2. اذهب إلى **SQL Editor**
3. انسخ محتوى ملف `supabase-schema.sql` وشغّله
4. اذهب إلى **Settings > API**:
   - انسخ `Project URL` → هذا هو `SUPABASE_URL`
   - انسخ `service_role` key → هذا هو `SUPABASE_SERVICE_KEY`

---

### 2️⃣ Google Gemini API Key

1. اذهب إلى [aistudio.google.com](https://aistudio.google.com)
2. **Get API Key** → اختار مشروع `loom` من Google Cloud
3. انسخ الـ API Key

---

### 3️⃣ Railway — Deploy Backend

1. اذهب إلى [railway.app](https://railway.app)
2. **New Project > Deploy from GitHub**
3. ارفع الكود أو اربطه بـ GitHub repo
4. اضف **Variables** (Environment Variables):

```
GEMINI_API_KEY=your_key_here
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=your_service_role_key
FRONTEND_URL=https://loomuae.xyz
NODE_ENV=production
PORT=3000
```

5. بعد الـ deploy، انسخ الـ Railway URL (مثل: `https://loom-xxx.railway.app`)

---

### 4️⃣ GoDaddy — ربط الدومين

1. اذهب إلى GoDaddy → **DNS Management** لـ `loomuae.xyz`
2. أضف **CNAME Record**:
   - Type: `CNAME`
   - Name: `@` أو `www`
   - Value: `your-railway-domain.railway.app`
3. في Railway: **Settings > Domains** → أضف `loomuae.xyz`

---

## 📁 هيكل المشروع

```
loom/
├── server.js              # Express server + API routes
├── package.json
├── railway.json           # Railway deployment config
├── supabase-schema.sql    # Database tables
├── .env.example           # Environment variables template
└── public/
    └── index.html         # Frontend (UI كاملة)
```

---

## 🔧 نظام الكريديتس

| الحالة | الكريديتس |
|--------|-----------|
| بدون حساب | 1 صورة مجانية (مرة واحدة) |
| بعد التسجيل | 5 صور / يوم مجاناً |

---

## 🤖 الـ AI المستخدم

- **Model**: `gemini-2.0-flash-exp-image-generation`
- **Input**: صورة المنتج + برومت (عربي أو إنجليزي)
- **Output**: الصورة المعدّلة

---

## 💡 ملاحظات مهمة

- الـ `SUPABASE_SERVICE_KEY` يجب أن يكون **service_role** وليس **anon**
- لا ترفع ملف `.env` على GitHub — استخدم `.env.example` فقط
- الـ `multer` يخزن الصور في الذاكرة (memory) وليس على القرص — مناسب لـ Railway
