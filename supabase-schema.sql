-- =====================================================
-- LOOM - Supabase Schema
-- Run this in: Supabase Dashboard > SQL Editor
-- =====================================================

-- 1. User Credits Table
CREATE TABLE IF NOT EXISTS user_credits (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  used_today  integer DEFAULT 0,
  last_reset  date DEFAULT CURRENT_DATE,
  total_used  integer DEFAULT 0,
  created_at  timestamptz DEFAULT now()
);

-- 2. Anonymous Usage Table (track by session ID)
CREATE TABLE IF NOT EXISTS anonymous_usage (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id  text UNIQUE NOT NULL,
  used        boolean DEFAULT false,
  ip_address  text,
  created_at  timestamptz DEFAULT now()
);

-- 3. RPC function to safely increment credits
CREATE OR REPLACE FUNCTION increment_credits(p_user_id uuid, p_today text)
RETURNS void AS $$
BEGIN
  UPDATE user_credits
  SET
    used_today = used_today + 1,
    total_used = total_used + 1
  WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    INSERT INTO user_credits (user_id, used_today, total_used, last_reset)
    VALUES (p_user_id, 1, 1, p_today::date);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Row Level Security
ALTER TABLE user_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE anonymous_usage ENABLE ROW LEVEL SECURITY;

-- Service role can do everything (backend uses service key)
CREATE POLICY "Service role full access to user_credits"
  ON user_credits FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access to anonymous_usage"
  ON anonymous_usage FOR ALL
  USING (auth.role() = 'service_role');

-- 5. Auto-cleanup old anonymous sessions (older than 30 days)
-- Run this as a scheduled job in Supabase (optional)
-- DELETE FROM anonymous_usage WHERE created_at < now() - interval '30 days';
