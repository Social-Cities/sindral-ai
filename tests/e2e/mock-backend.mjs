// Tiny HTTP mock of agatha-teams-backend for e2e tests. Returns canned
// responses for the endpoints exercised by the test flows. Records POSTed
// task creations so tests can assert on them via GET /__test__/tasks.

import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_BACKEND_PORT ?? 4100);

const projects = [
  {
    id: "proj-alpha",
    name: "Alpha",
    repo: "agatha/alpha",
    emoji: "\u{1F525}",
    description: "Alpha project",
    active: true,
    open: 2,
    planning: 0,
    inProgress: 1,
    prOpen: 0,
  },
  {
    id: "proj-beta",
    name: "Beta",
    repo: "agatha/beta",
    emoji: "\u{1F331}",
    description: "Beta project",
    active: true,
    open: 1,
    planning: 1,
    inProgress: 0,
    prOpen: 0,
  },
];

const teammates = [
  {
    id: "planner-1",
    name: "Planner One",
    role: "planner",
    model: "opus-4",
    hue: 200,
    status: "online",
    task: null,
  },
];

const createdTasks = [];

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/auth/me") {
    return send(res, 200, {
      success: true,
      user: { id: "user-test", email: "test@example.com" },
    });
  }
  if (method === "GET" && path === "/people/teammates") {
    return send(res, 200, { teammates });
  }
  if (method === "GET" && path === "/people/humans") {
    return send(res, 200, { humans: [] });
  }
  if (method === "GET" && path === "/projects") {
    return send(res, 200, { projects });
  }
  if (method === "GET" && path === "/activity") {
    return send(res, 200, { items: [], taskProjectMap: {} });
  }
  if (method === "POST" && path === "/tasks") {
    const body = await readJson(req);
    const id = `task-${createdTasks.length + 1}`;
    createdTasks.push({ id, ...body });
    return send(res, 200, { success: true, id });
  }
  if (method === "GET" && path === "/__test__/tasks") {
    return send(res, 200, { tasks: createdTasks });
  }
  if (method === "POST" && path === "/__test__/reset") {
    createdTasks.length = 0;
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: `mock-backend: no handler for ${method} ${path}` });
});

server.listen(PORT, () => {
  console.log(`mock-backend listening on :${PORT}`);
});
