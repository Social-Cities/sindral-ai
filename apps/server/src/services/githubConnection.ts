import type { AppPlatform, CreateGitHubRepositoryInput, GitHubCatalog, GitHubOwner, GitHubRepository } from '@sindral/shared';
import { HttpError, badRequest, conflict, forbidden, serviceUnavailable } from '../errors.js';
import type { GitHubOAuthService } from './githubOAuth.js';

type FetchLike = typeof fetch;
type JsonObject = Record<string, unknown>;

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';

export class GitHubConnectionService {
  constructor(
    private readonly githubOAuth: GitHubOAuthService,
    private readonly fetchImpl: FetchLike,
  ) {}

  async catalog(userId: string): Promise<GitHubCatalog> {
    const secret = await this.githubOAuth.credential(userId);
    if (!secret) return { connected: false, source: null, repositories: [], owners: [] };

    const user = await this.requestObject(secret.token, '/user');
    const login = stringField(user, 'login');
    if (!login) throw serviceUnavailable('GitHub returned an invalid user profile');

    const [repositories, organizations] = await Promise.all([
      this.listRepositories(secret.token),
      this.listOrganizations(secret.token),
    ]);
    const owner: GitHubOwner = {
      login,
      type: 'user',
      avatarUrl: nullableStringField(user, 'avatar_url'),
      role: 'owner',
    };

    return {
      connected: true,
      source: secret.metadata['source'] === 'oauth' ? 'oauth' : 'pat',
      repositories,
      owners: [owner, ...organizations.filter((candidate) => candidate.login.toLowerCase() !== login.toLowerCase())],
    };
  }

  async createRepository(userId: string, input: CreateGitHubRepositoryInput): Promise<GitHubRepository> {
    const secret = await this.githubOAuth.credential(userId);
    if (!secret) throw badRequest('Connect GitHub before creating a repository');

    const user = await this.requestObject(secret.token, '/user');
    const login = stringField(user, 'login');
    if (!login) throw serviceUnavailable('GitHub returned an invalid user profile');

    const isUserRepository = login.toLowerCase() === input.owner.toLowerCase();
    const endpoint = isUserRepository ? '/user/repos' : `/orgs/${encodeURIComponent(input.owner)}/repos`;
    const repository = await this.requestObject(secret.token, endpoint, {
      method: 'POST',
      body: {
        name: input.name,
        description: input.description || undefined,
        private: input.visibility === 'private',
        auto_init: true,
      },
    });

    const fullName = stringField(repository, 'full_name') || `${input.owner}/${input.name}`;
    const initialBranch = stringField(repository, 'default_branch') || 'main';
    if (initialBranch !== 'main') {
      const [owner, name] = fullName.split('/');
      if (!owner || !name) throw serviceUnavailable('GitHub returned an invalid repository name');
      await this.requestObject(
        secret.token,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches/${encodeURIComponent(initialBranch)}/rename`,
        { method: 'POST', body: { new_name: 'main' } },
      );
      repository['default_branch'] = 'main';
    }

    return mapRepository(repository);
  }

  async setRepositoryReadme(userId: string, fullName: string, input: { title: string; description: string; mobilePlatforms?: AppPlatform[] }): Promise<void> {
    const secret = await this.githubOAuth.credential(userId);
    if (!secret) throw badRequest('Connect GitHub before updating a repository');

    const [owner, name] = fullName.split('/');
    if (!owner || !name) throw serviceUnavailable('GitHub returned an invalid repository name');

    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/README.md`;
    let sha: string | undefined;
    try {
      const readme = await this.requestObject(secret.token, `${path}?ref=main`);
      sha = stringField(readme, 'sha') || undefined;
    } catch (error) {
      if (!(error instanceof HttpError) || error.statusCode !== 404) throw error;
    }

    const architecture = input.mobilePlatforms ? `## App architecture\n\nDefault task platforms: ${input.mobilePlatforms.join(', ')}.\n\n- ios/: SwiftUI\n- android/: Kotlin / Jetpack Compose\n- web/: React\n- supabase/: one shared Supabase backend\n\nEach task chooses its platforms; implement only those clients in order: iOS, Android, Web. Review both BDD and implementation plans before implementation. All code follows Domain Driven Design: bounded contexts, shared domain vocabulary, framework-independent business rules and invariants, application use cases, and infrastructure adapters for Supabase and other integrations. Keep UI and persistence models separate from domain models and test the domain in isolation. Every selected platform must pass the approved BDD scenarios and DDD architecture checks before release.` : '';
    const content = [`# ${input.title}`, input.description.trim(), architecture].filter(Boolean).join('\n\n') + '\n';
    await this.requestObject(secret.token, path, {
      method: 'PUT',
      body: {
        message: 'Initialize project README',
        content: Buffer.from(content, 'utf8').toString('base64'),
        branch: 'main',
        ...(sha ? { sha } : {}),
      },
    });
    if (input.mobilePlatforms) {
      for (const folder of ['ios', 'android', 'web', 'supabase']) {
        await this.requestObject(secret.token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${folder}/.gitkeep`, {
          method: 'PUT',
          body: { message: `Initialize ${folder} folder`, content: '', branch: 'main' },
        });
      }
    }
  }

  private async listRepositories(token: string): Promise<GitHubRepository[]> {
    const repositories: GitHubRepository[] = [];
    for (let page = 1; page <= 5; page++) {
      const rows = await this.requestArray(
        token,
        `/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc&per_page=100&page=${page}`,
      );
      for (const row of rows) {
        const permissions = objectField(row, 'permissions');
        if (permissions && permissions['push'] !== true && permissions['admin'] !== true && permissions['maintain'] !== true) continue;
        repositories.push(mapRepository(row));
      }
      if (rows.length < 100) break;
    }
    return repositories;
  }

  private async listOrganizations(token: string): Promise<GitHubOwner[]> {
    try {
      const rows = await this.requestArray(token, '/user/memberships/orgs?state=active&per_page=100');
      return rows.flatMap((row) => {
        const organization = objectField(row, 'organization');
        const login = organization ? stringField(organization, 'login') : '';
        if (!organization || !login) return [];
        return [{
          login,
          type: 'organization' as const,
          avatarUrl: nullableStringField(organization, 'avatar_url'),
          role: row['role'] === 'admin' ? 'admin' as const : 'member' as const,
        }];
      });
    } catch (error) {
      if (!(error instanceof HttpError) || (error.statusCode !== 403 && error.statusCode !== 404)) throw error;
      try {
        const rows = await this.requestArray(token, '/user/orgs?per_page=100');
        return rows.flatMap((row) => {
          const login = stringField(row, 'login');
          return login
            ? [{ login, type: 'organization' as const, avatarUrl: nullableStringField(row, 'avatar_url'), role: 'member' as const }]
            : [];
        });
      } catch (fallbackError) {
        if (fallbackError instanceof HttpError && (fallbackError.statusCode === 403 || fallbackError.statusCode === 404)) return [];
        throw fallbackError;
      }
    }
  }

  private async requestObject(
    token: string,
    path: string,
    options: { method?: 'GET' | 'POST' | 'PUT'; body?: JsonObject } = {},
  ): Promise<JsonObject> {
    const value = await this.request(token, path, options);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw serviceUnavailable('GitHub returned an unexpected response');
    return value as JsonObject;
  }

  private async requestArray(token: string, path: string): Promise<JsonObject[]> {
    const value = await this.request(token, path);
    if (!Array.isArray(value) || value.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
      throw serviceUnavailable('GitHub returned an unexpected response');
    }
    return value as JsonObject[];
  }

  private async request(
    token: string,
    path: string,
    options: { method?: 'GET' | 'POST' | 'PUT'; body?: JsonObject } = {},
  ): Promise<unknown> {
    const response = await this.fetchImpl(`${API}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': 'sindral-server',
      },
      redirect: 'error',
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await response.text();
    let value: unknown = null;
    if (text.trim()) {
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        throw serviceUnavailable('GitHub returned malformed JSON');
      }
    }
    if (response.ok) return value;

    const message = value && typeof value === 'object' && !Array.isArray(value) && typeof (value as JsonObject)['message'] === 'string'
      ? String((value as JsonObject)['message'])
      : `GitHub responded with ${response.status}`;
    if (response.status === 401) throw new HttpError(400, 'GITHUB_RECONNECT_REQUIRED', 'Your GitHub connection has expired. Reconnect GitHub and try again.');
    if (response.status === 403) throw forbidden(`GitHub denied this request: ${message}`);
    if (response.status === 422) throw conflict(`GitHub could not create the repository: ${message}`);
    if (response.status === 404) throw new HttpError(404, 'GITHUB_NOT_FOUND', message);
    throw serviceUnavailable(`GitHub request failed: ${message}`);
  }
}

function mapRepository(row: JsonObject): GitHubRepository {
  const fullName = stringField(row, 'full_name');
  const [owner = '', nameFromFullName = ''] = fullName.split('/');
  const ownerObject = objectField(row, 'owner');
  const name = stringField(row, 'name') || nameFromFullName;
  if (!fullName || !name || !owner) throw serviceUnavailable('GitHub returned an invalid repository');
  return {
    id: typeof row['id'] === 'number' ? row['id'] : 0,
    name,
    fullName,
    private: row['private'] === true,
    description: nullableStringField(row, 'description'),
    url: stringField(row, 'html_url') || `https://github.com/${fullName}`,
    defaultBranch: stringField(row, 'default_branch') || 'main',
    pushedAt: nullableStringField(row, 'pushed_at'),
    owner: ownerObject ? stringField(ownerObject, 'login') || owner : owner,
  };
}

function objectField(value: JsonObject, key: string): JsonObject | null {
  const field = value[key];
  return field && typeof field === 'object' && !Array.isArray(field) ? field as JsonObject : null;
}

function stringField(value: JsonObject, key: string): string {
  return typeof value[key] === 'string' ? String(value[key]) : '';
}

function nullableStringField(value: JsonObject, key: string): string | null {
  return typeof value[key] === 'string' && value[key] ? String(value[key]) : null;
}
