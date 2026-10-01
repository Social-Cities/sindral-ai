import http2 from 'node:http2';
import { SignJWT, importPKCS8 } from 'jose';
import type { PushDevice, Task } from '@sindral/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Repository } from '../db/repository.js';

export type TaskNotificationKind = 'needs-input' | 'failure';

export interface TaskNotification {
  kind: TaskNotificationKind;
  task: Task;
  stepLabel: string | null;
  error: string | null;
}

export interface NotificationSink {
  notifyTaskStatus(userId: string, notification: TaskNotification): Promise<void>;
}

export class NoopNotificationService implements NotificationSink {
  async notifyTaskStatus(): Promise<void> {
    // Push notifications are optional. Unconfigured servers keep task state changes working.
  }
}

interface ApnsConfig {
  keyId: string;
  teamId: string;
  bundleId: string;
  privateKey: string;
  environment: 'sandbox' | 'production';
}

interface ApnsResponse {
  status: number;
  body: string;
}

const TOKEN_TTL_MS = 45 * 60 * 1000;

export function notificationServiceFromConfig(config: AppConfig, repo: Repository, log: FastifyBaseLogger): NotificationSink {
  if (!config.apnsKeyId || !config.apnsTeamId || !config.apnsBundleId || !config.apnsPrivateKey) return new NoopNotificationService();
  return new ApnsNotificationService(
    {
      keyId: config.apnsKeyId,
      teamId: config.apnsTeamId,
      bundleId: config.apnsBundleId,
      privateKey: config.apnsPrivateKey,
      environment: config.apnsEnvironment,
    },
    repo,
    log,
  );
}

export class ApnsNotificationService implements NotificationSink {
  private signingKey: ReturnType<typeof importPKCS8> | null = null;
  private bearer: { token: string; createdAt: number } | null = null;

  constructor(
    private readonly config: ApnsConfig,
    private readonly repo: Repository,
    private readonly log: FastifyBaseLogger,
  ) {}

  async notifyTaskStatus(userId: string, notification: TaskNotification): Promise<void> {
    const devices = (await this.repo.listPushDevices(userId)).filter(
      (device) => device.platform === 'ios' && device.environment === this.config.environment,
    );
    if (devices.length === 0) return;
    await Promise.all(devices.map((device) => this.sendToDevice(userId, device, notification)));
  }

  private async sendToDevice(userId: string, device: PushDevice, notification: TaskNotification): Promise<void> {
    try {
      const response = await this.sendApns(device.token, payloadFor(notification));
      if (response.status >= 200 && response.status < 300) return;
      const reason = parseReason(response.body);
      if (response.status === 403 && reason === 'ExpiredProviderToken') this.bearer = null;
      if ((response.status === 400 && reason === 'BadDeviceToken') || response.status === 410) {
        await this.repo.deletePushDevice(userId, device.platform, device.environment, device.token);
      }
      this.log.warn({ userId, taskId: notification.task.id, status: response.status, reason }, 'push notification delivery failed');
    } catch (err) {
      this.log.warn({ err, userId, taskId: notification.task.id }, 'push notification delivery failed');
    }
  }

  private async sendApns(deviceToken: string, payload: Record<string, unknown>): Promise<ApnsResponse> {
    const bearer = await this.authToken();
    const authority = this.config.environment === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
    const client = http2.connect(authority);
    return new Promise<ApnsResponse>((resolve, reject) => {
      client.once('error', reject);
      const request = client.request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${bearer}`,
        'apns-topic': this.config.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
      });
      let status = 0;
      const chunks: Buffer[] = [];
      request.setEncoding('utf8');
      request.on('response', (headers) => {
        status = Number(headers[':status'] ?? 0);
      });
      request.on('data', (chunk: string) => chunks.push(Buffer.from(chunk)));
      request.once('error', reject);
      request.once('end', () => {
        client.close();
        resolve({ status, body: Buffer.concat(chunks).toString('utf8') });
      });
      request.end(JSON.stringify(payload));
    }).finally(() => client.close());
  }

  private async authToken(): Promise<string> {
    const now = Date.now();
    if (this.bearer && this.bearer.createdAt > now - TOKEN_TTL_MS) return this.bearer.token;
    this.signingKey ??= importPKCS8(this.config.privateKey, 'ES256');
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: this.config.keyId })
      .setIssuer(this.config.teamId)
      .setIssuedAt(Math.floor(now / 1000))
      .sign(await this.signingKey);
    this.bearer = { token, createdAt: now };
    return token;
  }
}

function payloadFor(notification: TaskNotification): Record<string, unknown> {
  const title = notification.kind === 'failure' ? `${notification.task.key} failed` : `${notification.task.key} needs input`;
  const body = notification.kind === 'failure'
    ? truncate(notification.error || `${notification.task.title} failed.`, 160)
    : truncate(`${notification.stepLabel ?? 'The next step'} is ready for ${notification.task.title}.`, 160);
  return {
    aps: {
      alert: { title, body },
      sound: 'default',
    },
    taskId: notification.task.id,
    taskKey: notification.task.key,
    kind: notification.kind,
  };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function parseReason(body: string): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    return typeof parsed.reason === 'string' ? parsed.reason : null;
  } catch {
    return null;
  }
}
