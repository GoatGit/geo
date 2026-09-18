-- Keep legacy cookies for compatibility; localStorage carries DeepSeek's userToken.
ALTER TABLE account_profiles ADD COLUMN IF NOT EXISTS storage_state jsonb;
