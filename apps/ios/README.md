# Sindral AI for iPhone

Native SwiftUI client for the Sindral REST API. It targets iOS 17 and supports the same user workflows as the web portal: Supabase authentication, task creation/import and lifecycle management, task chat and outputs, workflow editing, integrations, worker keys, workers, and live SSE refresh.

## Configure

Edit `Config/Debug.xcconfig` for local development. Set the Supabase anon/publishable key printed by `supabase status`:

```text
SUPABASE_ANON_KEY = your-local-anon-key
```

The checked-in debug URLs point at the local server (`127.0.0.1:8787`) and Supabase (`127.0.0.1:55321`). Do not commit production credentials. Override release values in CI or an untracked xcconfig.

Supabase GitHub auth must allow `sindral://auth-callback` as a redirect URL.

## Generate and build

```bash
cd apps/ios
xcodegen generate
xcodebuild -project SindralAI.xcodeproj -scheme SindralAI \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

Open `SindralAI.xcodeproj` in Xcode to run on an iPhone Simulator or signed device.
