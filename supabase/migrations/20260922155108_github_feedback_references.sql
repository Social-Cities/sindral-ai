alter table public.task_messages
  add column github_feedback_kind text check (github_feedback_kind is null or github_feedback_kind in ('issue_comment', 'review_comment')),
  add column github_comment_url text,
  add column github_pr_url text;

alter table public.task_messages
  add constraint task_messages_github_feedback_check check (
    (github_feedback_kind is null and github_comment_url is null and github_pr_url is null)
    or
    (source = 'github' and external_id is not null and github_feedback_kind is not null and github_pr_url ~ '^https://github\.com/[^/]+/[^/]+/pull/[0-9]+$')
  );
