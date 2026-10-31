import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { APP_PLATFORMS, type AppPlatform, type ProjectType, type CreateGitHubRepositoryInput } from '@sindral/shared';
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

type RepositoryMode = 'new' | 'existing';

export function ProjectsSection() {
  const projects = useProjects();
  const githubCatalog = useGitHubCatalog();
  const createProject = useCreateProject();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [projectType, setProjectType] = useState<ProjectType>('standard');
  const [platforms, setPlatforms] = useState<AppPlatform[]>(['ios', 'android']);
  const [repositoryMode, setRepositoryMode] = useState<RepositoryMode>('new');
  const [owner, setOwner] = useState('');
  const [repoName, setRepoName] = useState('');
  const [repoEdited, setRepoEdited] = useState(false);
  const [existingRepos, setExistingRepos] = useState<string[]>([]);
  const [visibility, setVisibility] = useState<CreateGitHubRepositoryInput['visibility']>('private');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  const catalogRepositories = useMemo(
    () => [...(githubCatalog.data?.repositories ?? [])].sort((a, b) => a.fullName.localeCompare(b.fullName)),
    [githubCatalog.data?.repositories],
  );

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

  function updateMode(value: RepositoryMode) {
    setRepositoryMode(value);
    setError(null);
    setCreated(null);
  }

  function toggleExistingRepo(repository: string) {
    setExistingRepos((current) =>
      current.includes(repository)
        ? current.filter((item) => item !== repository)
        : projectType === 'mobile-app' ? [repository] : [...current, repository],
    );
    setError(null);
    setCreated(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setCreated(null);
    const trimmedName = name.trim();
    const trimmedRepoName = repoName.trim();
    if (!trimmedName) {
      setError('Enter a project title.');
      return;
    }
    if (projectType === 'mobile-app' && platforms.length === 0) {
      setError('Select at least one platform.');
      return;
    }
    if (repositoryMode === 'new' && (!owner || !trimmedRepoName)) {
      setError('Enter a project title, owner and repository name.');
      return;
    }
    if (repositoryMode === 'existing' && existingRepos.length === 0) {
      setError('Select at least one existing repository.');
      return;
    }
    try {
      const trimmedDescription = description.trim();
      const mobileConfig = projectType === 'mobile-app' ? { projectType, platforms } : {};
      const result = await createProject.mutateAsync(repositoryMode === 'existing'
        ? {
            name: trimmedName,
            ...mobileConfig,
            description: trimmedDescription,
            repos: existingRepos,
          }
        : {
            name: trimmedName,
            ...mobileConfig,
            description: trimmedDescription,
            repository: {
              owner,
              name: trimmedRepoName,
              visibility,
              description: trimmedDescription || undefined,
            },
          });
      setCreated(repositoryMode === 'existing'
        ? `Created project using ${result.project.repositories.length} ${result.project.repositories.length === 1 ? 'repository' : 'repositories'}.`
        : `Created project and initialized ${result.project.repositories[0]?.repository ?? result.project.name}.`);
      setName('');
      setDescription('');
      setRepoName('');
      setRepoEdited(false);
      setExistingRepos([]);
    } catch (err) {
      setError(errorText(err));
    }
  }

  const connected = githubCatalog.data?.connected === true;
  const canSubmit = connected && Boolean(name.trim()) && (repositoryMode === 'existing' ? existingRepos.length > 0 : Boolean(owner && repoName.trim()));

  return (
    <div className="space-y-5">
      <form onSubmit={submit} className="space-y-3">
        <label className="block text-xs text-muted-foreground">
          Project type
          <select aria-label="Project type" className="block w-full rounded border border-border bg-input px-3 py-2 text-sm text-foreground" value={projectType} onChange={(event) => { setProjectType(event.target.value as ProjectType); setExistingRepos((current) => current.slice(0, 1)); }}>
            <option value="standard">Standard</option>
            <option value="mobile-app">Mobile app</option>
          </select>
        </label>
        {projectType === 'mobile-app' && (
          <fieldset className="space-y-2">
            <legend className="label-caps">Default task platforms</legend>
            <div className="flex gap-4">
              {APP_PLATFORMS.map((platform) => <label key={platform} className="flex gap-2 text-xs"><input type="checkbox" checked={platforms.includes(platform)} onChange={() => setPlatforms((current) => current.includes(platform) ? current.filter((item) => item !== platform) : [...current, platform])} />{platform === 'ios' ? 'iOS' : platform === 'android' ? 'Android' : 'Web'}</label>)}
            </div>
            <p className="text-xs text-muted-foreground">Defaults for new tasks; each task can choose any combination. One monorepo with ios/, android/, and web/ folders and a shared Supabase backend. Selected apps are implemented in that order using SwiftUI, Kotlin / Jetpack Compose, and React.</p>
          </fieldset>
        )}
        <div className="inline-flex rounded-md border border-border bg-input p-1" aria-label="Repository source">
          {(['new', 'existing'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => updateMode(mode)}
              className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                repositoryMode === mode ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
              aria-pressed={repositoryMode === mode}
            >
              {mode === 'new' ? 'Create new repo' : 'Use existing repos'}
            </button>
          ))}
        </div>
        <div className={`grid grid-cols-1 gap-3 ${repositoryMode === 'new' ? 'sm:grid-cols-2' : ''}`}>
          <Input label="App title" value={name} onChange={(event) => updateName(event.target.value)} placeholder="Billing platform" maxLength={200} required />
          {repositoryMode === 'new' && (
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
          )}
        </div>
        <Input label="Description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What this app is for" maxLength={2000} />
        {repositoryMode === 'new' ? (
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
        ) : (
          <div>
            <p className="label-caps mb-2">Repositories</p>
            {catalogRepositories.length === 0 ? (
              <p className="text-xs text-muted-foreground">No writable repositories found for this GitHub account.</p>
            ) : (
              <div className="max-h-48 overflow-y-auto rounded-md border border-border bg-input divide-y divide-border">
                {catalogRepositories.map((repository) => (
                  <label key={repository.fullName} className="flex items-center gap-2 px-3 py-2 text-xs text-secondary-foreground">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-accent"
                      checked={existingRepos.includes(repository.fullName)}
                      onChange={() => toggleExistingRepo(repository.fullName)}
                    />
                    <span className="min-w-0 flex-1 font-mono text-foreground truncate">{repository.fullName}</span>
                    <span className="text-[10px] text-muted-foreground">{repository.private ? 'Private' : 'Public'}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
        {githubCatalog.isLoading && <p className="text-xs text-muted-foreground">Loading GitHub {repositoryMode === 'existing' ? 'repositories' : 'owners'}…</p>}
        {githubCatalog.data && !connected && <p className="text-xs text-muted-foreground">Connect GitHub above to choose project repositories.</p>}
        {created && <p className="text-xs text-[var(--color-success)]" role="status">{created}</p>}
        {error && <p className="text-xs text-[#f87171]" role="alert">{error}</p>}
        <Button type="submit" loading={createProject.isPending} disabled={!canSubmit}>
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
                {project.projectType === 'mobile-app' && <p className="text-[10px] text-muted-foreground">Mobile app · {project.platforms.map((platform) => platform === 'ios' ? 'iOS' : platform === 'android' ? 'Android' : 'Web').join(' → ')} · Supabase</p>}
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
