import { test, expect, type Page } from "@playwright/test";

const APP_ORIGIN = "http://localhost:3100";
const MOCK_BACKEND = "http://localhost:4100";

async function signIn(page: Page) {
  // Frontend only checks for the presence of agatha_at + agatha_rt cookies; the
  // mock backend accepts any token. See lib/session.ts.
  await page.context().addCookies([
    {
      name: "agatha_at",
      value: "test-access",
      url: APP_ORIGIN,
      httpOnly: true,
      sameSite: "Lax",
    },
    {
      name: "agatha_rt",
      value: "test-refresh",
      url: APP_ORIGIN,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

test.beforeEach(async ({ request }) => {
  await request.post(`${MOCK_BACKEND}/__test__/reset`);
});

test("new task modal lets the user pick a project", async ({ page, request }) => {
  await signIn(page);
  await page.goto("/inbox");

  await page.getByRole("button", { name: /New task/i }).click();

  const dialog = page.locator(".modal");
  await expect(dialog).toBeVisible();

  // Both seeded projects appear as picker chips.
  const alphaChip = dialog.getByRole("button", { name: /Alpha/ });
  const betaChip = dialog.getByRole("button", { name: /Beta/ });
  await expect(alphaChip).toBeVisible();
  await expect(betaChip).toBeVisible();

  // Default selection is the first project (no project in URL on /inbox).
  await expect(alphaChip).toHaveCSS("border-color", "rgb(74, 138, 90)");

  // Switch to Beta.
  await betaChip.click();
  await expect(betaChip).toHaveCSS("border-color", "rgb(74, 138, 90)");

  await dialog.getByPlaceholder("Task title…").fill("Test task from picker");
  await dialog.getByRole("button", { name: /Create/ }).click();

  // Modal closes on success.
  await expect(dialog).toBeHidden();

  // Backend received the create with the picked project, not the default.
  const res = await request.get(`${MOCK_BACKEND}/__test__/tasks`);
  const body = (await res.json()) as {
    tasks: Array<{ projectId: string; title: string }>;
  };
  expect(body.tasks).toHaveLength(1);
  expect(body.tasks[0].projectId).toBe("proj-beta");
  expect(body.tasks[0].title).toBe("Test task from picker");
});
