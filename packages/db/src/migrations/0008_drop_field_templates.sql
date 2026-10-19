-- 0008_drop_field_templates.sql — user-defined field templates are removed (0.1.3, owner decision). New profiles
-- start from built-in presets, which are constants in code. Profiles and their entries (incl. options_json) stay.
DROP TABLE IF EXISTS field_templates;
