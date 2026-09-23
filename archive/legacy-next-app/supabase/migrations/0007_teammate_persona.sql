-- Per-teammate persona. persona_preset is one of the built-in preset ids
-- ('golang', 'typescript', 'kotlin', 'python', 'ruby') or 'custom' when the
-- user supplies their own prompt. persona_prompt is the resolved system
-- prompt used by the worker when this agent runs — for presets it's a
-- snapshot of the preset text at write time, so updating the preset library
-- later doesn't retroactively change every existing agent.

alter table teammates
  add column if not exists persona_preset text not null default 'custom',
  add column if not exists persona_prompt text not null default '';
