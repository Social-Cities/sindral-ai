import { useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { SecretProvider, SecretStatus, WorkerKey } from '@sindral/shared';
import { useSearchParams } from 'react-router';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Modal } from '@/components/Modal';
import { RelativeTime } from '@/components/RelativeTime';
import { useConnectGitHub, useCreateWorkerKey, useDeleteSecret, useRevokeWorkerKey, useSecrets, useSetSecret, useWorkerKeys } from '@/hooks/useSettings';
import { useWorkers } from '@/hooks/useWorkers';
import { formatDateTime } from '@/lib/format';
import { WorkerPanel } from './Home';

const API_ORIGIN = import.meta.env.VITE_API_URL || (typeof window !== 'undefined' ? window.location.origin : '');

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg bg-card border border-border">
      <div className="px-5 py-4 border-b border-border">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {description && <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{description}</p>}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

interface SecretFormProps {
  provider: SecretProvider;
  status: SecretStatus | undefined;
  tokenLabel: string;
  placeholder: string;
  hint: string;
  withEmail?: boolean;
}

function SecretForm({ provider, status, tokenLabel, placeholder, hint, withEmail = false }: SecretFormProps) {
  const setSecret = useSetSecret();
  const deleteSecret = useDeleteSecret();
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const configured = status?.configured ?? false;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await setSecret.mutateAsync({ provider, token, ...(withEmail ? { email } : {}) });
      setToken('');
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function remove() {
    setError(null);
    try {
      await deleteSecret.mutateAsync(provider);
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="flex items-center gap-2 text-xs">
        <span className={`w-1.5 h-1.5 rounded-full ${configured ? 'bg-emerald-400' : 'bg-muted-foreground'}`} aria-hidden="true" />
        <span className="text-secondary-foreground">
          {configured ? (
            <>
              Configured{status?.hint ? <span className="font-mono text-muted-foreground"> · ends in {status.hint}</span> : null}
              {status?.updatedAt ? <span className="text-muted-foreground"> · updated {formatDateTime(status.updatedAt)}</span> : null}
            </>
          ) : (
            'Not configured'
          )}
        </span>
      </div>
      {withEmail && <Input label="Account email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required />}
      <Input
        label={tokenLabel}
        type="password"
        autoComplete="off"
        mono
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder={placeholder}
        hint={hint}
        minLength={8}
        required
      />
      {error && (
        <p className="text-xs text-[#f87171]" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" loading={setSecret.isPending} disabled={!token || (withEmail && !email)}>
          {configured ? 'Replace' : 'Save'}
        </Button>
        {configured && (
          <Button type="button" variant="danger" onClick={remove} loading={deleteSecret.isPending}>
            Remove
          </Button>
        )}
      </div>
    </form>
  );
}

function WorkerKeysSection() {
  const keys = useWorkerKeys();
  const createKey = useCreateWorkerKey();
  const revokeKey = useRevokeWorkerKey();
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{ key: WorkerKey; secret: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<WorkerKey | null>(null);

  const command = created ? `SINDRAL_SERVER_URL=${API_ORIGIN} SINDRAL_WORKER_KEY=${created.secret} pnpm dev:worker` : '';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await createKey.mutateAsync(name.trim());
      setCreated(res);
      setName('');
      setCopied(false);
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  async function revoke(key: WorkerKey) {
    setError(null);
    try {
      await revokeKey.mutateAsync(key.id);
      if (created?.key.id === key.id) setCreated(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setConfirmRevoke(null);
    }
  }

  const activeKeys = useMemo(() => (keys.data ?? []).filter((k) => !k.revokedAt), [keys.data]);
  const revokedKeys = useMemo(() => (keys.data ?? []).filter((k) => k.revokedAt), [keys.data]);

  return (
    <div className="space-y-5">
      <form onSubmit={submit} className="flex items-end gap-2">
        <Input label="New worker key" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. MacBook Pro" maxLength={200} wrapperClassName="flex-1" required />
        <Button type="submit" loading={createKey.isPending} disabled={!name.trim()} size="md">
          Create key
        </Button>
      </form>
      {error && (
        <p className="text-xs text-[#f87171]" role="alert">
          {error}
        </p>
      )}

      {created && (
        <div className="rounded-lg p-4 space-y-3" style={{ background: '#34d39908', border: '1px solid #34d39920' }} data-testid="worker-key-secret">
          <p className="text-xs text-emerald-300/90 font-medium">Key “{created.key.name}” created — copy it now, it will not be shown again.</p>
          <div className="relative">
            <pre className="text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-all p-3 pr-20 rounded bg-background/70 border border-border text-foreground">{command}</pre>
            <Button type="button" variant="subtle" size="xs" onClick={copy} className="absolute top-2 right-2">
              {copied ? 'Copied ✓' : 'Copy'}
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            Run this from the repository root on the machine that should execute agent jobs. The worker registers itself and appears below once it connects.
          </p>
          <Button type="button" variant="subtle" size="xs" onClick={() => setCreated(null)}>
            Dismiss
          </Button>
        </div>
      )}

      <div>
        <p className="label-caps mb-2">Active keys</p>
        {keys.isLoading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : activeKeys.length === 0 ? (
          <p className="text-xs text-muted-foreground">No worker keys yet. Create one to connect a worker.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border overflow-hidden">
            {activeKeys.map((k) => (
              <li key={k.id} className="flex items-center justify-between gap-3 px-3 py-2.5 bg-input/40">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-foreground truncate">{k.name}</p>
                  <p className="text-[10px] font-mono text-muted-foreground mt-0.5">
                    {k.keyPrefix}… · created {formatDateTime(k.createdAt)} · last used {k.lastUsedAt ? <RelativeTime iso={k.lastUsedAt} /> : 'never'}
                  </p>
                </div>
                <Button variant="danger" size="xs" onClick={() => setConfirmRevoke(k)}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
        {revokedKeys.length > 0 && (
          <p className="text-[10px] text-muted-foreground mt-2">
            {revokedKeys.length} revoked key{revokedKeys.length === 1 ? '' : 's'} hidden.
          </p>
        )}
      </div>

      <Modal
        open={confirmRevoke !== null}
        title="Revoke worker key?"
        onClose={() => setConfirmRevoke(null)}
        footer={
          <>
            <Button variant="subtle" className="flex-1" onClick={() => setConfirmRevoke(null)}>
              Cancel
            </Button>
            <Button variant="danger" className="flex-1" onClick={() => confirmRevoke && revoke(confirmRevoke)} loading={revokeKey.isPending}>
              Revoke
            </Button>
          </>
        }
      >
        Workers using “{confirmRevoke?.name}” will be disconnected immediately and can no longer claim jobs.
      </Modal>
    </div>
  );
}

export function Settings() {
  const [searchParams] = useSearchParams();
  const connectGitHub = useConnectGitHub();
  const disconnectGitHub = useDeleteSecret();
  const secrets = useSecrets();
  const workers = useWorkers();
  const byProvider = useMemo(() => new Map((secrets.data ?? []).map((s) => [s.provider, s])), [secrets.data]);
  const [githubError, setGitHubError] = useState<string | null>(null);
  const githubStatus = byProvider.get('github');

  async function connect() {
    setGitHubError(null);
    try {
      const { url } = await connectGitHub.mutateAsync();
      window.location.assign(url);
    } catch (error) {
      setGitHubError(errorText(error));
    }
  }

  async function disconnect() {
    setGitHubError(null);
    try {
      await disconnectGitHub.mutateAsync('github');
    } catch (error) {
      setGitHubError(errorText(error));
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-10 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-foreground tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">Integrations, worker keys and connected workers.</p>
        </div>

        {secrets.isError && (
          <p className="text-xs text-[#f87171]" role="alert">
            Could not load integration status: {errorText(secrets.error)}
          </p>
        )}

        <Section title="GitHub" description="Connect an account to choose repositories, create new ones, open PRs and read review feedback.">
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2 text-xs">
                <span className={`w-1.5 h-1.5 rounded-full ${githubStatus?.configured ? 'bg-emerald-400' : 'bg-muted-foreground'}`} aria-hidden="true" />
                <span className="text-secondary-foreground">{githubStatus?.configured ? 'GitHub connected' : 'Not connected'}</span>
              </div>
              <div className="flex items-center gap-2">
                {githubStatus?.configured && (
                  <Button type="button" variant="danger" onClick={() => void disconnect()} loading={disconnectGitHub.isPending}>
                    Disconnect
                  </Button>
                )}
                <Button type="button" onClick={() => void connect()} loading={connectGitHub.isPending}>
                  {githubStatus?.configured ? 'Reconnect' : 'Connect GitHub'}
                </Button>
              </div>
            </div>
            {searchParams.get('github') === 'connected' && <p className="text-xs text-[#34d399]" role="status">GitHub account connected.</p>}
            {searchParams.get('github') === 'error' && <p className="text-xs text-[#f87171]" role="alert">GitHub authorization did not complete. Try connecting again.</p>}
            {githubError && <p className="text-xs text-[#f87171]" role="alert">{githubError}</p>}
            <details className="border-t border-border pt-3">
              <summary className="text-xs text-muted-foreground cursor-pointer hover:text-secondary-foreground">Use a personal access token instead</summary>
              <div className="pt-3">
                <SecretForm provider="github" status={githubStatus} tokenLabel="Token" placeholder="ghp_…" hint="Stored encrypted; requires repo and read:org scopes." />
              </div>
            </details>
          </div>
        </Section>

        <Section title="Linear" description="API key used to import tickets from linear.app URLs.">
          <SecretForm provider="linear" status={byProvider.get('linear')} tokenLabel="API key" placeholder="lin_api_…" hint="Create one under Linear → Settings → API." />
        </Section>

        <Section title="Jira" description="Account email and API token used to import tickets from atlassian.net URLs.">
          <SecretForm provider="jira" status={byProvider.get('jira')} tokenLabel="API token" placeholder="ATATT…" hint="Create one at id.atlassian.com → Security → API tokens." withEmail />
        </Section>

        <Section title="Worker keys" description="A worker runs agent jobs on your machine. Each key authenticates one worker installation.">
          <WorkerKeysSection />
        </Section>

        <Section title="Workers" description="Workers registered with this account and their current status.">
          <WorkerPanel workers={workers.data ?? []} loading={workers.isLoading} />
          {(workers.data ?? []).length > 0 && (
            <ul className="mt-4 divide-y divide-border rounded-md border border-border overflow-hidden">
              {(workers.data ?? []).map((w) => (
                <li key={w.id} className="flex items-center justify-between gap-3 px-3 py-2.5 bg-input/40">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-foreground truncate">
                      {w.name} <span className="font-mono text-muted-foreground">· {w.hostname}</span>
                    </p>
                    <p className="text-[10px] font-mono text-muted-foreground mt-0.5">
                      v{w.version} · {w.runningJobs} running · last seen <RelativeTime iso={w.lastSeenAt} />
                    </p>
                  </div>
                  <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${w.status === 'online' ? 'text-emerald-300' : 'text-muted-foreground'}`} style={{ background: w.status === 'online' ? '#34d39914' : '#13132a' }}>
                    {w.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}
