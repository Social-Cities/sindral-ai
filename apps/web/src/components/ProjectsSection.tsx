import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { CreateGitHubRepositoryInput } from '@sindral/shared';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { useCreateProject, useProjects } from '@/hooks/useProjects';
import { useGitHubCatalog } from '@/hooks/useSettings';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

function repositoryNameFromTitle(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

export function ProjectsSection() {
  const projects = useProjects();
  const githubCatalog = useGitHubCatalog();
  const createProject = useCreateProject();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [owner, setOwner] = useState('');
  const [repoName, setRepoName] = useState('');
  const [repoEdited, setRepoEdited] = useState(false);
  const [visibility, setVisibility] = useState<CreateGitHubRepositoryInput['visibility']>('private');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  useEffect(() => {
    const firstOwner = githubCatalog.data?.owners[0]?.login;
    if (!owner && firstOwner) setOwner(firstOwner);
  }, [githubCatalog.data, owner]);

  function updateName(value: string) {
    setName(value);
    if (!repoEdited) setRepoName(repositoryNameFromTitle(value));
    setError(null);
    setCreated(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setCreated(null);
    const trimmedName = name.trim();
    const trimmedRepoName = repoName.trim();
    if (!trimmedName || !owner || !trimmedRepoName) {
      setError('Enter a project title, owner and repository name.');
      return;
    }
    try {
      const result = await createProject.mutateAsync({
        name: trimmedName,
        description: description.trim(),
        repository: {
          owner,
          name: trimmedRepoName,
          visibility,
          description: description.trim() || undefined,
        },
      });
      setCreated(result.project.repositories[0]?.repository ?? result.project.name);
      setName('');
      setDescription('');
      setRepoName('');
      setRepoEdited(false);
    } catch (err) {
      setError(errorText(err));
    }
  }

  const connected = githubCatalog.data?.connected === true;

  return (
    <div className="space-y-5">
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input label="App title" value={name} onChange={(event) => updateName(event.target.value)} placeholder="Billing platform" maxLength={200} required />
          <Input
            label="Repository name"
            value={repoName}
            onChange={(event) => {
              setRepoEdited(true);
              setRepoName(event.target.value);
              setError(null);
              setCreated(null);
            }}
            placeholder="billing-platform"
            mono
            maxLength={100}
            required
          />
        </div>
        <Input label="Description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What this app is for" maxLength={2000} />
        <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] gap-3">
          <label className="space-y-1">
            <span className="label-caps block">Owner</span>
            <select
              aria-label="Repository owner"
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
              className="w-full rounded border border-border bg-input px-3 py-2 text-sm font-mono text-foreground outline-none focus:border-accent/40"
              disabled={!connected}
            >
              {!connected && <option value="">Connect GitHub first</option>}
              {githubCatalog.data?.owners.map((item) => <option key={item.login} value={item.login}>{item.login}</option>)}
            </select>
          </label>
          <label className="space-y-1">
            <span className="label-caps block">Visibility</span>
            <select
              aria-label="Repository visibility"
              value={visibility}
              onChange={(event) => setVisibility(event.target.value as CreateGitHubRepositoryInput['visibility'])}
              className="w-full rounded border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-accent/40"
              disabled={!connected}
            >
              <option value="private">Private</option>
              <option value="public">Public</option>
            </select>
          </label>
        </div>
        {githubCatalog.isLoading && <p className="text-xs text-muted-foreground">Loading GitHub owners…</p>}
        {githubCatalog.data && !connected && <p className="text-xs text-muted-foreground">Connect GitHub above to create project repositories.</p>}
        {created && <p className="text-xs text-[#34d399]" role="status">Created project and initialized {created}.</p>}
        {error && <p className="text-xs text-[#f87171]" role="alert">{error}</p>}
        <Button type="submit" loading={createProject.isPending} disabled={!connected || !name.trim() || !owner || !repoName.trim()}>
          Create project
        </Button>
      </form>

      <div>
        <p className="label-caps mb-2">Projects</p>
        {projects.isLoading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (projects.data ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">No projects yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border overflow-hidden">
            {(projects.data ?? []).map((project) => (
              <li key={project.id} className="px-3 py-2.5 bg-input/40">
                <p className="text-xs font-medium text-foreground">{project.name}</p>
                <p className="text-[10px] font-mono text-muted-foreground mt-0.5">
                  {project.repositories.map((repository) => repository.repository).join(', ')}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
