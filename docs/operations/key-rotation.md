# Secret and key rotation runbook

## Provider and worker credentials

- Rotate GitHub/Linear/Jira credentials in Settings; the replacement is encrypted before the previous ciphertext is removed.
- Revoke a worker key in Settings, stop that worker, create a replacement key, update its local secret store, and restart. Confirm the old key returns 401 and the new worker negotiates the current protocol.
- Rotate the GitHub webhook secret by coordinating a short maintenance window because GitHub sends only one signature. Pause dispatch, update GitHub and the server secret, send a test delivery, then resume.

## `SECRETS_ENCRYPTION_KEY`

The application does not retain plaintext, so changing this environment variable alone makes all stored provider credentials unreadable.

1. Disable dispatch and automatic merge; take a database backup.
2. Generate a new 32-byte key in the secret manager.
3. Use a one-off audited rotation job that decrypts each `user_secrets` row with the old key and immediately re-encrypts it with the new key. Do not log tokens or export plaintext.
4. Verify every row can be decrypted with the new key and cannot be decrypted with the old key.
5. Deploy the new key, test credential status and a sandbox GitHub operation, then destroy transient access to the old key after the recovery window.

Until an automated dual-key rotation command is added, this operation requires a reviewed maintenance script and two-person approval. Do not improvise it in the production console.
