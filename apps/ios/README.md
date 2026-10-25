# Sindral AI for iPhone

Native SwiftUI client for the Sindral REST API. It targets iOS 17 and supports Supabase authentication, task creation/import and lifecycle management, design creation and revision review, approved design handoffs, task chat and outputs, workflow editing, integrations, worker keys, workers, and live SSE refresh.

## Configure

The project provides two shared development schemes:

- `SindralAI` uses the Debug configuration and the local server and Supabase stack.
- `SindralAI Staging` uses the Staging build configuration with the hosted Vercel API at `https://sindral-ai.vercel.app` and hosted Supabase. This scheme currently connects to the shared hosted deployment, rather than a separate staging backend.

Release builds use the same hosted Vercel and Supabase configuration. API URLs are origins; REST requests and SSE use `/api/*` on that origin. For a separate deployment, override the public client settings in CI or an ignored `Config/Release.local.xcconfig`. Release builds do not read the Debug `Local.xcconfig`.

For local development, create the ignored `Config/Local.xcconfig` and set the Supabase publishable key printed by `supabase status`:

```text
SUPABASE_ANON_KEY = your-local-anon-key
```

The checked-in Debug URLs point at the local server (`127.0.0.1:8787`) and Supabase (`127.0.0.1:55321`). `Local.xcconfig` can override any Debug value without affecting the team. The checked-in hosted values are public client configuration; never add a Supabase secret/service-role key or other server credential to an iOS xcconfig. Vercel must allow mobile clients to reach the API without a Vercel login page.

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

Run unit and API contract tests with simulator signing enabled (the auth tests exercise Keychain):

```bash
xcodebuild -project SindralAI.xcodeproj -scheme 'SindralAI Staging' \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

## Design workflow

Choose **Design an app** on Home, describe the app and select an optional project. The server must provide a workflow with `output: design`. Open the task and start designing from its actions. The Design tab shows revisions, screen previews, the specification and source files. Conversation & feedback opens task chat to answer questions and request revisions.

Approve a revision while the task is in Design Review, then choose **Create implementation task**. Select an implementation workflow, repositories/project and scope. The new task receives a frozen snapshot of the approved design. Implementation tasks also expose their approved input in the Design tab. Export handoff saves the complete revision as JSON.

Previews use short-lived signed server URLs in an isolated web view without the app's auth header or cookies. Preview grants refresh while the view is active. Live updates reconnect to Vercel's rotating SSE stream and refresh authenticated state on `sync` signals.

For a fixture-only interface review, launch a Debug or Staging simulator build with `-SindralDemo YES -SindralDemoSection tasks -SindralDemoTask d1`. This uses local sample data, including a design revision and preview, without modifying hosted tasks.
