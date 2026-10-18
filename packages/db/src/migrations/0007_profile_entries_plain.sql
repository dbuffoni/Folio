-- 0007_profile_entries_plain.sql — signature and "today" entries are not kept in a profile: the profile names one
-- signature (profiles.signature_id) and the date of the day is written by Smart Fill itself.
UPDATE profiles SET signature_id = (SELECT value FROM profile_fields f WHERE f.profile_id = profiles.id AND f.type = 'signature' AND f.value IN (SELECT id FROM signatures) ORDER BY f.sort_order LIMIT 1)
  WHERE signature_id IS NULL;
DELETE FROM profile_fields WHERE type = 'signature';
UPDATE profile_fields SET type = 'date' WHERE type = 'today';
