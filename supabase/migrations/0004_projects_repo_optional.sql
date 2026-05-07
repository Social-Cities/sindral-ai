-- Projects can now be created without a GitHub repo. The repo URL becomes
-- an optional field that the user can fill in later from project settings.

alter table projects alter column repo drop not null;
