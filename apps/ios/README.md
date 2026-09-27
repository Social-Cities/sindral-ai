# Sindral AI for iPhone

Native SwiftUI client for the Sindral REST API. It targets iOS 17 and supports the same user workflows as the web portal: Supabase authentication, task creation/import and lifecycle management, task chat and outputs, workflow editing, integrations, worker keys, workers, and live SSE refresh.

## Configure

The project provides two shared development schemes:

- `SindralAI` uses the Debug configuration and the local server and Supabase stack.
- `SindralAI Staging` uses the checked-in Staging configuration and the hosted Railway and Supabase services.

For local development, create the ignored `Config/Local.xcconfig` and set the Supabase publishable key printed by `supabase status`:

```text
SUPABASE_ANON_KEY = your-local-anon-key
```

The checked-in Debug URLs point at the local server (`127.0.0.1:8787`) and Supabase (`127.0.0.1:55321`). `Local.xcconfig` can override any Debug value without affecting the team. The checked-in Staging values are public client configuration; never add a Supabase secret/service-role key or other server credential to an iOS xcconfig. Override Release values in CI or an untracked xcconfig.

## Generate and build

```bash
cd apps/ios
xcodegen generate
xcodebuild -project SindralAI.xcodeproj -scheme SindralAI \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

Open `SindralAI.xcodeproj` in Xcode to run on an iPhone Simulator or signed device.

To run a development-signed build against staging, select the `SindralAI Staging` scheme and the target device, then Run. Select `SindralAI` to return to the local stack.
